// service worker для studyflow
// bump SW_VERSION при каждом обновлении index.html, чтобы клиент подхватил новую версию

const SW_VERSION = 'v1.0.5';
const APP_CACHE = `studyflow-app-${SW_VERSION}`;
const RUNTIME_CACHE = `studyflow-runtime-${SW_VERSION}`;
const CDN_CACHE = `studyflow-cdn-${SW_VERSION}`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './offline.html',
  './manifest.json',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png'
];

// --- Никогда не кешируем: API и auth, иначе можно получить stale-данные ---
const NEVER_CACHE_PATTERNS = [
  'supabase.co/rest',
  'supabase.co/auth',
  'supabase.co/functions',
  'supabase.co/realtime',
  'supabase.co/storage/v1/object/authenticated'
];

// --- CDN: stale-while-revalidate (быстро отдаём кеш, фоново обновляем) ---
const CDN_PATTERNS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com'
];

// --- INSTALL ---
self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      try {
        await cache.addAll(PRECACHE_URLS);
      } catch (err) {
        console.warn('[SW] precache partial fail:', err);
        // кешируем по одному, чтобы не упасть из-за одного 404
        for (const url of PRECACHE_URLS) {
          try { await cache.add(url); } catch {}
        }
      }
      await self.skipWaiting();
    })()
  );
});

// --- ACTIVATE: чистим старые кеши + берём контроль над всеми вкладками ---
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(key => key.startsWith('studyflow-') && !key.endsWith(SW_VERSION))
          .map(key => caches.delete(key))
      );
      await self.clients.claim();

      // уведомляем уже открытые вкладки: можно показать «перезагрузить»
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(client => {
        client.postMessage({ type: 'SW_UPDATED', version: SW_VERSION });
      });
    })()
  );
});

// --- FETCH: роутинг по стратегиям ---
self.addEventListener('fetch', event => {
  const req = event.request;

  // Только GET — POST/PUT к Supabase идут напрямую
  if (req.method !== 'GET') return;

  // Только http(s) — отсекаем chrome-extension://, data:, blob: и т.д.
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Supabase API — не перехватываем вообще
  if (NEVER_CACHE_PATTERNS.some(p => req.url.includes(p))) return;

  // Запросы с явным запретом кэша (например, проверка связи из offline.html) не берём из кэша
  if (req.cache === 'no-store') {
    event.respondWith(fetch(req));
    return;
  }

  // HTML-навигация (открытие страницы, переход по ссылке)
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigate(req));
    return;
  }

  // CDN (шрифты, supabase-js, xlsx) — stale-while-revalidate
  if (CDN_PATTERNS.some(p => req.url.includes(p))) {
    event.respondWith(staleWhileRevalidate(req, CDN_CACHE));
    return;
  }

  // Всё остальное (иконки, manifest, локальные картинки) — cache-first
  event.respondWith(cacheFirst(req, RUNTIME_CACHE));
});

// --- MESSAGE: принудительный skipWaiting по запросу клиента ---
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ==========================================================================
// Стратегии
// ==========================================================================

// Network-first: свежий HTML, при офлайне — кеш, при полном провале — offline.html
async function networkFirstNavigate(req) {
  try {
    const fresh = await fetch(req);
    const cache = await caches.open(APP_CACHE);
    cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const cached = (await caches.match(req, { ignoreSearch: true }))
      || (await caches.match('./index.html'))
      || (await caches.match('./'));
    if (cached) return cached;
    const offline = await caches.match('./offline.html');
    if (offline) return offline;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>офлайн</title>' +
      '<body style="background:#090b14;color:#f0f3fa;font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0">' +
      '<p>нет подключения</p></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

// Stale-while-revalidate: моментально отдаём кеш, параллельно обновляем
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);

  const networkPromise = fetch(req)
    .then(res => {
      // opaque-ответы (no-cors к fonts.gstatic) тоже валидны
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => null);

  return cached || (await networkPromise) || new Response('', { status: 504 });
}

// Cache-first: сначала ищем в кеше, если нет — сеть + кладём в кеш
async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;

  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    return new Response('', { status: 504 });
  }
}