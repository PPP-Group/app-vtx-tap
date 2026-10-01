/*
 * Service worker do painel da equipe.
 * Páginas e arquivos do site: busca na rede primeiro e guarda uma cópia para abrir sem internet.
 * Fontes e bibliotecas externas: usa a cópia guardada e atualiza em segundo plano.
 * Dados do servidor (Supabase) nunca passam pelo cache.
 * Manifesto e ícones do app com o nome e a logo do restaurante: vêm do cache 'painel-marca',
 * que o painel preenche (assets/js/admin.js, marcaDoApp).
 */
const VERSAO = 'painel-v7';
const MARCA = 'painel-marca';
const BASE = [
  '/admin/',
  '/assets/css/base.css',
  '/assets/css/admin.css',
  '/assets/css/campos.css',
  '/assets/js/config.js',
  '/assets/js/store.js',
  '/assets/js/ui.js',
  '/assets/js/campos.js',
  '/assets/js/admin.js',
  '/admin/icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(BASE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO && k !== MARCA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const EXTERNOS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin && (url.pathname === '/admin/manifest.webmanifest' || url.pathname.startsWith('/admin/icons/marca-'))) {
    e.respondWith(caches.open(MARCA).then((c) => c.match(url.pathname)).then((r) => r || fetch(req)));
    return;
  }

  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && url.pathname !== '/admin/sw.js') {
            const copia = res.clone();
            caches.open(VERSAO).then((c) => c.put(req, copia));
          }
          return res;
        })
        .catch(async () => (await caches.match(req, { ignoreSearch: true }))
          || (req.mode === 'navigate' ? caches.match('/admin/') : Response.error())),
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

// Toque na notificação: volta para o painel aberto ou abre um novo.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      const aberto = lista.find((c) => new URL(c.url).pathname.startsWith('/admin'));
      if (aberto) return aberto.focus();
      return self.clients.openWindow('/admin/#chamados');
    }),
  );
});
