const CACHE_NAME = 'buddy-cache-v12';
const ANIMAL_IDS = [
  'cat', 'dog', 'rabbit', 'sheep', 'fox', 'deer', 'cow', 'horse',
  'owl', 'penguin', 'seal', 'polarbear',
  'seahorse', 'octopus', 'turtle', 'shark', 'orca',
  'parrot', 'toucan', 'flamingo', 'dolphin',
];
const FONT_FILES = [
  'styrene-light.woff2', 'styrene-light.woff',
  'styrene-regular.woff2', 'styrene-regular.woff',
  'styrene-medium.woff2', 'styrene-medium.woff',
  'styrene-bold.woff2', 'styrene-bold.woff',
];
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/store.js',
  './js/pet-render.js',
  './js/species-data.js',
  './js/habits-data.js',
  './js/notifications.js',
  './js/sound.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './assets/ui/coin.png',
  ...ANIMAL_IDS.map(id => `./assets/animals/${id}.png`),
  ...FONT_FILES.map(f => `./assets/fonts/${f}`),
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// One retry absorbs a transient blip (flaky wifi, or a dev server briefly
// overwhelmed by a burst of concurrent requests) instead of failing outright.
function fetchWithRetry(request, retries = 1) {
  return fetch(request).catch((err) => {
    if (retries > 0) return fetchWithRetry(request, retries - 1);
    throw err;
  });
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Serve the cached copy instantly; refresh it in the background for next time.
        fetchWithRetry(event.request)
          .then((resp) => {
            if (resp && resp.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resp));
          })
          .catch(() => {});
        return cached;
      }
      // respondWith() must always resolve to a Response — never fall through to
      // undefined, or the browser reports a hard, unrecoverable net::ERR_FAILED.
      return fetchWithRetry(event.request)
        .then((resp) => {
          if (resp && resp.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resp.clone()));
          }
          return resp;
        })
        .catch(() => new Response('Offline and not yet cached', { status: 503, statusText: 'Service Unavailable' }));
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});

// --- Best-effort background check-in (Chrome/Android installed PWAs only) ---

function readState() {
  return new Promise((resolve) => {
    const req = indexedDB.open('buddy-db', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('kv', 'readonly');
        const getReq = tx.objectStore('kv').get('state');
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    };
    req.onerror = () => resolve(null);
  });
}

function writeState(state) {
  return new Promise((resolve) => {
    const req = indexedDB.open('buddy-db', 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(state, 'state');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    };
    req.onerror = () => resolve();
  });
}

function withinWindow(now, startHHMM, endHHMM) {
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end;
}

const HUNGER_FULL_DECAY_HOURS = 14;
const JOY_BASE_FULL_DECAY_HOURS = 30;
const JOY_EXTRA_FULL_DECAY_HOURS = 10;

function applyDecay(state) {
  const now = Date.now();
  const minutes = Math.max(0, (now - state.lastTickAt) / 60000);
  let hunger = state.pet.hunger;
  let joy = state.pet.joy;
  const hRate = 100 / (HUNGER_FULL_DECAY_HOURS * 60);
  const jBase = 100 / (JOY_BASE_FULL_DECAY_HOURS * 60);
  const jExtra = 100 / (JOY_EXTRA_FULL_DECAY_HOURS * 60);
  let remaining = minutes;
  const stepMin = 15;
  while (remaining > 0) {
    const step = Math.min(stepMin, remaining);
    hunger = Math.max(0, hunger - hRate * step);
    let jr = jBase;
    if (hunger < 30) jr += jExtra;
    joy = Math.max(0, joy - jr * step);
    remaining -= step;
  }
  state.pet.hunger = hunger;
  state.pet.joy = joy;
  state.lastTickAt = now;
  return state;
}

async function backgroundCheckin() {
  const state = await readState();
  if (!state || !state.settings || !state.settings.notificationsEnabled) return;

  applyDecay(state);
  const now = new Date();
  if (!withinWindow(now, state.settings.reminderStart, state.settings.reminderEnd)) return;

  const sinceLast = Date.now() - (state.settings.lastNotifiedAt || 0);
  const minGapMs = state.settings.reminderIntervalHours * 3600 * 1000;
  if (sinceLast < minGapMs) return;

  const needsAttention = state.pet.hunger < 45 || state.pet.joy < 45;
  if (!needsAttention) {
    await writeState(state);
    return;
  }

  await self.registration.showNotification(`${state.pet.name} зовёт тебя`, {
    body: `${state.pet.name} немного заскучал(а). Загляни в приложение 🐾`,
    tag: 'buddy-checkin',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
  });

  state.settings.lastNotifiedAt = Date.now();
  await writeState(state);
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'buddy-checkin') {
    event.waitUntil(backgroundCheckin());
  }
});

// Some browsers support one-off background sync as a fallback trigger point.
self.addEventListener('sync', (event) => {
  if (event.tag === 'buddy-checkin') {
    event.waitUntil(backgroundCheckin());
  }
});
