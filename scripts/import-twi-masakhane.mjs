/**
 * Builds scripts/lists/tw.txt from Masakhane Twi POS corpus:
 * https://github.com/masakhane-io/masakhane-pos/tree/main/data/twi
 *
 * Downloads train/dev/test splits, extracts unique tokens, normalizes to playable lemmas.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "lists", "tw.txt");
const BASE =
  "https://raw.githubusercontent.com/masakhane-io/masakhane-pos/main/data/twi";
const SPLITS = ["train.txt", "dev.txt", "test.txt"];
const COMBINING_MARKS = /[\u0300-\u036f]/g;

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function fetchText(url, label, maxAttempts = 6) {
  for (let a = 0; a < maxAttempts; a++) {
    const res = await fetch(url, {
      headers: { "User-Agent": "poly-wordle-tw-import/masakhane-pos" },
    });
    if (res.ok) return res.text();
    const snippet = (await res.text()).slice(0, 240);
    if ((res.status === 429 || res.status === 503) && a < maxAttempts - 1) {
      const waitMs = Math.min(30_000, 800 * 2 ** a + Math.floor(Math.random() * 200));
      console.warn(
        `${label} HTTP ${res.status} — backoff ${waitMs}ms (${a + 1}/${maxAttempts})`,
      );
      await sleep(waitMs);
      continue;
    }
    throw new Error(`${label} HTTP ${res.status}: ${snippet}`);
  }
  throw new Error(`${label}: max retries exceeded`);
}

/**
 * Map corpus glyphs to playable Twi alphabet; strip tones/diacritics; keep ɛ ɔ.
 */
function normalizeTwLemma(raw) {
  let s = String(raw ?? "")
    .normalize("NFC")
    .trim()
    .toLowerCase();
  s = s.replace(/\u03b5/gu, "ɛ");
  s = s.replace(/ə/gu, "ɛ");
  for (let i = 0; i < 3; i++) {
    const next = s
      .normalize("NFD")
      .replace(COMBINING_MARKS, "")
      .normalize("NFC");
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

/** Playable lemma lengths 4–6 per server word rules. */
function isPlayableTwiLemma(s) {
  if (typeof s !== "string") return false;
  const len = s.length;
  if (len < 4 || len > 6) return false;
  return new RegExp(`^[a-zɛɔ]{${len}}$`, "u").test(s);
}

/** @param {string} text CoNLL-U-style: `token TAG` per line, blank between sentences. */
function* tokensFromConll(text) {
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const token = trimmed.split(/\s+/)[0];
    if (token) yield token;
  }
}

function addWordsFromRaw(uniq, rawStrings) {
  let scanned = 0;
  for (const raw of rawStrings) {
    scanned++;
    const w = normalizeTwLemma(raw);
    if (!w) continue;
    if (/[\s\-_'’]/.test(w)) continue;
    if (/\d/.test(w)) continue;
    if (!isPlayableTwiLemma(w)) continue;
    uniq.add(w);
  }
  return scanned;
}

async function main() {
  /** @type {string[]} */
  const raw = [];
  for (const file of SPLITS) {
    const url = `${BASE}/${file}`;
    console.log("Fetching:", url);
    const text = await fetchText(url, file);
    let count = 0;
    for (const token of tokensFromConll(text)) {
      raw.push(token);
      count++;
    }
    console.log(`  ${file}: ${count} tokens`);
  }

  /** @type {Set<string>} */
  const uniq = new Set();
  const scanned = addWordsFromRaw(uniq, raw);

  const list = [...uniq].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${list.join("\n")}\n`, "utf8");
  console.log(
    `Wrote ${list.length} unique Twi lemmas (4–6 letters) to ${OUT} (${scanned} corpus tokens scanned, masakhane-pos).`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
