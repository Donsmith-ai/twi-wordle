import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { foldSpanishGuess } from "./latinFold.js";

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");

/** @typedef {{ w: string, d?: 'easy'|'medium'|'hard' }} WordEntry */

/** @type {Map<string, Map<string, WordEntry>>} */
const langToSolutionMap = new Map();

function loadLanguageFile(lang) {
  const path = join(DATA_DIR, `${lang}.json`);
  const raw = readFileSync(path, "utf8");
  /** @type {{ language: string, words: WordEntry[] }} */
  const parsed = JSON.parse(raw);
  const map = new Map();
  for (const entry of parsed.words) {
    map.set(entry.w, entry);
  }
  langToSolutionMap.set(lang, map);
}

["en", "es", "tw"].forEach(loadLanguageFile);

/** @type {Set<string>|null} */
let enGuessSet = null;
/** @type {Set<string>|null} */
let esGuessSet = null;

function parseJson(pkgPathInsideNodeModules) {
  const resolved = require.resolve(pkgPathInsideNodeModules);
  return JSON.parse(readFileSync(resolved, "utf8"));
}

/** ~12k permissive guesses (includes plural/slang/obscene forms not in curated lists). */
function buildEnglishGuessExtras() {
  const words = /** @type {string[]} */ (
    parseJson("an-array-of-english-words/index.json")
  );
  /** @type {Set<string>} */
  const set = new Set();
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (typeof w !== "string" || w.length !== 5 || !/^[a-z]{5}$/.test(w))
      continue;
    set.add(w);
  }
  return set;
}

/** ~11k permissive guesses; corpus words folded to match unaccented play. */
function buildSpanishGuessExtras() {
  const words = /** @type {string[]} */ (
    parseJson("an-array-of-spanish-words/index.json")
  );
  /** @type {Set<string>} */
  const set = new Set();
  for (let i = 0; i < words.length; i++) {
    const raw = words[i];
    if (typeof raw !== "string") continue;
    const nfc = raw.normalize("NFC").toLowerCase();
    // Skip per-character folding when the word is already playable glyphs only (majority case).
    const folded = /^[a-zñ]{5}$/.test(nfc) ? nfc : foldSpanishGuess(raw);
    if (folded.length !== 5 || !/^[a-zñ]{5}$/.test(folded)) continue;
    set.add(folded);
  }
  return set;
}

function getEnGuessExtras() {
  if (!enGuessSet) enGuessSet = buildEnglishGuessExtras();
  return enGuessSet;
}

function getEsGuessExtras() {
  if (!esGuessSet) esGuessSet = buildSpanishGuessExtras();
  return esGuessSet;
}

/**
 * Words that may be picked as daily answers (curated per `server/data/*.json`).
 * @param {string} lang
 * @returns {string[]}
 */
export function getAllWords(lang) {
  const m = langToSolutionMap.get(lang);
  if (!m) return [];
  return [...m.keys()];
}

/**
 * Twi `tw.json` holds the full HF corpus (6-letter); valid guesses are membership in that map.
 * English/Spanish add extra permissive guess sets beyond solution words.
 */
export function isValidWord(lang, word) {
  const sol = langToSolutionMap.get(lang);
  if (sol?.has(word)) return true;

  if (lang === "en") return getEnGuessExtras().has(word);
  if (lang === "es") return getEsGuessExtras().has(word);
  return false;
}

/**
 * For daily selection: same pool as guesses (per language).
 * @param {string} lang
 */
export function getWordPool(lang) {
  return getAllWords(lang);
}

/** Warm at startup so the first /api/game/guess for ES is not blocked by a cold Spanish extras build. */
getEnGuessExtras();
getEsGuessExtras();
