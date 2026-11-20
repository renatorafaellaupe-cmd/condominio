/* POST /api/termo-link — guarda o PDF do Termo de Referência e devolve um link para enviar pelo WhatsApp */
const crypto = require('crypto');
const L = require('./_lib');

module.exports = async (req, res) => {
  if (L.cors(req, res)) return;
  try {
    if (req.method !== 'POST') throw new L.HttpErro(405, 'Use POST.');
    const usuario = await L.verificarUsuario(req);
    const b = await L.lerCorpo(req);
    const { buf, nome } = L.validarPdf(b.pdf);
    const id = crypto.randomBytes(18).toString('base64url'); // 24 caracteres, impossível de adivinhar
    await L.rtdb('PUT', `manutencao_termos/${id}`, {
      nome, numero: L.semQuebra(b.numero).slice(0, 40), tarefaId: L.semQuebra(b.tarefaId).slice(0, 60),
      pdf: buf.toString('base64'), criadoEm: new Date().toISOString(), por: usuario.uid
    });
    const base = (process.env.PUBLIC_BASE_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/+$/, '');
    L.json(res, 200, { ok: true, url: `${base}/api/termo?id=${id}` });
  } catch (e) { L.tratarErro(res, e); }
};
