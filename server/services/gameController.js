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
import { MAX_GUESSES, wordLengthForLang } from "../config.js";
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
  const n = wordLengthForLang(/** @type {'en'|'es'|'tw'} */ (lang));

  if (trimmed.length !== n) return { ok: false, reason: "length" };

  if (lang === "es") {
    const lowered = trimmed.toLowerCase();
    const folded = foldSpanishGuess(lowered);
    if (folded.length !== n) return { ok: false, reason: "charset" };
    if (!/^[a-zñ]{5}$/.test(folded)) return { ok: false, reason: "charset" };
    return { ok: true, value: folded };
  }
  if (lang === "tw") {
    const t = trimmed.toLowerCase().normalize("NFC");
    if (t.length !== n) return { ok: false, reason: "length" };
    if (!/^[a-zɛɔ]{6}$/u.test(t)) return { ok: false, reason: "charset" };
    return { ok: true, value: t };
  }
  if (lang === "en") {
    const folded = foldEnglishOrTwiGuess(trimmed);
    if (folded.length !== n) return { ok: false, reason: "charset" };
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
 *
 * Optional `resumeGuesses` + `resumeStatus` rebuild server state after a reload when the
 * in-memory Map was cleared (e.g. server restart). The daily answer is deterministic per
 * (lang, localDate), so counts stay aligned with rows persisted client-side.
 */
export function startGame(req, res) {
  const { lang, localDate, timeZone, resumeGuesses, resumeStatus } = req.body || {};
  if (!isLang(lang)) {
    return res.status(400).json({ error: "invalid_lang" });
  }
  if (!isIsoDate(localDate)) {
    return res.status(400).json({ error: "invalid_local_date" });
  }

  const fp = fingerprint(req);
  const key = statsKey(lang, localDate);
  recordPlayer(key, fp);

  const rgRaw =
    typeof resumeGuesses === "number" && Number.isFinite(resumeGuesses)
      ? resumeGuesses
      : 0;
  let rg = Math.floor(rgRaw);
  if (rg < 0 || rg > MAX_GUESSES) rg = 0;

  /** @type {'playing'|'won'|'lost'} */
  let st =
    resumeStatus === "won" || resumeStatus === "lost" ? resumeStatus : "playing";

  if (st === "won" && rg < 1) st = "playing";
  if (st === "lost" && rg !== MAX_GUESSES) st = "playing";
  if (st === "playing" && rg >= MAX_GUESSES) st = "lost";

  const answer = getDailyWord(/** @type {'en'|'es'|'tw'} */ (lang), localDate);
  const sessionId = randomBytes(24).toString("hex");
  sessions.set(sessionId, {
    lang,
    localDate,
    answer,
    status: st,
    guesses: rg,
    anon_fp: fp,
  });

  if (st === "won") {
    recordWinner(key, fp);
  }

  res.json({
    sessionId,
    maxGuesses: MAX_GUESSES,
    wordLength: wordLengthForLang(/** @type {'en'|'es'|'tw'} */ (lang)),
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
    /* 200 (not 404) so DevTools does not log “failed to load resource” for recoverable stale IDs */
    return res.json({
      valid: false,
      unknownSession: true,
      error: "unknown_session",
    });
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

  const wl = wordLengthForLang(/** @type {'en'|'es'|'tw'} */ (sess.lang));
  if (word.length !== wl || sess.answer.length !== wl) {
    return res.status(409).json({
      valid: false,
      invalidReason: "session_stale_length",
      message:
        "Start a new round — daily word cache was refreshed (language length mismatch).",
    });
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
