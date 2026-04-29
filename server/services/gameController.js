/** @typedef {{ lang: string, localDate: string, answer: string, wordLength: number, status: 'playing'|'won'|'lost', guesses: number, anon_fp: string }} GameSession */

import { randomBytes } from "node:crypto";
import { evaluateGuess } from "./wordEvaluate.js";
import { getDailyWord, pickPracticeRoundWord } from "./dailyWord.js";
import { isValidWord } from "./wordStore.js";
import {
  anonFingerprint,
  getAggregateStats,
  recordPlayer,
  recordWinner,
  statsKey,
} from "./statsStore.js";
import {
  MAX_GUESSES,
  DEFAULT_WORD_LENGTH,
  isAllowedWordLength,
  legacyDefaultWordLength,
  isPracticeRoundMode,
} from "../config.js";
import { foldEnglishOrTwiGuess, foldSpanishGuess } from "./latinFold.js";

/** @type {Map<string, GameSession>} */
const sessions = new Map();

/**
 * Practice mode only: maps opaque `roundKey` → answer so a refresh/resume keeps the same word
 * without tying it to the calendar (in-memory; cleared on server restart).
 * @type {Map<string, { answer: string, lang: string, localDate: string, wordLength: number }>}
 */
const devRoundByKey = new Map();

function trimDevRoundKeys() {
  while (devRoundByKey.size > 2500) {
    const first = devRoundByKey.keys().next().value;
    if (first === undefined) break;
    devRoundByKey.delete(first);
  }
}

const LANGS = ["en", "es", "tw"];

function isLang(x) {
  return LANGS.includes(x);
}

/**
 * @param {'en'|'es'|'tw'} lang
 * @param {unknown} raw
 */
function parseRequestedWordLength(lang, raw) {
  let n = NaN;
  if (typeof raw === "number" && Number.isFinite(raw)) n = Math.floor(raw);
  else if (typeof raw === "string" && /^\d+$/.test(raw.trim()))
    n = Number.parseInt(raw.trim(), 10);
  else if (raw === undefined || raw === null)
    n = legacyDefaultWordLength(lang);
  if (!Number.isFinite(n)) return null;
  return isAllowedWordLength(lang, n) ? n : null;
}

/**
 * @param {string} lang
 * @param {string} raw
 * @param {number} wordLength
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
export function normalizeGuess(lang, raw, wordLength) {
  if (typeof raw !== "string") return { ok: false, reason: "invalid_type" };
  const trimmed = raw.normalize("NFC").trim();
  const n = Math.floor(Number(wordLength));

  if (!Number.isFinite(n) || !isAllowedWordLength(/** @type {'en'|'es'|'tw'} */ (lang), n))
    return { ok: false, reason: "length" };

  if (trimmed.length !== n) return { ok: false, reason: "length" };

  if (lang === "es") {
    const lowered = trimmed.toLowerCase();
    const folded = foldSpanishGuess(lowered);
    if (folded.length !== n) return { ok: false, reason: "charset" };
    if (!new RegExp(`^[a-zñ]{${n}}$`).test(folded))
      return { ok: false, reason: "charset" };
    return { ok: true, value: folded };
  }
  if (lang === "tw") {
    const t = trimmed
      .toLowerCase()
      .normalize("NFC")
      .replace(/\u03b5/g, "\u025b");
    if (t.length !== n) return { ok: false, reason: "length" };
    if (!new RegExp(`^[a-zɛɔ]{${n}}$`, "u").test(t))
      return { ok: false, reason: "charset" };
    return { ok: true, value: t };
  }
  if (lang === "en") {
    const folded = foldEnglishOrTwiGuess(trimmed);
    if (folded.length !== n) return { ok: false, reason: "charset" };
    if (!new RegExp(`^[a-z]{${n}}$`).test(folded))
      return { ok: false, reason: "charset" };
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
 * in-memory Map was cleared (e.g. server restart). With `NODE_ENV=production`, the answer
 * is the daily word for (lang, localDate). In development (`NODE_ENV` not `production`),
 * each fresh start returns a random word plus `roundKey`; send that `roundKey` back with
 * resume so the same word is restored.
 */
export function startGame(req, res) {
  const {
    lang,
    localDate,
    timeZone,
    resumeGuesses,
    resumeStatus,
    roundKey: bodyRoundKeyRaw,
    wordLength: bodyWordLength,
  } = req.body || {};
  if (!isLang(lang)) {
    return res.status(400).json({ error: "invalid_lang" });
  }
  if (!isIsoDate(localDate)) {
    return res.status(400).json({ error: "invalid_local_date" });
  }

  const wl = parseRequestedWordLength(/** @type {'en'|'es'|'tw'} */ (lang), bodyWordLength);
  if (wl === null) {
    return res.status(400).json({ error: "invalid_word_length" });
  }

  const bodyRoundKey =
    typeof bodyRoundKeyRaw === "string" && bodyRoundKeyRaw.length >= 16
      ? bodyRoundKeyRaw
      : null;

  const isResume =
    (typeof resumeGuesses === "number" &&
      Number.isFinite(resumeGuesses) &&
      resumeGuesses > 0) ||
    resumeStatus === "won" ||
    resumeStatus === "lost";

  /** @type {string} */
  let answer = "";
  /** @type {string | null} */
  let outRoundKey = null;

  if (isPracticeRoundMode()) {
    if (bodyRoundKey) {
      const hit = devRoundByKey.get(bodyRoundKey);
      if (
        hit &&
        hit.lang === lang &&
        hit.localDate === localDate &&
        hit.wordLength === wl
      ) {
        answer = hit.answer;
        outRoundKey = bodyRoundKey;
      }
    }
    if (!answer && !isResume) {
      try {
        answer = pickPracticeRoundWord(/** @type {'en'|'es'|'tw'} */ (lang), wl);
      } catch {
        return res.status(503).json({
          error: "empty_word_pool",
          message:
            "No words available for this language and length. Try another length or language.",
        });
      }
      outRoundKey = randomBytes(18).toString("hex");
      devRoundByKey.set(outRoundKey, {
        answer,
        lang,
        localDate,
        wordLength: wl,
      });
      trimDevRoundKeys();
    }
  }

  if (!answer) {
    try {
      answer = getDailyWord(/** @type {'en'|'es'|'tw'} */ (lang), localDate, wl);
    } catch {
      return res.status(503).json({
        error: "empty_word_pool",
        message:
          "No words available for this language and length. Try another length or language.",
      });
    }
    outRoundKey = null;
  }

  const fp = fingerprint(req);
  const key = statsKey(lang, localDate, wl);
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

  const sessionId = randomBytes(24).toString("hex");
  sessions.set(sessionId, {
    lang,
    localDate,
    answer,
    wordLength: wl,
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
    wordLength: wl,
    timeZone: typeof timeZone === "string" ? timeZone : null,
    ...(outRoundKey ? { roundKey: outRoundKey } : {}),
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
    const sk = statsKey(sess.lang, sess.localDate, sess.wordLength);
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

  const norm = normalizeGuess(sess.lang, guess, sess.wordLength);
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

  const wl = sess.wordLength;
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

  const sk = statsKey(sess.lang, sess.localDate, sess.wordLength);

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
 * GET /stats?lang=&localDate=&wordLength=
 */
export function getStats(req, res) {
  const { lang, localDate, wordLength } = req.query;
  let wl = DEFAULT_WORD_LENGTH;
  if (
    wordLength !== undefined &&
    wordLength !== null &&
    String(wordLength).length > 0
  ) {
    const p = Number(wordLength);
    wl = Math.floor(p);
    if (!Number.isFinite(wl)) {
      return res.status(400).json({ error: "bad_query" });
    }
  }
  if (
    !isLang(lang) ||
    !isIsoDate(localDate) ||
    !isAllowedWordLength(/** @type {'en'|'es'|'tw'} */ (lang), wl)
  ) {
    return res.status(400).json({ error: "bad_query" });
  }
  const k = statsKey(lang, localDate, wl);
  res.json(getAggregateStats(k));
}
