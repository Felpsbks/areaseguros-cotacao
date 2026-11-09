// Consulta de veículo pela placa (Vercel Function, Node 18+, sem dependências).
// GET /api/placa?p=ABC1D23  ->  { ok: true, veiculo: { marca, modelo, versao, anoFabricacao, anoModelo, combustivel, cor, tipo, codigoFipe, valorFipe }, versoes: [...] }
//
// Variáveis de ambiente (painel da Vercel):
//   APIBRASIL_TOKEN    obrigatório — Bearer token da APIBrasil (com saldo)
//   APIBRASIL_TIPO     opcional — padrão "fipe" (Fipe Beta: R$ 0,06, aceita conta CPF).
//                      "agregados-propria" (R$ 0,08, traz a cor) exige conta com CNPJ.
//   APIBRASIL_HOMOLOG  opcional — "1" consulta a base de teste da APIBrasil, sem cobrança
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY  opcionais — guardam cada placa consultada no Storage
//                      do Supabase (bucket privado "consultas-placa"). Com isso cada placa é paga UMA vez:
//                      as próximas consultas leem o registro salvo, de graça, mesmo depois de reiniciar.
//
// A consulta "fipe" pode devolver mais de uma versão FIPE para a mesma placa (ex.: 2p e 4p):
// vão todas em `versoes`, a marcada como principal em `veiculo`, e o cliente confirma na tela.
//
// Cada consulta custa dinheiro: ordem = memória -> registro salvo no Supabase -> APIBrasil (paga),
// e a resposta paga é salva. Há também limite por IP e teto diário.
// Nunca devolve chassi, renavam, motor, dono ou município — só o que o formulário precisa.

const ENDPOINT = 'https://gateway.apibrasil.io/api/v2/consulta/veiculos/credits';
const PLACA_RE = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/; // antiga (ABC1234) e Mercosul (ABC1D23)
const TIMEOUT_MS = 8000;
const CACHE_MS = 24 * 60 * 60 * 1000;
// Cada consulta custa dinheiro: limites apertados de propósito (um cliente real consulta 1 ou 2 placas).
const LIMITE_MINUTO = 3;          // por IP
const LIMITE_DIA = 8;             // por IP
const TETO_DIA = Number(process.env.APIBRASIL_TETO_DIA || 40); // total do dia (por instância): no máximo ~R$ 2,40/dia na Fipe Beta

const cache = new Map();   // placa -> { expira, corpo, status }
const acessos = new Map(); // ip -> { minuto: [timestamps], dia: { data, total } }

// ---------- Registro permanente das consultas (Supabase Storage) ----------
const BUCKET = 'consultas-placa';
const NAO_ENCONTRADA_DIAS = 30; // placa não achada: tenta de novo depois desse prazo (pode ser placa nova)

function storage() {
  const base = process.env.SUPABASE_URL, chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !chave) return null;
  return { base: base.replace(/\/$/, ''), headers: { Authorization: `Bearer ${chave}`, apikey: chave } };
}

// Lê o registro salvo da placa. Qualquer falha aqui não pode impedir a consulta: devolve null.
async function lerSalvo(placa) {
  const s = storage();
  if (!s) return null;
  try {
    const r = await fetch(`${s.base}/storage/v1/object/${BUCKET}/${placa}.json`, { headers: s.headers, signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const reg = await r.json();
    if (reg.status === 404 && Date.now() - Date.parse(reg.salvoEm) > NAO_ENCONTRADA_DIAS * 864e5) return null;
    return reg;
  } catch {
    return null;
  }
}

async function salvar(placa, status, corpo) {
  const s = storage();
  if (!s || process.env.APIBRASIL_HOMOLOG === '1') return; // resposta de teste nunca vai para o registro
  try {
    await fetch(`${s.base}/storage/v1/object/${BUCKET}/${placa}.json`, {
      method: 'POST',
      headers: { ...s.headers, 'Content-Type': 'application/json', 'x-upsert': 'true' },
      body: JSON.stringify({ placa, status, corpo, salvoEm: new Date().toISOString() }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    console.error('placa: não consegui salvar o registro', e && e.name);
  }
}

function responder(res, status, corpo, cacheCdn) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheCdn || 'no-store');
  res.end(JSON.stringify(corpo));
}

// "GOL 1.0" -> "Gol 1.0"; siglas de marca e trechos com número ficam em maiúsculas ("VW", "12V").
const SIGLAS = new Set(['VW', 'GM', 'BMW', 'BYD', 'JAC', 'GWM', 'RAM', 'MG', 'JAC', 'CAOA', 'DS', 'TAC', 'MMC', 'AGL', 'GTI', 'TSI', 'TFSI', 'SUV', 'CVT', 'AT', 'MT', 'CD', 'CS', 'GL', 'GLS', 'LX', 'EX', 'LT', 'LTZ', 'XL', 'XLS', 'XLT', 'SE', 'SEL', 'HB']);
function bonito(texto) {
  return String(texto || '').trim().toUpperCase().split(/\s+/).filter(Boolean).map((p) =>
    (SIGLAS.has(p) || /\d/.test(p) || p.length <= 1) ? p : p.charAt(0) + p.slice(1).toLowerCase()
  ).join(' ');
}

function combustivel(texto) {
  const t = String(texto || '').toUpperCase();
  if (/FLEX|ALCOOL\s*\/\s*GASOLINA|GASOLINA\s*\/\s*ALCOOL/.test(t)) return 'Flex';
  if (/HIBRID/.test(t)) return 'Híbrido';
  if (/ELETRIC/.test(t)) return 'Elétrico';
  if (/DIESEL/.test(t)) return 'Diesel';
  if (/ALCOOL|ETANOL/.test(t)) return 'Etanol';
  if (/GASOLINA/.test(t)) return 'Gasolina';
  return '';
}

function tipoVeiculo(dados) {
  const t = `${dados.tipo_veiculo || ''} ${dados.especie || ''}`.toUpperCase();
  return /MOTO|CICLOMOTOR|MOTONETA/.test(t) ? 'Moto' : 'Carro';
}

// "VW - VolksWagen" -> "Volkswagen"; "GM - Chevrolet" -> "Chevrolet"; siglas curtas ficam ("BMW").
function marcaFipe(texto) {
  const partes = String(texto || '').split(' - ');
  const nome = partes[partes.length - 1].trim();
  if (/^[A-Z0-9]{2,4}$/.test(nome)) return nome;
  return nome.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep, letra) => sep + letra.toUpperCase());
}

// Deixa as duas respostas possíveis (Fipe Beta: lista de versões; Agregados: um veículo) no mesmo
// formato. Primeiro item = o mais provável. Só os campos que o formulário usa.
function normalizar(dados) {
  if (Array.isArray(dados.data)) {
    return dados.data
      .filter((v) => v && (v.marca || v.modelo))
      .sort((a, b) => (b.principal === true) - (a.principal === true))
      .slice(0, 6)
      .map((v) => ({
        marca: marcaFipe(v.marca),
        modelo: String(v.modelo || '').trim(),
        versao: '',
        anoFabricacao: v.anoFabricacao ? String(v.anoFabricacao) : '',
        anoModelo: v.anoModelo && String(v.anoModelo) !== '32000' ? String(v.anoModelo) : '', // 32000 = "0 km" na FIPE
        combustivel: combustivel(v.combustivel),
        cor: '',
        tipo: /moto/i.test(String(v.categoria || '')) ? 'Moto' : 'Carro',
        codigoFipe: String(v.codigoFipe || ''),
        valorFipe: typeof v.valor === 'number' ? v.valor : null,
      }));
  }
  if (!(dados.marca || dados.modelo)) return [];
  return [{
    marca: bonito(dados.marcaDetalhes?.nome || dados.marca || dados.fabricante),
    modelo: bonito(dados.modeloDetalhes?.nome || dados.modelo),
    versao: bonito(dados.versao),
    anoFabricacao: dados.ano_fabricacao ? String(dados.ano_fabricacao) : '',
    anoModelo: dados.ano_modelo ? String(dados.ano_modelo) : '',
    combustivel: combustivel(dados.combustivel),
    cor: bonito(dados.cor),
    tipo: tipoVeiculo(dados),
    codigoFipe: '',
    valorFipe: null,
  }];
}

function ipDe(req) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  return xff.split(',')[0].trim() || req.socket?.remoteAddress || 'desconhecido';
}

// Limite por instância (cada instância da Vercel tem a sua memória): segura abuso casual.
// Para um limite global, configure uma regra de Rate Limit no Firewall da Vercel.
const totalDoDia = { data: '', total: 0 };

function dentroDoLimite(ip) {
  const agora = Date.now();
  const hoje = new Date().toISOString().slice(0, 10);
  if (totalDoDia.data !== hoje) { totalDoDia.data = hoje; totalDoDia.total = 0; }
  if (totalDoDia.total >= TETO_DIA) { console.error('placa: teto diário de consultas atingido'); return false; }
  const reg = acessos.get(ip) || { minuto: [], dia: { data: hoje, total: 0 } };
  reg.minuto = reg.minuto.filter((t) => agora - t < 60000);
  if (reg.dia.data !== hoje) reg.dia = { data: hoje, total: 0 };
  if (reg.minuto.length >= LIMITE_MINUTO || reg.dia.total >= LIMITE_DIA) { acessos.set(ip, reg); return false; }
  totalDoDia.total += 1;
  reg.minuto.push(agora);
  reg.dia.total += 1;
  acessos.set(ip, reg);
  if (acessos.size > 5000) acessos.clear();
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return responder(res, 405, { ok: false, erro: 'metodo' }); }

  const url = new URL(req.url, 'http://localhost');
  const placa = String(url.searchParams.get('p') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!PLACA_RE.test(placa)) return responder(res, 400, { ok: false, erro: 'placa_invalida' });

  const guardado = cache.get(placa);
  if (guardado && guardado.expira > Date.now()) return responder(res, guardado.status, guardado.corpo, guardado.cacheCdn);

  // Já consultada antes (por qualquer pessoa)? Devolve o registro salvo, sem pagar de novo.
  const salvo = await lerSalvo(placa);
  if (salvo && salvo.corpo) {
    const cacheCdn = salvo.status === 200 ? 'public, s-maxage=2592000' : 'public, s-maxage=86400';
    cache.set(placa, { expira: Date.now() + CACHE_MS, status: salvo.status, corpo: salvo.corpo, cacheCdn });
    return responder(res, salvo.status, salvo.corpo, cacheCdn);
  }

  const token = process.env.APIBRASIL_TOKEN;
  if (!token) return responder(res, 503, { ok: false, erro: 'sem_config' });

  if (!dentroDoLimite(ipDe(req))) {
    res.setHeader('Retry-After', '60');
    return responder(res, 429, { ok: false, erro: 'limite' });
  }

  let resposta;
  try {
    resposta = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tipo: process.env.APIBRASIL_TIPO || 'fipe', placa, homolog: process.env.APIBRASIL_HOMOLOG === '1' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    console.error('placa: falha ao chamar o fornecedor', timeout ? 'timeout' : (e && e.name));
    return responder(res, timeout ? 504 : 502, { ok: false, erro: timeout ? 'timeout' : 'fornecedor' });
  }

  let corpo = null;
  try { corpo = await resposta.json(); } catch { /* corpo não-JSON */ }

  // A APIBrasil pode responder HTTP 200 com erro no corpo: o que vale é `error === false`.
  if (resposta.status === 402) {
    console.error('placa: saldo insuficiente na APIBrasil');
    return responder(res, 503, { ok: false, erro: 'saldo' });
  }
  const dados = corpo && corpo.error === false && corpo.data && typeof corpo.data === 'object' ? corpo.data : null;
  const versoes = dados ? normalizar(dados) : [];

  if (!versoes.length) {
    const msg = String((corpo && corpo.message) || '');
    const naoAchou = resposta.ok && (/n[aã]o\s+(foi\s+)?encontrad|not\s+found|sem\s+resultado/i.test(msg) || (corpo && corpo.error === false));
    if (naoAchou) {
      const r = { ok: false, erro: 'nao_encontrada' };
      cache.set(placa, { expira: Date.now() + CACHE_MS, status: 404, corpo: r, cacheCdn: 'public, s-maxage=86400' });
      await salvar(placa, 404, r);
      return responder(res, 404, r, 'public, s-maxage=86400');
    }
    console.error('placa: fornecedor recusou', resposta.status, msg.slice(0, 120));
    return responder(res, 502, { ok: false, erro: 'fornecedor' });
  }

  const r = { ok: true, veiculo: versoes[0], versoes };
  cache.set(placa, { expira: Date.now() + CACHE_MS, status: 200, corpo: r, cacheCdn: 'public, s-maxage=2592000' });
  if (cache.size > 2000) cache.clear();
  await salvar(placa, 200, r);
  return responder(res, 200, r, 'public, s-maxage=2592000');
};
