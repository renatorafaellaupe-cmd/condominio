/* POST /api/enviar-email — envia o Termo de Referência por e-mail, com o PDF anexado */
const L = require('./_lib');

module.exports = async (req, res) => {
  if (L.cors(req, res)) return;
  try {
    if (req.method !== 'POST') throw new L.HttpErro(405, 'Use POST.');
    const usuario = await L.verificarUsuario(req);
    const b = await L.lerCorpo(req);
    const para = String(b.para || '').trim();
    if (!L.emailValido(para)) throw new L.HttpErro(400, 'E-mail do fornecedor inválido.');
    const assunto = L.semQuebra(b.assunto || 'Solicitação de proposta').slice(0, 200);
    const texto = String(b.texto || '').slice(0, 20000);
    const anexo = L.validarPdf(b.pdf);
    const resposta = await L.enviarEmail({ para, responderPara: usuario.email, assunto, texto, anexo });
    L.json(res, 200, { ok: true, para, resposta: String(resposta).slice(0, 200) });
  } catch (e) { L.tratarErro(res, e); }
};
