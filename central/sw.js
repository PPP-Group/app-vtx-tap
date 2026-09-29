/*
 * Service worker da central (VTX Tap Master), publicado em /master-sw.js.
 * Arquivos do site: rede primeiro, com cópia para abrir sem internet.
 * Fontes e bibliotecas externas: cópia guardada, atualizada em segundo plano.
 * Dados do servidor (Supabase) nunca passam pelo cache.
 */
const VERSAO = 'master-v1';
const INICIO = '/master';
const BASE = [
  INICIO,
  '/assets/css/base.css',
  '/central/central.css',
  '/assets/js/ui.js',
  '/central/central.js',
  '/central/placa.js',
  '/assets/img/vtx-tap.png',
  '/assets/img/vtx-tap-escuro.png',
  '/admin/icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(BASE)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('master-') && k !== VERSAO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const EXTERNOS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // Só o que a central usa; a página de preços e as plaquinhas seguem direto pela rede.
    if (url.pathname === '/' || url.pathname.startsWith('/t/') || url.pathname === '/master-sw.js') return;
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copia = res.clone();
            caches.open(VERSAO).then((c) => c.put(req, copia));
          }
          return res;
        })
        .catch(async () => (await caches.match(req, { ignoreSearch: true }))
          || (req.mode === 'navigate' ? caches.match(INICIO) : Response.error())),
    );
    return;
  }

  if (EXTERNOS.includes(url.hostname)) {
    e.respondWith(
      caches.open(VERSAO).then(async (c) => {
        const guardado = await c.match(req);
        const rede = fetch(req)
          .then((res) => {
            if (res.ok || res.type === 'opaque') c.put(req, res.clone());
            return res;
          })
          .catch(() => guardado);
        return guardado || rede;
      }),
    );
  }
});
