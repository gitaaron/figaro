'use strict';

/**
 * Tiny file-backed JSON store.
 *
 * Each course is persisted as a single file:
 *   data/courses/<id>.json
 *
 * This keeps the whole thing dependency-free and human-inspectable. For a
 * single-user local app that's plenty; swap this module for SQLite/Postgres
 * later if you ever need concurrency or scale.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const COURSES_DIR = path.join(DATA_DIR, 'courses');

function ensureDirs() {
  fs.mkdirSync(COURSES_DIR, { recursive: true });
}
ensureDirs();

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function coursePath(id) {
  // Guard against path traversal — ids are hex, but be defensive anyway.
  const safe = String(id).replace(/[^a-z0-9]/gi, '');
  return path.join(COURSES_DIR, `${safe}.json`);
}

function readCourse(id) {
  try {
    const raw = fs.readFileSync(coursePath(id), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function writeCourse(course) {
  ensureDirs();
  const tmp = coursePath(course.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(course, null, 2));
  fs.renameSync(tmp, coursePath(course.id)); // atomic-ish replace
  return course;
}

function deleteCourse(id) {
  try {
    fs.unlinkSync(coursePath(id));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function listCourses() {
  ensureDirs();
  const files = fs.readdirSync(COURSES_DIR).filter((f) => f.endsWith('.json'));
  const courses = [];
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(COURSES_DIR, f), 'utf8'));
      courses.push(c);
    } catch {
      /* skip corrupt files */
    }
  }
  // Newest first.
  courses.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return courses;
}

/** Reduce a full course to a lightweight summary for list views. */
function lessonStatus(l) {
  if (l.completed && (l.score || 0) >= 80) return 'mastered';
  if (l.completed) return 'done';
  if (l.generated) return 'ready';
  return 'empty';
}

function courseSummary(course) {
  const lessons = course.lessons || [];
  const completed = lessons.filter((l) => l.completed).length;
  const passed = lessons.filter((l) => l.completed && (l.score || 0) >= 80).length;
  return {
    id: course.id,
    topic: course.topic,
    title: course.title,
    level: course.level,
    provider: course.provider,
    createdAt: course.createdAt,
    lessonCount: lessons.length,
    completedCount: completed,
    passedCount: passed,
    // Per-lesson states (in order) so the UI can track progress at a glance
    // across every course: 'empty' | 'ready' | 'done' | 'mastered'.
    lessonStatuses: lessons.map((l) => ({ title: l.title, status: lessonStatus(l) })),
  };
}

module.exports = {
  newId,
  readCourse,
  writeCourse,
  deleteCourse,
  listCourses,
  courseSummary,
  DATA_DIR,
  COURSES_DIR,
};
