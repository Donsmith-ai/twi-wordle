/**
 * Builds scripts/lists/tw.txt from Hugging Face Twi corpus:
 * https://huggingface.co/datasets/michsethowusu/twi_words (CC0-1.0)
 *
 * Modes:
 *   node scripts/import-twi-hf.mjs              — parquet file (single download, default)
 *   node scripts/import-twi-hf.mjs --hf-api     — train split via HF rows API only
 *   node scripts/import-twi-hf.mjs --union      — parquet + API (dedupe; slow, max coverage)
 *
 * Tokens: unique 4–6-letter words using Twi consonants/vowels including ɛ ɔ (matching game + server).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { asyncBufferFromUrl, parquetReadObjects } from "hyparquet";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "lists", "tw.txt");
const HF_PARQUET_URL =
  "https://huggingface.co/datasets/michsethowusu/twi_words/resolve/main/twi_words_clean.parquet";
const HF_ROWS_ENDPOINT = "https://datasets-server.huggingface.co/rows";
const COMBINING_MARKS = /[\u0300-\u036f]/g;

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function hfFetchJson(url, label, maxAttempts = 8) {
  for (let a = 0; a < maxAttempts; a++) {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "poly-wordle-tw-import/repository-build",
      },
    });
    if (res.ok) return res.json();
    const snippet = (await res.text()).slice(0, 240);
    if ((res.status === 429 || res.status === 503) && a < maxAttempts - 1) {
      const waitMs = Math.min(45_000, 900 * 2 ** a + Math.floor(Math.random() * 250));
      console.warn(
        `${label} HF HTTP ${res.status} — backoff ${waitMs}ms (${a + 1}/${maxAttempts})`,
      );
      await sleep(waitMs);
      continue;
    }
    throw new Error(`${label} HF HTTP ${res.status}: ${snippet}`);
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
  // Greek lowercase epsilon → Latin open e (sometimes found in scraped data)
  s = s.replace(/\u03b5/gu, "ɛ");
  // IPA schwa → open e (rare mixed encodings)
  s = s.replace(/ə/gu, "ɛ");
  // Repeated NFD peel for stacked marks
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

async function iterableRawWordsFromParquet() {
  console.log("Fetching parquet:", HF_PARQUET_URL);
  const file = await asyncBufferFromUrl({ url: HF_PARQUET_URL });
  const rows = await parquetReadObjects({ file, columns: ["word"] });
  return rows.map((r) => String(r.word ?? ""));
}

async function iterableRawWordsFromHfApi() {
  // HF datasets-server enforces length ≤ 100 (see HTTP 422).
  const pageLen = Math.min(
    100,
    Math.max(1, Number(process.env.TWI_HF_PAGE_LENGTH) || 100),
  );
  const pageDelayMs = Math.max(
    0,
    Number(process.env.TWI_HF_PAGE_DELAY_MS) || 275,
  );
  /** @type {string[]} */
  const out = [];
  let offset = 0;
  let total = Infinity;
  for (;;) {
    if (offset > 0 && pageDelayMs) await sleep(pageDelayMs);
    const url = `${HF_ROWS_ENDPOINT}?${new URLSearchParams({
      dataset: "michsethowusu/twi_words",
      config: "default",
      split: "train",
      offset: String(offset),
      length: String(pageLen),
    })}`;
    console.log(`HF rows API  offset=${offset}  page=${pageLen}`);
    const json = await hfFetchJson(url, "HF rows API");
    if (typeof json.num_rows_total === "number") total = json.num_rows_total;
    const chunk = Array.isArray(json.rows) ? json.rows : [];
    if (!chunk.length) break;
    for (const row of chunk) {
      const w = row?.row?.word;
      if (typeof w === "string") out.push(w);
    }
    offset += chunk.length;
    if (offset >= total) break;
  }
  console.log(`API read ${out.length} word cells (reported total ${total}).`);
  return out;
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
  const useUnion = process.argv.includes("--union");
  const apiOnly =
    process.argv.includes("--hf-api") ||
    process.argv.includes("--api") ||
    process.env.TWI_IMPORT_FROM_API === "1";

  let raw;
  let mode;
  if (useUnion) {
    const a = await iterableRawWordsFromParquet();
    const b = await iterableRawWordsFromHfApi();
    raw = [...a, ...b];
    mode = "parquet+hf-api (union)";
  } else if (apiOnly) {
    raw = await iterableRawWordsFromHfApi();
    mode = "hf-api";
  } else {
    raw = await iterableRawWordsFromParquet();
    mode = "parquet";
  }

  /** @type {Set<string>} */
  const uniq = new Set();
  const scanned = addWordsFromRaw(uniq, raw);

  const list = [...uniq].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${list.join("\n")}\n`, "utf8");
  console.log(
    `Wrote ${list.length} unique Twi lemmas (4–6 letters) to ${OUT} (${scanned} corpus rows scanned, mode=${mode}).`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
