'use strict';

/**
 * tts.js — server-side text-to-speech with streaming + disk caching.
 *
 * Provider is selected by TTS_PROVIDER in .env:
 *   gtts       — Google TTS via Python's gTTS library (no API key needed)
 *   openai     — OpenAI TTS API  (requires OPENAI_API_KEY)
 *   elevenlabs — ElevenLabs API  (requires ELEVENLABS_API_KEY)
 *
 * On the first request for a lesson the audio is generated and simultaneously
 * streamed to the HTTP response and written to disk. The browser starts
 * receiving audio bytes immediately — it doesn't wait for generation to finish.
 *
 * Subsequent requests are served straight from the cached file.
 *
 * Cache location: data/audio/<courseId>/<lessonIndex>.mp3
 */

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data', 'audio');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function audioPath(courseId, lessonIndex) {
  const safeId  = String(courseId).replace(/[^a-z0-9]/gi, '');
  const safeIdx = String(Number(lessonIndex));
  const dir = path.join(DATA_DIR, safeId);
  ensureDir(dir);
  return path.join(dir, `${safeIdx}.mp3`);
}

function isCached(filePath) {
  try { return fs.statSync(filePath).size > 0; } catch { return false; }
}

// In-flight generation promises keyed by filePath.
// Multiple simultaneous requests for the same lesson wait on the same promise
// instead of spawning duplicate generation jobs.
const inFlight = new Map();

// ---------------------------------------------------------------------------
// Provider: gTTS
// gTTS writes the whole file before we can stream it, so we generate to a
// temp path, then stream from disk once done. Still faster than buffering
// everything in memory first.
// ---------------------------------------------------------------------------
function generateGtts(text, outPath) {
  return new Promise((resolve, reject) => {
    const tmpText   = outPath + '.txt';
    const tmpScript = outPath + '.py';
    fs.writeFileSync(tmpText, text, 'utf8');
    fs.writeFileSync(tmpScript, `
import sys
from gtts import gTTS
text = open(sys.argv[1], encoding='utf-8').read()
tts = gTTS(text=text, lang='en', slow=False)
tts.save(sys.argv[2])
`.trim(), 'utf8');

    execFile('python3', [tmpScript, tmpText, outPath], { timeout: 120000 }, (err) => {
      try { fs.unlinkSync(tmpText);   } catch {}
      try { fs.unlinkSync(tmpScript); } catch {}
      if (err) return reject(new Error(`gTTS failed: ${err.message}`));
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers for streaming providers (OpenAI, ElevenLabs)
//
// streamToFileAndResponse pipes the TTS HTTP response body to:
//   1. A write stream → disk cache
//   2. The Express response → browser (starts playing immediately)
// ---------------------------------------------------------------------------
function streamToFileAndResponse(ttsRes, filePath, expressRes) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(filePath);

    ttsRes.on('data', (chunk) => {
      fileStream.write(chunk);
      // Only forward to client if it's still connected.
      if (!expressRes.writableEnded) expressRes.write(chunk);
    });

    ttsRes.on('end', () => {
      fileStream.end();
      if (!expressRes.writableEnded) expressRes.end();
      resolve();
    });

    ttsRes.on('error', (err) => {
      fileStream.destroy(err);
      reject(err);
    });

    fileStream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Provider: OpenAI TTS (true streaming)
// ---------------------------------------------------------------------------
function streamOpenAI(text, filePath, expressRes) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return Promise.reject(new Error('OPENAI_API_KEY is not set.'));

  const body = JSON.stringify({
    model: process.env.OPENAI_TTS_MODEL || 'tts-1',
    input: text,
    voice: process.env.OPENAI_TTS_VOICE || 'alloy',
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/speech',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (ttsRes) => {
      if (ttsRes.statusCode !== 200) {
        let errBody = '';
        ttsRes.on('data', (c) => { errBody += c; });
        ttsRes.on('end', () => reject(new Error(`OpenAI TTS error ${ttsRes.statusCode}: ${errBody}`)));
        return;
      }
      streamToFileAndResponse(ttsRes, filePath, expressRes).then(resolve, reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Provider: ElevenLabs (true streaming)
// ---------------------------------------------------------------------------
function streamElevenLabs(text, filePath, expressRes) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return Promise.reject(new Error('ELEVENLABS_API_KEY is not set.'));

  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
  const body = JSON.stringify({
    text,
    model_id: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2',
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'audio/mpeg',
      },
    }, (ttsRes) => {
      if (ttsRes.statusCode !== 200) {
        let errBody = '';
        ttsRes.on('data', (c) => { errBody += c; });
        ttsRes.on('end', () => reject(new Error(`ElevenLabs error ${ttsRes.statusCode}: ${errBody}`)));
        return;
      }
      streamToFileAndResponse(ttsRes, filePath, expressRes).then(resolve, reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function resolveProvider() {
  const p = (process.env.TTS_PROVIDER || 'gtts').toLowerCase();
  if (!['gtts', 'openai', 'elevenlabs'].includes(p)) {
    throw new Error(`Unknown TTS_PROVIDER "${p}". Use gtts, openai, or elevenlabs.`);
  }
  return p;
}

/**
 * Stream audio to `expressRes`, generating and caching it on first call.
 *
 * For streaming providers (openai, elevenlabs) the response headers are sent
 * here and bytes flow as they arrive from the TTS API.
 *
 * For gTTS the file is generated first (unavoidable — it's a subprocess), then
 * streamed from disk.
 *
 * Concurrent requests for the same lesson share one in-flight generation.
 */
async function streamAudio(courseId, lessonIndex, text, expressRes) {
  const filePath = audioPath(courseId, lessonIndex);
  const provider = resolveProvider();

  function serveFromDisk(res) {
    const size = fs.statSync(filePath).size;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', size);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(filePath).pipe(res);
  }

  // Cache hit — serve straight from disk.
  if (isCached(filePath)) {
    serveFromDisk(expressRes);
    return;
  }

  // If another request is already generating this file, wait for it then
  // serve from disk (the generating request handles its own response).
  if (inFlight.has(filePath)) {
    try {
      await inFlight.get(filePath);
    } catch {
      // Generation failed for the other request; try again for this one.
    }
    if (isCached(filePath)) {
      serveFromDisk(expressRes);
    } else {
      expressRes.status(502).json({ error: 'Audio generation failed.' });
    }
    return;
  }

  console.log(`[tts] generating audio via ${provider} for course=${courseId} lesson=${lessonIndex}`);

  // Send headers before we start so the browser can begin buffering.
  expressRes.setHeader('Content-Type', 'audio/mpeg');
  expressRes.setHeader('Cache-Control', 'public, max-age=86400');

  let generationPromise;

  if (provider === 'gtts') {
    // gTTS: generate to disk, then stream the file.
    generationPromise = generateGtts(text, filePath).then(() => {
      if (!expressRes.writableEnded) {
        serveFromDisk(expressRes);
      }
    });
  } else if (provider === 'openai') {
    generationPromise = streamOpenAI(text, filePath, expressRes);
  } else {
    generationPromise = streamElevenLabs(text, filePath, expressRes);
  }

  inFlight.set(filePath, generationPromise);

  try {
    await generationPromise;
    console.log(`[tts] saved ${filePath}`);
  } catch (err) {
    // Clean up partial file so a retry starts fresh.
    try { fs.unlinkSync(filePath); } catch {}
    if (!expressRes.headersSent) {
      expressRes.status(502).json({ error: `TTS generation failed: ${err.message}` });
    } else if (!expressRes.writableEnded) {
      expressRes.end();
    }
    throw err;
  } finally {
    inFlight.delete(filePath);
  }
}

/**
 * Pre-warm the audio cache for a lesson without streaming to any client.
 * Safe to call fire-and-forget — logs but does not throw.
 */
async function warmAudio(courseId, lessonIndex, text) {
  const filePath = audioPath(courseId, lessonIndex);
  if (isCached(filePath) || inFlight.has(filePath)) return;

  const provider = resolveProvider();
  console.log(`[tts] warming audio via ${provider} for course=${courseId} lesson=${lessonIndex}`);

  let generationPromise;

  if (provider === 'gtts') {
    generationPromise = generateGtts(text, filePath);
  } else if (provider === 'openai') {
    // Use a PassThrough sink so streamOpenAI has somewhere to write
    // while we discard the bytes (they're already going to disk via fileStream).
    const { PassThrough } = require('stream');
    const sink = new PassThrough();
    sink.resume(); // drain
    generationPromise = streamOpenAI(text, filePath, sink);
  } else {
    const { PassThrough } = require('stream');
    const sink = new PassThrough();
    sink.resume();
    generationPromise = streamElevenLabs(text, filePath, sink);
  }

  inFlight.set(filePath, generationPromise);
  try {
    await generationPromise;
    console.log(`[tts] warmed ${filePath}`);
  } catch (err) {
    console.error(`[tts] warm failed for course=${courseId} lesson=${lessonIndex}:`, err.message);
    try { fs.unlinkSync(filePath); } catch {}
  } finally {
    inFlight.delete(filePath);
  }
}

function deleteAudio(courseId, lessonIndex) {
  try { fs.unlinkSync(audioPath(courseId, lessonIndex)); } catch {}
}

function deleteCourseAudio(courseId) {
  const safeId = String(courseId).replace(/[^a-z0-9]/gi, '');
  try { fs.rmSync(path.join(DATA_DIR, safeId), { recursive: true, force: true }); } catch {}
}

module.exports = { streamAudio, warmAudio, deleteAudio, deleteCourseAudio, resolveProvider };
