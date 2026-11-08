// 오프라인에서도 열리도록 파일을 저장해 두는 서비스 워커.
// 항상 인터넷의 최신 파일을 먼저 쓰고, 인터넷이 안 될 때만 저장본을 써요.
const CACHE = 'tabmaker-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const c = r.clone(); caches.open(CACHE).then(cc => cc.put(e.request, c)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
