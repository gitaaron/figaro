'use strict';

const express = require('express');
const store = require('../store');
const llm = require('../llm');
const { assessmentPrompt, outlinePrompt, lessonPrompt } = require('../prompts');

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

    const provider = llm.resolveProvider(req.body.provider || course.provider);
    const { system, user } = lessonPrompt(course, lesson, idx);
    const raw = await llm.chat(provider, system, user);
    const parsed = llm.parseJson(raw);

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
    lesson.generated = Boolean(lesson.lecture && quiz.length);

    if (!lesson.generated) {
      return res.status(502).json({ error: 'The model returned incomplete lesson content. Try again.' });
    }

    store.writeCourse(course);
    res.json({ lesson });
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
