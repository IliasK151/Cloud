// Spoken briefings via the browser's built-in speech synthesis (macOS voices work great).

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
let voices = [];
let enabled = true;

function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices().filter((v) => /^en(-|_|$)/i.test(v.lang));
}
if (synth) {
  loadVoices();
  synth.onvoiceschanged = loadVoices;
}

try {
  enabled = localStorage.getItem('floor.voice') !== 'off';
} catch {
  /* storage unavailable */
}

const FEMALE_HINT = /samantha|victoria|karen|moira|tessa|serena|kate|stephanie|allison|ava|susan|zoe|nicky|veena|isha|female|amelie|paulina|monica|tingting|meijia|lekha|fiona|martha/i;
const MALE_HINT = /alex|daniel|tom|aaron|fred|ralph|arthur|oliver|lee|rishi|evan|nathan|male|gordon|reed|rocko|eddy/i;

function pickVoice(profile) {
  if (!voices.length) loadVoices();
  if (!voices.length) return null;
  for (const name of profile.voice?.prefer || []) {
    const v = voices.find((x) => x.name.toLowerCase().includes(name.toLowerCase()));
    if (v) return v;
  }
  const hint = profile.gender === 'female' ? FEMALE_HINT : MALE_HINT;
  const matching = voices.filter((v) => hint.test(v.name));
  const pool = matching.length ? matching : voices;
  // Spread desks across the available voices so they don't all sound the same.
  let h = 0;
  for (const c of profile.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}

export const voice = {
  get supported() { return !!synth; },
  get enabled() { return enabled && !!synth; },
  setEnabled(on) {
    enabled = on;
    try { localStorage.setItem('floor.voice', on ? 'on' : 'off'); } catch { /* ignore */ }
    if (!on) this.stop();
  },
  stop() {
    synth?.cancel();
  },
  // Speaks sentence by sentence (Chrome cuts off long utterances), calling onLine(i) as
  // each one starts. Resolves true if everything was spoken, false if muted/failed/cancelled.
  speakLines(lines, profile, { onLine } = {}) {
    return new Promise((resolve) => {
      if (!this.enabled || !lines.length) return resolve(false);
      synth.cancel();
      const v = pickVoice(profile);
      let started = false;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      lines.forEach((text, i) => {
        const u = new SpeechSynthesisUtterance(text);
        if (v) u.voice = v;
        u.pitch = profile.voice?.pitch ?? 1;
        u.rate = profile.voice?.rate ?? 1;
        u.onstart = () => {
          started = true;
          onLine?.(i);
        };
        u.onend = () => {
          if (i === lines.length - 1) finish(started);
        };
        u.onerror = () => finish(false);
        synth.speak(u);
      });
    });
  },
};
