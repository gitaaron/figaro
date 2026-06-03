'use strict';

/**
 * tts.js — server-side text-to-speech.
 *
 * Provider is selected by TTS_PROVIDER in .env:
 *   gtts       — Google TTS via Python's gTTS library (no API key needed)
 *   openai     — OpenAI TTS API  (requires OPENAI_API_KEY)
 *   elevenlabs — ElevenLabs API  (requires ELEVENLABS_API_KEY)
 *
 * Generated audio is cached as MP3 at:
 *   data/audio/<courseId>/<lessonIndex>.mp3
 *
 * Re-uses the cached file on subsequent requests.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const https = require('https');
const http = require('http');

const DATA_DIR = path.join(__dirname, '..', 'data', 'audio');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function audioPath(courseId, lessonIndex) {
  const safeId = String(courseId).replace(/[^a-z0-9]/gi, '');
  const safeIdx = String(Number(lessonIndex));
  const dir = path.join(DATA_DIR, safeId);
  ensureDir(dir);
  return path.join(dir, `${safeIdx}.mp3`);
}

function isCached(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Provider: gTTS (Google TTS via Python)
// ---------------------------------------------------------------------------
function generateGtts(text, outPath) {
  return new Promise((resolve, reject) => {
    // Write text to a temp file to avoid shell-injection / length limits.
    const tmpText = outPath + '.txt';
    fs.writeFileSync(tmpText, text, 'utf8');

    const script = `
import sys
from gtts import gTTS
text = open(sys.argv[1], encoding='utf-8').read()
tts = gTTS(text=text, lang='en', slow=False)
tts.save(sys.argv[2])
`.trim();

    const tmpScript = outPath + '.py';
    fs.writeFileSync(tmpScript, script, 'utf8');

    execFile('python3', [tmpScript, tmpText, outPath], { timeout: 60000 }, (err) => {
      try { fs.unlinkSync(tmpText); } catch {}
      try { fs.unlinkSync(tmpScript); } catch {}
      if (err) return reject(new Error(`gTTS failed: ${err.message}`));
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Provider: OpenAI TTS
// ---------------------------------------------------------------------------
async function generateOpenAI(text, outPath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set.');

  const model = process.env.OPENAI_TTS_MODEL || 'tts-1';
  const voice = process.env.OPENAI_TTS_VOICE || 'alloy';

  const body = JSON.stringify({ model, input: text, voice });

  const data = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/audio/speech',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => { errBody += c; });
          res.on('end', () => reject(new Error(`OpenAI TTS error ${res.statusCode}: ${errBody}`)));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  fs.writeFileSync(outPath, data);
}

// ---------------------------------------------------------------------------
// Provider: ElevenLabs
// ---------------------------------------------------------------------------
async function generateElevenLabs(text, outPath) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set.');

  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // "Sarah"
  const model = process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2';

  const body = JSON.stringify({
    text,
    model_id: model,
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  });

  const data = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${voiceId}`,
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'audio/mpeg',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => { errBody += c; });
          res.on('end', () => reject(new Error(`ElevenLabs error ${res.statusCode}: ${errBody}`)));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  fs.writeFileSync(outPath, data);
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
 * Returns the path to the cached MP3, generating it first if needed.
 * Throws on generation failure.
 */
async function getAudio(courseId, lessonIndex, text) {
  const filePath = audioPath(courseId, lessonIndex);

  if (isCached(filePath)) {
    return filePath;
  }

  const provider = resolveProvider();
  console.log(`[tts] generating audio via ${provider} for course=${courseId} lesson=${lessonIndex}`);

  switch (provider) {
    case 'gtts':
      await generateGtts(text, filePath);
      break;
    case 'openai':
      await generateOpenAI(text, filePath);
      break;
    case 'elevenlabs':
      await generateElevenLabs(text, filePath);
      break;
  }

  if (!isCached(filePath)) {
    throw new Error('TTS generated an empty file.');
  }

  console.log(`[tts] saved ${filePath}`);
  return filePath;
}

/**
 * Delete cached audio for a lesson (e.g. when lesson is regenerated).
 */
function deleteAudio(courseId, lessonIndex) {
  const filePath = audioPath(courseId, lessonIndex);
  try { fs.unlinkSync(filePath); } catch {}
}

/**
 * Delete all cached audio for a course.
 */
function deleteCourseAudio(courseId) {
  const safeId = String(courseId).replace(/[^a-z0-9]/gi, '');
  const dir = path.join(DATA_DIR, safeId);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

module.exports = { getAudio, deleteAudio, deleteCourseAudio, resolveProvider };
