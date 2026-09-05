const CACHE = 'rallymaker-roadbook-v3-20260905b';
const SHELL = ['./', './index.html', './styles.css', './app.js', './editor.js', './note-media.js', './icons.js', './store.js', './manifest.webmanifest', './icon.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(path => new Request(path, {cache:'reload'}))))));
// A new release waits until existing app tabs close; never mix new HTML with old JS.
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('rallymaker-roadbook-') && key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(new URL('./index.html', self.location).href)).then(cached => cached || fetch(event.request)));
  } else if (SHELL.some(path => new URL(path, self.location).href === event.request.url)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
