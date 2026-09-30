// Service worker do delivery: mostra os avisos do andamento do pedido (Web Push) e abre o pedido no toque.
// O servidor (função "push" do Supabase) manda { title, body, url } quando a equipe muda a situação.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Seu pedido', {
    body: d.body || 'O andamento do seu pedido mudou.',
    icon: '/admin/icons/icon-192.png',
    badge: '/assets/img/icon-64.png',
    tag: d.tag || 'pedido',
    renotify: true,
    data: { url: d.url || '/delivery/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/delivery/', self.location.origin).href;
  e.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mesma = abertas.find((c) => c.url === url) || abertas.find((c) => new URL(c.url).pathname.startsWith('/delivery/'));
    if (mesma) {
      if (mesma.url !== url && 'navigate' in mesma) await mesma.navigate(url).catch(() => {});
      return mesma.focus();
    }
    return self.clients.openWindow(url);
  })());
});
