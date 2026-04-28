/**
 * Central config. Twi uses 6-letter words; English and Spanish use 5.
 */
export const MAX_GUESSES = 8;
export const WORD_LENGTH = 5;
export const WORD_LENGTH_TW = 6;

/** @param {'en'|'es'|'tw'} lang */
export function wordLengthForLang(lang) {
  return lang === "tw" ? WORD_LENGTH_TW : WORD_LENGTH;
}

/** How many recent daily solutions to avoid repeating per language */
export const HISTORY_BUFFER_SIZE = 45;

/**
 * Server secret for daily word selection (prevents offline prediction of answers).
 * Set DAILY_WORD_SECRET in production.
 */
export function getDailyWordSecret() {
  return process.env.DAILY_WORD_SECRET || "dev-only-change-in-production";
}
