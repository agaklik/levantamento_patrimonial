// Service Worker - Levantamento Patrimonial
// Cache simples para permitir instalação como app e abertura offline da casca.
const CACHE = 'levpat-v45';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './vendor/archivo.woff2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // só GET; chamadas ao Supabase sempre vão à rede
  if (req.method !== 'GET' || req.url.includes('supabase')) return;
  e.respondWith(
    // arquivos do próprio app: pede sempre a versão nova ao servidor (ignora o cache de 10 min do GitHub Pages)
    (new URL(req.url).origin === self.location.origin ? fetch(req.url, {cache: 'no-cache', credentials: 'same-origin'}) : fetch(req)).then(res => {
      // atualiza o cache da casca em segundo plano
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});

// ---------- notificações (avisos do painel e do sistema) ----------
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { texto: e.data ? e.data.text() : '' }; }
  const titulo = d.titulo || 'Levantamento Patrimonial';
  e.waitUntil((async () => {
    await self.registration.showNotification(titulo, {
      body: d.texto || '', icon: 'icon-192.png', badge: 'icon-192.png', lang: 'pt-BR',
      tag: d.id ? 'aviso-' + d.id : undefined, data: { url: d.url || './#avisos' },
    });
    // avisa o app aberto para atualizar o contador
    const abertos = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    abertos.forEach(c => c.postMessage({ tipo: 'aviso', id: d.id }));
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './#avisos', self.registration.scope).href;
  e.waitUntil((async () => {
    const abertos = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = abertos.find(c => c.url.startsWith(self.registration.scope) && !c.url.includes('admin.html'));
    if (app) { app.postMessage({ tipo: 'abrir', url }); return app.focus(); }
    return self.clients.openWindow(url);
  })());
});
