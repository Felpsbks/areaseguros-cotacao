// Envio da cotação pelo WhatsApp (Vercel Function, Node 18+, sem dependências).
// POST /api/enviar  { produto, mensagemCorretora, imagens: [{ url, caption }], nomeCliente, numeroCliente }
//
// A chave da API do WhatsApp fica só aqui no servidor (antes ficava no HTML, visível para qualquer um).
// Para não virar um disparador de mensagens nas mãos de terceiros:
//   - a cotação e as fotos vão SEMPRE para o número da corretora (fixo aqui, não vem do navegador);
//   - o cliente recebe só um texto fixo de confirmação, com o primeiro nome dele;
//   - fotos só do bucket de documentos do próprio Supabase;
//   - limite de envios por IP.
//
// Variáveis de ambiente (painel da Vercel):
//   WHATSAPP_API_KEY  obrigatório — chave da Edge Function send-whatsapp do Supabase
//   WHATSAPP_API_URL  opcional — padrão: a Edge Function do projeto AREASEGUROS
//   WHATSAPP_NUMBER   opcional — número da corretora (padrão abaixo)

const API_URL = process.env.WHATSAPP_API_URL || 'https://uieoiomhhuykmaummjyb.supabase.co/functions/v1/send-whatsapp';
const NUMERO_CORRETORA = process.env.WHATSAPP_NUMBER || '5511996526469';
const PREFIXO_FOTOS = 'https://uieoiomhhuykmaummjyb.supabase.co/storage/v1/object/public/cotacao-docs/';
const PRODUTOS = { veicular: 'seguro auto', celular: 'seguro celular', saude: 'plano de saúde', residencial: 'seguro residencial' };
const MAX_MENSAGEM = 4000;
const MAX_IMAGENS = 10;
const LIMITE_10_MIN = 3; // envios por IP
const LIMITE_DIA = 10;
const TIMEOUT_MS = 15000;

const acessos = new Map(); // ip -> [timestamps]

function responder(res, status, corpo) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(corpo));
}

function ipDe(req) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  return xff.split(',')[0].trim() || req.socket?.remoteAddress || 'desconhecido';
}

function dentroDoLimite(ip) {
  const agora = Date.now();
  const lista = (acessos.get(ip) || []).filter((t) => agora - t < 864e5);
  const ultimos10 = lista.filter((t) => agora - t < 6e5).length;
  if (ultimos10 >= LIMITE_10_MIN || lista.length >= LIMITE_DIA) { acessos.set(ip, lista); return false; }
  lista.push(agora);
  acessos.set(ip, lista);
  if (acessos.size > 5000) acessos.clear();
  return true;
}

// Vercel já entrega req.body parseado; no servidor local lemos o corpo à mão.
async function lerCorpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  let texto = '';
  for await (const parte of req) { texto += parte; if (texto.length > 100000) throw new Error('grande'); }
  return JSON.parse(texto || '{}');
}

const primeiroNome = (nome) => String(nome || '').trim().split(/\s+/)[0].replace(/[^\p{L}'-]/gu, '').slice(0, 30);

async function enviar(chave, corpo) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: chave },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // Essa API responde HTTP 200 mesmo quando falha (ex.: WhatsApp desconectado): o erro vem no corpo.
  if (!r.ok) return false;
  try { const d = await r.json(); return !d.error; } catch { return false; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return responder(res, 405, { ok: false, erro: 'metodo' }); }

  const chave = process.env.WHATSAPP_API_KEY;
  if (!chave) return responder(res, 503, { ok: false, erro: 'sem_config' });

  let dados;
  try { dados = await lerCorpo(req); } catch { return responder(res, 400, { ok: false, erro: 'corpo_invalido' }); }

  const produto = PRODUTOS[dados.produto] ? dados.produto : null;
  const mensagem = String(dados.mensagemCorretora || '').trim();
  const numeroCliente = String(dados.numeroCliente || '').replace(/\D/g, '');
  if (!produto || !mensagem || mensagem.length > MAX_MENSAGEM || !/^\d{10,13}$/.test(numeroCliente)) {
    return responder(res, 400, { ok: false, erro: 'dados_invalidos' });
  }
  const imagens = (Array.isArray(dados.imagens) ? dados.imagens : [])
    .filter((i) => i && typeof i.url === 'string' && i.url.startsWith(PREFIXO_FOTOS) && !i.url.includes('..'))
    .slice(0, MAX_IMAGENS)
    .map((i) => ({ url: i.url, caption: String(i.caption || '').slice(0, 120) }));

  if (!dentroDoLimite(ipDe(req))) {
    res.setHeader('Retry-After', '600');
    return responder(res, 429, { ok: false, erro: 'limite' });
  }

  try {
    // 1) A cotação para a corretora — é o que decide se o envio deu certo.
    const ok = await enviar(chave, { number: NUMERO_CORRETORA, message: mensagem });
    if (!ok) return responder(res, 502, { ok: false, erro: 'whatsapp' });

    // 2) Fotos e confirmação para o cliente: se alguma falhar, a cotação já chegou.
    const nome = primeiroNome(dados.nomeCliente);
    const confirmacao = `⭐ *MK Corretora de Seguros - Cotação recebida!*\n\nOlá${nome ? `, ${nome}` : ''}! Recebemos seu pedido de cotação de *${PRODUTOS[produto]}*.`
      + '\n\nUm especialista vai comparar as opções e falar com você por aqui. Se algo estiver errado, é só responder esta mensagem.'
      + '\n\n_MK Corretora de Seguros - Proteção para o que realmente importa._';
    await Promise.allSettled([
      ...imagens.map((img) => enviar(chave, { number: NUMERO_CORRETORA, image: img.url, caption: img.caption })),
      enviar(chave, { number: numeroCliente, message: confirmacao }),
    ]);
    return responder(res, 200, { ok: true });
  } catch (e) {
    console.error('enviar: falha', e && e.name);
    return responder(res, 502, { ok: false, erro: 'whatsapp' });
  }
};
