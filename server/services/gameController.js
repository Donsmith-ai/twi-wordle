/** @typedef {{ lang: string, localDate: string, answer: string, status: 'playing'|'won'|'lost', guesses: number, anon_fp: string }} GameSession */

import { randomBytes } from "node:crypto";
import { evaluateGuess } from "./wordEvaluate.js";
import { getDailyWord } from "./dailyWord.js";
import { isValidWord } from "./wordStore.js";
import {
  anonFingerprint,
  getAggregateStats,
  recordPlayer,
  recordWinner,
  statsKey,
} from "./statsStore.js";
import { claimIpPlaySlot } from "./ipPlayStore.js";
import { MAX_GUESSES, WORD_LENGTH } from "../config.js";
import { foldEnglishOrTwiGuess, foldSpanishGuess } from "./latinFold.js";

/** @type {Map<string, GameSession>} */
const sessions = new Map();

const LANGS = ["en", "es", "tw"];

function isLang(x) {
  return LANGS.includes(x);
}

/**
 * @param {string} lang
 * @param {string} raw
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
export function normalizeGuess(lang, raw) {
  if (typeof raw !== "string") return { ok: false, reason: "invalid_type" };
  const trimmed = raw.normalize("NFC").trim();
  if (trimmed.length !== WORD_LENGTH) return { ok: false, reason: "length" };

  if (lang === "es") {
    const lowered = trimmed.toLowerCase();
    const folded = foldSpanishGuess(lowered);
    if (folded.length !== WORD_LENGTH) return { ok: false, reason: "charset" };
    if (!/^[a-zñ]{5}$/.test(folded)) return { ok: false, reason: "charset" };
    return { ok: true, value: folded };
  }
  if (lang === "en" || lang === "tw") {
    const folded = foldEnglishOrTwiGuess(trimmed);
    if (folded.length !== WORD_LENGTH) return { ok: false, reason: "charset" };
    if (!/^[a-z]{5}$/.test(folded)) return { ok: false, reason: "charset" };
    return { ok: true, value: folded };
  }
  return { ok: false, reason: "lang" };
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "0.0.0.0";
}

/**
 * @param {import('express').Request} req
 */
function fingerprint(req) {
  const dev = req.headers["x-device-id"];
  const id =
    typeof dev === "string" && dev.length > 8 ? dev.slice(0, 256) : undefined;
  return anonFingerprint(clientIp(req), id);
}

/** ISO date regex */
function isIsoDate(d) {
  return (
    typeof d === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    !Number.isNaN(Date.parse(`${d}T12:00:00`))
  );
}

/**
 * POST /start
 */
export function startGame(req, res) {
  const { lang, localDate, timeZone } = req.body || {};
  if (!isLang(lang)) {
    return res.status(400).json({ error: "invalid_lang" });
  }
  if (!isIsoDate(localDate)) {
    return res.status(400).json({ error: "invalid_local_date" });
  }

  const ip = clientIp(req);
  if (!claimIpPlaySlot(localDate, ip)) {
    return res.status(403).json({
      error: "ip_already_played",
      message:
        "This network address already started today’s game. Only one play per day is allowed.",
    });
  }

  const fp = fingerprint(req);
  const key = statsKey(lang, localDate);
  recordPlayer(key, fp);

  const answer = getDailyWord(/** @type {'en'|'es'|'tw'} */ (lang), localDate);
  const sessionId = randomBytes(24).toString("hex");
  sessions.set(sessionId, {
    lang,
    localDate,
    answer,
    status: "playing",
    guesses: 0,
    anon_fp: fp,
  });

  res.json({
    sessionId,
    maxGuesses: MAX_GUESSES,
    wordLength: WORD_LENGTH,
    timeZone: typeof timeZone === "string" ? timeZone : null,
  });
}

/**
 * POST /guess
 */
export function submitGuess(req, res) {
  const { sessionId, guess } = req.body || {};
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "missing_session" });
  }
  const sess = sessions.get(sessionId);
  if (!sess) {
    return res.status(404).json({ error: "unknown_session", valid: false });
  }

  if (sess.status !== "playing") {
    const sk = statsKey(sess.lang, sess.localDate);
    return res.json({
      valid: true,
      gameOver: true,
      alreadyFinished: true,
      status: sess.status,
      answer: sess.answer,
      stats: getAggregateStats(sk),
      guessesUsed: sess.guesses,
    });
  }

  const norm = normalizeGuess(sess.lang, guess);
  if (!norm.ok) {
    return res.json({
      valid: false,
      invalidReason: norm.reason,
    });
  }

  const word = norm.value;
  if (!isValidWord(sess.lang, word)) {
    return res.json({ valid: false, invalidReason: "not_in_dictionary" });
  }

  sess.guesses += 1;

  const tiles = evaluateGuess(word, sess.answer);

  /** @type {('correct'|'present'|'absent')[]} */
  const feedback = tiles.map(({ state }) =>
    state === "correct"
      ? "correct"
      : state === "present"
      ? "present"
      : "absent",
  );

  const won = word === sess.answer;
  const lost = !won && sess.guesses >= MAX_GUESSES;

  /** @type {'playing'|'won'|'lost'} */
  let status = sess.status;

  const sk = statsKey(sess.lang, sess.localDate);

  if (won) {
    sess.status = "won";
    status = "won";
    recordWinner(sk, sess.anon_fp);
  } else if (lost) {
    sess.status = "lost";
    status = "lost";
  }

  const gameOver = won || lost;
  const stats = gameOver ? getAggregateStats(sk) : undefined;

  res.json({
    valid: true,
    feedback,
    guessesUsed: sess.guesses,
    maxGuesses: MAX_GUESSES,
    gameOver,
    status,
    answer: gameOver ? sess.answer : null,
    stats: gameOver ? stats : null,
  });
}

/**
 * GET /stats?lang=&localDate=
 */
export function getStats(req, res) {
  const { lang, localDate } = req.query;
  if (!isLang(lang) || !isIsoDate(localDate)) {
    return res.status(400).json({ error: "bad_query" });
  }
  const k = statsKey(lang, localDate);
  res.json(getAggregateStats(k));
}
