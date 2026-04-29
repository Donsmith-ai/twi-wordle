import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt } from "node:crypto";
import {
  HISTORY_BUFFER_SIZE,
  getDailyWordSecret,
  legacyDefaultWordLength,
  isAllowedWordLength,
} from "../config.js";
import { getWordPool } from "./wordStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAILY_CACHE_PATH = join(__dirname, "..", "data", "daily-cache.json");
const HISTORY_PATH = join(__dirname, "..", "data", "usage-history.json");

/** @type {Record<string, string>} */
let memoryDaily = {};
/** @type {Record<string, string[]>} keys `${lang}|${wordLength}` */
let memoryHistory = {};

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function persistDaily() {
  writeFileSync(DAILY_CACHE_PATH, JSON.stringify(memoryDaily, null, 2), "utf8");
}

function persistHistory() {
  writeFileSync(HISTORY_PATH, JSON.stringify(memoryHistory, null, 2), "utf8");
}

function migrateDailyKeysFromLegacy() {
  /** @type {'en'|'es'|'tw'} */
  const langs = ["en", "es", "tw"];
  let dirty = false;
  const legacyLang = new Set(langs);
  for (const key of Object.keys(memoryDaily)) {
    const parts = key.split("|");
    if (parts.length !== 2 || !legacyLang.has(parts[0])) continue;
    const lang = /** @type {'en'|'es'|'tw'} */ (parts[0]);
    const date = parts[1];
    const wl = legacyDefaultWordLength(lang);
    const nk = `${lang}|${wl}|${date}`;
    memoryDaily[nk] = memoryDaily[key];
    delete memoryDaily[key];
    dirty = true;
  }
  if (dirty) persistDaily();
}

function migrateHistoryFromLegacy(raw) {
  /** @type {'en'|'es'|'tw'} */
  const langs = ["en", "es", "tw"];
  if (
    raw &&
    typeof raw === "object" &&
    Array.isArray(/** @type {{ en?: unknown }} */ (raw).en)
  ) {
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const lang of langs) {
      const wl = legacyDefaultWordLength(lang);
      const arr = Array.isArray(raw[lang]) ? raw[lang] : [];
      const k = `${lang}|${wl}`;
      out[k] = arr.filter(
        (w) => typeof w === "string" && w.length === wl,
      );
    }
    return out;
  }
  return raw && typeof raw === "object" ? raw : {};
}

/** Drop cached entries whose keys or word lengths are inconsistent. */
function sanitizePersistedState() {
  /** @type {'en'|'es'|'tw'} */
  const langs = ["en", "es", "tw"];
  const legacyLang = new Set(langs);
  migrateDailyKeysFromLegacy();

  let dailyDirty = false;
  for (const key of Object.keys(memoryDaily)) {
    const parts = key.split("|");
    if (parts.length !== 3) {
      delete memoryDaily[key];
      dailyDirty = true;
      continue;
    }
    const [langStr, wlStr, dateStr] = parts;
    if (
      !legacyLang.has(langStr) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    ) {
      delete memoryDaily[key];
      dailyDirty = true;
      continue;
    }
    const lang = /** @type {'en'|'es'|'tw'} */ (langStr);
    const wl = Number.parseInt(wlStr, 10);
    if (!isAllowedWordLength(lang, wl)) {
      delete memoryDaily[key];
      dailyDirty = true;
      continue;
    }
    const w = memoryDaily[key];
    if (typeof w !== "string" || w.length !== wl) {
      delete memoryDaily[key];
      dailyDirty = true;
    }
  }
  if (dailyDirty) persistDaily();

  let histDirty = false;
  for (const key of Object.keys(memoryHistory)) {
    const parts = key.split("|");
    if (parts.length !== 2) {
      delete memoryHistory[key];
      histDirty = true;
      continue;
    }
    const lang = /** @type {'en'|'es'|'tw'} */ (parts[0]);
    const wl = Number.parseInt(parts[1], 10);
    if (!legacyLang.has(lang) || !isAllowedWordLength(lang, wl)) {
      delete memoryHistory[key];
      histDirty = true;
      continue;
    }
    const arr = memoryHistory[key];
    if (!Array.isArray(arr)) {
      delete memoryHistory[key];
      histDirty = true;
      continue;
    }
    const next = arr.filter(
      (word) => typeof word === "string" && word.length === wl,
    );
    if (next.length !== arr.length) {
      memoryHistory[key] = next;
      histDirty = true;
    }
  }
  if (histDirty) persistHistory();
}

function initMemory() {
  memoryDaily = loadJson(DAILY_CACHE_PATH, {});
  const h = loadJson(HISTORY_PATH, null);
  let migrated = false;
  if (h && typeof h === "object" && Array.isArray(h.en)) migrated = true;
  memoryHistory = migrateHistoryFromLegacy(h);
  if (migrated) persistHistory();
  sanitizePersistedState();
}

initMemory();

/** Recent answers for dev/practice rounds (avoid immediate repeats). */
const practiceRecent = /** @type {Map<string, string[]>} */ (new Map());
const PRACTICE_RECENT_CAP = 80;

function recentPracticeKey(lang, wl) {
  return `${lang}|${wl}`;
}

/**
 * Random word from the language pool (non-deterministic). Used when `isPracticeRoundMode()`.
 * @param {'en'|'es'|'tw'} lang
 * @param {number} wordLength
 */
export function pickPracticeRoundWord(lang, wordLength) {
  const wl = Math.floor(Number(wordLength));
  const poolAll = getWordPool(lang, wl);
  if (poolAll.length === 0) {
    throw new Error(`empty_word_pool:${lang}:${wl}`);
  }
  const rk = recentPracticeKey(lang, wl);
  let recent = practiceRecent.get(rk) ?? [];
  let pool = poolAll.filter((w) => !recent.includes(w));
  if (pool.length === 0) pool = [...poolAll];

  const word = pool[randomInt(pool.length)];
  recent = [...recent, word];
  while (recent.length > PRACTICE_RECENT_CAP) recent.shift();
  practiceRecent.set(rk, recent);
  return word;
}

/**
 * Stable non-negative integer from string.
 * @param {string} s
 */
function hashToBucket(s, modulo) {
  const hex = createHash("sha256").update(s).digest("hex");
  const n = Number.parseInt(hex.slice(0, 12), 16);
  return modulo <= 0 ? 0 : n % modulo;
}

/**
 * Deterministic daily word for (lang, wordLength, local calendar date). Cached on disk.
 * @param {'en'|'es'|'tw'} lang
 * @param {string} localDate YYYY-MM-DD
 * @param {number} wordLength
 */
export function getDailyWord(lang, localDate, wordLength) {
  const wl = Math.floor(Number(wordLength));
  const key = `${lang}|${wl}|${localDate}`;
  const cached = memoryDaily[key];
  if (cached?.length === wl) return cached;
  if (cached && cached.length !== wl) {
    delete memoryDaily[key];
    persistDaily();
  }

  const poolAll = getWordPool(lang, wl);
  if (poolAll.length === 0) {
    throw new Error(`empty_daily_pool:${lang}:${wl}`);
  }

  const histKey = `${lang}|${wl}`;
  const recent = memoryHistory[histKey] ?? [];
  let pool = poolAll.filter((w) => !recent.includes(w));
  if (pool.length === 0) pool = [...poolAll];

  const secret = getDailyWordSecret();
  const pick = `${secret}|${localDate}|${lang}|${wl}`;
  const idx = hashToBucket(pick, pool.length);
  const word = pool[idx];

  memoryDaily[key] = word;

  if (!recent.includes(word)) {
    recent.push(word);
    while (recent.length > HISTORY_BUFFER_SIZE) recent.shift();
    memoryHistory[histKey] = recent;
  }

  persistDaily();
  persistHistory();
  return word;
}
