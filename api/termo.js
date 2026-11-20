/* GET /api/termo?id=... — abre o PDF do Termo de Referência enviado ao fornecedor */
const L = require('./_lib');
const VALIDADE_DIAS = +(process.env.TERMO_VALIDADE_DIAS || 180);

function pagina(res, status, titulo, msg) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.end(`<!DOCTYPE html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#14202B"><h2>${titulo}</h2><p>${msg}</p></body></html>`);
}

module.exports = async (req, res) => {
  try {
    const id = String((req.query && req.query.id) || new URL(req.url, 'http://x').searchParams.get('id') || '');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) return pagina(res, 404, 'Link inválido', 'Confira se o link foi copiado por inteiro.');
    const t = await L.rtdb('GET', `manutencao_termos/${id}`);
    if (!t || !t.pdf) return pagina(res, 404, 'Termo não encontrado', 'Este Termo de Referência não está mais disponível. Peça um novo envio ao condomínio.');
    if (t.criadoEm && Date.now() - Date.parse(t.criadoEm) > VALIDADE_DIAS * 864e5)
      return pagina(res, 410, 'Link expirado', 'Este link venceu. Peça um novo envio do Termo de Referência ao condomínio.');
    const buf = Buffer.from(t.pdf, 'base64');
    const nome = String(t.nome || 'Termo_de_Referencia.pdf').replace(/[^\w.\-]+/g, '_');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Content-Disposition', `inline; filename="${nome}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.end(buf);
  } catch (e) {
    console.error(e);
    pagina(res, e.status === 503 ? 503 : 500, 'Indisponível no momento', 'Não foi possível abrir o Termo de Referência agora. Tente novamente em alguns minutos.');
  }
};
