import { getState, updateSettings, applyDecay } from './store.js';

let swRegistration = null;

export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    swRegistration = await navigator.serviceWorker.register('./sw.js');
    return swRegistration;
  } catch (e) {
    console.warn('SW registration failed', e);
    return null;
  }
}

export function isSupported() {
  return 'Notification' in window;
}

export async function requestPermission() {
  if (!isSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  const result = await Notification.requestPermission();
  return result;
}

async function show(title, body, tag) {
  if (!isSupported() || Notification.permission !== 'granted') return;
  if (swRegistration && swRegistration.showNotification) {
    swRegistration.showNotification(title, {
      body,
      tag,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      renotify: false,
    });
  } else {
    new Notification(title, { body, icon: 'icons/icon-192.png' });
  }
}

function withinWindow(now, startHHMM, endHHMM) {
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end; // window wraps past midnight
}

const FLAVOR = [
  n => `${n} немного проголодался... 🍎`,
  n => `${n} скучает по тебе. Загляни на минутку?`,
  n => `${n} смотрит на дверь и ждёт тебя 🐾`,
  n => `Пять минут дела — и ${n} снова счастлив!`,
];

export function maybeNotify() {
  const s = getState();
  if (!s.settings.notificationsEnabled) return;
  if (Notification.permission !== 'granted') return;

  applyDecay();
  const now = new Date();
  if (!withinWindow(now, s.settings.reminderStart, s.settings.reminderEnd)) return;

  const sinceLast = Date.now() - (s.settings.lastNotifiedAt || 0);
  const minGapMs = s.settings.reminderIntervalHours * 3600 * 1000;
  if (sinceLast < minGapMs) return;

  const needsAttention = s.pet.hunger < 45 || s.pet.joy < 45;
  if (!needsAttention) return;

  const line = FLAVOR[Math.floor(Math.random() * FLAVOR.length)](s.pet.name);
  show(`${s.pet.name} зовёт тебя`, line, 'buddy-checkin');
  updateSettings({ lastNotifiedAt: Date.now() });
}

let foregroundTimer = null;
export function startForegroundScheduler() {
  if (foregroundTimer) return;
  foregroundTimer = setInterval(maybeNotify, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeNotify();
  });
}

export async function sendTestNotification() {
  const s = getState();
  await show(`${s.pet.name} машет лапой 👋`, 'Так будут выглядеть напоминания.', 'buddy-test');
}

export async function tryRegisterPeriodicSync() {
  if (!swRegistration || !('periodicSync' in swRegistration)) return false;
  try {
    const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (status.state !== 'granted') return false;
    await swRegistration.periodicSync.register('buddy-checkin', {
      minInterval: 60 * 60 * 1000,
    });
    return true;
  } catch (e) {
    return false;
  }
}
