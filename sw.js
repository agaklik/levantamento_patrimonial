// Service Worker - Levantamento Patrimonial
// Cache simples para permitir instalação como app e abertura offline da casca.
const CACHE = 'levpat-v1';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

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
    fetch(req).then(res => {
      // atualiza o cache da casca em segundo plano
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
