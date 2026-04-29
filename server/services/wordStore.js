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

/** @type {Map<number, Set<string>>} */
const enGuessByLen = new Map();
/** @type {Map<number, Set<string>>} */
const esGuessByLen = new Map();

function parseJson(pkgPathInsideNodeModules) {
  const resolved = require.resolve(pkgPathInsideNodeModules);
  return JSON.parse(readFileSync(resolved, "utf8"));
}

/** Permissive guesses from npm corpus for a fixed letter count. */
function buildEnglishGuessExtras(len) {
  const words = /** @type {string[]} */ (
    parseJson("an-array-of-english-words/index.json")
  );
  /** @type {Set<string>} */
  const set = new Set();
  const re = new RegExp(`^[a-z]{${len}}$`);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (typeof w !== "string" || w.length !== len || !re.test(w)) continue;
    set.add(w);
  }
  return set;
}

/** Permissive guesses; corpus words folded to match unaccented play. */
function buildSpanishGuessExtras(len) {
  const words = /** @type {string[]} */ (
    parseJson("an-array-of-spanish-words/index.json")
  );
  /** @type {Set<string>} */
  const set = new Set();
  const re = new RegExp(`^[a-zñ]{${len}}$`);
  for (let i = 0; i < words.length; i++) {
    const raw = words[i];
    if (typeof raw !== "string") continue;
    const nfc = raw.normalize("NFC").toLowerCase();
    const folded = re.test(nfc) ? nfc : foldSpanishGuess(raw);
    if (folded.length !== len || !re.test(folded)) continue;
    set.add(folded);
  }
  return set;
}

function ensureEnglishExtras(len) {
  if (!enGuessByLen.has(len)) {
    enGuessByLen.set(len, buildEnglishGuessExtras(len));
  }
  return enGuessByLen.get(len);
}

function ensureSpanishExtras(len) {
  if (!esGuessByLen.has(len)) {
    esGuessByLen.set(len, buildSpanishGuessExtras(len));
  }
  return esGuessByLen.get(len);
}

/**
 * Words that may be picked as daily answers (curated per `server/data/*.json`), merged with permissive npm guesses.
 * @param {string} lang
 * @param {number} wordLength
 * @returns {string[]}
 */
export function getWordPool(lang, wordLength) {
  const wl = Math.floor(Number(wordLength));
  /** @type {Set<string>} */
  const acc = new Set();
  const sol = langToSolutionMap.get(lang);
  if (sol) {
    for (const w of sol.keys()) {
      if (typeof w === "string" && w.length === wl) acc.add(w);
    }
  }
  if (lang === "en") {
    ensureEnglishExtras(wl).forEach((w) => acc.add(w));
  } else if (lang === "es") {
    ensureSpanishExtras(wl).forEach((w) => acc.add(w));
  }
  return [...acc];
}

/**
 * Twi `tw.json` holds the corpus (6-letter); valid guesses are membership in that map.
 * English/Spanish add extra permissive guess sets beyond solution words.
 * @param {string} lang
 * @param {string} word
 */
export function isValidWord(lang, word) {
  if (typeof word !== "string") return false;
  const sol = langToSolutionMap.get(lang);
  if (sol?.has(word)) return true;

  const wl = word.length;
  if (lang === "en") return ensureEnglishExtras(wl).has(word);
  if (lang === "es") return ensureSpanishExtras(wl).has(word);
  return false;
}

/** Warm popular lengths so first guesses stay fast after deploy. */
for (const len of [4, 5, 6]) {
  ensureEnglishExtras(len);
  ensureSpanishExtras(len);
}
