'use strict';

/**
 * Unified LLM interface. Every provider exposes the same call:
 *
 *   chat(system, user) -> Promise<string>   // returns the model's text
 *
 * Supported providers: claude, openai, gemini, and a keyless "mock" that
 * fabricates plausible (clearly placeholder) course content so the whole app
 * is usable before any API keys are configured.
 *
 * Uses Node 18+ global fetch — no SDK dependencies.
 */

const PROVIDERS = {
  claude: {
    label: 'Claude (Anthropic)',
    envKey: 'ANTHROPIC_API_KEY',
    model: () => process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  },
  openai: {
    label: 'ChatGPT (OpenAI)',
    envKey: 'OPENAI_API_KEY',
    model: () => process.env.OPENAI_MODEL || 'gpt-4o',
  },
  gemini: {
    label: 'Gemini (Google)',
    envKey: 'GEMINI_API_KEY',
    model: () => process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  },
  mock: {
    label: 'Demo (no API key)',
    envKey: null,
    model: () => 'figaro-mock-v1',
  },
};

/** List providers with whether they're usable (key present, or mock). */
function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    model: p.model(),
    available: id === 'mock' ? true : Boolean(process.env[p.envKey]),
  }));
}

function isAvailable(id) {
  if (id === 'mock') return true;
  const p = PROVIDERS[id];
  return Boolean(p && p.envKey && process.env[p.envKey]);
}

/**
 * Pick the provider to actually use. Honors the requested one if it's valid
 * and available; otherwise falls back to DEFAULT_PROVIDER, then to any
 * available real provider, then to mock.
 */
function resolveProvider(requested) {
  if (requested && isAvailable(requested)) return requested;
  const def = process.env.DEFAULT_PROVIDER;
  if (def && isAvailable(def)) return def;
  const firstReal = ['claude', 'openai', 'gemini'].find(isAvailable);
  return firstReal || 'mock';
}

// --- Provider implementations ---------------------------------------------

async function callClaude(system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: PROVIDERS.claude.model(),
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

async function callOpenAI(system, user) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: PROVIDERS.openai.model(),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGemini(system, user) {
  const model = PROVIDERS.gemini.model();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
    `?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('');
}

// --- Mock provider ---------------------------------------------------------
// Reads markers in the prompt to decide which canned JSON to return, and
// pulls the topic / lesson title out so the placeholder feels relevant.

function mockChat(system, user) {
  const topic = (user.match(/study:\s*"([^"]+)"/) || [])[1] || 'your topic';

  // NOTE: order matters. The outline prompt also contains the words
  // "diagnostic questions" (it quotes the learner's answers to them), so the
  // lesson and outline branches are checked first with markers unique to each.
  if (/Write lesson \d+/i.test(user)) {
    const title = (user.match(/Write lesson \d+:\s*"([^"]+)"/) || [])[1] || 'this lesson';
    return mockLesson(title);
  }

  if (/design a focused course/i.test(user)) {
    const titles = [
      `Getting Oriented in ${topic}`,
      `The Core Vocabulary of ${topic}`,
      `How ${topic} Works in Practice`,
      `Common Pitfalls and How to Avoid Them`,
      `Putting ${topic} Together`,
    ];
    return JSON.stringify({
      title: `A Friendly Path into ${topic}`,
      level: 'beginner',
      summary:
        `A demo course on ${topic} generated by Figaro's offline mock provider. ` +
        `Add a real API key in your .env to get genuinely tailored content.`,
      lessons: titles.map((t) => ({
        title: t,
        summary: `A short look at ${t.toLowerCase()}.`,
      })),
    });
  }

  if (/diagnostic questions that probe/i.test(user)) {
    return JSON.stringify({
      questions: [
        { id: 'q1', question: `In your own words, what does "${topic}" mean to you right now?` },
        { id: 'q2', question: `Have you encountered any of the core ideas behind ${topic} before? Which ones?` },
        { id: 'q3', question: `Can you describe a situation where ${topic} would be useful?` },
        { id: 'q4', question: `What is the hardest thing you expect about learning ${topic}?` },
      ],
    });
  }

  return JSON.stringify({ error: 'mock could not classify the request' });
}

// Builds a placeholder lecture + quiz for the demo provider.
function mockLesson(title) {
    const lecture =
      `Welcome back. In this lesson we are going to explore ${title.toLowerCase()}. ` +
      `This text was produced by Figaro's built-in demo provider, so it is intentionally ` +
      `generic — but it shows you exactly how a real five-minute audio lecture will flow ` +
      `once you connect Claude, ChatGPT, or Gemini. ` +
      `Imagine an instructor speaking warmly and directly to you. They would open by ` +
      `framing why this idea matters, then walk through it one careful step at a time, ` +
      `pausing to connect each new piece back to what you already understand. ` +
      `They would offer a concrete example, anticipate the question forming in your mind, ` +
      `and answer it before you have to ask. ` +
      `Along the way they would repeat the single most important takeaway in a few ` +
      `different ways, because hearing an idea from several angles is how it sticks. ` +
      `By the end of a real lesson you would be able to explain the concept to a friend ` +
      `in your own words, recognize it out in the wild, and avoid the most common mistakes ` +
      `beginners make. ` +
      `To wrap up: connect a provider in your .env file, pick it from the menu, and Figaro ` +
      `will replace this placeholder with a lecture written precisely for your level and your ` +
      `chosen topic. For now, take the short quiz below to see how the assessment flow works.`;
    return JSON.stringify({
      lecture,
      quiz: [
        {
          question: 'What is producing this particular lesson text?',
          options: ['Claude', 'A connected provider', "Figaro's offline demo mock", 'Random noise'],
          answer: 2,
          explanation: 'With no API key set, Figaro falls back to the built-in mock provider.',
        },
        {
          question: 'Roughly how long is a Figaro audio lecture meant to be?',
          options: ['About 30 seconds', 'About 5 minutes', 'About 1 hour', 'It varies wildly'],
          answer: 1,
          explanation: 'Each lesson is scoped to roughly five minutes of speech.',
        },
        {
          question: 'How do you unlock genuinely tailored lessons?',
          options: ['Refresh the page', 'Add an API key and pick that provider', 'Wait 24 hours', 'Nothing is needed'],
          answer: 1,
          explanation: 'Add a key to .env and select that provider in the app.',
        },
        {
          question: 'What score do you need for the green check of mastery?',
          options: ['50% or more', '70% or more', '80% or more', '100%'],
          answer: 2,
          explanation: 'Figaro awards the green check at 80% and above.',
        },
        {
          question: 'How can you answer quiz questions in Figaro?',
          options: ['Only by typing', 'Only by voice', 'Hands-free by voice OR by tapping', 'By email'],
          answer: 2,
          explanation: 'Every quiz supports both hands-free voice answers and tapping.',
        },
      ],
    });
}

// --- Public API ------------------------------------------------------------

async function chat(provider, system, user) {
  switch (provider) {
    case 'claude':
      return callClaude(system, user);
    case 'openai':
      return callOpenAI(system, user);
    case 'gemini':
      return callGemini(system, user);
    case 'mock':
    default:
      return mockChat(system, user);
  }
}

/** Defensively extract a JSON object/array from a model response. */
function parseJson(text) {
  if (typeof text !== 'string') throw new Error('Expected string from model');
  let s = text.trim();

  // Strip ```json ... ``` or ``` ... ``` fences.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // Fast path.
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }

  // Slice from first opening brace/bracket to its matching last one.
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1;
  let openCh = '{';
  let closeCh = '}';
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    start = firstArr;
    openCh = '[';
    closeCh = ']';
  } else if (firstObj !== -1) {
    start = firstObj;
  }
  if (start === -1) throw new Error('No JSON found in model response');

  const end = s.lastIndexOf(closeCh);
  if (end <= start) throw new Error('Malformed JSON in model response');

  return JSON.parse(s.slice(start, end + 1));
}

module.exports = { listProviders, resolveProvider, isAvailable, chat, parseJson, PROVIDERS };
