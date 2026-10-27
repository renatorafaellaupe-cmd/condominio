/* Service worker do aplicativo de Gestão de Manutenção de Condomínios.
   - index.html: sempre busca a versão mais nova na internet; sem conexão, usa a cópia salva.
   - ícones e manifesto: usa a cópia salva.
   - Firebase, mapas e bibliotecas externas não passam por aqui (vão direto para a internet).
   Ao publicar uma nova versão do sistema, troque o número de VERSAO abaixo. */
const VERSAO = 'gm-cond-v2';
const ARQUIVOS = ['./index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin) return;
  if (r.mode === 'navigate' || u.pathname.endsWith('.html') || u.pathname.endsWith('/')) {
    e.respondWith(
      fetch(r).then(res => {
        if (res.ok) { const c = res.clone(); caches.open(VERSAO).then(x => x.put('./index.html', c)); }
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }
  e.respondWith(caches.match(r).then(m => m || fetch(r)));
});
