import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HISTORY_BUFFER_SIZE,
  getDailyWordSecret,
  wordLengthForLang,
} from "../config.js";
import { getWordPool } from "./wordStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAILY_CACHE_PATH = join(__dirname, "..", "data", "daily-cache.json");
const HISTORY_PATH = join(__dirname, "..", "data", "usage-history.json");

/** @type {Record<string, string>} */
let memoryDaily = {};
/** @type {{ en: string[], es: string[], tw: string[] }} */
let memoryHistory = { en: [], es: [], tw: [] };

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

/** Drop cached daily words / history entries whose length does not match the language (e.g. bad legacy cache). */
function sanitizePersistedState() {
  /** @type {'en'|'es'|'tw'} */
  const langs = ["en", "es", "tw"];
  let dailyDirty = false;
  for (const key of Object.keys(memoryDaily)) {
    const lang = /** @type {string} */ (key.split("|")[0]);
    if (!langs.includes(lang)) continue;
    const w = memoryDaily[key];
    const wl = wordLengthForLang(/** @type {'en'|'es'|'tw'} */ (lang));
    if (typeof w !== "string" || w.length !== wl) {
      delete memoryDaily[key];
      dailyDirty = true;
    }
  }
  if (dailyDirty) persistDaily();

  let histDirty = false;
  for (const lang of langs) {
    const wl = wordLengthForLang(lang);
    const arr = memoryHistory[lang];
    const next = arr.filter((w) => typeof w === "string" && w.length === wl);
    if (next.length !== arr.length) {
      memoryHistory[lang] = next;
      histDirty = true;
    }
  }
  if (histDirty) persistHistory();
}

function initMemory() {
  memoryDaily = loadJson(DAILY_CACHE_PATH, {});
  const h = loadJson(HISTORY_PATH, null);
  if (h && typeof h === "object") {
    memoryHistory = {
      en: Array.isArray(h.en) ? h.en : [],
      es: Array.isArray(h.es) ? h.es : [],
      tw: Array.isArray(h.tw) ? h.tw : [],
    };
  }
  sanitizePersistedState();
}

initMemory();

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
 * Deterministic daily word for (lang, local calendar date). Cached on disk.
 * @param {'en'|'es'|'tw'} lang
 * @param {string} localDate YYYY-MM-DD
 */
export function getDailyWord(lang, localDate) {
  const wl = wordLengthForLang(lang);
  const key = `${lang}|${localDate}`;
  const cached = memoryDaily[key];
  if (cached?.length === wl) return cached;
  if (cached && cached.length !== wl) {
    delete memoryDaily[key];
    persistDaily();
  }

  const poolAll = getWordPool(lang).filter(
    (w) => typeof w === "string" && w.length === wl,
  );
  const recent = memoryHistory[lang] || [];
  let pool = poolAll.filter((w) => !recent.includes(w));
  if (pool.length === 0) pool = [...poolAll];

  const secret = getDailyWordSecret();
  const pick = `${secret}|${localDate}|${lang}`;
  const idx = hashToBucket(pick, pool.length);
  const word = pool[idx];

  memoryDaily[key] = word;

  if (!recent.includes(word)) {
    recent.push(word);
    while (recent.length > HISTORY_BUFFER_SIZE) recent.shift();
    memoryHistory[lang] = recent;
  }

  persistDaily();
  persistHistory();
  return word;
}
