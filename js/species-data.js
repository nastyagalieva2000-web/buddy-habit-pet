// Most species share one static watercolor illustration (assets/animals/<id>.png)
// across every mood/stage, communicated instead with small badge overlays + filters.
// A species can opt into real per-stage/per-mood art via `variants` — any combination
// not listed there just falls back to the base <id>.png (see speciesImage below).

// Only one species is free — everything else, including the deer, has to be earned.
export const STARTER_SPECIES = ['cat'];

export const SPECIES = [
  { id: 'cat', name: 'Котёнок', emoji: '🐱', category: 'Лес', cost: 0, variants: {
    'baby-happy': 'cat-baby.png',
    'baby-sad': 'cat-baby-sad.png',
    'adult-happy': 'cat.png',
    'adult-sad': 'cat-sad.png',
  } },

  { id: 'dog', name: 'Щенок', emoji: '🐶', category: 'Лес', cost: 100 },
  { id: 'rabbit', name: 'Зайка', emoji: '🐰', category: 'Лес', cost: 100 },
  { id: 'sheep', name: 'Овечка', emoji: '🐑', category: 'Лес', cost: 110 },
  { id: 'fox', name: 'Лисёнок', emoji: '🦊', category: 'Лес', cost: 120 },
  { id: 'deer', name: 'Оленёнок', emoji: '🦌', category: 'Лес', cost: 150 },
  { id: 'cow', name: 'Коровка', emoji: '🐮', category: 'Лес', cost: 150 },
  { id: 'horse', name: 'Лошадка', emoji: '🐴', category: 'Лес', cost: 160 },

  { id: 'owl', name: 'Совёнок', emoji: '🦉', category: 'Арктика', cost: 160 },
  { id: 'penguin', name: 'Пингвинёнок', emoji: '🐧', category: 'Арктика', cost: 190 },
  { id: 'seal', name: 'Тюленёнок', emoji: '🦭', category: 'Арктика', cost: 190 },
  { id: 'polarbear', name: 'Белый медвежонок', emoji: '🐻‍❄️', category: 'Арктика', cost: 230 },

  { id: 'seahorse', name: 'Морской конёк', emoji: '🐠', category: 'Океан', cost: 190 },
  { id: 'octopus', name: 'Осьминожек', emoji: '🐙', category: 'Океан', cost: 220 },
  { id: 'turtle', name: 'Черепашка', emoji: '🐢', category: 'Океан', cost: 220 },
  { id: 'shark', name: 'Акулёнок', emoji: '🦈', category: 'Океан', cost: 270 },
  { id: 'orca', name: 'Косатка', emoji: '🐋', category: 'Океан', cost: 320 },

  { id: 'parrot', name: 'Попугайчик', emoji: '🦜', category: 'Тропики', cost: 260 },
  { id: 'toucan', name: 'Тукан', emoji: '🦤', category: 'Тропики', cost: 310 },
  { id: 'flamingo', name: 'Фламинго', emoji: '🦩', category: 'Тропики', cost: 380 },
  { id: 'dolphin', name: 'Дельфинёнок', emoji: '🐬', category: 'Тропики', cost: 420 },
];

export function getSpecies(id) {
  return SPECIES.find(s => s.id === id) || SPECIES[0];
}

// stage: 'baby' | 'teen' | 'adult' (teen borrows the adult art — no separate frame for it).
// mood: any of the app's mood bands ('happy' | 'neutral' | 'sad' | 'cry' | 'starving').
export function speciesImage(id, { stage, mood } = {}) {
  const sp = getSpecies(id);
  if (sp.variants) {
    const stageKey = stage === 'baby' ? 'baby' : 'adult';
    const moodKey = (mood === 'happy' || mood === 'neutral' || !mood) ? 'happy' : 'sad';
    const file = sp.variants[`${stageKey}-${moodKey}`];
    if (file) return `assets/animals/${file}`;
  }
  return `assets/animals/${id}.png`;
}
