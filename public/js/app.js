/** Mobile-first Daily Word UI — communicates only via API for answers. Future: hard mode flag here. */

const STORAGE_PREFIX = "dw-v2";
const MAX_ROWS = 8;
const WORD_LEN = 5;
/** Time until the last tile’s flip animation has finished (stagger + duration). */
const WIN_FLIP_COMPLETE_MS = (WORD_LEN - 1) * 75 + 560;
/** Beat after flips before the end modal (lets confetti stay on screen briefly). */
const WIN_MODAL_AFTER_MS = 650;

/** Future: hard mode — server must enforce when enabled. */
const GAME_CONFIG = { hardMode: false, wordLength: WORD_LEN, maxGuesses: MAX_ROWS };
void GAME_CONFIG;

/** @type {'en'|'es'|'tw'} */
let lang = "en";
let draft = "";
let sessionId = null;
let rowIdx = 0;
/** @type {{ word: string; feedback: string[] }[]} */
let completedRows = [];
/** @type {{ status: string; answer: string; stats: Record<string, unknown> | null } | null } */
let lastOutcome = null;
let tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

const boardEl = document.getElementById("board");
const keyboardEl = document.getElementById("keyboard");
const langSel = document.getElementById("lang-select");
const toastEl = document.getElementById("toast");
const invalidEl = document.getElementById("invalid-overlay");
const modalEl = document.getElementById("end-modal");
const endTitle = document.getElementById("end-title");
const endAnswer = document.getElementById("end-answer");
const endStats = document.getElementById("end-stats");
const btnShare = document.getElementById("btn-share");
const winSharePanel = document.getElementById("win-share-panel");
const btnDismiss = document.getElementById("btn-dismiss");
const shareCanvas = document.getElementById("share-canvas");
const connectionBanner =
  document.getElementById("connection-banner") ?? undefined;
const playedTodayMsg =
  document.getElementById("played-today-msg") ?? undefined;
const btnReset = document.getElementById("btn-reset") ?? undefined;

/** Failed to get a playable session from the API (distinct from finished puzzle). */
let bootstrapFailed = false;

function deviceId() {
  const k = "dw-device-id";
  let id = localStorage.getItem(k);
  if (!id) {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      id = crypto.randomUUID();
    } else {
      id = `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    }
    localStorage.setItem(k, id);
  }
  return id;
}

function isoLocalDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function storageKey(l) {
  return `${STORAGE_PREFIX}-${l}-${isoLocalDate()}`;
}

function persist() {
  if (!sessionId) return;
  const payload = {
    lang,
    sessionId,
    rows: completedRows,
    tz,
    localDate: isoLocalDate(),
    outcome: lastOutcome,
  };
  localStorage.setItem(storageKey(lang), JSON.stringify(payload));
}

function loadSaved(l) {
  try {
    const raw = localStorage.getItem(storageKey(l));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}



async function api(pathname, opts = {}) {
  const url =
    typeof window !== "undefined"
      ? new URL(pathname, `${window.location.origin}/`).href
      : pathname;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "X-Device-Id": deviceId(),
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res;
}

/**
 * @param {unknown} rows
 * @returns {{ word: string; feedback: string[] }[]}
 */
function sanitizeImportedRows(rows) {
  if (!Array.isArray(rows)) return [];
  /** @type {{ word: string; feedback: string[] }[]} */
  const out = [];
  for (const r of rows) {
    if (
      !r ||
      typeof r !== "object" ||
      typeof /** @type {{word?:unknown}} */ (r).word !== "string" ||
      /** @type {{word:string}} */ (r).word.length !== WORD_LEN
    ) {
      continue;
    }
    const fb = /** @type {{feedback?:unknown}} */ (r).feedback;
    if (!Array.isArray(fb) || fb.length !== WORD_LEN) continue;
    if (!fb.every((x) => typeof x === "string")) continue;
    out.push({
      word: /** @type {{word:string}} */ (r).word.toLowerCase(),
      feedback: [...fb],
    });
  }
  return out;
}

function gameFinishedFromRows() {
  try {
    if (!completedRows?.length) return false;
    for (const row of completedRows) {
      if (
        !row?.feedback?.length ||
        row.feedback.length !== WORD_LEN
      ) {
        continue;
      }
      if (row.feedback.every((x) => x === "correct")) return true;
    }
    return completedRows.length >= MAX_ROWS;
  } catch {
    completedRows = [];
    return false;
  }
}

function refreshPlayabilityUx() {
  if (!connectionBanner) return;
  const isFilePage =
    typeof location !== "undefined" && location.protocol === "file:";

  if (isFilePage) {
    connectionBanner.hidden = false;
    connectionBanner.textContent =
      "Use http://localhost:3000 — opening the HTML file directly (file://) cannot reach the API, so letters will not register.";
    bootstrapFailed = true;
  } else if (bootstrapFailed && !sessionId) {
    connectionBanner.hidden = false;
    connectionBanner.textContent =
      "No active game session. Ensure npm start is running and reload.";
  } else {
    connectionBanner.hidden = true;
    connectionBanner.textContent = "";
  }

  const doneToday =
    Boolean(sessionId) && gameFinishedFromRows() && lastOutcome !== null;

  if (playedTodayMsg) playedTodayMsg.hidden = !doneToday;
  if (btnReset) btnReset.hidden = !doneToday;
}

function validCharsetForGuess(str, l) {
  const lower = str.toLowerCase();
  if (l === "es") return /^[a-zñ]{5}$/.test(lower);
  return /^[a-z]{5}$/.test(lower);
}

/** Match server guess folding (accented keys → plain letters). */
function normalizeTyped(ch, l) {
  if (!ch) return null;
  let out = "";
  for (const cp of ch.normalize("NFC").toLowerCase()) {
    const nfc = cp.normalize("NFC");
    if (l === "es" && nfc === "ñ") out += "ñ";
    else out += cp.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  if (out.length !== 1) return null;
  if (l === "es") return /^[a-zñ]$/.test(out) ? out : null;
  return /^[a-z]$/.test(out) ? out : null;
}

function keyboards() {
  return {
    en: [
      ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
      ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
      ["ENTER", "z", "x", "c", "v", "b", "n", "m", "⌫"],
    ],
    es: [
      ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
      ["a", "s", "d", "f", "g", "h", "j", "k", "l", "ñ"],
      ["ENTER", "z", "x", "c", "v", "b", "n", "m", "⌫"],
    ],
    tw: [
      ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
      ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
      ["ENTER", "z", "x", "c", "v", "b", "n", "m", "⌫"],
    ],
  };
}

function buildBoard() {
  boardEl.innerHTML = "";
  for (let r = 0; r < MAX_ROWS; r++) {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.row = String(r);
    for (let c = 0; c < WORD_LEN; c++) {
      const t = document.createElement("div");
      t.className = "tile";
      t.dataset.col = String(c);
      row.appendChild(t);
    }
    boardEl.appendChild(row);
  }
}

function flashRowLetters() {
  for (let c = 0; c < WORD_LEN; c++) {
    const ch = draft[c] ?? "";
    setCell(
      rowIdx,
      c,
      ch.length ? ch.toUpperCase() : "",
    );
  }
}

function setCell(row, col, letter) {
  const rowEl = boardEl.querySelector(`.row[data-row="${row}"]`);
  if (!rowEl) return;
  const cell = rowEl.querySelector(`.tile[data-col="${col}"]`);
  if (!cell) return;
  cell.textContent = letter;
  cell.classList.toggle("filled", letter.length > 0);
}

function stripTile(tile) {
  tile.classList.remove(
    "correct",
    "present",
    "absent",
    "filled",
    "reveal",
    "win-solve",
  );
  tile.removeAttribute("style");
}

function applyRowFeedback(row, word, cssStates) {
  const rowEl = boardEl.querySelector(`.row[data-row="${row}"]`);
  if (!rowEl) return;
  const tiles = [...rowEl.querySelectorAll(".tile")];
  for (let i = 0; i < WORD_LEN; i++) {
    const st = cssStates[i];
    stripTile(tiles[i]);
    tiles[i].textContent = word[i]?.toUpperCase() ?? "";
    void tiles[i].offsetWidth;
    tiles[i].style.animationDelay = `${i * 75}ms`;
    tiles[i].classList.add("reveal");
    tiles[i].classList.add(st);
    tiles[i].classList.remove("filled");
  }
}

/** Best tile state per letter across submitted rows (Wordle-style priority). */
function keyboardLetterHints() {
  const rank = { correct: 3, present: 2, absent: 1 };
  /** @type {Map<string, 'correct' | 'present' | 'absent'>} */
  const best = new Map();
  for (const row of completedRows) {
    if (
      !row?.word ||
      !Array.isArray(row.feedback) ||
      row.feedback.length !== WORD_LEN
    ) {
      continue;
    }
    for (let i = 0; i < WORD_LEN; i++) {
      const letter = row.word[i];
      const fb = row.feedback[i];
      if (fb !== "correct" && fb !== "present" && fb !== "absent") continue;
      const prev = best.get(letter);
      if (!prev || rank[fb] > rank[prev]) best.set(letter, fb);
    }
  }
  return best;
}

function renderKeyboard() {
  const hints = keyboardLetterHints();
  const layout = keyboards()[lang];
  keyboardEl.innerHTML = "";
  for (const line of layout) {
    const kr = document.createElement("div");
    kr.className = "kb-row";
    for (const key of line) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kb-key" + (key.length > 1 ? " wide" : "");
      b.textContent = key === "⌫" ? "⌫" : key.toUpperCase();
      b.dataset.key = key;
      if (key.length === 1) {
        const letter = lang === "es" && key === "ñ" ? "ñ" : key.toLowerCase();
        const st = hints.get(letter);
        if (st) b.classList.add(`kb-hit-${st}`);
      }
      b.addEventListener("click", () => handleKeyTap(key));
      kr.appendChild(b);
    }
    keyboardEl.appendChild(kr);
  }
  refreshEnterDisabled();
}

function refreshEnterDisabled() {
  document.querySelectorAll(".kb-key").forEach((btn) => {
    if (btn.dataset.key !== "ENTER") return;
    const ok =
      draft.length === WORD_LEN && validCharsetForGuess(draft, lang) && canType();
    btn.disabled = !ok;
  });
}

async function handleKeyTap(sym) {
  if (!canType()) return;
  if (sym === "⌫") {
    draft = draft.slice(0, -1);
    flashRowLetters();
    refreshEnterDisabled();
    return;
  }
  if (sym === "ENTER") {
    await submitGuess();
    return;
  }
  const ch =
    lang === "es" && sym.toLowerCase() === "ñ"
      ? "ñ"
      : sym.toLowerCase();
  const n = normalizeTyped(ch, lang);
  if (!n || draft.length >= WORD_LEN) return;
  draft += n;
  flashRowLetters();
  refreshEnterDisabled();
}

function onPhysicalKey(ev) {
  if (!canType()) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.key === "Backspace") {
    handleKeyTap("⌫");
    ev.preventDefault();
    return;
  }
  if (ev.key === "Enter") {
    handleKeyTap("ENTER");
    ev.preventDefault();
    return;
  }
  const n = normalizeTyped(ev.key, lang);
  if (n && draft.length < WORD_LEN) handleKeyTap(n);
}

async function startGame() {
  try {
    if (
      typeof location !== "undefined" &&
      location.protocol === "file:"
    ) {
      sessionId = null;
      bootstrapFailed = true;
      buildBoard();
      renderKeyboard();
      return;
    }

    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    const ld = isoLocalDate();
    const saved = loadSaved(lang);
    if (
      saved &&
      saved.sessionId &&
      saved.localDate === ld &&
      Array.isArray(saved.rows)
    ) {
      sessionId = saved.sessionId;
      lastOutcome =
        saved.outcome && typeof saved.outcome === "object"
          ? {
              status: String(saved.outcome.status),
              answer: saved.outcome.answer
                ? String(saved.outcome.answer)
                : "",
              stats: saved.outcome.stats ?? null,
            }
          : null;
      completedRows = sanitizeImportedRows(saved.rows);

      if (gameFinishedFromRows() && !lastOutcome) {
        localStorage.removeItem(storageKey(lang));
        sessionId = null;
        completedRows = [];
        lastOutcome = null;
      } else {
        rowIdx = completedRows.length;
        draft = "";
        buildBoard();
        let r = 0;
        for (const row of completedRows) {
          applyRowFeedback(r, row.word, row.feedback.map(mapApiStateToClass));
          r++;
        }
        {
          const winR = winningRowIndex(completedRows);
          if (winR >= 0) addWinSolveToRow(winR);
        }
        renderKeyboard();
        if (gameFinishedFromRows() && lastOutcome) {
          showEndModal(
            lastOutcome.status === "won",
            lastOutcome.answer,
            lastOutcome.stats,
          );
        }
        focusGameSurface();
        bootstrapFailed = false;
        return;
      }
    }

    lastOutcome = null;

    const res = await api("/api/game/start", {
      method: "POST",
      body: {
        lang,
        localDate: ld,
        timeZone: tz,
      },
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* empty */
    }
    if (!res.ok) {
      if (res.status === 403 && data.error === "ip_already_played") {
        toastMsg(
          data.message ??
            "This network already played today’s puzzle. Only one game per day is allowed.",
        );
      } else {
        toastMsg("Could not start game — is the server running?");
      }
      sessionId = null;
      bootstrapFailed = true;
      buildBoard();
      renderKeyboard();
      return;
    }
    sessionId = data.sessionId;
    completedRows = [];
    draft = "";
    rowIdx = 0;
    buildBoard();
    renderKeyboard();
    persist();
    focusGameSurface();
    bootstrapFailed = false;
  } catch (e) {
    console.error(e);
    toastMsg("Could not connect. Check network or run npm start.");
    sessionId = null;
    bootstrapFailed = true;
    buildBoard();
    renderKeyboard();
  } finally {
    refreshPlayabilityUx();
  }
}

function mapApiStateToClass(s) {
  if (s === "correct") return "correct";
  if (s === "present") return "present";
  return "absent";
}

/** Index of the row that solved the puzzle, or `-1`. */
function winningRowIndex(rows) {
  if (!Array.isArray(rows)) return -1;
  return rows.findIndex(
    (row) =>
      row?.feedback?.length === WORD_LEN &&
      row.feedback.every((x) => x === "correct"),
  );
}

function addWinSolveToRow(row) {
  const rowEl = boardEl.querySelector(`.row[data-row="${row}"]`);
  if (!rowEl) return;
  rowEl.querySelectorAll(".tile").forEach((t) => {
    t.classList.add("win-solve");
  });
}

function burstConfetti() {
  const w = typeof globalThis !== "undefined" ? globalThis : {};
  const c =
    "confetti" in w && typeof /** @type {{ confetti?: unknown }} */ (w).confetti === "function"
      ? /** @type {(opts?: object) => void} */ (
          /** @type {{ confetti: (opts?: object) => void }} */ (w).confetti
        )
      : null;
  if (!c) return;
  const colors = ["#60a5fa", "#38bdf8", "#2563eb", "#fbbf24", "#f472b6"];
  c({
    particleCount: 110,
    spread: 72,
    origin: { y: 0.68 },
    ticks: 280,
    colors,
    zIndex: 5000,
  });
  c({
    particleCount: 65,
    angle: 60,
    spread: 52,
    origin: { x: 0, y: 0.65 },
    colors,
    zIndex: 5000,
  });
  c({
    particleCount: 65,
    angle: 120,
    spread: 52,
    origin: { x: 1, y: 0.65 },
    colors,
    zIndex: 5000,
  });
}

function celebrateWin(rowIdx) {
  addWinSolveToRow(rowIdx);
  burstConfetti();
}

/** @param {Record<string, unknown> | null | undefined} stats */
function formatStatsHtml(stats) {
  const p = Number(stats?.uniquePlayers);
  const w = Number(stats?.uniqueWinners);
  if (!stats || !Number.isFinite(p) || p <= 0) {
    return "Stats unavailable.";
  }
  const winPct = Math.round((w / p) * 100);
  const otherPct = Math.max(0, 100 - winPct);
  return [
    `Players today: ${p}`,
    `Winners: ${winPct}%`,
    `Did not win: ${otherPct}%`,
  ].join("<br/>");
}

/** True when a session exists and the daily puzzle for this language/day is still playable. */
function canType() {
  return Boolean(sessionId) && !gameFinishedFromRows();
}

function focusGameSurface() {
  const el = document.getElementById("game-root");
  if (el && typeof el.focus === "function") {
    el.focus({ preventScroll: true });
  }
}

async function submitGuess() {
  if (!canType()) return;
  if (
    draft.length !== WORD_LEN ||
    !validCharsetForGuess(draft, lang)
  )
    return;
  const guess = draft.toLowerCase();
  toastMsg("");
  const res = await api("/api/game/guess", {
    method: "POST",
    body: { sessionId, guess },
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    toastMsg("Network error.");
    return;
  }

  if (res.status === 404) {
    localStorage.removeItem(storageKey(lang));
    sessionId = null;
    toastMsg("Session expired — reloading.");
    await startGame();
    return;
  }

  if (!res.ok) {
    toastMsg("Server error.");
    return;
  }

  if (data.valid === false) {
    if (data.invalidReason === "not_in_dictionary") showInvalid();
    else toastMsg("Guess not accepted.");
    return;
  }

  if (!Array.isArray(data.feedback)) {
    toastMsg("Try again.");
    return;
  }

  completedRows.push({ word: guess, feedback: data.feedback });
  const won = data.status === "won";
  const cssStates = won
    ? Array(WORD_LEN).fill("correct")
    : data.feedback.map(mapApiStateToClass);
  applyRowFeedback(rowIdx, guess, cssStates);
  rowIdx++;
  draft = "";

  if (data.gameOver) {
    lastOutcome = {
      status: String(data.status ?? ""),
      answer: data.answer ? String(data.answer) : "",
      stats: data.stats ?? null,
    };
    persist();
    renderKeyboard();
    if (won) {
      const winRowIdx = rowIdx - 1;
      window.setTimeout(() => {
        celebrateWin(winRowIdx);
      }, WIN_FLIP_COMPLETE_MS);
      window.setTimeout(() => {
        showEndModal(true, data.answer ?? "", data.stats ?? null);
        refreshPlayabilityUx();
      }, WIN_FLIP_COMPLETE_MS + WIN_MODAL_AFTER_MS);
      return;
    }
    showEndModal(false, data.answer ?? "", data.stats ?? null);
    refreshPlayabilityUx();
    return;
  }
  persist();
  renderKeyboard();
}

function showInvalid() {
  if (showInvalid._timer) window.clearTimeout(showInvalid._timer);
  invalidEl.hidden = false;
  invalidEl.setAttribute("aria-hidden", "false");
  showInvalid._timer = window.setTimeout(() => {
    invalidEl.hidden = true;
    invalidEl.setAttribute("aria-hidden", "true");
    showInvalid._timer = undefined;
  }, 3000);
}

/**
 * Win: stats + share panel. Loss: only title, answer, Close (no share UI).
 */
function showEndModal(won, answer, stats) {
  if (won) {
    endTitle.textContent = "You got it!";
    endAnswer.textContent = answer ? `Word: ${answer.toUpperCase()}` : "";
    let lines = "";
    if (stats) {
      lines = formatStatsHtml(stats);
    }
    endStats.innerHTML = lines || "Stats unavailable.";
    if (btnShare) {
      btnShare.onclick = () => exportShare(true, answer ?? "");
    }
    winSharePanel?.removeAttribute("hidden");
  } else {
    endTitle.textContent = "Nice try!";
    endAnswer.textContent = answer
      ? `The word was: ${answer.toUpperCase()}`
      : "";
    endStats.innerHTML = "";
    if (btnShare) btnShare.onclick = null;
    winSharePanel?.setAttribute("hidden", "");
  }
  modalEl.hidden = false;
  modalEl.removeAttribute("aria-hidden");
}

function closeEndModal() {
  modalEl.hidden = true;
  modalEl.setAttribute("aria-hidden", "true");
  refreshPlayabilityUx();
}

function toastMsg(msg) {
  toastEl.hidden = !msg;
  toastEl.textContent = msg ?? "";
}

function exportShare(won, answer) {
  const ctx = shareCanvas.getContext("2d");
  const w = shareCanvas.width;
  const h = shareCanvas.height;
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#f1f5f9";
  ctx.font = "bold 22px sans-serif";
  ctx.fillText(`Daily Word (${lang})`, 20, 36);
  ctx.font = "14px sans-serif";
  ctx.fillStyle = "#94a3b8";
  ctx.fillText(isoLocalDate(), 20, 58);

  const cell = 42;
  const gap = 6;
  const ox = 20;
  const oy = 80;
  for (let r = 0; r < MAX_ROWS; r++) {
    for (let c = 0; c < WORD_LEN; c++) {
      ctx.fillStyle = "#334155";
      const gx = ox + c * (cell + gap);
      const gy = oy + r * (cell + gap);
      ctx.strokeStyle = "#334155";
      ctx.strokeRect(gx, gy, cell, cell);
      const row = completedRows[r];
      if (!row?.feedback[c]) continue;
      const fb = row.feedback[c];
      if (fb === "correct") ctx.fillStyle = "#2563eb";
      else if (fb === "present") ctx.fillStyle = "#9333ea";
      else ctx.fillStyle = "#57534e";
      ctx.fillRect(gx, gy, cell, cell);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 20px sans-serif";
      ctx.fillText(
        (row.word[c] ?? "").toUpperCase(),
        gx + 12,
        gy + 29,
      );
    }
  }

  ctx.fillStyle = "#e2e8f0";
  ctx.font = "16px sans-serif";
  const line = won
    ? `Solved in ${completedRows.length} tries`
    : `Lost — ${answer}`;
  ctx.fillText(line, 20, h - 28);

  shareCanvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.download = `daily-word-${lang}-${isoLocalDate()}.png`;
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
  });
}

btnDismiss.addEventListener("click", () => {
  closeEndModal();
});

langSel.addEventListener("change", async () => {
  lang = /** @type {'en'|'es'|'tw'} */ (langSel.value);
  await startGame();
});

boardEl?.addEventListener("click", () => {
  if (!modalEl.hidden) return;
  focusGameSurface();
});

keyboardEl?.addEventListener("click", (e) => {
  e.stopPropagation();
});

btnReset?.addEventListener("click", async () => {
  localStorage.removeItem(storageKey(lang));
  sessionId = null;
  completedRows = [];
  lastOutcome = null;
  draft = "";
  rowIdx = 0;
  closeEndModal();
  toastMsg("");
  bootstrapFailed = false;
  await startGame();
});

window.addEventListener("keydown", onPhysicalKey, true);

buildBoard();
langSel.value = lang;
startGame().then(() => {
  keyboardEl.hidden = false;
  focusGameSurface();
});
