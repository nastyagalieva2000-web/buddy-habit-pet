// Central state: persisted to localStorage, mirrored to IndexedDB so the
// service worker can read it in the background (localStorage isn't visible there).
import { DEFAULT_HABITS, isoWeekday } from './habits-data.js';
import { SPECIES, STARTER_SPECIES, getSpecies } from './species-data.js';

export const TREAT_COST = 25;

const STORAGE_KEY = 'buddy-state-v1';

const HUNGER_FULL_DECAY_HOURS = 14;   // 100 -> 0 over this many hours
const JOY_BASE_FULL_DECAY_HOURS = 30; // 100 -> 0 over this many hours (base rate)
const JOY_EXTRA_FULL_DECAY_HOURS = 10; // extra decay applied on top when hunger < 30

const HUNGER_RATE_PER_MIN = 100 / (HUNGER_FULL_DECAY_HOURS * 60);
const JOY_BASE_RATE_PER_MIN = 100 / (JOY_BASE_FULL_DECAY_HOURS * 60);
const JOY_EXTRA_RATE_PER_MIN = 100 / (JOY_EXTRA_FULL_DECAY_HOURS * 60);

function defaultState() {
  const now = Date.now();
  return {
    version: 3,
    pet: {
      name: 'Бадди',
      species: STARTER_SPECIES[0],
      hunger: 100,
      joy: 100,
      lifetimeActions: 0,
      createdAt: now,
    },
    lastTickAt: now,
    coins: 0,
    streak: { count: 0, best: 0, lastCompletionDate: null, penalizedForDate: null },
    habits: DEFAULT_HABITS.map(h => ({ ...h })),
    log: [],                // { id, habitId, emoji, label, ts, minutes }
    unlockedSpecies: [...STARTER_SPECIES],
    excusedHabits: { weekStart: null, habitIds: [] },
    health: { sick: false, sickHabits: [], badWeeksInRow: 0 },
    weeklyReview: { lastReviewedWeekStart: null },
    settings: {
      notificationsEnabled: false,
      reminderStart: '09:00',
      reminderEnd: '22:00',
      reminderIntervalHours: 3,
      lastNotifiedAt: 0,
      soundEnabled: true,
    },
  };
}

function migrate(state) {
  const d = defaultState();
  const habits = (state.habits || d.habits).map(h => {
    const def = DEFAULT_HABITS.find(dh => dh.id === h.id);
    // Built-in habits keep the user's target/progress, but re-sync their format
    // (days, mode, durations, note) from the current defaults whenever it changes in code.
    return def ? { ...h, pinnedDays: def.pinnedDays, mode: def.mode, durations: def.durations || [], note: def.note || null } : h;
  });

  let unlockedSpecies = state.unlockedSpecies || [...STARTER_SPECIES];
  let petSpecies = state.pet && state.pet.species;
  if (!petSpecies || !SPECIES.some(s => s.id === petSpecies)) {
    // Older/unknown species id (e.g. a retired procedural pet) — fall back to a starter.
    petSpecies = STARTER_SPECIES[0];
  }
  if (!unlockedSpecies.includes(petSpecies)) unlockedSpecies = [...unlockedSpecies, petSpecies];

  return {
    ...d,
    ...state,
    pet: { ...d.pet, ...(state.pet || {}), species: petSpecies },
    streak: { ...d.streak, ...(state.streak || {}) },
    settings: { ...d.settings, ...(state.settings || {}) },
    excusedHabits: { ...d.excusedHabits, ...(state.excusedHabits || {}) },
    health: { ...d.health, ...(state.health || {}) },
    weeklyReview: { ...d.weeklyReview, ...(state.weeklyReview || {}) },
    habits,
    unlockedSpecies,
    log: state.log || [],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return migrate(JSON.parse(raw));
  } catch (e) {
    console.warn('state load failed', e);
    return defaultState();
  }
}

let state = load();
const listeners = new Set();
const eventListeners = new Set();

function notify() {
  for (const fn of listeners) fn(state);
}

export function onEvent(fn) {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

function emit(type, payload) {
  for (const fn of eventListeners) fn(type, payload);
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('state save failed', e);
  }
  mirrorToIndexedDB(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState() {
  return state;
}

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const iso = isoWeekday(d);
  d.setDate(d.getDate() - (iso - 1));
  return d; // local midnight Monday
}

// { start: Date, end: Date } for the calendar week containing `date`, offset by whole weeks.
function weekRange(date = new Date(), offsetWeeks = 0) {
  const start = mondayOf(date);
  start.setDate(start.getDate() + offsetWeeks * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

// Applies time-based decay since the last tick. Call on load and periodically.
export function applyDecay(nowTs = Date.now()) {
  const minutes = Math.max(0, (nowTs - state.lastTickAt) / 60000);
  if (minutes <= 0) {
    state.lastTickAt = nowTs;
    return;
  }
  let hunger = state.pet.hunger;
  let joy = state.pet.joy;

  // Integrate decay in small steps so the joy-extra-penalty threshold is respected reasonably.
  let remaining = minutes;
  const stepMin = 15;
  while (remaining > 0) {
    const step = Math.min(stepMin, remaining);
    hunger = Math.max(0, hunger - HUNGER_RATE_PER_MIN * step);
    let joyRate = JOY_BASE_RATE_PER_MIN;
    if (hunger < 30) joyRate += JOY_EXTRA_RATE_PER_MIN;
    joy = Math.max(0, joy - joyRate * step);
    remaining -= step;
  }

  state.pet.hunger = Math.round(hunger * 10) / 10;
  state.pet.joy = Math.round(joy * 10) / 10;
  state.lastTickAt = nowTs;
}

// Detects days that passed with zero care and applies a one-time penalty per gap,
// so ignoring the pet for a day has a real, noticeable cost (not just slow decay).
function checkNeglect() {
  if (!state.streak.lastCompletionDate) return;
  const today = todayStr();
  if (state.streak.penalizedForDate === today) return;
  if (state.streak.lastCompletionDate === today) return;

  const last = new Date(state.streak.lastCompletionDate + 'T00:00:00');
  const now = new Date(today + 'T00:00:00');
  const gapDays = Math.round((now - last) / 86400000);

  if (gapDays >= 2 && state.streak.count > 0) {
    const missed = gapDays - 1;
    state.streak.count = 0;
    state.pet.joy = Math.max(0, state.pet.joy - 15);
    state.streak.penalizedForDate = today;
    emit('streak-broken', { missed });
  }
}

function habitCountInRange(habitId, start, end) {
  const s = start.getTime(), e = end.getTime();
  let n = 0;
  for (const entry of state.log) {
    if (entry.habitId === habitId && entry.ts >= s && entry.ts < e) n++;
  }
  return n;
}

const STAGE_ORDER = ['egg', 'baby', 'teen', 'adult'];
// lifetimeActions value to drop into when regressing INTO this stage from the one above.
const REGRESS_INTO = { egg: 0, baby: 2, teen: 10 };

function regressStage() {
  const stage = getStage().key;
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx <= 0) return null; // already an egg, nothing lower
  const toStage = STAGE_ORDER[idx - 1];
  state.pet.lifetimeActions = REGRESS_INTO[toStage];
  state.coins = Math.max(0, state.coins - 30);
  return { from: stage, to: toStage };
}

// Runs once per calendar week (checked every tick) to judge the week that just ended.
function performWeeklyReviewIfDue() {
  const thisMonday = mondayOf(new Date());
  const prevMonday = new Date(thisMonday);
  prevMonday.setDate(prevMonday.getDate() - 7);
  const prevKey = todayStr(prevMonday);

  if (state.weeklyReview.lastReviewedWeekStart === prevKey) return;
  if (prevMonday.getTime() < mondayOf(new Date(state.pet.createdAt)).getTime()) {
    // pet didn't exist for that whole week yet — nothing to judge
    state.weeklyReview.lastReviewedWeekStart = prevKey;
    return;
  }

  const prevEnd = new Date(prevMonday);
  prevEnd.setDate(prevEnd.getDate() + 7);

  const habits = state.habits;
  if (habits.length === 0) {
    state.weeklyReview.lastReviewedWeekStart = prevKey;
    return;
  }

  const excusedThisWeek = state.excusedHabits.weekStart === prevKey ? state.excusedHabits.habitIds : [];
  const results = habits.map(h => {
    if (excusedThisWeek.includes(h.id)) {
      return { habit: h, count: h.weeklyTarget, ratio: 1, excused: true };
    }
    const count = habitCountInRange(h.id, prevMonday, prevEnd);
    return { habit: h, count, ratio: h.weeklyTarget > 0 ? count / h.weeklyTarget : 1 };
  });

  const failed = results.filter(r => r.ratio < 0.5);
  const allMet = results.every(r => r.ratio >= 1);

  if (allMet) {
    state.coins += 25;
    state.pet.joy = Math.min(100, state.pet.joy + 10);
    state.health.badWeeksInRow = 0;
    if (state.health.sick) { state.health.sick = false; state.health.sickHabits = []; }
    emit('week-perfect', {});
  } else if (failed.length === 0) {
    // nobody badly failed, but not a perfect week either — no reward, no punishment
    state.health.badWeeksInRow = 0;
  } else if (failed.length === 1) {
    state.pet.joy = Math.max(0, state.pet.joy - 10);
    emit('week-strike', { habitTitle: failed[0].habit.title });
    state.health.badWeeksInRow = 0;
  } else {
    state.pet.joy = Math.max(0, state.pet.joy - 20);
    state.coins = Math.max(0, state.coins - 10);
    state.health.sick = true;
    state.health.sickHabits = Array.from(new Set([...state.health.sickHabits, ...failed.map(r => r.habit.id)]));
    state.health.badWeeksInRow += 1;
    emit('week-sick', { habitTitles: failed.map(r => r.habit.title) });

    if (state.health.badWeeksInRow >= 2) {
      const regression = regressStage();
      state.health.badWeeksInRow = 0;
      state.health.sick = false;
      state.health.sickHabits = [];
      if (regression) emit('pet-regressed', regression);
    }
  }

  state.weeklyReview.lastReviewedWeekStart = prevKey;
}

export function tick() {
  applyDecay();
  checkNeglect();
  performWeeklyReviewIfDue();
  persist();
  notify();
}

export function getStage() {
  const n = state.pet.lifetimeActions;
  if (n < 1) return { key: 'egg', label: 'яйцо' };
  if (n < 5) return { key: 'baby', label: 'малыш' };
  if (n < 20) return { key: 'teen', label: 'подросток' };
  return { key: 'adult', label: 'взрослый' };
}

export const STAGE_LABEL = { egg: 'яйцо', baby: 'малыш', teen: 'подросток', adult: 'взрослый' };

export function getMoodBand() {
  const avg = (state.pet.hunger + state.pet.joy) / 2;
  if (state.pet.hunger < 12) return 'starving';
  if (avg >= 70) return 'happy';
  if (avg >= 40) return 'neutral';
  if (avg >= 15) return 'sad';
  return 'cry';
}

function bumpStreak() {
  const today = todayStr();
  if (state.streak.lastCompletionDate === today) return; // already counted today
  const yesterday = todayStr(new Date(Date.now() - 86400000));
  if (state.streak.lastCompletionDate === yesterday) {
    state.streak.count += 1;
  } else {
    state.streak.count = 1;
  }
  state.streak.lastCompletionDate = today;
  state.streak.penalizedForDate = null;
  if (state.streak.count > state.streak.best) state.streak.best = state.streak.count;
}

// Core reward function used by every completed habit.
function feedPet({ hungerAmt = 22, joyAmt = 14, coinAmt = 6 }) {
  applyDecay();
  state.pet.hunger = Math.min(100, state.pet.hunger + hungerAmt);
  state.pet.joy = Math.min(100, state.pet.joy + joyAmt);
  state.pet.lifetimeActions += 1;
  state.coins += coinAmt;
  bumpStreak();
  return { coins: coinAmt };
}

export function completeHabit(habitId, { minutes = 0 } = {}) {
  const habit = state.habits.find(h => h.id === habitId);
  if (!habit) return null;

  const hungerAmt = 16 + Math.min(10, Math.round(minutes / 5));
  const joyAmt = 10 + Math.min(10, Math.round(minutes / 6));
  const coinAmt = Math.max(5, Math.round((minutes || 10) / 2));
  const result = feedPet({ hungerAmt, joyAmt, coinAmt });

  state.log.unshift({ id: cryptoId(), habitId, emoji: habit.emoji, label: habit.title, ts: Date.now(), minutes });
  state.log = state.log.slice(0, 300);

  if (state.health.sick && state.health.sickHabits.includes(habitId)) {
    state.health.sickHabits = state.health.sickHabits.filter(id => id !== habitId);
    if (state.health.sickHabits.length === 0) {
      state.health.sick = false;
      emit('pet-cured', {});
    }
  }

  persist();
  notify();
  return result;
}

export function addHabit({ title, emoji = '✨', weeklyTarget = 3, mode = 'check', durations = [], pinnedDays = [] }) {
  const trimmed = title.trim();
  if (!trimmed) return;
  state.habits.push({
    id: 'custom-' + cryptoId(),
    title: trimmed.slice(0, 40),
    emoji,
    weeklyTarget: Math.max(1, Math.min(14, Math.round(weeklyTarget))),
    mode,
    durations,
    pinnedDays,
  });
  persist();
  notify();
}

export function removeHabit(id) {
  state.habits = state.habits.filter(h => h.id !== id);
  state.health.sickHabits = state.health.sickHabits.filter(hid => hid !== id);
  persist();
  notify();
}

export function updateHabitTarget(id, weeklyTarget) {
  const habit = state.habits.find(h => h.id === id);
  if (!habit) return;
  habit.weeklyTarget = Math.max(1, Math.min(14, Math.round(weeklyTarget)));
  persist();
  notify();
}

// Count of completions for `habit` in the current calendar week (Mon..Sun).
export function getHabitWeekCount(habitId, offsetWeeks = 0) {
  const { start, end } = weekRange(new Date(), offsetWeeks);
  return habitCountInRange(habitId, start, end);
}

export function isPinnedToday(habit) {
  return habit.pinnedDays && habit.pinnedDays.includes(isoWeekday());
}

// A "flexible" habit (no fixed days) becomes urgent once the remaining count
// can no longer be spread over the days left in the week — i.e. skipping today
// would make the weekly target mathematically impossible to hit.
export function isUrgentToday(habit) {
  if (habit.pinnedDays && habit.pinnedDays.length > 0) return false;
  const remaining = habit.weeklyTarget - getHabitWeekCount(habit.id);
  if (remaining <= 0) return false;
  const daysLeft = 8 - isoWeekday(); // today counts as 1 of the remaining days
  return remaining >= daysLeft;
}

// Habits worth surfacing today: pinned-to-today first, then urgent flexible ones.
export function getTodayHabits() {
  const pinned = state.habits.filter(h => isPinnedToday(h));
  const urgent = state.habits.filter(h => isUrgentToday(h));
  return { pinned, urgent };
}

export function isSpeciesUnlocked(id) {
  return state.unlockedSpecies.includes(id);
}

// Spend coins to permanently unlock a new animal, then switch to it right away.
export function unlockSpecies(id) {
  if (state.unlockedSpecies.includes(id)) return false;
  const sp = getSpecies(id);
  if (state.coins < sp.cost) return false;
  state.coins -= sp.cost;
  state.unlockedSpecies.push(id);
  state.pet.species = id;
  persist();
  notify();
  emit('species-unlocked', { species: sp });
  return true;
}

export function setSpecies(species) {
  if (!state.unlockedSpecies.includes(species)) return;
  state.pet.species = species;
  persist();
  notify();
}

// Spend coins to excuse one habit from this week's review — it counts as met even
// if it never gets done, so a known-impossible week doesn't make the pet suffer.
export function useTreat(habitId) {
  const habit = state.habits.find(h => h.id === habitId);
  if (!habit) return false;
  if (state.coins < TREAT_COST) return false;

  const thisWeekKey = todayStr(mondayOf(new Date()));
  if (state.excusedHabits.weekStart !== thisWeekKey) {
    state.excusedHabits = { weekStart: thisWeekKey, habitIds: [] };
  }
  if (state.excusedHabits.habitIds.includes(habitId)) return false;

  state.coins -= TREAT_COST;
  state.excusedHabits.habitIds.push(habitId);
  applyDecay();
  state.pet.hunger = Math.min(100, state.pet.hunger + 8);
  state.pet.joy = Math.min(100, state.pet.joy + 14);
  state.log.unshift({ id: cryptoId(), habitId: null, emoji: '🎁', label: `Прощено: ${habit.title}`, ts: Date.now(), minutes: 0 });
  state.log = state.log.slice(0, 300);

  persist();
  notify();
  return true;
}

export function isHabitExcusedThisWeek(habitId) {
  const thisWeekKey = todayStr(mondayOf(new Date()));
  return state.excusedHabits.weekStart === thisWeekKey && state.excusedHabits.habitIds.includes(habitId);
}

// Returns the last `days` days as { dateStr, count, minutes } for a calendar heatmap.
export function getActivityByDay(days = 70) {
  const map = new Map();
  for (const entry of state.log) {
    const d = todayStr(new Date(entry.ts));
    const row = map.get(d) || { dateStr: d, count: 0, minutes: 0 };
    row.count += 1;
    row.minutes += entry.minutes || 0;
    map.set(d, row);
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = todayStr(new Date(Date.now() - i * 86400000));
    out.push(map.get(d) || { dateStr: d, count: 0, minutes: 0 });
  }
  return out;
}

export function getWeekSummary() {
  const since = Date.now() - 7 * 86400000;
  const entries = state.log.filter(e => e.ts >= since);
  let minutes = 0;
  for (const e of entries) minutes += e.minutes || 0;
  return { total: entries.length, minutes };
}

export function renamePet(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  state.pet.name = trimmed.slice(0, 20);
  persist();
  notify();
}

export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  persist();
  notify();
}

export function resetAll() {
  state = defaultState();
  persist();
  notify();
}

function cryptoId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now();
}

// --- IndexedDB mirror, read by the service worker for background checks ---
let idbPromise = null;
function openIdb() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('buddy-db', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}

async function mirrorToIndexedDB(s) {
  try {
    const db = await openIdb();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(s, 'state');
  } catch (e) {
    // best effort only
  }
}

// Initial decay so getState() is accurate as soon as the app reads it.
// checkNeglect()/performWeeklyReviewIfDue() run later via the first tick() call
// (after app.js subscribes to onEvent), so a cold-load event isn't silently dropped.
applyDecay();
persist();
