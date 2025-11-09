
self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open('turf-cache-v1').then(cache=> cache.addAll([
    './', './index.html', './styles/styles.css',
    './scripts/app.js', './data/site.json'
  ])));
});
self.addEventListener('fetch', (e)=>{
  e.respondWith(caches.match(e.request).then(resp=> resp || fetch(e.request)));
});
