// app.js — application shell: provider selector, hash router, and the
// home / assessment / course / lesson views. Quiz lives in quiz.js.

import { el, clear, showToast } from './ui.js';
import { api } from './api.js';
import { mountQuiz } from './quiz.js';
import { say, listenOnce, cancelSpeech, checkMic, ttsSupported, sttSupported } from './speech.js';

const mount = document.getElementById('view');
const settingsBtn = document.getElementById('settings-btn');

// ---- app state ------------------------------------------------------------
const state = {
  providers: [],
  defaultProvider: 'mock',
  selectedProvider: localStorage.getItem('figaro.provider') || null,
  flow: null, // transient course-creation flow: { topic, questions }
};

function currentProvider() {
  if (state.selectedProvider) return state.selectedProvider;
  return state.defaultProvider;
}

function providerAvailable(id) {
  const p = state.providers.find((x) => x.id === id);
  return p ? p.available : false;
}

function onlyMockAvailable() {
  return !state.providers.some((p) => p.id !== 'mock' && p.available);
}

// Cleanup hook for the active view (stop audio, clear timers).
let cleanup = () => {};
function setCleanup(fn) { cleanup = fn; }

// ---- settings -------------------------------------------------------------

const THEMES = [
  { id: 'pacman',       label: 'Pac-Man' },
  { id: 'gruvbox',      label: 'Gruvbox' },
  { id: 'dracula',      label: 'Dracula' },
  { id: 'nord',         label: 'Nord' },
  { id: 'solarized',    label: 'Solarized Dark' },
  { id: 'monokai',      label: 'Monokai' },
  { id: 'onedark',      label: 'One Dark' },
  { id: 'catppuccin',   label: 'Catppuccin' },
];

function getTheme()  { return localStorage.getItem('figaro.theme') || 'pacman'; }
function getSpeed()  { return parseFloat(localStorage.getItem('figaro.speed') || '1.0'); }

function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  localStorage.setItem('figaro.theme', id);
}

// Apply saved theme on load
applyTheme(getTheme());

function openSettings() {
  if (document.getElementById('settings-overlay')) return;

  const overlay = el('div', { class: 'settings-overlay', id: 'settings-overlay' });
  const panel   = el('div', { class: 'settings-panel' });

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Header
  panel.appendChild(el('div', { class: 'settings-header' },
    el('span', { class: 'settings-title', text: 'Settings' }),
    el('button', { class: 'settings-close', text: '✕', onClick: close }),
  ));

  // ── Model ──
  panel.appendChild(el('label', { class: 'settings-label', text: 'Model' }));
  const modelSel = el('select', { class: 'settings-select' });
  for (const p of state.providers) {
    modelSel.appendChild(el('option', {
      value: p.id,
      text: p.available ? p.label : `${p.label} — no key`,
      disabled: !p.available,
      selected: p.id === currentProvider(),
    }));
  }
  modelSel.addEventListener('change', (e) => {
    state.selectedProvider = e.target.value;
    localStorage.setItem('figaro.provider', e.target.value);
    route();
  });
  panel.appendChild(modelSel);

  // ── Theme ──
  panel.appendChild(el('label', { class: 'settings-label', text: 'Theme' }));
  const themeGrid = el('div', { class: 'settings-theme-grid' });
  for (const t of THEMES) {
    const btn = el('button', {
      class: 'settings-theme-btn' + (getTheme() === t.id ? ' is-active' : ''),
      dataset: { theme: t.id },
      text: t.label,
      onClick: () => {
        applyTheme(t.id);
        themeGrid.querySelectorAll('.settings-theme-btn').forEach((b) =>
          b.classList.toggle('is-active', b.dataset.theme === t.id)
        );
      },
    });
    themeGrid.appendChild(btn);
  }
  panel.appendChild(themeGrid);

  // ── Playback speed ──
  panel.appendChild(el('label', { class: 'settings-label', text: `Playback Speed` }));
  const speedVal = el('span', { class: 'settings-speed-val', text: `${getSpeed().toFixed(1)}×` });
  const speedRow = el('div', { class: 'settings-speed-row' },
    el('span', { class: 'settings-speed-tick', text: '0.5×' }),
    (() => {
      const s = el('input', {
        class: 'settings-speed-slider',
        type: 'range', min: '0.5', max: '2.0', step: '0.1',
        value: String(getSpeed()),
      });
      s.addEventListener('input', () => {
        const v = parseFloat(s.value);
        speedVal.textContent = `${v.toFixed(1)}×`;
        localStorage.setItem('figaro.speed', String(v));
        // Update any live audio element
        document.querySelectorAll('audio').forEach((a) => { a.playbackRate = v; });
      });
      return s;
    })(),
    el('span', { class: 'settings-speed-tick', text: '2.0×' }),
    speedVal,
  );
  panel.appendChild(speedRow);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

settingsBtn.addEventListener('click', openSettings);

// ---- provider init --------------------------------------------------------
async function initProviders() {
  try {
    const data = await api.getProviders();
    state.providers = data.providers;
    state.defaultProvider = data.default;
  } catch {
    state.providers = [{ id: 'mock', label: 'Demo (no API key)', available: true, model: '' }];
    state.defaultProvider = 'mock';
  }
  if (!state.selectedProvider || !state.providers.some((p) => p.id === state.selectedProvider)) {
    state.selectedProvider = state.defaultProvider;
  }
}

// ---- shared bits ----------------------------------------------------------
function loading(message, subMessages = []) {
  const wrap = el('div', { class: 'loading-wrap' });
  wrap.appendChild(el('div', { class: 'spinner' }));
  const msg = el('div', { class: 'msg', text: message });
  wrap.appendChild(msg);
  if (subMessages.length) {
    let i = 0;
    msg.textContent = subMessages[0];
    const t = setInterval(() => {
      i = (i + 1) % subMessages.length;
      msg.textContent = subMessages[i];
    }, 2600);
    const prev = cleanup;
    setCleanup(() => { clearInterval(t); prev(); });
  }
  return wrap;
}

function errorBox(message) {
  return el('div', { class: 'error-box', text: message });
}

function levelBadge(level) {
  return el('span', { class: 'badge', text: level || 'beginner' });
}

function go(hash) { location.hash = hash; }

// ===========================================================================
// VIEW: Home
// ===========================================================================
async function viewHome() {
  clear(mount);

  // Prompt
  const prompt = el('div', { class: 'prompt' });
  prompt.appendChild(el('p', { class: 'eyebrow', text: 'New course' }));
  prompt.appendChild(el('h1', { text: 'What do you want to know about?' }));

  const input = el('textarea', {
    class: 'textarea',
    rows: 2,
    placeholder: 'e.g. the basics of music theory, how vaccines work, Spanish subjunctive…',
  });
  const begin = el('button', {
    class: 'btn btn--primary btn--lg btn--block',
    text: 'Begin →',
    onClick: () => {
      const topic = input.value.trim();
      if (!topic) { input.focus(); return; }
      state.flow = { topic };
      go('/assess');
    },
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) begin.click();
  });
  const field = el('div', { class: 'field' }, input, begin);
  prompt.appendChild(field);
  mount.appendChild(prompt);

  if (onlyMockAvailable()) {
    mount.appendChild(el('div', { class: 'notice', text:
      'Running in demo mode — no API keys detected. You can explore the whole flow now; add a key to .env and pick that model above for real, tailored lessons.' }));
  } else if (!providerAvailable(currentProvider())) {
    mount.appendChild(el('div', { class: 'notice', text:
      'The selected model has no API key, so Figaro will fall back to another available model.' }));
  }

  // Course library
  mount.appendChild(el('div', { class: 'section-head' }, el('h2', { text: 'Your courses' })));
  const listSlot = el('div');
  mount.appendChild(listSlot);
  listSlot.appendChild(loading('Loading your courses…'));

  try {
    const { courses } = await api.listCourses();
    clear(listSlot);
    if (!courses.length) {
      listSlot.appendChild(el('div', { class: 'empty', text: 'No courses yet. Ask Figaro about anything above to create your first one.' }));
      return;
    }
    listSlot.appendChild(progressOverview(courses));
    const ul = el('ul', { class: 'course-list' });
    for (const c of courses) ul.appendChild(courseCard(c));
    listSlot.appendChild(ul);
  } catch (e) {
    clear(listSlot);
    listSlot.appendChild(errorBox(e.message));
  }
}

// A roll-up of progress across every course: total lessons, how many have
// been studied, and how many are mastered (quiz score >= 80%).
function progressOverview(courses) {
  let lessons = 0, studied = 0, mastered = 0;
  for (const c of courses) {
    lessons += c.lessonCount || 0;
    studied += c.completedCount || 0;
    mastered += c.passedCount || 0;
  }
  const pct = lessons ? Math.round((mastered / lessons) * 100) : 0;

  const stat = (n, label) =>
    el('div', { class: 'overview__stat' },
      el('span', { class: 'overview__num', text: String(n) }),
      el('span', { class: 'overview__label', text: label }));

  const wrap = el('section', { class: 'overview' });
  wrap.appendChild(el('div', { class: 'overview__stats' },
    stat(courses.length, courses.length === 1 ? 'course' : 'courses'),
    stat(lessons, 'lessons'),
    stat(studied, 'studied'),
    stat(mastered, 'mastered'),
  ));

  const barRow = el('div', { class: 'overview__barrow' },
    el('div', { class: 'progress progress--lg' }, el('i', { style: `width:${pct}%` })),
    el('span', { class: 'overview__pct', text: `${pct}%` }),
  );
  wrap.appendChild(barRow);
  wrap.appendChild(el('div', { class: 'overview__caption muted', text:
    lessons ? `${mastered} of ${lessons} lessons mastered across all your courses` : 'No lessons yet' }));

  const legendItem = (cls, label) =>
    el('span', { class: 'legend__item' },
      el('span', { class: `dot dot--${cls}` }),
      el('span', { text: label }));
  wrap.appendChild(el('div', { class: 'legend muted' },
    legendItem('empty', 'not started'),
    legendItem('ready', 'ready'),
    legendItem('done', 'completed'),
    legendItem('mastered', 'mastered'),
  ));
  return wrap;
}

const STATUS_LABEL = { mastered: 'Mastered', done: 'Completed', ready: 'Ready to study', empty: 'Not generated yet' };

// A compact row of dots — one per lesson — so progress is visible per lesson,
// for every course, without opening it.
function lessonDots(c) {
  const row = el('div', { class: 'dots', title: 'Lesson progress' });
  const statuses = c.lessonStatuses || [];
  statuses.forEach((s, i) => {
    row.appendChild(el('span', {
      class: `dot dot--${s.status}`,
      title: `${i + 1}. ${s.title} — ${STATUS_LABEL[s.status] || s.status}`,
    }));
  });
  return row;
}

function courseCard(c) {
  const li = el('li');
  const card = el('a', { class: 'course-card', href: `#/course/${c.id}` });
  card.appendChild(el('h3', { text: c.title || c.topic }));

  const meta = el('div', { class: 'course-card__meta' },
    levelBadge(c.level),
    el('span', { class: 'badge badge--muted', text: c.provider }),
    el('span', { class: 'muted', style: 'font-size:14px', text:
      `${c.passedCount}/${c.lessonCount} mastered` }),
  );
  card.appendChild(meta);

  const frac = c.lessonCount ? c.passedCount / c.lessonCount : 0;
  const bar = el('div', { class: 'progress' }, el('i', { style: `width:${Math.round(frac * 100)}%` }));
  card.appendChild(bar);

  card.appendChild(lessonDots(c));

  const del = el('button', {
    class: 'course-card__del', title: 'Delete course', html: '&times;',
    onClick: async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!confirm(`Delete “${c.title || c.topic}”? This can't be undone.`)) return;
      try { await api.deleteCourse(c.id); viewHome(); } catch (err) { alert(err.message); }
    },
  });

  card.appendChild(del); // absolutely positioned inside the card
  li.appendChild(card);
  return li;
}

// ===========================================================================
// VIEW: Assessment (diagnostic questions -> build course)
// ===========================================================================
async function viewAssess() {
  if (!state.flow || !state.flow.topic) { go('/'); return; }
  const { topic } = state.flow;
  clear(mount);
  mount.appendChild(el('a', { class: 'back', href: '#/', text: '‹ start over' }));
  mount.appendChild(el('p', { class: 'eyebrow', text: 'Step 1 · A quick check-in' }));
  mount.appendChild(el('h1', { text: topic }));

  const body = el('div');
  mount.appendChild(body);
  body.appendChild(loading('Figaro is thinking of a few questions…', [
    'Sizing up the topic…',
    'Choosing diagnostic questions…',
    'Almost ready…',
  ]));

  let questions = state.flow.questions;
  if (!questions) {
    try {
      const data = await api.assess(topic, currentProvider());
      questions = data.questions;
      state.flow.questions = questions;
    } catch (e) {
      clear(body);
      body.appendChild(errorBox(e.message));
      body.appendChild(el('button', { class: 'btn btn--ghost', style: 'margin-top:14px', text: 'Try again', onClick: viewAssess }));
      return;
    }
  }

  setCleanup(() => {});
  clear(body);
  body.appendChild(el('p', { class: 'muted', text:
    'Answer what you can so Figaro can pitch the course at the right level. Leave blanks if you\'re unsure — that\'s useful information too.' }));

  const inputs = [];
  questions.forEach((q) => {
    const ta = el('textarea', { class: 'textarea', rows: 2, placeholder: 'Your answer (optional)…' });
    inputs.push({ q, ta });
    body.appendChild(el('div', { class: 'q-block' },
      el('label', { text: q.question }),
      ta,
    ));
  });

  const build = el('button', {
    class: 'btn btn--primary btn--lg btn--block',
    text: 'Build my course →',
    onClick: () => submit(false),
  });
  const skip = el('button', {
    class: 'btn btn--ghost btn--block', style: 'margin-top:10px',
    text: 'Skip — just build it', onClick: () => submit(true),
  });
  body.appendChild(build);
  body.appendChild(skip);

  async function submit(skipAnswers) {
    const answers = inputs.map(({ q, ta }) => ({
      question: q.question,
      answer: skipAnswers ? '' : ta.value.trim(),
    }));
    clear(mount);
    mount.appendChild(el('p', { class: 'eyebrow', text: 'Step 2 · Designing' }));
    mount.appendChild(el('h1', { text: topic }));
    mount.appendChild(loading('Figaro is designing your course…', [
      'Reading your answers…',
      'Choosing where to start you…',
      'Outlining the lessons…',
      'Shaping a learning path…',
    ]));
    try {
      const { course } = await api.createCourse(topic, currentProvider(), answers);
      state.flow = null;
      await eagerGenerate(course);
    } catch (e) {
      clear(mount);
      mount.appendChild(el('a', { class: 'back', href: '#/', text: '‹ start over' }));
      mount.appendChild(el('h1', { text: 'Hmm.' }));
      mount.appendChild(errorBox(e.message));
      mount.appendChild(el('button', { class: 'btn btn--ghost', style: 'margin-top:14px', text: 'Back to questions', onClick: viewAssess }));
    }
  }
}

// ===========================================================================
// EAGER GENERATION: generate all lessons + audio sequentially after course creation
// ===========================================================================
async function eagerGenerate(course) {
  const total = course.lessons.length;

  clear(mount);
  mount.appendChild(el('p', { class: 'eyebrow', text: course.topic }));
  mount.appendChild(el('h1', { text: course.title }));

  const stepText = el('p', { class: 'muted', style: 'margin:4px 0 20px' });
  const barFill  = el('i', { style: 'width:0%' });
  const bar      = el('div', { class: 'progress progress--lg' }, barFill);
  mount.appendChild(stepText);
  mount.appendChild(bar);

  // A cancelled flag so navigating away mid-generation stops the loop.
  let cancelled = false;
  setCleanup(() => { cancelled = true; });

  function setStep(text, doneLessons) {
    stepText.textContent = text;
    barFill.style.width = `${Math.round((doneLessons / total) * 100)}%`;
  }

  setStep(`Preparing lesson 1 of ${total}…`, 0);

  for (let i = 0; i < total; i++) {
    if (cancelled) return;

    setStep(`Writing lesson ${i + 1} of ${total} — ${course.lessons[i].title}`, i);

    try {
      const { lesson } = await api.generateLesson(course.id, i, course.provider);
      course.lessons[i] = lesson;
    } catch {
      // Non-fatal: skip this lesson, it will generate on-demand when opened.
      continue;
    }

    // Audio is now warmed server-side automatically after generateLesson.
    setStep(`Lesson ${i + 1} of ${total} ready`, i + 1);
  }

  if (cancelled) return;

  // Generate the closing message in the background — non-fatal if it fails.
  setStep('Finishing up…', total);
  api.generateClosing(course.id, course.provider).catch(() => {});

  go(`/course/${course.id}`);
}

// ===========================================================================
// VIEW: Course overview
// ===========================================================================
async function viewCourse(id) {
  clear(mount);
  mount.appendChild(loading('Loading course…'));
  let course;
  try {
    course = (await api.getCourse(id)).course;
  } catch (e) {
    clear(mount);
    mount.appendChild(el('a', { class: 'back', href: '#/', text: '‹ home' }));
    mount.appendChild(errorBox(e.message));
    return;
  }

  clear(mount);
  mount.appendChild(el('a', { class: 'back', href: '#/', text: '‹ all courses' }));
  mount.appendChild(el('p', { class: 'eyebrow', text: `On ${course.topic}` }));
  mount.appendChild(el('h1', { text: course.title }));

  const meta = el('div', { class: 'course-card__meta', style: 'margin:12px 0 4px' },
    levelBadge(course.level),
    el('span', { class: 'badge badge--muted', text: `via ${course.provider}` }),
  );
  mount.appendChild(meta);
  if (course.summary) mount.appendChild(el('p', { class: 'lede', style: 'margin-top:12px', text: course.summary }));

  const passed = course.lessons.filter((l) => l.passed).length;
  mount.appendChild(el('div', { class: 'progress', style: 'margin:18px 0 4px' },
    el('i', { style: `width:${Math.round((passed / course.lessons.length) * 100)}%` })));
  mount.appendChild(el('p', { class: 'muted', style: 'font-size:14px', text: `${passed} of ${course.lessons.length} lessons mastered` }));

  const suggestSlot = el('div');

  const lessonsDetails = el('details', { open: true });
  const lessonsSummary = el('summary', { class: 'lessons-summary' });
  lessonsSummary.appendChild(el('h2', { text: 'Lessons' }));
  lessonsDetails.appendChild(lessonsSummary);
  mount.appendChild(lessonsDetails);

  const list = el('ul', { class: 'course-list' });
  course.lessons.forEach((lesson, i) => {
    const li = el('li');

    const card = el('a', { class: 'course-card', href: `#/lesson/${course.id}/${i}` });
    card.appendChild(el('div', { class: 'lesson-num', text: `Lesson ${i + 1}` }));
    card.appendChild(el('h3', { text: lesson.title }));
    if (lesson.summary) card.appendChild(el('p', { class: 'muted', style: 'margin:8px 0 0; font-size:15px', text: lesson.summary }));

    const status = el('div', { class: 'course-card__meta', style: 'margin-top:12px' });
    if (lesson.completed && lesson.passed) {
      status.appendChild(el('span', { class: 'badge badge--ok', html: `&#10003; Mastered · ${lesson.score}%` }));
    } else if (lesson.completed) {
      status.appendChild(el('span', { class: 'badge badge--muted', text: `Scored ${lesson.score}% · retry for 80%` }));
    } else {
      status.appendChild(el('span', { class: 'badge', text: lesson.generated ? 'Continue' : 'Start' }));
    }

    // Regenerate button — sits inside the card footer alongside the status badge.
    const regenBtn = el('button', {
      class: 'lesson-regen',
      text: '↺ Regenerate',
      title: 'Rewrite this lesson from scratch',
      onClick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!confirm(`Regenerate "${lesson.title}"? The current content and audio will be replaced.`)) return;
        regenBtn.disabled = true;
        regenBtn.textContent = 'Regenerating…';
        try {
          await api.generateLesson(course.id, i, currentProvider(), true);
          viewCourse(id);
        } catch (err) {
          regenBtn.disabled = false;
          regenBtn.textContent = '↺ Regenerate';
          alert(`Could not regenerate: ${err.message}`);
        }
      },
    });
    status.appendChild(regenBtn);
    card.appendChild(status);
    li.appendChild(card);

    list.appendChild(li);
  });
  lessonsDetails.appendChild(list);

  mount.appendChild(suggestSlot);
  renderSuggestions(suggestSlot, course, id);
}

function renderSuggestions(slot, course, id) {
  clear(slot);

  function startCourse(topic) {
    clear(mount);
    mount.appendChild(el('p', { class: 'eyebrow', text: topic }));
    mount.appendChild(el('h1', { text: 'Building your course…' }));
    mount.appendChild(loading('Figaro is designing your course…', [
      'Outlining the lessons…',
      'Shaping a learning path…',
    ]));
    api.createCourse(topic, currentProvider(), [])
      .then(({ course: newCourse }) => eagerGenerate(newCourse))
      .catch((e) => {
        clear(mount);
        mount.appendChild(el('a', { class: 'back', href: `#/course/${id}`, text: '‹ back' }));
        mount.appendChild(errorBox(e.message));
      });
  }

  function renderList(suggestions) {
    slot.appendChild(el('div', { class: 'section-head', style: 'margin-top:32px' },
      el('h2', { text: 'Suggested next topics' })));
    const list = el('ul', { class: 'suggest-list' });
    for (const topic of suggestions) {
      const li = el('li');
      li.appendChild(el('button', {
        class: 'suggest-item',
        text: topic,
        onClick: () => startCourse(topic),
      }));
      list.appendChild(li);
    }
    slot.appendChild(list);

    const regenBtn = el('button', {
      class: 'btn btn--ghost', style: 'margin-top:14px; font-size:14px',
      text: '↺ Regenerate suggestions',
      onClick: () => generate(regenBtn),
    });
    slot.appendChild(regenBtn);
  }

  function generate(triggerBtn) {
    if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = 'Generating…'; }
    api.generateSuggestions(id, currentProvider())
      .then(({ suggestions }) => {
        course.suggestions = suggestions;
        clear(slot);
        if (suggestions.length) renderList(suggestions);
      })
      .catch(() => {
        if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = '↺ Regenerate suggestions'; }
      });
  }

  if (course.suggestions && course.suggestions.length) {
    renderList(course.suggestions);
  } else {
    // No suggestions yet — show the generate button.
    slot.appendChild(el('div', { style: 'margin-top:32px' },
      el('button', {
        class: 'btn btn--ghost btn--block',
        text: 'Recommend follow-up course topics',
        onClick: (e) => generate(e.currentTarget),
      })
    ));
  }
}

// ===========================================================================
// VIEW: Lesson (audio lecture + start quiz)
// ===========================================================================
async function viewLesson(id, indexStr) {
  const index = Number(indexStr);
  clear(mount);
  mount.appendChild(loading('Opening lesson…'));

  let course;
  try {
    course = (await api.getCourse(id)).course;
  } catch (e) {
    clear(mount); mount.appendChild(errorBox(e.message)); return;
  }
  const lesson = course.lessons[index];
  if (!lesson) { clear(mount); mount.appendChild(errorBox('Lesson not found.')); return; }

  // Generate content if needed.
  if (!lesson.generated) {
    clear(mount);
    mount.appendChild(el('a', { class: 'back', href: `#/course/${id}`, text: '‹ back to course' }));
    mount.appendChild(el('div', { class: 'lesson-num', text: `Lesson ${index + 1}` }));
    mount.appendChild(el('h1', { text: lesson.title }));
    mount.appendChild(loading('Figaro is preparing your five-minute lecture…', [
      'Writing the lecture…',
      'Picking clear examples…',
      'Composing the quiz…',
      'Polishing the script…',
    ]));
    try {
      const data = await api.generateLesson(id, index, currentProvider());
      course.lessons[index] = data.lesson;
    } catch (e) {
      clear(mount);
      mount.appendChild(el('a', { class: 'back', href: `#/course/${id}`, text: '‹ back to course' }));
      mount.appendChild(el('h1', { text: lesson.title }));
      mount.appendChild(errorBox(e.message));
      mount.appendChild(el('button', { class: 'btn btn--ghost', style: 'margin-top:14px', text: 'Try again', onClick: () => viewLesson(id, indexStr) }));
      return;
    }
  }

  renderLesson(course, index);
}

function renderLesson(course, index) {
  const lesson = course.lessons[index];
  clear(mount);
  mount.appendChild(el('a', { class: 'back', href: `#/course/${course.id}`, text: '‹ back to course' }));
  mount.appendChild(el('div', { class: 'lesson-head' },
    el('div', { class: 'lesson-num', text: `Lesson ${index + 1} of ${course.lessons.length}` }),
    el('h1', { text: lesson.title }),
  ));

  if (lesson.completed) {
    const b = lesson.passed
      ? el('span', { class: 'badge badge--ok', html: `&#10003; Mastered · ${lesson.score}%` })
      : el('span', { class: 'badge badge--muted', text: `Last score ${lesson.score}% — aim for 80%` });
    mount.appendChild(el('div', { style: 'margin-bottom:16px' }, b));
  }

  // --- Formulas / concept visual ---
  function renderKatex(node, latex, displayMode) {
    try {
      window.katex.render(latex, node, { displayMode: !!displayMode, throwOnError: false });
    } catch {
      node.textContent = latex;
    }
  }

  if (lesson.formulas && lesson.formulas.length) {
    const details = el('details', { class: 'infographic-details' });
    const captionText = lesson.formulas.length === 1 ? 'Formula' : 'Formulas';
    details.appendChild(el('summary', { class: 'infographic-summary infographic-summary--formula', text: captionText }));
    const panel = el('div', { class: 'infographic' });
    for (const f of lesson.formulas) {
      const card = el('div', { class: 'formula-card' });
      if (f.label) card.appendChild(el('div', { class: 'formula-card__label', text: f.label }));
      const display = el('div', { class: 'formula-card__display' });
      renderKatex(display, f.latex, true);
      card.appendChild(display);
      if (f.variables && f.variables.length) {
        const vars = el('dl', { class: 'formula-card__vars' });
        for (const v of f.variables) {
          const dt = el('dt', { class: 'formula-card__sym' });
          renderKatex(dt, v.symbol, false);
          vars.appendChild(dt);
          vars.appendChild(el('dd', { class: 'formula-card__meaning', text: v.meaning }));
        }
        card.appendChild(vars);
      }
      panel.appendChild(card);
    }
    details.appendChild(panel);
    mount.appendChild(details);
  } else if (lesson.concept && lesson.concept.steps && lesson.concept.steps.length) {
    const details = el('details', { class: 'infographic-details' });
    const captionText = lesson.concept.title || 'Concept';
    details.appendChild(el('summary', { class: 'infographic-summary infographic-summary--concept', text: captionText }));
    const panel = el('div', { class: 'infographic' });
    const flow = el('div', { class: `concept-flow concept-flow--${lesson.concept.style || 'flow'}` });
    lesson.concept.steps.forEach((s, si) => {
      const node = el('div', { class: 'concept-node' },
        el('div', { class: 'concept-node__label', text: s.label }),
        s.detail ? el('div', { class: 'concept-node__detail', text: s.detail }) : null,
      );
      flow.appendChild(node);
      if (si < lesson.concept.steps.length - 1) {
        flow.appendChild(el('div', { class: 'concept-arrow', html: '&#8594;' }));
      }
    });
    panel.appendChild(flow);
    details.appendChild(panel);
    mount.appendChild(details);
  }

  // --- Audio player ---
  const audioUrl   = api.lessonAudioUrl(course.id, index);
  const posKey     = `figaro.playpos.${course.id}.${index}`;
  const playingKey = `figaro.playing.${course.id}.${index}`;
  const savedAtKey = `figaro.savedat.${course.id}.${index}`;
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = audioUrl;
  audio.playbackRate = getSpeed();

  function formatTime(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  const playerEl  = el('div', { class: 'player' });
  const playBtn   = el('button', { class: 'player__btn',               html: '&#9654;', title: 'Play / pause' });
  const rewindBtn = el('button', { class: 'player__btn player__small', html: '&#8630;', title: 'Rewind 30 seconds' });
  const fromTopBtn= el('button', { class: 'player__btn player__small', html: '&#8635;', title: 'Start from beginning' });
  const status    = el('div',    { class: 'player__status',            text: 'Tap play to hear the lecture' });
  const timeLeft  = el('div',    { class: 'player__timeleft',          text: '' });
  const scrubber  = el('input',  { class: 'player__scrubber', type: 'range', min: '0', max: '100', step: '0.1', value: '0' });

  const meta = el('div', { class: 'player__meta' },
    el('div', { class: 'player__statusrow' }, status, timeLeft),
    scrubber,
  );
  playerEl.appendChild(el('div', { class: 'player__row' }, playBtn, rewindBtn, fromTopBtn, meta));
  mount.appendChild(playerEl);

  let scrubbing = false;

  function syncScrubber() {
    if (scrubbing || !audio.duration || !isFinite(audio.duration)) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    scrubber.value = pct;
    scrubber.style.setProperty('--pct', `${pct.toFixed(2)}%`);
  }

  function syncTimeLeft() {
    if (!audio.duration || !isFinite(audio.duration)) return;
    const rem = audio.duration - audio.currentTime;
    timeLeft.textContent = rem > 0 ? `-${formatTime(rem)}` : '';
  }

  function syncUI() {
    syncScrubber();
    syncTimeLeft();
    if (audio.ended) {
      playBtn.innerHTML = '&#9654;';
      status.textContent = 'Finished \u2014 ready for the quiz';
      scrubber.value = '100';
      scrubber.style.setProperty('--pct', '100%');
      timeLeft.textContent = '';
    } else if (!audio.paused) {
      playBtn.innerHTML = '&#10073;&#10073;';
      status.textContent = 'Now playing\u2026';
    } else if (audio.currentTime > 0) {
      playBtn.innerHTML = '&#9654;';
      status.textContent = `Paused at ${formatTime(audio.currentTime)}`;
    }
  }

  function showResumeBanner() {
    // Remove any existing banner first.
    const existing = playerEl.querySelector('.player__resume');
    if (existing) existing.remove();
    const banner = el('button', {
      class: 'player__resume',
      text: '\u25B6\uFE0E Tap to resume',
      onClick: () => {
        banner.remove();
        audio.play();
      },
    });
    playerEl.appendChild(banner);
  }

  audio.addEventListener('timeupdate', () => {
    syncScrubber();
    syncTimeLeft();
    if (Math.round(audio.currentTime) % 5 === 0) {
      localStorage.setItem(posKey, audio.currentTime);
      localStorage.setItem(playingKey, audio.paused ? '0' : '1');
      localStorage.setItem(savedAtKey, Date.now());
    }
  });
  audio.addEventListener('durationchange', () => { syncScrubber(); syncTimeLeft(); });
  audio.addEventListener('playing', () => {
    playBtn.innerHTML = '&#10073;&#10073;';
    status.textContent = 'Now playing\u2026';
    localStorage.setItem(playingKey, '1');
    localStorage.setItem(savedAtKey, Date.now());
  });
  audio.addEventListener('pause', () => {
    playBtn.innerHTML = '&#9654;';
    localStorage.setItem(posKey, audio.currentTime);
    localStorage.setItem(playingKey, '0');
    localStorage.setItem(savedAtKey, Date.now());
    if (!scrubbing) status.textContent = audio.currentTime > 0 ? `Paused at ${formatTime(audio.currentTime)}` : 'Tap play to hear the lecture';
  });
  const isLastLesson = index === course.lessons.length - 1;
  let endFlowActive = false; // guard so cleanup can cancel it
  let micCheckPromise = null; // kicked off on first play (user gesture)

  async function runEndFlow() {
    if (document.hidden || endFlowActive) return;
    endFlowActive = true;

    // For the last lesson, speak the closing message first.
    if (isLastLesson && ttsSupported) {
      const closing = course.closingMessage ||
        'You have reached the end of the course. Congratulations on completing every lesson. Keep exploring and applying what you have learned.';
      status.textContent = 'Playing closing message…';
      await say(closing);
      if (!endFlowActive) return;
    }

    if (!ttsSupported || !sttSupported) return; // nothing more to do without voice

    const micStatus = await (micCheckPromise || checkMic());
    if (micStatus === 'permission') {
      showToast('Microphone is blocked. Click the lock icon in the URL bar → Site settings → Microphone → Allow, then reload.', { type: 'warn', duration: 12000 });
      return;
    }
    if (micStatus === 'error') {
      showToast('Could not access the microphone. Check your device settings.', { type: 'error' });
      return;
    }

    const prompt = isLastLesson
      ? 'Would you like to take the final quiz, or go back to the course overview? Say "quiz" or "course".'
      : 'Would you like to continue to the next lesson, replay this one, or stop to take the quiz? Say "next", "replay", or "quiz".';

    status.textContent = 'Listening…';
    await say(prompt);
    if (!endFlowActive) return;

    status.textContent = 'Listening…';
    const { promise, abort: abortListen } = listenOnce({ timeout: 8000 });

    // Store abort so cleanup can cancel it.
    const prevCleanup = cleanup;
    setCleanup(() => { endFlowActive = false; abortListen(); prevCleanup(); });

    const transcript = (await promise).toLowerCase().trim();
    if (!endFlowActive) return;

    status.textContent = transcript ? `Heard: "${transcript}"` : 'Didn\'t catch that.';

    if (isLastLesson) {
      if (/quiz|test|question/.test(transcript)) {
        go(`/quiz/${course.id}/${index}`);
      } else if (/course|overview|back|home/.test(transcript)) {
        go(`/course/${course.id}`);
      } else if (transcript) {
        await say('Sorry, I didn\'t catch that. Head to the quiz or course overview using the buttons below.');
      }
    } else {
      if (/next|continue|forward/.test(transcript)) {
        go(`/lesson/${course.id}/${index + 1}`);
      } else if (/replay|again|repeat|restart/.test(transcript)) {
        endFlowActive = false;
        status.textContent = 'Tap play to hear the lecture';
        audio.currentTime = 0;
        scrubber.value = '0';
        scrubber.style.setProperty('--pct', '0%');
        audio.play();
      } else if (/quiz|test|question|stop/.test(transcript)) {
        go(`/quiz/${course.id}/${index}`);
      } else if (transcript) {
        await say('Sorry, I didn\'t catch that. Say "next", "replay", or "quiz".');
      }
    }
  }

  audio.addEventListener('ended', () => {
    playBtn.innerHTML = '&#9654;';
    localStorage.removeItem(posKey);
    localStorage.removeItem(playingKey);
    localStorage.removeItem(savedAtKey);
    status.textContent = 'Finished \u2014 ready for the quiz';
    scrubber.value = '100';
    scrubber.style.setProperty('--pct', '100%');
    timeLeft.textContent = '';
    runEndFlow();
  });
  audio.addEventListener('loadedmetadata', () => {
    const saved      = parseFloat(localStorage.getItem(posKey));
    const wasPlaying = localStorage.getItem(playingKey) === '1';
    const savedAt    = parseInt(localStorage.getItem(savedAtKey), 10);

    let restorePos = saved;
    // If audio was playing when we last saved, the OS continued playing it in
    // the background. Add the elapsed wall-clock time so we skip ahead to where
    // playback actually is now.
    if (wasPlaying && savedAt && isFinite(saved)) {
      const elapsed = (Date.now() - savedAt) / 1000;
      restorePos = saved + elapsed;
    }

    // Consume the saved state now so the pause event (fired when autoplay is
    // blocked) doesn't overwrite restorePos with a stale value before the user
    // taps the resume banner.
    localStorage.removeItem(posKey);
    localStorage.removeItem(playingKey);
    localStorage.removeItem(savedAtKey);

    if (restorePos > 0 && isFinite(restorePos) && restorePos < audio.duration) {
      audio.currentTime = restorePos;
    }
    syncUI();
    if (wasPlaying) {
      audio.play().catch(() => {
        // Autoplay blocked (no prior user interaction on this page load).
        // Show a resume banner — tapping it counts as a user gesture.
        showResumeBanner();
      });
    }
  });
  audio.addEventListener('waiting', () => { if (!scrubbing) status.textContent = 'Loading audio\u2026'; });
  audio.addEventListener('error',   () => { status.textContent = 'Audio unavailable \u2014 read the transcript below.'; });

  scrubber.addEventListener('mousedown',  () => { scrubbing = true; });
  scrubber.addEventListener('touchstart', () => { scrubbing = true; }, { passive: true });
  scrubber.addEventListener('input', () => {
    scrubber.style.setProperty('--pct', `${parseFloat(scrubber.value).toFixed(2)}%`);
    if (audio.duration) {
      const preview = (scrubber.value / 100) * audio.duration;
      timeLeft.textContent = `-${formatTime(audio.duration - preview)}`;
    }
  });
  scrubber.addEventListener('change', () => {
    const wasPlaying = !audio.paused;
    scrubbing = false;
    if (audio.duration && isFinite(audio.duration)) {
      audio.currentTime = (scrubber.value / 100) * audio.duration;
      scrubber.style.setProperty('--pct', `${parseFloat(scrubber.value).toFixed(2)}%`);
      if (wasPlaying) audio.play();
    }
  });

  playBtn.onclick = () => {
    // Call getUserMedia synchronously within the click gesture so the browser
    // shows its permission prompt in the URL bar. Store the promise so
    // runEndFlow can await the result without re-requesting.
    if (sttSupported && !micCheckPromise && navigator.mediaDevices) {
      micCheckPromise = navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => { stream.getTracks().forEach((t) => t.stop()); return 'ok'; })
        .catch((err) => {
          if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') return 'permission';
          return 'error';
        });
    }
    if (audio.paused) audio.play(); else audio.pause();
  };
  rewindBtn.onclick = () => {
    audio.currentTime = Math.max(0, audio.currentTime - 30);
    if (audio.paused && audio.currentTime > 0) audio.play();
  };
  fromTopBtn.onclick = () => {
    localStorage.removeItem(posKey);
    localStorage.removeItem(playingKey);
    localStorage.removeItem(savedAtKey);
    audio.currentTime = 0;
    scrubber.value = '0';
    scrubber.style.setProperty('--pct', '0%');
    audio.play();
  };

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: lesson.title,
      artist: `Figaro \u00b7 Lesson ${index + 1} of ${course.lessons.length}`,
      album: course.title,
    });
    navigator.mediaSession.setActionHandler('play',         () => audio.play());
    navigator.mediaSession.setActionHandler('pause',        () => audio.pause());
    navigator.mediaSession.setActionHandler('stop',         () => { audio.pause(); audio.currentTime = 0; });
    navigator.mediaSession.setActionHandler('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - 30); });
    navigator.mediaSession.setActionHandler('seekforward',  () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 30); });
  }

  setCleanup(() => {
    endFlowActive = false;
    cancelSpeech();
    if (audio.currentTime > 0) {
      localStorage.setItem(posKey, audio.currentTime);
      localStorage.setItem(playingKey, audio.paused ? '0' : '1');
      localStorage.setItem(savedAtKey, Date.now());
    }
    audio.pause();
    audio.src = '';
  });

  // --- Transcript ---
  const details = el('details', { class: 'transcript' });
  details.appendChild(el('summary', { text: 'Read the transcript' }));
  const tbody = el('div', { class: 'transcript__body' });
  lesson.lecture.split(/\n+/).forEach((para) => { if (para.trim()) tbody.appendChild(el('p', { text: para.trim() })); });
  details.appendChild(tbody);
  mount.appendChild(details);

  // --- Start quiz ---
  mount.appendChild(el('button', {
    class: 'btn btn--primary btn--lg btn--block', style: 'margin-top:22px',
    text: lesson.completed ? 'Retake the quiz' : 'Take the quiz →',
    onClick: () => { audio.pause(); go(`/quiz/${course.id}/${index}`); },
  }));

  // --- Follow-up chat ---
  mount.appendChild(el('div', { class: 'chat-section' },
    el('h2', { class: 'chat-section__heading', text: 'Ask a follow-up question' }),
  ));

  // Seed history from persisted follow-ups so reloading restores prior Q&A.
  const chatHistory = (lesson.followUps || []).map((f) => ({ question: f.question, answer: f.answer }));
  const chatLog  = el('div', { class: 'chat-log' });

  function figaroBubble(text) {
    const bubble = el('div', { class: 'chat-bubble chat-bubble--figaro' });
    bubble.appendChild(el('span', { class: 'chat-bubble__text', text }));
    if (ttsSupported) {
      const speakBtn = el('button', {
        class: 'chat-bubble__speak',
        title: 'Play response',
        html: '&#9654;',
        onClick: () => say(text),
      });
      bubble.appendChild(speakBtn);
    }
    return bubble;
  }

  for (const { question, answer } of chatHistory) {
    chatLog.appendChild(el('div', { class: 'chat-bubble chat-bubble--user', text: question }));
    chatLog.appendChild(figaroBubble(answer));
  }
  const chatInput = el('textarea', {
    class: 'textarea chat-input',
    rows: 2,
    placeholder: 'Ask anything about this lesson…',
  });
  const chatSend = el('button', {
    class: 'btn btn--primary btn--block',
    text: 'Ask →',
  });

  async function sendChat() {
    const q = chatInput.value.trim();
    if (!q) { chatInput.focus(); return; }
    chatInput.value = '';
    chatSend.disabled = true;

    // Optimistically append the question.
    const qBubble = el('div', { class: 'chat-bubble chat-bubble--user', text: q });
    chatLog.appendChild(qBubble);
    const aBubble = el('div', { class: 'chat-bubble chat-bubble--figaro chat-bubble--loading', text: 'Thinking…' });
    chatLog.appendChild(aBubble);
    aBubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      const { answer } = await api.chatLesson(course.id, index, q, chatHistory, currentProvider());
      const filled = figaroBubble(answer);
      aBubble.replaceWith(filled);
      chatHistory.push({ question: q, answer });
    } catch (e) {
      aBubble.classList.remove('chat-bubble--loading');
      aBubble.classList.add('chat-bubble--error');
      aBubble.textContent = `Error: ${e.message}`;
    } finally {
      chatSend.disabled = false;
      chatInput.focus();
      aBubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendChat();
  });

  mount.appendChild(chatLog);
  mount.appendChild(el('div', { class: 'chat-compose' }, chatInput, chatSend));
}

// ===========================================================================
// VIEW: Quiz (delegates to quiz.js)
// ===========================================================================
async function viewQuiz(id, indexStr) {
  const index = Number(indexStr);
  clear(mount);
  mount.appendChild(loading('Loading quiz…'));
  let course;
  try {
    course = (await api.getCourse(id)).course;
  } catch (e) { clear(mount); mount.appendChild(errorBox(e.message)); return; }

  let lesson = course.lessons[index];
  if (!lesson) { clear(mount); mount.appendChild(errorBox('Lesson not found.')); return; }

  if (!lesson.generated) {
    try {
      const data = await api.generateLesson(id, index, currentProvider());
      course.lessons[index] = data.lesson;
    } catch (e) { clear(mount); mount.appendChild(errorBox(e.message)); return; }
  }

  clear(mount);
  const teardown = mountQuiz(mount, { course, index, navigate: go });
  setCleanup(teardown || (() => {}));
}

// ===========================================================================
// Router
// ===========================================================================
function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  return h.split('/').filter(Boolean); // ['course','<id>'] etc.
}

function route() {
  cleanup();
  setCleanup(() => {});
  window.scrollTo({ top: 0 });
  const parts = parseHash();

  if (parts.length === 0) return viewHome();
  switch (parts[0]) {
    case 'assess': return viewAssess();
    case 'course': return viewCourse(parts[1]);
    case 'lesson': return viewLesson(parts[1], parts[2]);
    case 'quiz':   return viewQuiz(parts[1], parts[2]);
    default:       return viewHome();
  }
}

window.addEventListener('hashchange', () => {
  // Persist the current route so we can restore it after a full app exit.
  localStorage.setItem('figaro.lastRoute', location.hash);
  route();
});

// ---- boot ----
(async function boot() {
  await initProviders();

  // If the page loaded without a hash (e.g. opened from homescreen icon),
  // restore the last lesson the user was viewing.
  if (!location.hash || location.hash === '#' || location.hash === '#/') {
    const last = localStorage.getItem('figaro.lastRoute');
    if (last && last.startsWith('#/lesson/')) {
      location.hash = last;
      return; // hashchange will fire route()
    }
  }

  route();
})();
