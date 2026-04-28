/**
 * Wordle-style per-tile feedback. Maps to UI: correct=blue, present=purple, absent=grey.
 * @param {string} guess normalized, same length as answer
 * @param {string} answer
 * @returns {{ letter: string, state: 'correct' | 'present' | 'absent' }[]}
 */
export function evaluateGuess(guess, answer) {
  const n = answer.length;
  const result = Array.from({ length: n }, (_, i) => ({
    letter: guess[i],
    state: /** @type {'absent'} */ ("absent"),
  }));

  const remaining = {};
  for (let i = 0; i < n; i++) {
    const c = answer[i];
    remaining[c] = (remaining[c] || 0) + 1;
  }

  for (let i = 0; i < n; i++) {
    if (guess[i] === answer[i]) {
      result[i].state = "correct";
      remaining[guess[i]]--;
    }
  }

  for (let i = 0; i < n; i++) {
    if (result[i].state === "correct") continue;
    const c = guess[i];
    if (remaining[c] > 0) {
      result[i].state = "present";
      remaining[c]--;
    }
  }

  return result;
}
