import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATS_PATH = join(__dirname, "..", "data", "stats-store.json");

/** @type {Record<string, { players: string[], winners: string[] }>} */
let store = {};

function loadStore() {
  if (!existsSync(STATS_PATH)) {
    store = {};
    return;
  }
  try {
    store = JSON.parse(readFileSync(STATS_PATH, "utf8"));
  } catch {
    store = {};
  }
}

function saveStore() {
  writeFileSync(STATS_PATH, JSON.stringify(store, null, 2), "utf8");
}

loadStore();

/** @param {string} lang @param {string} localDate */
export function statsKey(lang, localDate) {
  return `${lang}|${localDate}`;
}

function bucket(key) {
  if (!store[key]) store[key] = { players: [], winners: [] };
  return store[key];
}

/**
 * @param {string} ip
 * @param {string|undefined} deviceId
 */
export function anonFingerprint(ip, deviceId) {
  const raw = `${ip}|${deviceId || "no-device"}|daily-wordle-stats`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

/**
 * Idempotent player count for calendar day + language.
 * @param {string} compositeKey statsKey(...)
 * @param {string} fp
 */
export function recordPlayer(compositeKey, fp) {
  const b = bucket(compositeKey);
  if (!b.players.includes(fp)) b.players.push(fp);
  saveStore();
}

/**
 * Record a win (deduped per player per day/language).
 */
export function recordWinner(compositeKey, fp) {
  const b = bucket(compositeKey);
  if (!b.winners.includes(fp)) b.winners.push(fp);
  saveStore();
}

/**
 * Snapshot for API (no raw hashes exposed — only aggregates).
 */
export function getAggregateStats(compositeKey) {
  const b = store[compositeKey];
  if (!b) {
    return {
      uniquePlayers: 0,
      uniqueWinners: 0,
    };
  }
  return {
    uniquePlayers: b.players.length,
    uniqueWinners: b.winners.length,
    /** Users who completed with a winning guess — same as uniqueWinners for this game */
    guessedCorrectCount: b.winners.length,
  };
}
