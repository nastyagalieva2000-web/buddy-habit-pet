import { getSpecies, speciesImage } from './species-data.js';

const MOOD_BADGE = {
  happy: '',
  neutral: '',
  sad: '😔',
  cry: '😢',
  starving: '🥺',
};

function eggSvg() {
  return `
  <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="100" cy="188" rx="48" ry="8" fill="#3a1620" opacity="0.08"/>
    <ellipse cx="100" cy="110" rx="62" ry="76" fill="#ece0d3" stroke="#ddccb9" stroke-width="3"/>
    <path d="M 70 70 L 84 96 L 68 100 L 96 138" stroke="#ddccb9" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="70" cy="70" r="4" fill="#cf98a1" opacity="0.7"/>
    <circle cx="132" cy="150" r="5" fill="#cf98a1" opacity="0.6"/>
    <circle cx="140" cy="90" r="3" fill="#cf98a1" opacity="0.6"/>
  </svg>`;
}

export function renderPet(host, { stage, mood, species, sick }) {
  if (stage === 'egg') {
    host.innerHTML = `<div class="pet-wrap">${eggSvg()}</div>`;
    return;
  }

  const sp = getSpecies(species);
  const filters = [];
  if (sick) filters.push('grayscale(0.55)', 'brightness(0.96)');
  if (mood === 'cry' || mood === 'starving') filters.push('saturate(0.75)', 'brightness(0.92)');
  const filterStyle = filters.length ? `style="filter:${filters.join(' ')}"` : '';

  // Species with real drawn mood variants don't need the emoji badge on top —
  // only fall back to it when the art itself can't show the mood (happy/sad only, so far).
  const stageKey = stage === 'baby' ? 'baby' : 'adult';
  const moodKey = (mood === 'happy' || mood === 'neutral') ? 'happy' : 'sad';
  const hasDrawnMood = !!(sp.variants && sp.variants[`${stageKey}-${moodKey}`]);
  const moodBadge = !sick && !hasDrawnMood && MOOD_BADGE[mood] ? `<span class="pet-mood-badge">${MOOD_BADGE[mood]}</span>` : '';
  const stageBadge = stage === 'adult' ? '<span class="pet-badge">✨</span>' : '';

  host.innerHTML = `
    <div class="pet-wrap ${sick ? 'sick' : ''}">
      <img class="pet-photo" src="${speciesImage(sp.id, { stage, mood })}" alt="${sp.name}" ${filterStyle} />
      ${stageBadge}
      ${moodBadge}
      ${sick ? '<span class="pet-sick-badge">🤒</span>' : ''}
    </div>
  `;
}

export function popSparkles(container, count = 6) {
  const emojis = ['✨', '💛', '⭐️', '💫'];
  for (let i = 0; i < count; i++) {
    const el = document.createElement('span');
    el.className = 'sparkle';
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    el.style.left = `${20 + Math.random() * 60}%`;
    el.style.top = `${30 + Math.random() * 30}%`;
    el.style.animationDelay = `${Math.random() * 0.2}s`;
    container.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }
}
