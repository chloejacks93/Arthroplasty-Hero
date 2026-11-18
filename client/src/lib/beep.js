// Scan feedback sounds (Web Audio, no files).
//  * ok():    one short high beep: scan accepted
//  * error(): two low tones: scan refused / problem
// iPhone: audio can only start after a tap, so unlockAudio() is called on the
// first touch anywhere. Where Safari supports it, the audio session is set to
// "playback" so beeps sound even with the side switch on silent.
const KEY = 'ah.scanSound';
let ctx = null;

export function soundEnabled() {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}
export function setSoundEnabled(on) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
  if (on) ok();
}

function context() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch { /* unsupported */ }
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function unlockAudio() {
  const c = context();
  if (!c) return;
  // A silent blip completes the unlock on iOS.
  const o = c.createOscillator();
  const g = c.createGain();
  g.gain.value = 0;
  o.connect(g).connect(c.destination);
  o.start();
  o.stop(c.currentTime + 0.01);
}

function tone(freq, start, dur, vol = 0.25) {
  const c = context();
  if (!c) return;
  const t = c.currentTime + start;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'square';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export function ok() {
  if (!soundEnabled()) return;
  tone(1760, 0, 0.11, 0.18);
  if (navigator.vibrate) navigator.vibrate(35);
}

export function error() {
  if (!soundEnabled()) return;
  tone(330, 0, 0.13, 0.22);
  tone(262, 0.17, 0.16, 0.22);
  if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
}
