import test from "node:test";
import assert from "node:assert/strict";
import {
  foldSpanishGuess,
  foldEnglishOrTwiGuess,
} from "../server/services/latinFold.js";

test("foldSpanishGuess strips accents from vowels", () => {
  assert.equal(foldSpanishGuess("árbol"), "arbol");
  assert.equal(foldSpanishGuess("ÁRBOL"), "arbol");
  assert.equal(foldSpanishGuess("canción"), "cancion");
});

test("foldSpanishGuess keeps ñ intact", () => {
  assert.equal(foldSpanishGuess("niño"), "niño");
  assert.equal(foldSpanishGuess("NIÑO"), "niño");
});

test("foldSpanishGuess lowercases", () => {
  assert.equal(foldSpanishGuess("PERRO"), "perro");
});

test("foldSpanishGuess handles decomposed (NFD) input", () => {
  // "á" as a + combining acute accent
  assert.equal(foldSpanishGuess("árbol"), "arbol");
});

test("foldEnglishOrTwiGuess strips diacritics from loanwords", () => {
  assert.equal(foldEnglishOrTwiGuess("naïve"), "naive");
  assert.equal(foldEnglishOrTwiGuess("café"), "cafe");
});

test("foldEnglishOrTwiGuess lowercases", () => {
  assert.equal(foldEnglishOrTwiGuess("HELLO"), "hello");
});

test("foldEnglishOrTwiGuess leaves plain ascii unchanged", () => {
  assert.equal(foldEnglishOrTwiGuess("crane"), "crane");
});
