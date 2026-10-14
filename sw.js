/* 库存看板 Service Worker：network-first 缓存。
 * 优先走网络（保证 ?v= 版本更新立即生效），离线时回退缓存；不预缓存业务数据。 */
var CACHE = 'ks-dashboard-v1';

self.addEventListener('install', function (e) { self.skipWaiting(); });

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(function (resp) {
      if (resp && resp.status === 200 && resp.type === 'basic') {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return resp;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        /* 离线且无缓存时，导航请求回退首页 */
        if (req.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
