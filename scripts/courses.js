#!/usr/bin/env node
'use strict';

/**
 * Figaro course management CLI
 *
 * Usage:
 *   node scripts/courses.js list
 *   node scripts/courses.js regenerate <course-id> [--provider=claude]
 */

const path = require('path');

// Resolve modules relative to the server directory.
const store   = require(path.join(__dirname, '../server/store'));
const llm     = require(path.join(__dirname, '../server/llm'));
const tts     = require(path.join(__dirname, '../server/tts'));
const { lessonPrompt } = require(path.join(__dirname, '../server/prompts'));

// Load .env from project root if present.
try {
  const fs = require('fs');
  const envPath = path.join(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch { /* .env is optional */ }

// ---- helpers ---------------------------------------------------------------

function die(msg) {
  console.error(`\nError: ${msg}\n`);
  process.exit(1);
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

const STATUS_ICON = { empty: '○', ready: '◑', done: '●', mastered: '★' };

// ---- commands --------------------------------------------------------------

function cmdList() {
  const courses = store.listCourses();
  if (!courses.length) {
    console.log('\nNo courses found.\n');
    return;
  }

  console.log(`\nFound ${courses.length} course${courses.length === 1 ? '' : 's'}:\n`);

  for (const c of courses) {
    const lessons  = c.lessons || [];
    const passed   = lessons.filter((l) => l.completed && (l.score || 0) >= 80).length;
    const done     = lessons.filter((l) => l.completed).length;
    const ready    = lessons.filter((l) => l.generated && !l.completed).length;
    const pct      = lessons.length ? Math.round((passed / lessons.length) * 100) : 0;

    console.log(`  ${c.title}`);
    console.log(`    ID       : ${c.id}`);
    console.log(`    Topic    : ${c.topic}`);
    console.log(`    Level    : ${c.level}  |  Provider: ${c.provider}  |  Created: ${formatDate(c.createdAt)}`);
    console.log(`    Progress : ${passed}/${lessons.length} mastered (${pct}%) — ${done} completed, ${ready} ready`);

    // One dot per lesson showing its status.
    const dots = lessons.map((l, i) => {
      let s = 'empty';
      if (l.completed && (l.score || 0) >= 80) s = 'mastered';
      else if (l.completed) s = 'done';
      else if (l.generated) s = 'ready';
      return `${i + 1}${STATUS_ICON[s]}`;
    }).join('  ');
    console.log(`    Lessons  : ${dots}`);
    console.log();
  }

  console.log('Legend: ○ not generated  ◑ ready  ● completed  ★ mastered\n');
}

async function cmdRegenerate(courseId, provider) {
  const course = store.readCourse(courseId);
  if (!course) die(`Course not found: "${courseId}"\nRun 'list' to see valid IDs.`);

  const resolvedProvider = llm.resolveProvider(provider || course.provider);
  const lessons = course.lessons || [];

  console.log(`\nRegenerating: ${course.title}`);
  console.log(`Provider    : ${resolvedProvider}`);
  console.log(`Lessons     : ${lessons.length}\n`);

  for (let i = 0; i < lessons.length; i++) {
    const lesson = lessons[i];
    process.stdout.write(`  [${i + 1}/${lessons.length}] ${lesson.title} … `);

    try {
      // Delete stale audio first.
      tts.deleteAudio(course.id, i);

      const { system, user } = lessonPrompt(course, lesson, i);
      const raw    = await llm.chat(resolvedProvider, system, user);
      const parsed = llm.parseJson(raw);

      const quiz = (Array.isArray(parsed.quiz) ? parsed.quiz : [])
        .map((q) => ({
          question:    String(q.question || '').trim(),
          options:     (Array.isArray(q.options) ? q.options : []).map(String),
          answer:      Number.isInteger(q.answer) ? q.answer : 0,
          explanation: String(q.explanation || '').trim(),
        }))
        .filter((q) => q.question && q.options.length >= 2);

      lesson.lecture = String(parsed.lecture || '').trim();
      lesson.quiz    = quiz;

      const rawFormulas = Array.isArray(parsed.formulas) ? parsed.formulas : [];
      lesson.formulas = rawFormulas
        .filter((f) => f && typeof f.latex === 'string' && f.latex.trim())
        .map((f) => ({
          latex:     String(f.latex).trim(),
          label:     String(f.label || '').trim(),
          variables: Array.isArray(f.variables)
            ? f.variables.filter((v) => v && v.symbol)
                .map((v) => ({ symbol: String(v.symbol).trim(), meaning: String(v.meaning || '').trim() }))
            : [],
        }));

      if (!lesson.formulas.length && parsed.concept && parsed.concept.steps) {
        lesson.concept = {
          title: String(parsed.concept.title || '').trim(),
          style: String(parsed.concept.style || 'flow').trim(),
          steps: Array.isArray(parsed.concept.steps)
            ? parsed.concept.steps.filter((s) => s && s.label)
                .map((s) => ({ label: String(s.label).trim(), detail: String(s.detail || '').trim() }))
            : [],
        };
      } else {
        lesson.concept = null;
      }

      lesson.generated  = Boolean(lesson.lecture && quiz.length);
      lesson.completed  = false;
      lesson.score      = null;
      lesson.passed     = false;
      lesson.completedAt = null;

      if (!lesson.generated) {
        console.log('WARN — incomplete content, skipping');
        continue;
      }

      store.writeCourse(course);
      console.log('done');

      // Warm audio in background; don't await so lessons generate serially.
      tts.warmAudio(course.id, i, lesson.lecture).catch(() => {});
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }
  }

  console.log('\nRegeneration complete.\n');
}

// ---- CLI entry point -------------------------------------------------------

const [,, command, ...args] = process.argv;

const providerArg = args.find((a) => a.startsWith('--provider='));
const provider    = providerArg ? providerArg.split('=')[1] : null;
const positional  = args.filter((a) => !a.startsWith('--'));

switch (command) {
  case 'list':
    cmdList();
    break;

  case 'regenerate': {
    const id = positional[0];
    if (!id) die('Usage: node scripts/courses.js regenerate <course-id> [--provider=claude]');
    cmdRegenerate(id, provider).catch((err) => die(err.message));
    break;
  }

  default:
    console.log(`
Figaro course CLI

Commands:
  list                                     List all courses with progress
  regenerate <id> [--provider=<name>]      Regenerate all lessons for a course

Examples:
  node scripts/courses.js list
  node scripts/courses.js regenerate abc123def456
  node scripts/courses.js regenerate abc123def456 --provider=claude
`);
}
