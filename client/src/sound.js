// Tiny sound engine. Everything is synthesised with the Web Audio API, so there are no asset
// files to ship and nothing to load. Muting is remembered in localStorage.
let ctx = null;
let muted = localStorage.getItem('iq180:muted') === '1';

const ensure = () => (ctx ??= new (window.AudioContext || window.webkitAudioContext)());

export const isMuted = () => muted;
export function setMuted(v) {
  muted = v;
  localStorage.setItem('iq180:muted', v ? '1' : '0');
}

// A single shaped tone. type/freq/duration vary per effect.
function tone(freq, dur, { type = 'sine', gain = 0.12, slideTo } = {}) {
  if (muted) return;
  let ac;
  try { ac = ensure(); } catch { return; }
  if (ac.state === 'suspended') ac.resume();
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, ac.currentTime + dur);
  vol.gain.setValueAtTime(gain, ac.currentTime);
  vol.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
  osc.connect(vol).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + dur);
}

const seq = (notes) => notes.forEach(([f, t, d], i) => setTimeout(() => tone(f, d ?? 0.18, { type: 'triangle', gain: 0.14 }), i ? t : 0));

export const sfx = {
  tap: () => tone(420, 0.06, { type: 'square', gain: 0.06 }),
  op: () => tone(300, 0.06, { type: 'square', gain: 0.05 }),
  submit: () => tone(520, 0.12, { type: 'triangle', slideTo: 680 }),
  hint: () => tone(660, 0.14, { type: 'sine', gain: 0.1 }),
  tick: () => tone(880, 0.05, { type: 'square', gain: 0.05 }),
  win: () => seq([[523, 0], [659, 120], [784, 240], [1047, 360, 0.32]]),
  lose: () => seq([[392, 0], [330, 140], [262, 300, 0.4]]),
  go: () => tone(700, 0.2, { type: 'triangle', slideTo: 1000, gain: 0.16 }),
};
