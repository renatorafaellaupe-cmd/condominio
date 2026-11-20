/* Funções auxiliares das rotas /api (arquivos com "_" não viram rota na Vercel).
   Sem dependências externas: usa apenas módulos nativos do Node 18+. */
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');

const FB_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCQItgaMvzJqKU-A7m4hFQtilB7a8cA51Y';
const FB_DB_URL = (process.env.FIREBASE_DB_URL || 'https://gestaodecondominio-f7163-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const PDF_MAX = 3 * 1024 * 1024;

class HttpErro extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
  return false;
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function lerCorpo(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let txt = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null;
  if (txt == null) {
    txt = await new Promise((ok, fail) => {
      let d = '', n = 0;
      req.on('data', c => { n += c.length; if (n > 5 * 1024 * 1024) { fail(new HttpErro(413, 'Arquivo grande demais.')); req.destroy(); } else d += c; });
      req.on('end', () => ok(d)); req.on('error', fail);
    });
  }
  try { return JSON.parse(txt || '{}'); } catch (e) { throw new HttpErro(400, 'Requisição inválida.'); }
}

/* Confere o login do Firebase e se o usuário está ativo no sistema (usuarios/{uid}.ativo === true) */
async function verificarUsuario(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) throw new HttpErro(401, 'Faça login no sistema para enviar.');
  const idToken = m[1].trim();
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  });
  const j = await r.json().catch(() => ({}));
  const u = r.ok && j.users && j.users[0];
  if (!u || !u.localId) throw new HttpErro(401, 'Sessão expirada. Saia e entre de novo no sistema.');
  const pr = await fetch(`${FB_DB_URL}/usuarios/${encodeURIComponent(u.localId)}.json?auth=${encodeURIComponent(idToken)}`);
  const p = pr.ok ? await pr.json().catch(() => null) : null;
  if (!p || p.ativo !== true) throw new HttpErro(403, 'Seu usuário não tem acesso ativo ao sistema.');
  return { uid: u.localId, email: u.email || p.email || '', nome: p.nome || u.email || '' };
}

function validarPdf(pdf) {
  if (!pdf || typeof pdf.base64 !== 'string') throw new HttpErro(400, 'PDF do termo não recebido.');
  const b64 = pdf.base64.replace(/^data:application\/pdf;base64,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new HttpErro(400, 'PDF inválido.');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 100 || buf.slice(0, 5).toString('latin1') !== '%PDF-') throw new HttpErro(400, 'O arquivo enviado não é um PDF.');
  if (buf.length > PDF_MAX) throw new HttpErro(413, 'PDF maior que 3 MB.');
  const nome = String(pdf.nome || 'Termo_de_Referencia.pdf').replace(/[^\w.\-]+/g, '_').slice(0, 100);
  return { buf, nome: /\.pdf$/i.test(nome) ? nome : nome + '.pdf' };
}

/* ---------- Conta de serviço do Firebase (para guardar e ler o PDF do link) ---------- */
let tokenCache = null;
function contaServico() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new HttpErro(503, 'Link do PDF ainda não configurado no servidor (falta FIREBASE_SERVICE_ACCOUNT na Vercel).');
  let sa; try { sa = JSON.parse(raw); } catch (e) { throw new HttpErro(500, 'FIREBASE_SERVICE_ACCOUNT inválida: cole o conteúdo inteiro do arquivo JSON.'); }
  if (!sa.client_email || !sa.private_key) throw new HttpErro(500, 'FIREBASE_SERVICE_ACCOUNT incompleta.');
  return { email: sa.client_email, chave: String(sa.private_key).replace(/\\n/g, '\n') };
}
async function tokenServico() {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.tk;
  const sa = contaServico(), agora = Math.floor(Date.now() / 1000);
  const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const corpo = b64u({ alg: 'RS256', typ: 'JWT' }) + '.' + b64u({
    iss: sa.email, aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email'
  });
  const assin = crypto.createSign('RSA-SHA256').update(corpo).sign(sa.chave, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: corpo + '.' + assin })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new HttpErro(500, 'Não foi possível autenticar a conta de serviço do Firebase.');
  tokenCache = { tk: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.tk;
}
async function rtdb(metodo, caminho, dados) {
  const tk = await tokenServico();
  const r = await fetch(`${FB_DB_URL}/${caminho}.json?access_token=${encodeURIComponent(tk)}`, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: dados === undefined ? undefined : JSON.stringify(dados)
  });
  if (!r.ok) throw new HttpErro(502, 'Falha ao acessar o banco de dados (' + r.status + ').');
  return r.json();
}

/* ---------- E-mail por SMTP (Gmail: smtp.gmail.com, porta 465, senha de app) ---------- */
function configSmtp() {
  const user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  if (!user || !pass) throw new HttpErro(503, 'Envio de e-mail ainda não configurado no servidor (faltam SMTP_USER e SMTP_PASS na Vercel).');
  const port = +(process.env.SMTP_PORT || 465);
  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com', port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    user, pass: String(pass).replace(/\s+/g, ''), // senha de app do Google vem com espaços
    nomeRemetente: process.env.SMTP_FROM_NAME || 'Gestão de Manutenção'
  };
}
const semQuebra = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const cabUtf8 = s => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
const quebrar76 = b64 => b64.replace(/.{1,76}/g, '$&\r\n');
const emailValido = e => /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/.test(String(e || ''));

function montarMensagem({ de, nomeDe, para, responderPara, assunto, texto, anexo }) {
  const fronteira = '=_gm_' + crypto.randomBytes(12).toString('hex');
  const dominio = de.split('@')[1] || 'localhost';
  const h = [
    `From: ${cabUtf8(semQuebra(nomeDe).replace(/["<>]/g, ''))} <${de}>`,
    `To: <${para}>`,
    responderPara ? `Reply-To: <${responderPara}>` : null,
    `Subject: ${cabUtf8(semQuebra(assunto).slice(0, 200))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@${dominio}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${fronteira}"`
  ].filter(Boolean).join('\r\n');
  const partes = [
    `--${fronteira}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      quebrar76(Buffer.from(String(texto || ''), 'utf8').toString('base64')),
    anexo ? `--${fronteira}\r\nContent-Type: application/pdf; name="${anexo.nome}"\r\nContent-Transfer-Encoding: base64\r\n` +
      `Content-Disposition: attachment; filename="${anexo.nome}"\r\n\r\n` + quebrar76(anexo.buf.toString('base64')) : null,
    `--${fronteira}--\r\n`
  ].filter(Boolean);
  return h + '\r\n\r\n' + partes.join('');
}

function conexaoSmtp(cfg) {
  return new Promise((ok, fail) => {
    let sock, buf = '', espera = null, erro = null;
    const ligar = s => {
      sock = s; s.setEncoding('utf8');
      s.on('data', d => { buf += d; conferir(); });
      s.on('error', e => { erro = e; if (espera) { const w = espera; espera = null; w.fail(e); } });
      s.on('close', () => { if (espera) { const w = espera; espera = null; w.fail(erro || new Error('Conexão SMTP encerrada')); } });
    };
    const conferir = () => {
      if (!espera) return;
      const linhas = buf.split('\r\n');
      for (let i = 0; i < linhas.length - 1; i++) {
        if (/^\d{3}(?: |$)/.test(linhas[i])) {
          const resp = linhas.slice(0, i + 1);
          buf = linhas.slice(i + 1).join('\r\n');
          const w = espera; espera = null;
          w.ok({ cod: +resp[i].slice(0, 3), texto: resp.join('\n') });
          return;
        }
      }
    };
    const ler = () => new Promise((o, f) => { if (erro) return f(erro); espera = { ok: o, fail: f }; conferir(); });
    const c = {
      ler,
      async cmd(linha, esperado) {
        sock.write(linha + '\r\n');
        const r = await ler();
        if (![].concat(esperado).includes(r.cod)) {
          const visivel = /^AUTH|^[A-Za-z0-9+/=]+$/.test(linha) ? '(autenticação)' : linha.slice(0, 40);
          throw new HttpErro(502, `Servidor de e-mail recusou ${visivel}: ${r.texto.slice(0, 200)}`);
        }
        return r;
      },
      async starttls() {
        await c.cmd('STARTTLS', 220);
        await new Promise((o, f) => {
          const s = tls.connect({ socket: sock, servername: cfg.host }, o);
          s.once('error', f); sock.removeAllListeners('data'); ligar(s);
        });
      },
      fechar() { try { sock.end('QUIT\r\n'); } catch (e) {} }
    };
    const s = cfg.secure ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : net.connect({ host: cfg.host, port: cfg.port });
    ligar(s);
    s.setTimeout(20000, () => s.destroy(new Error('Tempo esgotado no servidor de e-mail')));
    s.once(cfg.secure ? 'secureConnect' : 'connect', () => ok(c));
    s.once('error', fail);
  });
}

async function enviarEmail({ para, responderPara, assunto, texto, anexo }) {
  const cfg = configSmtp();
  if (!emailValido(para)) throw new HttpErro(400, 'E-mail do fornecedor inválido.');
  const c = await conexaoSmtp(cfg);
  try {
    let r = await c.ler(); if (r.cod !== 220) throw new HttpErro(502, 'Servidor de e-mail indisponível: ' + r.texto);
    r = await c.cmd('EHLO gestao-manutencao', 250);
    if (!cfg.secure && /STARTTLS/i.test(r.texto)) { await c.starttls(); await c.cmd('EHLO gestao-manutencao', 250); }
    await c.cmd('AUTH LOGIN', 334);
    await c.cmd(Buffer.from(cfg.user).toString('base64'), 334);
    try { await c.cmd(Buffer.from(cfg.pass).toString('base64'), 235); }
    catch (e) { throw new HttpErro(502, 'Usuário ou senha de app do e-mail recusados. Confira SMTP_USER e SMTP_PASS na Vercel.'); }
    await c.cmd(`MAIL FROM:<${cfg.user}>`, 250);
    await c.cmd(`RCPT TO:<${para}>`, [250, 251]);
    await c.cmd('DATA', 354);
    const msg = montarMensagem({ de: cfg.user, nomeDe: cfg.nomeRemetente, para, responderPara: emailValido(responderPara) ? responderPara : '', assunto, texto, anexo })
      .replace(/\r\n\./g, '\r\n..');
    r = await c.cmd(msg + '\r\n.', 250);
    return r.texto;
  } finally { c.fechar(); }
}

function tratarErro(res, e) {
  const status = e instanceof HttpErro ? e.status : 500;
  if (status >= 500) console.error(e);
  json(res, status, { ok: false, erro: e instanceof HttpErro ? e.message : 'Erro interno no servidor.' });
}

module.exports = { HttpErro, cors, json, lerCorpo, verificarUsuario, validarPdf, rtdb, enviarEmail, emailValido, semQuebra, tratarErro, montarMensagem };
