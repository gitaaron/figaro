// quiz.js — runs a lesson quiz in either hands-free (voice) or manual mode,
// scores it, persists the result, and shows a Coursera-style results screen.

import { el, clear, showToast } from './ui.js';
import { api } from './api.js';
import {
  say, listenOnce, cancelSpeech, checkMic, matchAnswer, sttSupported, ttsSupported,
} from './speech.js';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

export function mountQuiz(mount, { course, index, navigate }) {
  const lesson = course.lessons[index];
  const quiz = lesson.quiz || [];
  const answers = new Array(quiz.length).fill(null);
  let mode = null;      // 'voice' | 'manual'
  let cancelled = false;

  function teardown() {
    cancelled = true;
    cancelSpeech();
  }

  // ---- Mode chooser -------------------------------------------------------
  function renderModeChooser() {
    cancelSpeech();
    clear(mount);
    mount.appendChild(
      el('a', { class: 'back', href: `#/lesson/${course.id}/${index}`, text: '‹ back to lesson' })
    );
    mount.appendChild(el('p', { class: 'eyebrow', text: 'Quiz' }));
    mount.appendChild(el('h1', { text: lesson.title }));
    mount.appendChild(el('p', { class: 'lede', text: `${quiz.length} questions · choose how you'd like to answer.` }));

    const voiceDisabled = !sttSupported;
    const grid = el('div', { class: 'mode-grid' },
      el('button', {
        class: 'mode-card' + (voiceDisabled ? ' is-disabled' : ''),
        disabled: voiceDisabled,
        onClick: () => {
          if (voiceDisabled) return;
          // Call getUserMedia synchronously within the click gesture so the
          // browser shows its permission prompt in the URL bar.
          const micPromise = navigator.mediaDevices
            ? navigator.mediaDevices.getUserMedia({ audio: true })
            : Promise.reject(new Error('no mediaDevices'));
          micPromise.then((stream) => {
            stream.getTracks().forEach((t) => t.stop());
            start('voice');
          }).catch((err) => {
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
              showToast('Microphone is blocked. Click the lock icon in the URL bar → Site settings → Microphone → Allow, then reload.', { type: 'warn', duration: 12000 });
            } else {
              showToast('Could not access the microphone. Check your device settings.', { type: 'error' });
            }
          });
        },
      },
        el('div', { class: 'ico', text: '🎙️' }),
        el('h3', { text: 'Answer hands-free' }),
        el('p', { class: 'muted', text: voiceDisabled
          ? 'Voice recognition isn’t available in this browser. Try Chrome or Edge.'
          : 'Figaro reads each question and its options aloud, then listens for your answer. Say “A”, “two”, or the option itself.' }),
      ),
      el('button', { class: 'mode-card', onClick: () => start('manual') },
        el('div', { class: 'ico', text: '✍️' }),
        el('h3', { text: 'Use my hands' }),
        el('p', { class: 'muted', text: 'Read at your own pace and tap to choose your answers.' }),
      ),
    );
    mount.appendChild(grid);
  }

  function start(m) {
    mode = m;
    renderQuestion(0);
  }

  // ---- One question -------------------------------------------------------
  function renderQuestion(qi) {
    if (cancelled) return;
    cancelSpeech();
    const q = quiz[qi];
    let locked = answers[qi] != null;

    clear(mount);
    mount.appendChild(el('a', { class: 'back', href: `#/course/${course.id}`, text: '‹ back to course' }));
    mount.appendChild(el('div', { class: 'quiz-progress', text: `Question ${qi + 1} of ${quiz.length}` }));
    mount.appendChild(el('div', { class: 'quiz-question', text: q.question }));

    const optionsWrap = el('div', { class: 'options' });
    const optionBtns = q.options.map((opt, oi) =>
      el('button', { class: 'option', onClick: () => choose(oi) },
        el('span', { class: 'key', text: LETTERS[oi] }),
        el('span', { text: opt }),
      )
    );
    optionBtns.forEach((b) => optionsWrap.appendChild(b));
    mount.appendChild(optionsWrap);

    const feedbackSlot = el('div');
    mount.appendChild(feedbackSlot);

    // hands-free live indicator
    let listenIndicator = null;
    if (mode === 'voice') {
      listenIndicator = el('div', { class: 'listening' },
        el('span', { class: 'pulse' }),
        el('span', { text: 'Listening…' }),
      );
    }

    function paintResult(chosen) {
      optionBtns.forEach((b, oi) => {
        b.disabled = true;
        if (oi === q.answer) b.classList.add('option--correct');
        else if (oi === chosen) b.classList.add('option--wrong');
        else b.classList.add('option--dim');
      });
    }

    function choose(oi) {
      if (locked) return;
      locked = true;
      answers[qi] = oi;
      if (listenIndicator && listenIndicator.parentNode) listenIndicator.remove();
      paintResult(oi);

      const correct = oi === q.answer;
      clear(feedbackSlot);
      feedbackSlot.appendChild(
        el('div', { class: 'explanation' },
          el('b', { text: correct ? 'Correct. ' : `Not quite — the answer is ${LETTERS[q.answer]}. ` }),
          document.createTextNode(q.explanation || ''),
        )
      );

      const isLast = qi === quiz.length - 1;
      const next = el('button', {
        class: 'btn btn--primary btn--block',
        style: 'margin-top:16px',
        text: isLast ? 'See results' : 'Next question',
        onClick: () => goNext(),
      });
      feedbackSlot.appendChild(next);

      let advanced = false;
      const goNext = () => {
        if (advanced) return;
        advanced = true;
        if (isLast) renderResults();
        else renderQuestion(qi + 1);
      };
      next.onclick = goNext;

      if (mode === 'voice') {
        const feedbackSpeech = correct
          ? 'Correct.'
          : `Not quite. The correct answer is ${LETTERS[q.answer]}.`;
        say(`${feedbackSpeech} ${isLast ? 'That was the last question. Here are your results.' : 'Say next to continue.'}`)
          .then(() => {
            if (cancelled || advanced) return;
            if (isLast) { goNext(); return; }
            const { promise } = listenOnce({ timeout: 6000 });
            promise.then(() => { if (!cancelled) goNext(); });
          });
      }
    }

    if (mode === 'voice') {
      mount.appendChild(listenIndicator);
      runVoiceTurn(qi, q, choose, optionsWrap);
    }
  }

  // Speak the question + options, then listen and auto-select.
  async function runVoiceTurn(qi, q, choose, optionsWrap, attempt = 1) {
    if (cancelled) return;
    const spoken =
      `Question ${qi + 1}. ${q.question}. ` +
      q.options.map((o, oi) => `Option ${LETTERS[oi]}: ${o}.`).join(' ') +
      ' What is your answer?';
    await say(spoken);
    if (cancelled || answers[qi] != null) return;

    const { promise } = listenOnce({ timeout: 9000 });
    const transcript = await promise;
    if (cancelled || answers[qi] != null) return;

    const idx = matchAnswer(transcript, q.options);
    // show what was heard
    const heard = el('div', { class: 'heard', text: transcript ? `Heard: “${transcript}”` : 'Didn’t catch that.' });
    optionsWrap.parentNode.insertBefore(heard, optionsWrap.nextSibling);

    if (idx >= 0) {
      choose(idx);
    } else if (attempt < 2) {
      await say("Sorry, I didn't catch that. Let's try once more.");
      if (!cancelled && answers[qi] == null) runVoiceTurn(qi, q, choose, optionsWrap, attempt + 1);
    } else {
      await say('No problem — please tap your answer.');
    }
  }

  // ---- Results ------------------------------------------------------------
  async function renderResults() {
    cancelSpeech();
    const total = quiz.length;
    const correct = quiz.reduce((acc, q, i) => acc + (answers[i] === q.answer ? 1 : 0), 0);
    const score = Math.round((correct / total) * 100);
    const passed = score >= 80;

    // persist
    try {
      const updated = await api.completeLesson(course.id, index, score);
      course.lessons[index] = updated.lesson;
    } catch (e) {
      console.warn('Could not save result:', e.message);
    }

    clear(mount);
    const result = el('div', { class: 'result' });

    // score ring
    const R = 64, C = 2 * Math.PI * R;
    const ring = el('div', { class: 'score-ring' });
    ring.innerHTML = `
      <svg viewBox="0 0 150 150" width="150" height="150">
        <circle cx="75" cy="75" r="${R}" fill="none" stroke="var(--line)" stroke-width="11"/>
        <circle cx="75" cy="75" r="${R}" fill="none"
          stroke="${passed ? 'var(--success)' : 'var(--accent)'}" stroke-width="11"
          stroke-linecap="round" stroke-dasharray="${C}"
          stroke-dashoffset="${C * (1 - score / 100)}"/>
      </svg>`;
    ring.appendChild(el('div', { style: 'text-align:center' },
      el('div', { class: 'score-ring__num', text: `${score}` }),
      el('div', { class: 'score-ring__pct', text: `${correct}/${total}` }),
    ));
    result.appendChild(ring);

    const verdict = el('div', { class: 'verdict' });
    verdict.textContent = passed ? 'Mastered' : 'Keep going';
    if (passed) verdict.appendChild(el('span', { class: 'check', html: '&#10003;', title: 'Score over 80%' }));
    result.appendChild(verdict);
    result.appendChild(el('p', { class: 'muted', text: passed
      ? 'You scored over 80% — this lesson is marked complete.'
      : 'Score 80% or higher to earn the green check. Review the answers below and try again.' }));

    // review
    const review = el('div', { class: 'review' });
    quiz.forEach((q, i) => {
      const ok = answers[i] === q.answer;
      const yourAns = answers[i] == null ? '—' : `${LETTERS[answers[i]]}. ${q.options[answers[i]]}`;
      const item = el('div', { class: 'review-item' },
        el('div', { class: 'rq', text: `${i + 1}. ${q.question}` }),
        el('div', { class: `ra ${ok ? 'ok' : 'no'}`, text: `${ok ? '✓' : '✗'} Your answer: ${yourAns}` }),
      );
      if (!ok) item.appendChild(el('div', { class: 'ra', text: `Correct: ${LETTERS[q.answer]}. ${q.options[q.answer]}`, style: 'color:var(--success)' }));
      review.appendChild(item);
    });

    const actions = el('div', { class: 'row', style: 'margin-top:24px' },
      el('button', { class: 'btn btn--ghost', text: 'Retake quiz', onClick: () => {
        answers.fill(null);
        renderModeChooser();
      } }),
      el('a', { class: 'btn btn--primary', href: `#/course/${course.id}`, text: 'Back to course' }),
    );

    mount.appendChild(result);
    mount.appendChild(actions);
    mount.appendChild(review);

    if (mode === 'voice' && ttsSupported) {
      say(`You scored ${score} percent. ${passed ? 'Well done, you passed.' : 'Review the answers and try again when ready.'}`);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  renderModeChooser();
  return teardown;
}
