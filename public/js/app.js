// app.js — application shell: provider selector, hash router, and the
// home / assessment / course / lesson views. Quiz lives in quiz.js.

import { el, clear } from './ui.js';
import { api } from './api.js';
import { LecturePlayer, ttsSupported } from './speech.js';
import { mountQuiz } from './quiz.js';

const mount = document.getElementById('view');
const providerSlot = document.getElementById('provider-slot');

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

// ---- provider selector ----------------------------------------------------
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
  renderProviderSelector();
}

function renderProviderSelector() {
  clear(providerSlot);
  const sel = el('select', {
    title: 'Choose which model powers Figaro',
    onChange: (e) => {
      state.selectedProvider = e.target.value;
      localStorage.setItem('figaro.provider', e.target.value);
      route(); // re-render to refresh demo-mode notices
    },
  });
  for (const p of state.providers) {
    const label = p.available ? p.label : `${p.label} — no key`;
    sel.appendChild(el('option', {
      value: p.id,
      text: label,
      disabled: !p.available,
      selected: p.id === currentProvider(),
    }));
  }
  providerSlot.appendChild(sel);
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
      if (!confirm(`Delete “${c.title || c.topic}”? This can’t be undone.`)) return;
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
    'Answer what you can so Figaro can pitch the course at the right level. Leave blanks if you’re unsure — that’s useful information too.' }));

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
      go(`/course/${course.id}`);
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

  mount.appendChild(el('div', { class: 'section-head' }, el('h2', { text: 'Lessons' })));
  const list = el('ul', { class: 'course-list' });
  course.lessons.forEach((lesson, i) => {
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
    card.appendChild(status);
    list.appendChild(el('li', {}, card));
  });
  mount.appendChild(list);
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

  // --- Audio player ---
  const player = el('div', { class: 'player' });
  const playBtn = el('button', { class: 'player__btn', html: '&#9654;', title: 'Play' });
  const restartBtn = el('button', { class: 'player__btn player__small', html: '&#8635;', title: 'Restart' });
  const status = el('div', { class: 'player__status', text: ttsSupported ? 'Tap play to hear the lecture' : 'Audio narration isn’t supported in this browser — read the transcript below.' });
  const barFill = el('i');
  const meta = el('div', { class: 'player__meta' }, status, el('div', { class: 'player__bar' }, barFill));
  player.appendChild(el('div', { class: 'player__row' }, playBtn, restartBtn, meta));
  mount.appendChild(player);

  let lect = null;
  if (ttsSupported) {
    lect = new LecturePlayer(lesson.lecture, {
      onProgress: (f) => { barFill.style.width = `${Math.round(f * 100)}%`; },
      onState: (s) => {
        playBtn.innerHTML = s === 'playing' ? '&#10073;&#10073;' : '&#9654;';
        status.textContent =
          s === 'playing' ? 'Now playing…'
          : s === 'paused' ? 'Paused'
          : s === 'done' ? 'Finished — ready for the quiz'
          : 'Tap play to hear the lecture';
      },
    });
    playBtn.onclick = () => lect.toggle();
    restartBtn.onclick = () => lect.restart();
    setCleanup(() => lect.stop());
  } else {
    playBtn.disabled = true;
    restartBtn.disabled = true;
  }

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
    onClick: () => { if (lect) lect.stop(); go(`/quiz/${course.id}/${index}`); },
  }));
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

window.addEventListener('hashchange', route);

// ---- boot ----
(async function boot() {
  await initProviders();
  route();
})();
