import test from "node:test";
import assert from "node:assert/strict";
import { evaluateGuess } from "../server/services/wordEvaluate.js";

const states = (guess, answer) =>
  evaluateGuess(guess, answer).map((t) => t.state);

test("all letters correct when guess equals answer", () => {
  assert.deepEqual(states("crane", "crane"), [
    "correct",
    "correct",
    "correct",
    "correct",
    "correct",
  ]);
});

test("all letters absent when no overlap", () => {
  assert.deepEqual(states("fghij", "abcde"), [
    "absent",
    "absent",
    "absent",
    "absent",
    "absent",
  ]);
});

test("present when letter exists in wrong position", () => {
  // answer "abcde", guess "eabcd" — every letter present but shifted
  assert.deepEqual(states("eabcd", "abcde"), [
    "present",
    "present",
    "present",
    "present",
    "present",
  ]);
});

test("returns the guessed letters, not the answer letters", () => {
  const tiles = evaluateGuess("eabcd", "abcde");
  assert.deepEqual(
    tiles.map((t) => t.letter),
    ["e", "a", "b", "c", "d"],
  );
});

test("duplicate guess letter: only as many marked as the answer contains", () => {
  // answer has one "l"; guess has two. Correct position wins, the other is absent.
  // answer "balls" has two "l". guess "lulls": l(0) present? answer l at idx 2,3.
  const tiles = states("lllla", "balls");
  // answer letters: b a l l s  -> 'l' count 2
  // guess: l l l l a
  // pass1 correct: none of guess[i]===answer[i]? idx2 l===l yes, idx3 l===l yes -> 2 correct
  // remaining l: 2 - 2 = 0
  // pass2: idx0 l remaining 0 -> absent, idx1 l absent, idx4 a present (answer has a)
  assert.deepEqual(tiles, [
    "absent",
    "absent",
    "correct",
    "correct",
    "present",
  ]);
});

test("correct position takes priority over present for a repeated letter", () => {
  // answer "apple" has two "p". guess "ppppp"
  const tiles = states("ppppp", "apple");
  // correct at idx1,idx2 -> 2 correct, remaining p = 0
  assert.deepEqual(tiles, [
    "absent",
    "correct",
    "correct",
    "absent",
    "absent",
  ]);
});

test("present is consumed left-to-right and not double counted", () => {
  // answer "scoot" has two "o". guess "ooxxx" -> two o's, both present
  const tiles = states("ooxxx", "scoot");
  assert.deepEqual(tiles, [
    "present",
    "present",
    "absent",
    "absent",
    "absent",
  ]);
});

test("handles 6-letter words", () => {
  assert.equal(evaluateGuess("abcdef", "abcdef").length, 6);
});