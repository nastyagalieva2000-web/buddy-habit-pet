import {
  getState, subscribe, tick, getStage, getMoodBand, STAGE_LABEL,
  completeHabit, addHabit, removeHabit, updateHabitTarget, getHabitWeekCount, isPinnedToday,
  isUrgentToday, getTodayHabits,
  renamePet, updateSettings, resetAll,
  setSpecies, unlockSpecies, isSpeciesUnlocked, useTreat, isHabitExcusedThisWeek, TREAT_COST,
  getActivityByDay, getWeekSummary, onEvent,
} from './store.js';
import { renderPet, popSparkles } from './pet-render.js';
import { SPECIES, speciesImage } from './species-data.js';
import { DAY_LABELS } from './habits-data.js';
import {
  registerSW, requestPermission, isSupported, startForegroundScheduler,
  sendTestNotification, tryRegisterPeriodicSync, maybeNotify,
} from './notifications.js';
import { playFeed, playCoin, playSad, setSoundEnabled, vibrate } from './sound.js';

// ---------- toast ----------
const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg, holdMs = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), holdMs);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------- tab navigation ----------
const views = document.querySelectorAll('.view');
const tabBtns = document.querySelectorAll('.tab-btn');

function goto(name) {
  views.forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  tabBtns.forEach(b => b.classList.toggle('active', b.dataset.view === name));
}

tabBtns.forEach(btn => btn.addEventListener('click', () => goto(btn.dataset.view)));
document.querySelectorAll('[data-goto]').forEach(btn => {
  btn.addEventListener('click', () => goto(btn.dataset.goto));
});

// ---------- mood copy ----------
const MOOD_LINES = {
  happy: 'Полон энергии и счастья!',
  neutral: 'В целом неплохо, но не откажется от дела',
  sad: 'Грустит и ждёт твоего внимания',
  cry: 'Очень грустно... позаботься о нём поскорее',
  starving: 'Ужасно голоден! Скорее покорми его',
};

// ---------- main render ----------
const petSvgHost = document.getElementById('petSvgHost');
const petSparkles = document.getElementById('petSparkles');
const sickBanner = document.getElementById('sickBanner');

function render() {
  const s = getState();
  const stage = getStage();
  const mood = stage.key === 'egg' ? 'neutral' : getMoodBand();

  document.getElementById('streakCount').textContent = s.streak.count;
  document.getElementById('coinCount').textContent = s.coins;
  document.getElementById('petName').textContent = s.pet.name;
  document.getElementById('petStageLabel').textContent = stage.label;

  document.getElementById('petMoodLine').textContent =
    stage.key === 'egg' ? 'Ждёт своего первого дела, чтобы вылупиться' : MOOD_LINES[mood];

  const hunger = Math.round(s.pet.hunger);
  const joy = Math.round(s.pet.joy);
  document.getElementById('hungerPct').textContent = `${hunger}%`;
  document.getElementById('joyPct').textContent = `${joy}%`;
  document.getElementById('hungerBar').style.width = `${hunger}%`;
  document.getElementById('joyBar').style.width = `${joy}%`;

  renderPet(petSvgHost, { stage: stage.key, mood, species: s.pet.species, sick: s.health.sick });

  if (s.health.sick) {
    const names = s.health.sickHabits
      .map(id => s.habits.find(h => h.id === id))
      .filter(Boolean)
      .map(h => h.title);
    sickBanner.textContent = `🤒 Питомец заболел — не закрыты: ${names.join(', ') || 'привычки прошлой недели'}. Выполни их, чтобы вылечить.`;
    sickBanner.classList.remove('hidden');
  } else {
    sickBanner.classList.add('hidden');
  }

  renderToday(s);
  renderHabits(s);
  renderSpeciesGrid(s);
  renderSettings(s);
  renderStats(s);
}

function celebrate() {
  petSvgHost.classList.remove('bounce');
  void petSvgHost.offsetWidth;
  petSvgHost.classList.add('bounce');
  popSparkles(petSparkles);
  playFeed();
  vibrate([15, 25, 15]);
}

onEvent((type, payload) => {
  if (type === 'streak-broken') {
    const days = payload.missed === 1 ? '1 день' : `${payload.missed} дня`;
    showToast(`Стрик прерван — питомец грустил ${days} без дела 💔`);
    playSad();
    vibrate([40, 30, 40]);
  } else if (type === 'week-perfect') {
    showToast('Идеальная неделя! Все привычки закрыты — бонус питомцу 🎉', 3000);
    playCoin();
    vibrate([15, 20, 15, 20, 15]);
  } else if (type === 'week-strike') {
    showToast(`Неделя закрыта не полностью: «${payload.habitTitle}» — питомец расстроен`, 3200);
    playSad();
    vibrate(30);
  } else if (type === 'week-sick') {
    showToast(`Питомец заболел 🤒 Провалено: ${payload.habitTitles.join(', ')}`, 3600);
    playSad();
    vibrate([50, 40, 50, 40, 50]);
  } else if (type === 'pet-cured') {
    showToast('Питомец поправился! Спасибо, что позаботился 💚', 2600);
    playFeed();
    vibrate([15, 15, 15]);
  } else if (type === 'pet-regressed') {
    showToast(`От долгого пренебрежения питомец вернулся в стадию «${STAGE_LABEL[payload.to]}» 😢`, 4000);
    playSad();
    vibrate([80, 50, 80]);
  } else if (type === 'species-unlocked') {
    showToast(`${payload.species.emoji} Открыт новый питомец: ${payload.species.name}!`, 3000);
    playCoin();
    celebrate();
  }
});

// ---------- habits ----------
const habitsList = document.getElementById('habitsList');
const TIMER_KEY = 'buddy-active-timer';
let activeTimer = null; // { habitId, totalSec, remainingSec, endTs|null, minutes }
let timerInterval = null;

function formatMMSS(totalSec) {
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function saveTimer() {
  try { localStorage.setItem(TIMER_KEY, JSON.stringify(activeTimer)); } catch (e) {}
}
function clearTimerStorage() {
  try { localStorage.removeItem(TIMER_KEY); } catch (e) {}
}
function restoreTimer() {
  try {
    const raw = localStorage.getItem(TIMER_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || !getState().habits.some(h => h.id === saved.habitId)) { clearTimerStorage(); return; }
    activeTimer = saved;
    if (activeTimer.endTs) timerInterval = setInterval(tickTimer, 1000);
  } catch (e) {}
}

function startTimer(habitId, minutes) {
  if (activeTimer) return;
  activeTimer = { habitId, totalSec: minutes * 60, remainingSec: minutes * 60, endTs: Date.now() + minutes * 60000, minutes };
  saveTimer();
  render();
  timerInterval = setInterval(tickTimer, 1000);
}

function toggleTimerPause() {
  if (!activeTimer) return;
  if (activeTimer.endTs) {
    activeTimer.remainingSec = Math.max(0, Math.round((activeTimer.endTs - Date.now()) / 1000));
    activeTimer.endTs = null;
    clearInterval(timerInterval);
    timerInterval = null;
  } else {
    activeTimer.endTs = Date.now() + activeTimer.remainingSec * 1000;
    timerInterval = setInterval(tickTimer, 1000);
  }
  saveTimer();
  render();
}

function tickTimer() {
  if (!activeTimer || !activeTimer.endTs) return;
  const sec = Math.max(0, Math.round((activeTimer.endTs - Date.now()) / 1000));
  document.querySelectorAll(`[data-timer-for="${activeTimer.habitId}"]`).forEach(el => {
    el.textContent = formatMMSS(sec);
  });
  if (sec <= 0) finishTimer();
}

function finishTimer() {
  const { habitId, minutes } = activeTimer;
  const habit = getState().habits.find(h => h.id === habitId);
  clearInterval(timerInterval);
  timerInterval = null;
  activeTimer = null;
  clearTimerStorage();
  completeHabit(habitId, { minutes });
  celebrate();
  if (habit) showToast(`${habit.emoji} ${habit.title} — ${minutes} мин, готово!`);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  activeTimer = null;
  clearTimerStorage();
  render();
}

function habitControlsHTML(habit) {
  if (habit.mode === 'timer') {
    const runningHere = activeTimer && activeTimer.habitId === habit.id;
    const blockedByOther = activeTimer && activeTimer.habitId !== habit.id;
    if (runningHere) {
      const sec = activeTimer.endTs ? Math.max(0, Math.round((activeTimer.endTs - Date.now()) / 1000)) : activeTimer.remainingSec;
      return `
        <div class="timer-active">
          <div class="timer-display" data-timer-for="${habit.id}">${formatMMSS(sec)}</div>
          <div class="timer-btn-row">
            <button class="btn ghost" data-action="timer-cancel">Отмена</button>
            <button class="btn ghost" data-action="timer-pause">${activeTimer.endTs ? 'Пауза' : 'Продолжить'}</button>
          </div>
        </div>`;
    } else if (blockedByOther) {
      return `<p class="card-sub">Сначала заверши текущий таймер на другой привычке</p>`;
    }
    return `<div class="chip-row">${habit.durations.map(m => `<button class="chip" data-action="timer-start" data-min="${m}">${m} мин</button>`).join('')}</div>`;
  }
  if (habit.mode === 'quick') {
    return `<div class="chip-row">${habit.durations.map(m => `<button class="chip" data-action="quick" data-min="${m}">${m} мин</button>`).join('')}</div>`;
  }
  return `<button class="habit-check-btn" data-action="check">Отметить выполнено</button>`;
}

function treatRowHTML(habit, s) {
  const excused = isHabitExcusedThisWeek(habit.id);
  if (excused) {
    return `
      <div class="treat-row">
        <span class="treat-hint">🍬 Прощено на этой неделе — питомец не расстроится</span>
      </div>`;
  }
  const canAfford = s.coins >= TREAT_COST;
  return `
    <div class="treat-row">
      <span class="treat-hint">Знаешь, что не успеешь? Побалуй питомца, чтобы не расстраивался из-за этого</span>
      <button class="treat-btn" data-action="treat" ${canAfford ? '' : 'disabled'}>🍬 ${TREAT_COST}</button>
    </div>`;
}

function habitCardHTML(habit, s) {
  const weekCount = getHabitWeekCount(habit.id);
  const pct = Math.min(100, Math.round((weekCount / habit.weeklyTarget) * 100));
  const met = weekCount >= habit.weeklyTarget;
  const pinnedToday = isPinnedToday(habit);
  const daysLine = habit.pinnedDays && habit.pinnedDays.length
    ? `<div class="habit-days">${habit.pinnedDays.map(d => DAY_LABELS[d - 1]).join(', ')}</div>` : '';

  return `
    <div class="card habit-card" data-habit="${habit.id}">
      <div class="habit-head">
        <span class="habit-emoji">${habit.emoji}</span>
        <div style="flex:1; min-width:0;">
          <div class="habit-title-row">
            <h3>${escapeHtml(habit.title)}</h3>
            ${pinnedToday ? '<span class="habit-today-tag">Сегодня по плану</span>' : ''}
            <button class="habit-del" data-action="delete" aria-label="Удалить привычку">✕</button>
          </div>
          ${daysLine}
        </div>
      </div>
      <div class="habit-progress-row">
        <span>Эта неделя</span>
        <span>${weekCount} / ${habit.weeklyTarget} <button class="edit-target" data-action="edit-target">✏️</button></span>
      </div>
      <div class="habit-bar"><div class="habit-bar-fill ${met ? 'met' : ''}" style="width:${pct}%"></div></div>
      ${habitControlsHTML(habit)}
      ${!met ? treatRowHTML(habit, s) : ''}
    </div>
  `;
}

function renderHabits(s) {
  habitsList.innerHTML = s.habits.map(h => habitCardHTML(h, s)).join('');
}

// Shared by the full habit list and the compact "Today" widget.
function handleHabitAction(habitId, action, actionEl, { fromToday = false } = {}) {
  const habit = getState().habits.find(h => h.id === habitId);
  if (!habit) return;

  if (action === 'delete') {
    if (confirm(`Удалить привычку «${habit.title}»?`)) removeHabit(habitId);
  } else if (action === 'edit-target') {
    const next = prompt(`Сколько раз в неделю: «${habit.title}»?`, habit.weeklyTarget);
    if (next !== null) {
      const n = parseInt(next, 10);
      if (!Number.isNaN(n) && n > 0) updateHabitTarget(habitId, n);
    }
  } else if (action === 'check') {
    completeHabit(habitId, { minutes: 0 });
    celebrate();
    showToast(`${habit.emoji} ${habit.title} — готово!`);
  } else if (action === 'quick') {
    const minutes = Number(actionEl.dataset.min);
    completeHabit(habitId, { minutes });
    celebrate();
    showToast(`${habit.emoji} ${habit.title} засчитано!`);
  } else if (action === 'timer-start') {
    startTimer(habitId, Number(actionEl.dataset.min));
    if (fromToday) goto('tasks');
  } else if (action === 'timer-pause') {
    toggleTimerPause();
  } else if (action === 'timer-cancel') {
    stopTimer();
  } else if (action === 'treat') {
    if (useTreat(habitId)) {
      showToast(`🍬 ${habit.title} прощена на эту неделю — питомец рад угощению`);
      celebrate();
    } else {
      showToast('Не хватает монет на гостинец');
    }
  }
}

habitsList.addEventListener('click', (e) => {
  const card = e.target.closest('.habit-card');
  if (!card) return;
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;
  handleHabitAction(card.dataset.habit, actionEl.dataset.action, actionEl);
});

// ---------- today widget ----------
const todayList = document.getElementById('todayList');
const todayTitle = document.getElementById('todayTitle');
const WEEKDAY_NAMES = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

function todayItemHTML(habit, tag) {
  const weekCount = getHabitWeekCount(habit.id);
  return `
    <div class="today-item" data-habit="${habit.id}">
      <div class="today-item-head">
        <span class="habit-emoji">${habit.emoji}</span>
        <span class="today-item-title">${escapeHtml(habit.title)}</span>
        <span class="today-item-tag ${tag.cls}">${tag.label}</span>
        <span class="today-item-progress">${weekCount}/${habit.weeklyTarget}</span>
      </div>
      ${habitControlsHTML(habit)}
    </div>
  `;
}

function renderToday(s) {
  const today = new Date();
  todayTitle.textContent = `Сегодня, ${WEEKDAY_NAMES[today.getDay() === 0 ? 6 : today.getDay() - 1]}`;

  const { pinned, urgent } = getTodayHabits();
  const items = [
    ...pinned.map(h => ({ habit: h, tag: { cls: 'plan', label: 'по плану' } })),
    ...urgent.map(h => ({ habit: h, tag: { cls: 'urgent', label: 'пора' } })),
  ];

  if (items.length === 0) {
    todayList.innerHTML = `<p class="card-sub">Сегодня без жёсткого плана — но питомцу всегда рад любому делу 🐾</p>`;
    return;
  }
  todayList.innerHTML = items.map(({ habit, tag }) => todayItemHTML(habit, tag)).join('');
}

todayList.addEventListener('click', (e) => {
  const item = e.target.closest('.today-item');
  if (!item) return;
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;
  handleHabitAction(item.dataset.habit, actionEl.dataset.action, actionEl, { fromToday: true });
});

const newHabitTitle = document.getElementById('newHabitTitle');
const newHabitTarget = document.getElementById('newHabitTarget');
document.getElementById('addHabitBtn').addEventListener('click', () => {
  const title = newHabitTitle.value.trim();
  if (!title) return;
  const target = Math.max(1, Math.min(14, parseInt(newHabitTarget.value, 10) || 3));
  addHabit({ title, weeklyTarget: target, mode: 'check' });
  newHabitTitle.value = '';
  newHabitTarget.value = '3';
  showToast('Привычка добавлена');
});
newHabitTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('addHabitBtn').click();
});

// ---------- species zoo ----------
const speciesGrid = document.getElementById('speciesGrid');
function renderSpeciesGrid(s) {
  const categories = [...new Set(SPECIES.map(sp => sp.category))];
  let html = '';
  for (const cat of categories) {
    html += `<div class="species-category">${cat}</div><div class="species-grid">`;
    for (const sp of SPECIES.filter(x => x.category === cat)) {
      const unlocked = isSpeciesUnlocked(sp.id);
      const active = s.pet.species === sp.id;
      const canAfford = s.coins >= sp.cost;
      let btnLabel, btnClass, disabled;
      if (active) { btnLabel = 'Текущий'; btnClass = 'selected'; disabled = true; }
      else if (unlocked) { btnLabel = 'Выбрать'; btnClass = ''; disabled = false; }
      else { btnLabel = `${sp.cost} <img class="coin-icon-inline" src="assets/ui/coin.png" alt="монет" />`; btnClass = ''; disabled = !canAfford; }

      html += `
        <div class="species-card ${unlocked ? '' : 'locked'} ${active ? 'active' : ''}" data-species="${sp.id}">
          <div class="species-photo-wrap">
            <img class="species-photo" src="${speciesImage(sp.id)}" alt="${sp.name}" />
            ${unlocked ? '' : '<span class="species-lock-badge">🔒</span>'}
          </div>
          <div class="species-name">${sp.emoji} ${sp.name}</div>
          ${active ? '<div class="species-active-tag">С тобой сейчас</div>' : `<button class="species-btn ${btnClass}" data-action="${unlocked ? 'select' : 'unlock'}" ${disabled ? 'disabled' : ''}>${btnLabel}</button>`}
        </div>`;
    }
    html += `</div>`;
  }
  speciesGrid.innerHTML = html;
}

speciesGrid.addEventListener('click', (e) => {
  const card = e.target.closest('.species-card');
  const btn = e.target.closest('[data-action]');
  if (!card || !btn) return;
  const id = card.dataset.species;
  const sp = SPECIES.find(x => x.id === id);
  if (btn.dataset.action === 'select') {
    setSpecies(id);
    celebrate();
  } else if (btn.dataset.action === 'unlock') {
    if (unlockSpecies(id)) {
      // toast + celebrate handled by the species-unlocked event
    } else {
      showToast('Не хватает монет');
    }
  }
});

// ---------- stats ----------
function timeAgo(ts) {
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if (diffMin < 1) return 'только что';
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} ч назад`;
  const diffD = Math.round(diffH / 24);
  return `${diffD} дн назад`;
}

function renderStats(s) {
  const week = getWeekSummary();
  document.getElementById('statWeekCount').textContent = week.total;
  document.getElementById('statWeekMinutes').textContent = week.minutes;
  document.getElementById('statStreakNow').textContent = s.streak.count;
  document.getElementById('statStreakBest').textContent = s.streak.best;

  const heatmap = document.getElementById('heatmap');
  const days = getActivityByDay(70);
  heatmap.innerHTML = days.map(d => {
    let level = 'h0';
    if (d.count >= 3) level = 'h3';
    else if (d.count === 2) level = 'h2';
    else if (d.count === 1) level = 'h1';
    return `<div class="heat-cell ${level}" title="${d.dateStr}: ${d.count}"></div>`;
  }).join('');

  const historyList = document.getElementById('historyList');
  if (s.log.length === 0) {
    historyList.innerHTML = '<li class="history-empty">Пока нет выполненных дел</li>';
  } else {
    historyList.innerHTML = s.log.slice(0, 15).map(e => `
      <li class="history-item">
        <span class="history-item-label">${e.emoji || '✨'} ${escapeHtml(e.label)}</span>
        <span class="history-item-time">${timeAgo(e.ts)}</span>
      </li>
    `).join('');
  }
}

// ---------- settings ----------
const notifToggle = document.getElementById('notifToggle');
const notifDetails = document.getElementById('notifDetails');
const notifStart = document.getElementById('notifStart');
const notifEnd = document.getElementById('notifEnd');
const notifInterval = document.getElementById('notifInterval');
const notifPlatformNote = document.getElementById('notifPlatformNote');
const petNameInput = document.getElementById('petNameInput');
const soundToggle = document.getElementById('soundToggle');

function renderSettings(s) {
  notifToggle.checked = s.settings.notificationsEnabled;
  notifDetails.classList.toggle('hidden', !s.settings.notificationsEnabled);
  notifStart.value = s.settings.reminderStart;
  notifEnd.value = s.settings.reminderEnd;
  notifInterval.value = String(s.settings.reminderIntervalHours);
  if (document.activeElement !== petNameInput) petNameInput.value = s.pet.name;
  soundToggle.checked = s.settings.soundEnabled;
}

soundToggle.addEventListener('change', () => {
  setSoundEnabled(soundToggle.checked);
  updateSettings({ soundEnabled: soundToggle.checked });
});

notifToggle.addEventListener('change', async () => {
  if (notifToggle.checked) {
    if (!isSupported()) {
      showToast('Уведомления не поддерживаются этим браузером');
      notifToggle.checked = false;
      return;
    }
    const perm = await requestPermission();
    if (perm !== 'granted') {
      showToast('Разрешение на уведомления не дано');
      notifToggle.checked = false;
      return;
    }
    updateSettings({ notificationsEnabled: true, lastNotifiedAt: 0 });
    tryRegisterPeriodicSync();
    showToast('Напоминания включены');
  } else {
    updateSettings({ notificationsEnabled: false });
  }
});

notifStart.addEventListener('change', () => updateSettings({ reminderStart: notifStart.value }));
notifEnd.addEventListener('change', () => updateSettings({ reminderEnd: notifEnd.value }));
notifInterval.addEventListener('change', () => updateSettings({ reminderIntervalHours: Number(notifInterval.value) }));
document.getElementById('testNotifBtn').addEventListener('click', async () => {
  if (Notification.permission !== 'granted') { showToast('Сначала включи напоминания'); return; }
  await sendTestNotification();
});

document.getElementById('renamePetBtn').addEventListener('click', () => {
  renamePet(petNameInput.value);
  showToast('Имя сохранено');
});

document.getElementById('resetBtn').addEventListener('click', () => {
  if (confirm('Точно сбросить весь прогресс? Это необратимо.')) {
    resetAll();
    showToast('Прогресс сброшен');
  }
});

function setPlatformNote() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isIOS) {
    notifPlatformNote.textContent = standalone
      ? 'На iPhone уведомления приходят надёжнее всего, когда приложение хоть иногда открыто в фоне. Полностью закрытое приложение будить не может.'
      : 'На iPhone уведомления работают только после установки на экран Домой (Поделиться → На экран «Домой»).';
  } else {
    notifPlatformNote.textContent = 'Уведомления надёжнее всего работают, если браузер/приложение не выгружены из памяти полностью.';
  }
}

// ---------- install prompt ----------
let deferredPrompt = null;
const installBtn = document.getElementById('installBtn');
const installHint = document.getElementById('installHint');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.classList.remove('hidden');
  installHint.textContent = 'Готово к установке — нажми кнопку ниже.';
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.classList.add('hidden');
});

window.addEventListener('appinstalled', () => {
  showToast('Приложение установлено!');
});

function setInstallHintDefault() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (standalone) {
    installHint.textContent = 'Уже установлено на этом устройстве 🎉';
  } else if (isIOS) {
    installHint.textContent = 'На iPhone: нажми «Поделиться» внизу Safari → «На экран «Домой».';
  } else {
    installHint.textContent = 'Открой это в Chrome на телефоне — появится баннер «Установить приложение», либо пункт в меню (⋮).';
  }
}

// ---------- init ----------
async function init() {
  const reg = await registerSW();
  setSoundEnabled(getState().settings.soundEnabled);
  subscribe(render);
  tick(); // applies decay + neglect/weekly review now that listeners are registered
  restoreTimer();
  render();
  setPlatformNote();
  setInstallHintDefault();
  startForegroundScheduler();
  setInterval(tick, 30 * 1000);
  window.addEventListener('focus', tick);
  if (getState().settings.notificationsEnabled && Notification.permission === 'granted') {
    tryRegisterPeriodicSync();
  }
}

init();
