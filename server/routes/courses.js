'use strict';

const express = require('express');
const store = require('../store');
const llm = require('../llm');
const tts = require('../tts');
const { assessmentPrompt, outlinePrompt, lessonPrompt, chatPrompt, suggestionsPrompt } = require('../prompts');

const router = express.Router();

// Small wrapper so thrown errors land in the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- Providers -------------------------------------------------------------

router.get('/providers', (req, res) => {
  res.json({
    providers: llm.listProviders(),
    default: llm.resolveProvider(process.env.DEFAULT_PROVIDER),
  });
});

// --- Diagnostic assessment -------------------------------------------------

router.post(
  '/assess',
  wrap(async (req, res) => {
    const topic = (req.body.topic || '').trim();
    if (!topic) return res.status(400).json({ error: 'A topic is required.' });

    const provider = llm.resolveProvider(req.body.provider);
    const { system, user } = assessmentPrompt(topic);
    const raw = await llm.chat(provider, system, user);
    const parsed = llm.parseJson(raw);

    const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
    res.json({
      provider,
      questions: questions.map((q, i) => ({
        id: q.id || `q${i + 1}`,
        question: String(q.question || '').trim(),
      })),
    });
  })
);

// --- Course list / detail / delete ----------------------------------------

router.get('/courses', (req, res) => {
  res.json({ courses: store.listCourses().map(store.courseSummary) });
});

router.get('/courses/:id', (req, res) => {
  const course = store.readCourse(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found.' });
  res.json({ course });
});

router.delete('/courses/:id', (req, res) => {
  const ok = store.deleteCourse(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Course not found.' });
  tts.deleteCourseAudio(req.params.id);
  res.json({ ok: true });
});

// --- Create a course (generate the outline) --------------------------------

router.post(
  '/courses',
  wrap(async (req, res) => {
    const topic = (req.body.topic || '').trim();
    if (!topic) return res.status(400).json({ error: 'A topic is required.' });

    const provider = llm.resolveProvider(req.body.provider);
    const answers = Array.isArray(req.body.answers) ? req.body.answers : [];

    const { system, user } = outlinePrompt(topic, answers);
    const raw = await llm.chat(provider, system, user);
    const parsed = llm.parseJson(raw);

    const lessons = (Array.isArray(parsed.lessons) ? parsed.lessons : []).map((l, i) => ({
      index: i,
      title: String(l.title || `Lesson ${i + 1}`).trim(),
      summary: String(l.summary || '').trim(),
      generated: false,
      lecture: null,
      quiz: null,
      completed: false,
      score: null,
    }));

    if (lessons.length === 0) {
      return res.status(502).json({ error: 'The model did not return any lessons. Try again.' });
    }

    const course = {
      id: store.newId(),
      topic,
      title: String(parsed.title || topic).trim(),
      level: String(parsed.level || 'beginner').trim(),
      summary: String(parsed.summary || '').trim(),
      provider,
      assessment: answers,
      createdAt: Date.now(),
      lessons,
    };

    store.writeCourse(course);
    res.status(201).json({ course });
  })
);

// --- Follow-up chat on a lesson --------------------------------------------

router.post(
  '/courses/:id/lessons/:index/chat',
  wrap(async (req, res) => {
    const course = store.readCourse(req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found.' });

    const idx = Number(req.params.index);
    const lesson = course.lessons?.[idx];
    if (!lesson) return res.status(404).json({ error: 'Lesson not found.' });
    if (!lesson.generated) return res.status(409).json({ error: 'Lesson content not generated yet.' });

    const question = String(req.body.question || '').trim();
    if (!question) return res.status(400).json({ error: 'A question is required.' });

    const history = Array.isArray(req.body.history) ? req.body.history : [];
    const provider = llm.resolveProvider(req.body.provider || course.provider);

    const { system, user } = chatPrompt(course, { ...lesson, index: idx }, history, question);
    const answer = await llm.chat(provider, system, user);

    // Persist follow-up Q&A on the lesson so suggestions can use it.
    if (!Array.isArray(lesson.followUps)) lesson.followUps = [];
    lesson.followUps.push({ question, answer: answer.trim(), askedAt: Date.now() });
    store.writeCourse(course);

    res.json({ answer: answer.trim() });
  })
);

// --- Suggested follow-on course topics (POST — can be regenerated) ---------

router.post(
  '/courses/:id/suggestions',
  wrap(async (req, res) => {
    const course = store.readCourse(req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found.' });

    const provider = llm.resolveProvider(req.body.provider || course.provider);
    const { system, user } = suggestionsPrompt(course);
    const raw = await llm.chat(provider, system, user);
    const parsed = llm.parseJson(raw);

    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map((s) => String(s).trim()).filter(Boolean).slice(0, 4)
      : [];

    // Persist so the course page can show them without re-generating.
    course.suggestions = suggestions;
    store.writeCourse(course);

    res.json({ suggestions });
  })
);

// --- Generate one lesson's content (lazy, cached on disk) ------------------

router.post(
  '/courses/:id/lessons/:index/generate',
  wrap(async (req, res) => {
    const course = store.readCourse(req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found.' });

    const idx = Number(req.params.index);
    const lesson = course.lessons?.[idx];
    if (!lesson) return res.status(404).json({ error: 'Lesson not found.' });

    // Return cached content unless the client forces regeneration.
    if (lesson.generated && !req.body.regenerate) {
      return res.json({ lesson });
    }

    // Bust cached audio when regenerating lesson content.
    if (req.body.regenerate) tts.deleteAudio(req.params.id, idx);

    const provider = llm.resolveProvider(req.body.provider || course.provider);
    const { system, user } = lessonPrompt(course, lesson, idx);
    const raw = await llm.chat(provider, system, user);
    console.log('[generate] raw response length:', raw.length, '— last 200 chars:', raw.slice(-200));
    const parsed = llm.parseJson(raw);
    console.log('[generate] parsed keys:', Object.keys(parsed), '— formulas:', JSON.stringify(parsed.formulas?.slice(0,1)));

    const quiz = (Array.isArray(parsed.quiz) ? parsed.quiz : [])
      .map((q) => ({
        question: String(q.question || '').trim(),
        options: (Array.isArray(q.options) ? q.options : []).map((o) => String(o)),
        answer: Number.isInteger(q.answer) ? q.answer : 0,
        explanation: String(q.explanation || '').trim(),
      }))
      .filter((q) => q.question && q.options.length >= 2);

    lesson.lecture = String(parsed.lecture || '').trim();
    lesson.quiz = quiz;

    // Formulas (optional — array of { latex, label, variables }).
    const rawFormulas = Array.isArray(parsed.formulas) ? parsed.formulas : [];
    lesson.formulas = rawFormulas
      .filter((f) => f && typeof f.latex === 'string' && f.latex.trim())
      .map((f) => ({
        latex: String(f.latex).trim(),
        label: String(f.label || '').trim(),
        variables: Array.isArray(f.variables)
          ? f.variables
              .filter((v) => v && v.symbol)
              .map((v) => ({ symbol: String(v.symbol).trim(), meaning: String(v.meaning || '').trim() }))
          : [],
      }));

    // Concept visual (optional — only when no formulas, for pipeline/hierarchy/comparison).
    if (!lesson.formulas.length && parsed.concept && parsed.concept.steps) {
      lesson.concept = {
        title: String(parsed.concept.title || '').trim(),
        style: String(parsed.concept.style || 'flow').trim(),
        steps: Array.isArray(parsed.concept.steps)
          ? parsed.concept.steps
              .filter((s) => s && s.label)
              .map((s) => ({ label: String(s.label).trim(), detail: String(s.detail || '').trim() }))
          : [],
      };
    } else {
      lesson.concept = null;
    }

    lesson.generated = Boolean(lesson.lecture && quiz.length);

    if (!lesson.generated) {
      return res.status(502).json({ error: 'The model returned incomplete lesson content. Try again.' });
    }

    store.writeCourse(course);
    res.json({ lesson });

    // Kick off audio generation in the background — don't make the client wait.
    tts.warmAudio(req.params.id, idx, lesson.lecture).catch(() => {});
  })
);

// --- Serve lesson audio (generate + cache on demand) -----------------------

router.get(
  '/courses/:id/lessons/:index/audio',
  wrap(async (req, res) => {
    const course = store.readCourse(req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found.' });

    const idx = Number(req.params.index);
    const lesson = course.lessons?.[idx];
    if (!lesson) return res.status(404).json({ error: 'Lesson not found.' });
    if (!lesson.generated || !lesson.lecture) {
      return res.status(409).json({ error: 'Lesson content has not been generated yet.' });
    }

    // streamAudio owns the response — it handles its own error replies.
    // Catch here so wrap() doesn't try to send a second error response.
    try {
      await tts.streamAudio(req.params.id, idx, lesson.lecture, res);
    } catch {
      // already handled inside streamAudio
    }
  })
);

// --- Record a quiz result --------------------------------------------------

router.post('/courses/:id/lessons/:index/complete', (req, res) => {
  const course = store.readCourse(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found.' });

  const idx = Number(req.params.index);
  const lesson = course.lessons?.[idx];
  if (!lesson) return res.status(404).json({ error: 'Lesson not found.' });

  const score = Math.max(0, Math.min(100, Number(req.body.score)));
  lesson.completed = true;
  lesson.score = score;
  lesson.passed = score >= 80;
  lesson.completedAt = Date.now();

  store.writeCourse(course);
  res.json({ lesson });
});

module.exports = router;
