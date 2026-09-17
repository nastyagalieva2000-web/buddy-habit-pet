let ctx = null;
function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, startDelay, duration, gainPeak = 0.16) {
  const c = getCtx();
  if (!c) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const t0 = c.currentTime + startDelay;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(gainPeak, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

let enabled = true;
export function setSoundEnabled(v) { enabled = v; }

export function playFeed() {
  if (!enabled) return;
  tone(523.25, 0, 0.14);
  tone(659.25, 0.09, 0.18);
  tone(783.99, 0.17, 0.22);
}

export function playCoin() {
  if (!enabled) return;
  tone(880, 0, 0.1, 0.12);
  tone(1318.5, 0.06, 0.16, 0.12);
}

export function playSad() {
  if (!enabled) return;
  tone(392, 0, 0.18, 0.1);
  tone(311, 0.14, 0.24, 0.1);
}

export function playTick() {
  if (!enabled) return;
  tone(660, 0, 0.06, 0.06);
}

export function vibrate(pattern) {
  if (!enabled) return;
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (e) {}
  }
}
