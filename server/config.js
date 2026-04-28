/**
 * Central config. Future: hard mode, variable length, extra languages via env.
 */
export const MAX_GUESSES = 8;
export const WORD_LENGTH = 5;

/** How many recent daily solutions to avoid repeating per language */
export const HISTORY_BUFFER_SIZE = 45;

/**
 * Server secret for daily word selection (prevents offline prediction of answers).
 * Set DAILY_WORD_SECRET in production.
 */
export function getDailyWordSecret() {
  return process.env.DAILY_WORD_SECRET || "dev-only-change-in-production";
}
