// Agent voices.
//  - "natural": Kokoro, a neural text-to-speech model that the floor's server runs on this
//    Mac (server/voices). Set up once on demand; each agent has their own voice and the audio
//    drives their lip sync. Any failure falls back to system voices, never silence.
//  - "system": the operating system's voices through the Web Speech API, ranked so the
//    best installed voices (Premium / Enhanced / Natural) win and novelty or robotic voices
//    are never used, with a distinct voice per agent where possible.
//  - "off"

import { apiFetch } from './net.js';

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
const listeners = new Set();
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

let engine = store.get('floor.voiceEngine') || (store.get('floor.voice') === 'off' ? 'off' : 'system');
// Mirrors the server's voice engine: absent | installed | installing | loading | ready | error.
const neural = { state: 'absent', step: '', progress: null, loaded: 0, total: 0, error: null, lastError: null };

let ctx = null;
let analyser = null;
let gain = null;
let buf = null;
let current = null; // { id, stop }
let speakToken = 0;
let mimic = { id: null, until: 0 };
let boundaryPulse = 0;

const emit = () => { for (const fn of listeners) fn(voice.status()); };

// ---- text for the ear ------------------------------------------------------------------
const SPOKEN = {
  NAS100: 'the Nasdaq', SPX500: 'the S and P 500', XAUUSD: 'gold', USOIL: 'crude oil',
  EURUSD: 'euro dollar', GBPUSD: 'cable', USDJPY: 'dollar yen', BTCUSD: 'Bitcoin', ETHUSD: 'Ether', SOLUSD: 'Solana',
  US100: 'the Nasdaq', US500: 'the S and P 500',
};
export function speechText(line, { neuralEngine = false } = {}) {
  let s = String(line)
    .replace(/\b(US100|US500|USOIL)\.cash\b/g, (m, a) => SPOKEN[a] || a)
    .replace(/\bETH\s*\/\s*BTC\b/g, 'Ether against Bitcoin')
    .replace(/\b(NAS100|SPX500|XAUUSD|USOIL|EURUSD|GBPUSD|USDJPY|BTCUSD|ETHUSD|SOLUSD)\b/g, (m) => SPOKEN[m])
    .replace(/\bP&L\b/g, 'P and L')
    .replace(/\bFTMO\b/g, 'F T M O')
    .replace(/\bVWAP\b/g, 'V-wap')
    .replace(/\b(ATR|EMA|RSI|ADX|MT5|DOM)\b/g, (m) => m.split('').join(' '))
    .replace(/(\d)\s?R\b/g, '$1 R')
    .replace(/(\d)σ/g, '$1 sigma')
    .replace(/[−–]/g, '-')
    .replace(/-\$/g, 'minus $')
    .replace(/—/g, ', ')
    .replace(/·/g, ',')
    .replace(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?([kKmM])\b/g, (_, n, u) => `${n} ${/k/i.test(u) ? 'thousand' : 'million'} dollars`)
    .replace(/\$(\d[\d,]*(?:\.\d+)?)/g, '$1 dollars');
  if (neuralEngine) s = s.replace(/(\d),(\d{3})/g, '$1$2').replace(/(\d),(\d{3})/g, '$1$2');
  return s.replace(/\s+/g, ' ').trim();
}

// ---- system voices ------------------------------------------------------------------------
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|pipe organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|kathy|ralph|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley|deranged|hysterical)\b/i;
const FEMALE = /samantha|\bava\b|allison|susan|zoe|nicky|joelle|noelle|\bkate\b|serena|stephanie|martha|karen|catherine|matilda|moira|tessa|fiona|veena|isha|sangeeta|lekha|victoria|female|\baria\b|jenny|sonia|libby|natasha|neerja|\bemma\b|michelle|ava\s|salli|joanna|kendra|kimberly|amy/i;
const MALE = /\bevan\b|nathan|\btom\b|aaron|\balex\b|daniel|oliver|jamie|arthur|\blee\b|gordon|rishi|\bmale\b|\bguy\b|ryan|william|prabhat|davis|\btony\b|christopher|\beric\b|brian|andrew|george|matthew|joey|justin/i;

function quality(v) {
  const n = v.name;
  if (/premium/i.test(n)) return 60;
  if (/\(natural\)|neural|online/i.test(n)) return 56;
  if (/enhanced/i.test(n)) return 50;
  if (/^google/i.test(n)) return 32;
  if (/siri/i.test(n)) return 45;
  return 16;
}

function genderOf(v) {
  if (/google uk english male/i.test(v.name)) return 'male';
  if (/google (us|uk) english( female)?$/i.test(v.name)) return 'female';
  if (FEMALE.test(v.name)) return 'female';
  if (MALE.test(v.name)) return 'male';
  return null;
}

let profiles = [];
let assignment = new Map();

function candidateVoices() {
  if (!synth) return [];
  return synth.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang) && !NOVELTY.test(v.name));
}

function assignVoices() {
  const voices = candidateVoices();
  assignment = new Map();
  if (!voices.length) return;
  const used = new Map();
  for (const p of profiles) {
    const want = p.gender === 'female' ? 'female' : 'male';
    const lang = (p.voice?.lang || 'en-US').toLowerCase().replace('_', '-');
    let best = null;
    let bestScore = -Infinity;
    for (const v of voices) {
      const vl = v.lang.toLowerCase().replace('_', '-');
      const g = genderOf(v);
      let score = quality(v);
      const idx = (p.voice?.prefer || []).findIndex((n) => v.name.toLowerCase().startsWith(n.toLowerCase()) || v.name.toLowerCase().includes(`${n.toLowerCase()} (`));
      if (idx >= 0) score += 40 - idx * 5;
      if (vl === lang) score += 12;
      else if (vl.slice(0, 2) === lang.slice(0, 2)) score += vl === 'en-us' || vl === 'en-gb' ? 2 : 0;
      if (g === want) score += 20;
      else if (g) score -= 100;
      else score -= 12;
      score -= (used.get(v.name) || 0) * 22;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    if (best) {
      assignment.set(p.id, best);
      used.set(best.name, (used.get(best.name) || 0) + 1);
    }
  }
  emit();
}

if (synth) {
  assignVoices();
  synth.addEventListener?.('voiceschanged', assignVoices);
  if (!synth.addEventListener) synth.onvoiceschanged = assignVoices;
}

// ---- audio (neural playback + level metering) -----------------------------------------
function audio() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  buf = new Float32Array(analyser.fftSize);
  gain = ctx.createGain();
  gain.gain.value = 1;
  analyser.connect(gain).connect(ctx.destination);
  return ctx;
}

function playBuffer(audioBuffer) {
  return new Promise((resolve) => {
    const ac = audio();
    if (!ac) return resolve(false);
    const src = ac.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(analyser);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    src.onended = () => finish(true);
    current = { stop: () => { try { src.stop(); } catch { /* already stopped */ } finish(false); } };
    src.start();
  });
}

// One sentence of speech from the server, decoded and ready to play.
async function fetchSpeech(text, voiceId) {
  const res = await apiFetch('/api/voices/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice: voiceId }) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const bytes = await res.arrayBuffer();
  return audio().decodeAudioData(bytes);
}

function requestSetup() {
  apiFetch('/api/voices/setup', { method: 'POST' }).catch(() => {});
}

// ---- public API ---------------------------------------------------------------------------
export const voice = {
  get supported() { return !!synth || typeof Worker !== 'undefined'; },
  get engine() { return engine; },
  get enabled() { return engine !== 'off'; },

  status() {
    return { engine, neural: { ...neural }, systemVoices: candidateVoices().length, assigned: Object.fromEntries([...assignment].map(([id, v]) => [id, v.name])) };
  },

  on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  setProfiles(list) {
    profiles = list;
    assignVoices();
  },

  setEngine(next) {
    const was = engine;
    engine = next;
    store.set('floor.voiceEngine', next);
    if (next === 'off') this.stop();
    if (next === 'natural' && neural.state !== 'ready') requestSetup();
    if (was === 'natural' && next !== 'natural') apiFetch('/api/voices/disable', { method: 'POST' }).catch(() => {});
    emit();
  },

  // Server status for the realistic voice engine (pushed over the WebSocket).
  setServerStatus(st) {
    if (!st) return;
    Object.assign(neural, { state: st.state, step: st.step, progress: st.progress, loaded: st.loaded, total: st.total, error: st.error });
    // Chosen in this browser but not set up on this server yet (or it restarted): ask for it.
    if (engine === 'natural' && !st.wanted && st.state !== 'ready') requestSetup();
    emit();
  },

  prepare() {},

  // Browsers only allow audio after a click; call from click handlers.
  unlock() {
    const ac = audio();
    if (ac?.state === 'suspended') ac.resume();
  },

  systemVoiceFor(id) {
    return assignment.get(id)?.name || null;
  },

  stop() {
    speakToken++;
    current?.stop();
    current = null;
    this.speakerId = null;
    synth?.cancel();
  },

  speakerId: null,

  // 0..1 mouth opening for the agent who is talking (lip sync).
  level(id) {
    if (id && this.speakerId === id && analyser && current) {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      return Math.min(1, Math.max(0, (rms - 0.012) * 7));
    }
    const now = performance.now();
    if (id && ((this.speakerId === id && synth?.speaking) || (mimic.id === id && now < mimic.until))) {
      // System voices expose no audio: approximate syllables, boosted on word boundaries.
      boundaryPulse *= 0.9;
      const t = now / 1000;
      return Math.min(1, 0.18 + 0.32 * Math.abs(Math.sin(t * 11.5) * Math.sin(t * 4.3)) + boundaryPulse);
    }
    return 0;
  },

  isSpeaking(id) {
    if (!id) return false;
    if (this.speakerId === id && (current || synth?.speaking)) return true;
    return mimic.id === id && performance.now() < mimic.until;
  },

  // With voices off, animate the mouth for a while as the text types out.
  mimic(id, ms) {
    mimic = { id, until: performance.now() + ms };
  },

  // Speaks sentence by sentence, calling onLine(i) as each starts. Resolves true when
  // everything was spoken, false if muted, failed or interrupted.
  async speakLines(lines, profile, { onLine } = {}) {
    if (engine === 'off' || !lines.length) return false;
    this.stop();
    const token = speakToken;
    this.speakerId = profile.id;
    if (engine === 'natural' && neural.state === 'ready' && profile.voice?.neural) {
      this.unlock();
      // Ask for every sentence up front (the server makes them one by one); play in order.
      const jobs = lines.map((l) => fetchSpeech(speechText(l, { neuralEngine: true }), profile.voice.neural));
      jobs.forEach((j) => j.catch(() => {}));
      for (let i = 0; i < jobs.length; i++) {
        let buffer;
        try {
          buffer = await jobs[i];
        } catch (err) {
          // Never go silent: finish the briefing with the system voice and say why in settings.
          neural.lastError = err.message;
          emit();
          current = null;
          if (token !== speakToken) return false;
          return speakSystem(lines.slice(i), profile, token, (k) => onLine?.(i + k));
        }
        if (token !== speakToken) return false;
        onLine?.(i);
        const ok = await playBuffer(buffer);
        if (!ok || token !== speakToken) return false;
        if (i < jobs.length - 1) await new Promise((r) => setTimeout(r, 140));
      }
      current = null;
      if (token === speakToken) this.speakerId = null;
      return token === speakToken;
    }
    return speakSystem(lines, profile, token, onLine);
  },

  // A short line in the agent's voice, for the settings panel.
  preview(profile) {
    return this.speakLines([`Hello boss! ${profile.name.split(' ')[0]} here, ${profile.desk} desk.`], profile);
  },
};

function speakSystem(lines, profile, token, onLine) {
    return new Promise((resolve) => {
      if (!synth) return resolve(false);
      synth.cancel();
      const v = assignment.get(profile.id) || null;
      let started = false;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        if (token === speakToken) voice.speakerId = null;
        resolve(ok);
      };
      lines.forEach((text, i) => {
        const u = new SpeechSynthesisUtterance(speechText(text));
        if (v) {
          u.voice = v;
          u.lang = v.lang;
        }
        u.rate = /^google/i.test(v?.name || '') ? 0.98 : 1.0;
        u.pitch = 1;
        u.onstart = () => {
          if (token !== speakToken) return;
          started = true;
          onLine?.(i);
        };
        u.onboundary = () => { boundaryPulse = 0.35; };
        u.onend = () => {
          if (i === lines.length - 1) finish(started && token === speakToken);
        };
        u.onerror = () => finish(false);
        synth.speak(u);
      });
    });
}
