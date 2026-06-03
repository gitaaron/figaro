'use strict';

/**
 * Prompt builders for Figaro's three LLM tasks:
 *   1. assessment  — probe prerequisite knowledge for a topic
 *   2. outline     — turn topic + answers into a leveled course outline
 *   3. lesson      — write one ~5-minute audio lecture + a quiz
 *
 * Every prompt instructs the model to return ONLY JSON. The parsing in
 * llm.js is defensive in case a model adds stray prose or code fences.
 */

const BASE_SYSTEM =
  'You are Figaro, an expert tutor and instructional designer. ' +
  'You create clear, accurate, well-structured learning material. ' +
  'When asked for JSON, you respond with raw JSON only — no markdown, ' +
  'no code fences, no commentary before or after.';

function assessmentPrompt(topic) {
  const system = BASE_SYSTEM;
  const user = `A learner wants to study: "${topic}".

Write 4 to 6 short diagnostic questions that probe whether they already
understand the PREREQUISITE concepts needed to learn this topic well. The
questions should range from foundational to more advanced so the answers
reveal the learner's current level. Keep each question to one or two sentences
and answerable in a sentence or two (open-ended, not multiple choice).

Return ONLY this JSON shape:
{
  "questions": [
    { "id": "q1", "question": "..." }
  ]
}`;
  return { system, user };
}

function outlinePrompt(topic, answers) {
  const system = BASE_SYSTEM;
  const transcript = (answers || [])
    .map((a, i) => `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer || '(no answer)'}`)
    .join('\n\n');

  const user = `A learner wants to study: "${topic}".

Here are their answers to the diagnostic questions:

${transcript || '(the learner skipped the diagnostic)'}

Based on these answers, infer their current level ("beginner",
"intermediate", or "advanced") and design a focused course of 5 to 7 lessons
that starts exactly where they are — skip what they already know, reinforce
shaky areas, and build toward genuine competence in "${topic}".

Each lesson will later become a ~5-minute audio lecture, so scope each one to
a single digestible idea.

Return ONLY this JSON shape:
{
  "title": "A short, compelling course title",
  "level": "beginner | intermediate | advanced",
  "summary": "2-3 sentences on what the course covers and why it fits this learner.",
  "lessons": [
    { "title": "Lesson title", "summary": "One sentence on what this lesson teaches." }
  ]
}`;
  return { system, user };
}

function lessonPrompt(course, lesson, lessonIndex) {
  const system = BASE_SYSTEM;
  const outline = (course.lessons || [])
    .map((l, i) => `${i + 1}. ${l.title}${i === lessonIndex ? '  <-- WRITE THIS ONE' : ''}`)
    .join('\n');

  const user = `Course: "${course.title}" (topic: "${course.topic}", level: ${course.level}).

Full lesson outline:
${outline}

Write lesson ${lessonIndex + 1}: "${lesson.title}".
Focus: ${lesson.summary || lesson.title}

Requirements for the lecture:
- It is spoken aloud by a text-to-speech voice, so write flowing PROSE only.
- No markdown, no headings, no bullet points, no lists, no stage directions.
- Aim for 650-850 words (about five minutes of speech).
- Warm, clear, and engaging — like a great instructor talking to one student.
- Pitch it at a ${course.level} level and build on earlier lessons in the outline.

Then write a 5-question multiple-choice quiz on THIS lesson. Each question has
exactly 4 options, one correct. "answer" is the 0-based index of the correct
option. Include a one-sentence explanation.

Return ONLY this JSON shape:
{
  "lecture": "The full spoken lecture as one prose string.",
  "quiz": [
    {
      "question": "...",
      "options": ["...", "...", "...", "..."],
      "answer": 0,
      "explanation": "..."
    }
  ]
}`;
  return { system, user };
}

module.exports = { assessmentPrompt, outlinePrompt, lessonPrompt, BASE_SYSTEM };
