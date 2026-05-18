/**
 * Builds server/data/{en,es,tw}.json from scripts/lists/*.txt
 *
 * Twi: run `npm run fetch:tw-words` first to download Masakhane POS tokens into lists/tw.txt
 * (https://github.com/masakhane-io/masakhane-pos/tree/main/data/twi), then run this script.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "server", "data");

function loadLines(rel) {
  const text = readFileSync(join(__dirname, rel), "utf8");
  const out = [];
  const seen = new Set();
  for (const line of text.split(/\n/)) {
    const w = line
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    if (!w || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function filterEn(words) {
  return words.filter((w) => w.length === 5 && /^[a-z]{5}$/.test(w));
}

function filterEs(words) {
  return words.filter(
    (w) =>
      w.length === 5 &&
      /^[a-zñ]{5}$/.test(w) &&
      ![...w].some((ch) => "áéíóúü".includes(ch)),
  );
}

/** Twi list: 4–6-letter [a-zɛɔ] NFC (Masakhane POS romanization + ɛɔ; see import-twi-masakhane.mjs). */
function filterTw(words) {
  return words.filter((w) => {
    const nfc = w.normalize("NFC");
    const len = nfc.length;
    if (len < 4 || len > 6) return false;
    return new RegExp(`^[a-zɛɔ]{${len}}$`, "u").test(nfc);
  });
}

function tag(words) {
  const levels = ["easy", "medium", "hard"];
  return words.map((w, i) => ({ w, d: levels[i % 3] }));
}

function write(lang, languageName, words) {
  if (words.length < 40) {
    console.warn(`Warning: ${lang} has only ${words.length} words`);
  }
  const payload = {
    language: languageName,
    version: 1,
    words: tag(words),
  };
  const compactJson = lang === "tw" && words.length > 2000 ? undefined : 2;
  writeFileSync(
    join(DATA, `${lang}.json`),
    JSON.stringify(payload, null, compactJson),
  );
  console.log(`${lang}.json: ${words.length} words`);
}

mkdirSync(DATA, { recursive: true });

const en = filterEn(loadLines("lists/en.txt"));
const es = filterEs(loadLines("lists/es.txt"));
const tw = filterTw(loadLines("lists/tw.txt"));

write("en", "English", en);
write("es", "Spanish", es);
write("tw", "Twi", tw);
