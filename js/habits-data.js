// mode: 'timer' (countdown with pause), 'quick' (duration chip = instant log),
// 'check' (single tap = instant log, no duration).
// pinnedDays uses ISO weekday numbers: 1=Mon ... 7=Sun.
// note: optional short text shown under the title (e.g. a fixed quantity per session).

export const DEFAULT_HABITS = [
  { id: 'reading', title: 'Чтение', emoji: '📖', weeklyTarget: 6, mode: 'timer', durations: [10, 15, 25, 45], pinnedDays: [] },
  { id: 'english', title: 'Английский', emoji: '🇬🇧', weeklyTarget: 3, mode: 'check', pinnedDays: [2, 5, 7], note: '2 урока за раз' },
  { id: 'dance', title: 'Танцы', emoji: '💃', weeklyTarget: 2, mode: 'quick', durations: [60, 90], pinnedDays: [1, 3] },
  { id: 'warmup', title: 'Разминка', emoji: '🤸', weeklyTarget: 3, mode: 'quick', durations: [5, 10, 15], pinnedDays: [2, 5, 7] },
  { id: 'vacuum', title: 'Пылесос', emoji: '🧹', weeklyTarget: 1, mode: 'check', pinnedDays: [4] },
  { id: 'laundry', title: 'Стирка', emoji: '🧺', weeklyTarget: 1, mode: 'check', pinnedDays: [4] },
  { id: 'dust', title: 'Пыль', emoji: '🪶', weeklyTarget: 1, mode: 'check', pinnedDays: [4] },
  { id: 'cook', title: 'Ужин', emoji: '🍳', weeklyTarget: 2, mode: 'check', pinnedDays: [1, 3] },
];

export const DAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function isoWeekday(date = new Date()) {
  const d = date.getDay();
  return d === 0 ? 7 : d;
}
