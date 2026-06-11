// speech.js — text-to-speech playback and voice answer recognition.
// Built on the browser Web Speech API (SpeechSynthesis + SpeechRecognition).

export const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

const SR = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;
export const sttSupported = Boolean(SR);

// Voices load asynchronously in some browsers.
let cachedVoices = [];
function loadVoices() {
  if (!ttsSupported) return;
  cachedVoices = window.speechSynthesis.getVoices() || [];
}
if (ttsSupported) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function pickVoice() {
  if (!cachedVoices.length) loadVoices();
  const en = cachedVoices.filter((v) => /^en(-|_|$)/i.test(v.lang));
  const pool = en.length ? en : cachedVoices;
  // Prefer a natural-sounding, local voice when one is offered.
  const preferred =
    pool.find((v) => /natural|google|samantha|daniel|aria|jenny/i.test(v.name)) ||
    pool.find((v) => v.localService) ||
    pool[0];
  return preferred || null;
}

// Split prose into chunks (sentence-ish) so we get progress + reliable playback.
function chunkText(text) {
  const parts = String(text)
    .replace(/\s+/g, ' ')
    .match(/[^.!?]+[.!?]*\s*/g) || [text];
  // Merge tiny fragments so very short sentences don't cause choppy speech.
  const out = [];
  let buf = '';
  for (const p of parts) {
    buf += p;
    if (buf.length > 90) { out.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/**
 * LecturePlayer — plays a long string of prose with play / pause / restart and
 * a progress callback (0..1). Single active player at a time.
 */
export class LecturePlayer {
  constructor(text, { onProgress, onState } = {}) {
    this.chunks = chunkText(text);
    this.i = 0;
    this.onProgress = onProgress || (() => {});
    this.onState = onState || (() => {});
    this.voice = pickVoice();
    this.state = 'idle'; // idle | playing | paused | done
  }

  _emitProgress() {
    const frac = this.chunks.length ? this.i / this.chunks.length : 0;
    this.onProgress(Math.min(1, frac));
  }

  _setState(s) {
    this.state = s;
    this.onState(s);
  }

  _speakCurrent() {
    if (this.i >= this.chunks.length) {
      stopKeepalive();
      this._setState('done');
      this.onProgress(1);
      return;
    }
    const u = new SpeechSynthesisUtterance(this.chunks[this.i]);
    if (this.voice) u.voice = this.voice;
    u.rate = 0.98;
    u.pitch = 1.0;
    u.onend = () => {
      if (this.state !== 'playing') return; // stopped/paused mid-way
      this.i += 1;
      this._emitProgress();
      this._speakCurrent();
    };
    u.onerror = () => {
      // Treat errors as "move on" so a single bad chunk can't wedge playback.
      if (this.state !== 'playing') return;
      this.i += 1;
      this._speakCurrent();
    };
    window.speechSynthesis.speak(u);
  }

  play() {
    if (!ttsSupported) return;
    window.speechSynthesis.cancel(); // clear any stale queue
    if (this.state === 'done') this.i = 0;
    this._setState('playing');
    this._emitProgress();
    startKeepalive();
    this._speakCurrent();
  }

  pause() {
    if (this.state !== 'playing') return;
    window.speechSynthesis.cancel();
    stopKeepalive();
    this._setState('paused');
  }

  toggle() {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  restart() {
    window.speechSynthesis.cancel();
    this.i = 0;
    this._emitProgress();
    this.play();
  }

  stop() {
    window.speechSynthesis.cancel();
    stopKeepalive();
    this._setState('idle');
  }
}

// ---------------------------------------------------------------------------
// Silent audio keepalive — prevents the OS from suspending SpeechSynthesis
// when the screen locks or the tab goes to the background. A 1-second silent
// MP3 played in a loop holds the audio session open for the duration of TTS.
// ---------------------------------------------------------------------------

// Smallest valid MP3: 1 s of silence, base64-encoded.
const SILENT_MP3 =
  'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA' +
  '//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADwAD////////////' +
  '////////////////////////////////////////////////////////////////8AAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/7UEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABJbmZvAAAADwAAAAIAAADAAP' +
  '///////////////////////////////////////////////////////////////////////8AAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/7UMAAAAAA2gAAAAAAAANIAAAAEAAABpAAAA';

let keepaliveAudio = null;

function startKeepalive() {
  if (keepaliveAudio) return;
  try {
    keepaliveAudio = new Audio(SILENT_MP3);
    keepaliveAudio.loop = true;
    keepaliveAudio.volume = 0;
    keepaliveAudio.play().catch(() => {});
  } catch {
    keepaliveAudio = null;
  }
}

function stopKeepalive() {
  if (!keepaliveAudio) return;
  keepaliveAudio.pause();
  keepaliveAudio.src = '';
  keepaliveAudio = null;
}

/** Speak a single utterance, resolving when finished. */
export function say(text, { rate = 1.0 } = {}) {
  return new Promise((resolve) => {
    if (!ttsSupported) return resolve();
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = rate;
    startKeepalive();
    const finish = () => { stopKeepalive(); resolve(); };
    u.onend = finish;
    u.onerror = finish;
    window.speechSynthesis.speak(u);
  });
}

export function cancelSpeech() {
  if (ttsSupported) window.speechSynthesis.cancel();
  stopKeepalive();
}

/**
 * Check whether microphone access is available.
 * Returns: 'ok' | 'permission' | 'error'
 */
export async function checkMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'error';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return 'ok';
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') return 'permission';
    return 'error';
  }
}

/**
 * Listen once for a spoken phrase. Resolves with the transcript string, or ''
 * on no-result / error. Returns a controller too so callers can abort.
 */
export function listenOnce({ timeout = 8000 } = {}) {
  if (!sttSupported) return { promise: Promise.resolve(''), abort() {} };

  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 3;
  rec.continuous = false;

  let done = false;
  let timer = null;

  const promise = new Promise((resolve) => {
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { rec.stop(); } catch {}
      resolve(val);
    };
    rec.onresult = (e) => {
      let best = '';
      for (const res of e.results) {
        for (const alt of res) best += alt.transcript + ' ';
      }
      finish(best.trim());
    };
    rec.onerror = (e) => {
      // 'no-speech' is normal — just let the timeout handle it.
      if (e.error === 'no-speech') return;
      finish('');
    };
    // onend fires after both success and failure; only use it as a fallback
    // if we haven't already resolved via onresult/onerror.
    rec.onend = () => { if (!done) finish(''); };
    try { rec.start(); } catch { finish(''); }
    timer = setTimeout(() => finish(''), timeout);
  });

  return { promise, abort: () => { try { rec.abort(); } catch {} } };
}

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, first: 1, second: 2, third: 3, fourth: 4, last: -1 };

/**
 * Match a spoken transcript to one of the quiz options.
 * Recognizes: letters (a/b/c/d), numbers (1-4 / one-four), ordinals
 * (first..fourth, last), or fuzzy overlap with the option text.
 * Returns the 0-based index, or -1 if nothing matched.
 */
export function matchAnswer(transcript, options) {
  const t = String(transcript || '').toLowerCase().trim();
  if (!t) return -1;
  const n = options.length;

  // letter: "a", "option b", "the answer is c"
  const letter = t.match(/\b(?:option |answer (?:is )?)?([a-d])\b/);
  if (letter) {
    const idx = letter[1].charCodeAt(0) - 97;
    if (idx >= 0 && idx < n) return idx;
  }

  // digit
  const digit = t.match(/\b([1-9])\b/);
  if (digit) {
    const idx = parseInt(digit[1], 10) - 1;
    if (idx >= 0 && idx < n) return idx;
  }

  // number / ordinal word
  for (const [word, val] of Object.entries(WORD_NUM)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) {
      const idx = val === -1 ? n - 1 : val - 1;
      if (idx >= 0 && idx < n) return idx;
    }
  }

  // fuzzy text overlap: score each option by shared words
  const stop = new Set(['the', 'a', 'an', 'of', 'to', 'is', 'in', 'and', 'or', 'it', 'that', 'this']);
  const tWords = new Set(t.split(/\W+/).filter((w) => w.length > 2 && !stop.has(w)));
  let bestIdx = -1;
  let bestScore = 0;
  options.forEach((opt, idx) => {
    const oWords = String(opt).toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !stop.has(w));
    if (!oWords.length) return;
    let hits = 0;
    for (const w of oWords) if (tWords.has(w)) hits += 1;
    const score = hits / oWords.length;
    if (score > bestScore) { bestScore = score; bestIdx = idx; }
  });
  if (bestScore >= 0.5) return bestIdx;

  return -1;
}
