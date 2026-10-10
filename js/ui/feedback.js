// Retour sensoriel du scan : bip (WebAudio) et vibration, désactivables dans le menu.
import { prefs } from './state.js';

let audio = null;
const TONES = { scan: [1760, 0.08], ok: [988, 0.1], error: [196, 0.28] };

export function beep(kind = 'ok') {
  if (!prefs.get('sound', true)) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const [freq, dur] = TONES[kind] ?? TONES.ok;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = freq;
    o.type = kind === 'error' ? 'square' : 'sine';
    g.gain.setValueAtTime(0.06, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + dur);
  } catch { /* audio indisponible : sans conséquence */ }
}

export function haptic(kind = 'ok') {
  if (!prefs.get('sound', true)) return;
  try { navigator.vibrate?.(kind === 'error' ? [70, 40, 70] : 30); } catch { /* ignoré */ }
}

export function feedback(kind = 'ok') { beep(kind); haptic(kind); }
