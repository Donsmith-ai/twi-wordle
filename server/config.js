/**
 * Central config. EN / ES / Twi support word lengths 4–6 (see server/data/*.json).
 */

/**
 * When true (typical for `npm start` / NODE_ENV not `production`), each fresh round
 * uses a random word and `roundKey` for resume; production keeps one daily word per locale date.
 */
export function isPracticeRoundMode() {
  return process.env.NODE_ENV !== "production";
}

export const MAX_GUESSES = 8;

/** Default length before prefs load (classic Wordle size). */
export const DEFAULT_WORD_LENGTH = 5;

/** @param {'en'|'es'|'tw'} lang */
export function allowedWordLengths(lang) {
  void lang;
  return [4, 5, 6];
}

/**
 * True when `wl` is allowed for `lang`.
 * @param {'en'|'es'|'tw'} lang
 * @param {number} wl
 */
export function isAllowedWordLength(lang, wl) {
  const n = Math.floor(Number(wl));
  return allowedWordLengths(/** @type {'en'|'es'|'tw'} */ (lang)).includes(n);
}

/**
 * Legacy daily defaults before multi-length (migrate persisted caches).
 * @param {'en'|'es'|'tw'} lang
 */
export function legacyDefaultWordLength(lang) {
  return lang === "tw" ? 6 : 5;
}

/** How many recent daily solutions to avoid repeating per language × length */
export const HISTORY_BUFFER_SIZE = 45;

/**
 * Server secret for daily word selection (prevents offline prediction of answers).
 * Set DAILY_WORD_SECRET in production.
 */
export function getDailyWordSecret() {
  return process.env.DAILY_WORD_SECRET || "dev-only-change-in-production";
}

/** RAE API key (https://rae-api.com) for Spanish end-game definitions. */
export function getRaeApiKey() {
  const key = process.env.RAE_API_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : "";
}
