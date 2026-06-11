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

IMPORTANT — mathematical formulas: if a lesson would naturally introduce
many formulas, scope it down so each lesson covers at most 3 formulas.
This keeps each lesson self-contained and digestible.

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

VISUAL SUPPLEMENT RULES:

A. FORMULAS — if this lesson introduces any mathematical formulas, you MUST
   include a "formulas" array. Each entry represents one formula:
   {
     "latex": "...",   // the formula in LaTeX notation, e.g. "\\frac{QK^T}{\\sqrt{d_k}}"
     "label": "...",   // short display name, e.g. "Scaled Dot-Product"
     "variables": [    // each variable that appears in the formula
       { "symbol": "Q", "meaning": "query matrix" }
     ]
   }
   Omit "formulas" (or use an empty array) if the lesson has no formulas.

B. CONCEPT VISUAL — if no formulas are present but the lesson covers a concept
   that would be significantly clearer as a labelled diagram (e.g. a pipeline,
   a hierarchy, a before/after comparison), include a "concept" object:
   {
     "title": "Short display title",
     "steps": [          // ordered list of nodes/steps/components
       { "label": "...", "detail": "one short phrase" }
     ],
     "style": "flow" | "hierarchy" | "comparison"
   }
   Omit "concept" entirely if the lesson is purely narrative or already has
   formulas.

Return ONLY this JSON shape:
{
  "lecture": "The full spoken lecture as one prose string.",
  "formulas": [
    {
      "latex": "...",
      "label": "...",
      "variables": [ { "symbol": "...", "meaning": "..." } ]
    }
  ],
  "concept": {
    "title": "...",
    "steps": [ { "label": "...", "detail": "..." } ],
    "style": "flow"
  },
  "quiz": [
    {
      "question": "...",
      "options": ["...", "...", "...", "..."],
      "answer": 0,
      "explanation": "..."
    }
  ]
}

Omit "formulas" if there are none. Omit "concept" if not needed or if formulas are present.`;
  return { system, user };
}

function chatPrompt(course, lesson, history, question) {
  const system =
    'You are Figaro, an expert tutor. ' +
    'Answer the learner\'s follow-up question clearly and concisely, ' +
    'staying grounded in the lesson content. ' +
    'Respond in plain prose — no markdown, no bullet points, no headings. ' +
    'Keep answers to 2-4 short paragraphs at most.';

  const historyText = (history || [])
    .map((h) => `Learner: ${h.question}\nFigaro: ${h.answer}`)
    .join('\n\n');

  const user = `Course: "${course.title}" (${course.topic}, ${course.level} level).
Lesson ${lesson.index + 1}: "${lesson.title}"

Lesson content:
${lesson.lecture}

${historyText ? `Prior follow-up conversation:\n${historyText}\n\n` : ''}Learner's question: ${question}`;

  return { system, user };
}

function suggestionsPrompt(course) {
  const system = BASE_SYSTEM;
  const lessonTitles = (course.lessons || []).map((l, i) => `${i + 1}. ${l.title}`).join('\n');

  // Collect all follow-up questions asked across every lesson.
  const allFollowUps = (course.lessons || []).flatMap((l) =>
    (l.followUps || []).map((f) => `[${l.title}] Q: ${f.question}`)
  );
  const followUpSection = allFollowUps.length
    ? `\nThe learner also asked these follow-up questions during the course:\n${allFollowUps.join('\n')}\n`
    : '';

  const user = `A learner is studying a course called "${course.title}" on the topic "${course.topic}" at ${course.level} level.

Lessons:
${lessonTitles}
${followUpSection}
Based on what they have studied and the questions they have asked, suggest 4 follow-on course topics they would naturally want to explore next. Each topic should be a concise phrase (5-10 words) — specific, actionable, and clearly connected to or extending this course. Vary the suggestions: some can go deeper into sub-topics, some can branch into adjacent areas.

Return ONLY this JSON shape:
{
  "suggestions": [
    "topic phrase one",
    "topic phrase two",
    "topic phrase three",
    "topic phrase four"
  ]
}`;
  return { system, user };
}

function closingPrompt(course) {
  const system =
    'You are Figaro, an expert tutor and instructional designer. ' +
    'Write flowing spoken prose only — no markdown, no headings, no bullet points. ' +
    'This text will be read aloud by a text-to-speech voice.';

  const lessonTitles = (course.lessons || []).map((l, i) => `${i + 1}. ${l.title}`).join('\n');

  const user = `A learner has just finished every lesson in the course "${course.title}" on "${course.topic}" (${course.level} level).

Lessons completed:
${lessonTitles}

Write a warm, encouraging closing message of 120-180 words that:
- Congratulates the learner on finishing the course
- Briefly recaps the two or three most important concepts they covered
- Encourages them to apply what they have learned and keep exploring

Write it as a single spoken paragraph. No JSON — just the plain text of the message.`;

  return { system, user };
}

module.exports = { assessmentPrompt, outlinePrompt, lessonPrompt, chatPrompt, suggestionsPrompt, closingPrompt, BASE_SYSTEM };
