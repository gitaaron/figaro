# Figaro 🎙️

**Figaro** is a web-based, mobile-friendly app that turns any large language model into a personal tutor.

Tell it what you want to learn, answer a few diagnostic questions, and it builds you a course of bite-sized **five-minute audio lectures**, each capped with a quiz you can take **hands-free (by voice)** or by tapping.

Score 80% or higher and the lesson earns a green check.

Everything you generate is **saved on the machine running the server**, so your courses persist between sessions.

---

## Highlights

- **Ask anything** — _"What do you want to know about?"_ kicks off a new course.
- **Adaptive** — Figaro quizzes your prerequisite knowledge first, then pitches the course at your level.
- **Five-minute audio lectures** — lessons are read aloud with the browser's speech engine; a full transcript is always available.
- **Two quiz modes** — answer **hands-free by voice** ("A", "two", or say the option) or **tap** your way through.
- **Mastery check** — see your score with a green check at 80%+.
- **Multiple courses** — build as many as you like; they're listed on the home screen.
- **Switch models** — use **Claude**, **ChatGPT (OpenAI)**, or **Gemini** from the dropdown in the header.
- **Runs with zero keys** — a built-in **demo (mock) provider** lets you explore the entire flow before adding any credentials.
- **Local persistence** — each course is a JSON file under `data/courses/`.

---

## Requirements

- **Node.js 18 or newer** (uses the built-in `fetch`).
- A modern browser. Voice features (text-to-speech and speech recognition) work best in **Chrome** or **Edge**; everything else works everywhere, and the transcript is always available if narration isn't supported.

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure (optional — Figaro runs in demo mode without this)
cp .env.example .env
#   then open .env and paste in a key for any provider you want to use

# 3. Run
npm start
```

Open **http://localhost:3000**.

> **No API key?** No problem. Figaro starts in **demo mode** using a built-in mock provider that fabricates placeholder lessons so you can try the whole experience. Add a real key and pick that model from the dropdown to get genuine, tailored content.

---

## Configuration (`.env`)

| Variable            | Purpose                                              | Default              |
|---------------------|------------------------------------------------------|----------------------|
| `PORT`              | Server port                                          | `3000`               |
| `DEFAULT_PROVIDER`  | `claude` \| `openai` \| `gemini` \| `mock`           | `mock`               |
| `ANTHROPIC_API_KEY` | Claude key — get one at console.anthropic.com        | —                    |
| `CLAUDE_MODEL`      | Claude model string                                  | `claude-sonnet-4-6`  |
| `OPENAI_API_KEY`    | OpenAI key — get one at platform.openai.com          | —                    |
| `OPENAI_MODEL`      | OpenAI model string                                  | `gpt-4o`             |
| `GEMINI_API_KEY`    | Google AI Studio key — aistudio.google.com           | —                    |
| `GEMINI_MODEL`      | Gemini model string                                  | `gemini-2.0-flash`   |

You only need a key for the provider(s) you actually select. Models you have no key for appear greyed-out in the dropdown. Model names change over time — update the `*_MODEL` values if a provider retires one.

---

## How it works

```
Browser (vanilla JS SPA)                 Node + Express server
┌───────────────────────────┐           ┌──────────────────────────────┐
│ Home: "What do you want    │           │ POST /api/assess             │
│        to know about?"     │──topic──► │   → diagnostic questions     │
│ Assessment questions       │           │ POST /api/courses            │
│ Course + lesson list       │◄─course── │   → leveled course outline   │
│ Audio lecture (TTS)        │           │ POST /.../lessons/:i/generate│
│ Quiz (voice or tap)        │◄─lesson── │   → 5-min lecture + quiz      │
│ Score + green check        │──score──► │ POST /.../lessons/:i/complete│
└───────────────────────────┘           │ Persist → data/courses/*.json│
                                         └──────────────┬───────────────┘
                                                        │
                                  ┌─────────────────────┴─────────────────────┐
                                  │  LLM router → Claude · OpenAI · Gemini ·   │
                                  │              built-in mock                 │
                                  └────────────────────────────────────────────┘
```

Lessons are generated **lazily** — the outline is created up front, and each lecture + quiz is generated (and then cached on disk) the first time you open that lesson. API keys live only on the server; the browser never sees them.

---

## Project structure

```
figaro/
├── package.json
├── .env.example            # copy to .env and add your keys
├── .gitignore
├── README.md
├── server/
│   ├── index.js            # Express app + static hosting + SPA fallback
│   ├── store.js            # JSON file persistence (data/courses/*.json)
│   ├── llm.js              # provider router: claude / openai / gemini / mock
│   ├── prompts.js          # prompt templates for the 3 generation tasks
│   └── routes/
│       └── courses.js      # REST API
├── public/
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── app.js          # router + shell + home/assess/course/lesson views
│       ├── quiz.js         # quiz runner (voice + manual) + results
│       ├── speech.js       # text-to-speech + voice recognition helpers
│       ├── api.js          # backend API client
│       └── ui.js           # tiny DOM helpers
└── data/
    └── courses/            # generated courses are saved here (git-ignored)
```

---

## Turn this into a git repository

From inside the unzipped folder:

```bash
git init
git add .
git commit -m "Initial commit: Figaro LLM tutor"
```

The included `.gitignore` keeps `node_modules/`, your `.env` secrets, and generated course files out of version control.

---

## Notes & limitations

- **Voice recognition** uses the Web Speech API, which is best supported in Chromium-based browsers and requires microphone permission. If it's unavailable, the hands-free option is disabled and you can still tap your answers.
- **Audio narration** uses the browser's built-in voices, which vary by OS/browser. No external TTS service or key is required. (To upgrade to a cloud TTS voice later, swap the implementation in `public/js/speech.js`.)
- The JSON file store is intended for **single-user local use**. For multi-user or production scenarios, replace `server/store.js` with a real database.

---

## License

MIT — do whatever you like.
