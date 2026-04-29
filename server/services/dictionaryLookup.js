/**
 * Looks up short dictionary-style glosses for win-modal copy.
 * English: Free Dictionary API (dictionaryapi.dev).
 * Spanish / Twi fallbacks: English Wiktionary language-section extracts (best-effort plain text).
 */

const FETCH_MS = 12_000;
const LANGS = new Set(["en", "es", "tw"]);

/** @param {unknown} data */
function formatFreeDictionaryJson(data) {
  if (!Array.isArray(data) || !data.length) return null;
  const parts = [];
  outer: for (const entry of data) {
    for (const m of entry.meanings ?? []) {
      for (const d of m.definitions ?? []) {
        const def = typeof d.definition === "string" ? d.definition.trim() : "";
        if (def) parts.push(def);
        if (parts.length >= 4) break outer;
      }
    }
  }
  if (!parts.length) return null;
  let text = parts.slice(0, 3).join(" ");
  if (text.length > 520) text = `${text.slice(0, 517)}…`;
  return text;
}

/** @param {string} word NFC lowercase */
async function fetchEnglishDefinitions(word) {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return formatFreeDictionaryJson(data);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** @param {string} word */
async function fetchEnWiktionaryExtract(word) {
  const title = encodeURIComponent(word.replace(/ /g, "_"));
  const apiUrl = `https://en.wiktionary.org/w/api.php?action=query&titles=${title}&prop=extracts&explaintext=true&format=json&redirects=1`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const res = await fetch(apiUrl, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const pages = json.query?.pages;
    if (!pages || typeof pages !== "object") return null;
    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined) return null;
    const extract = page.extract;
    return typeof extract === "string" && extract.length > 0 ? extract : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string | null | undefined} fullExtract
 * @param {string} langSection e.g. "Spanish", "English", "Twi"
 */
function extractWikiLangSection(fullExtract, langSection) {
  if (!fullExtract) return null;
  const esc = langSection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\n== ${esc} ==([\\s\\S]*?)(?=\\n== [^=\\n]+ ==)`, "u");
  const m = fullExtract.match(re);
  return m ? cleanWikiBody(m[1]) : null;
}

/** @param {string} body */
function cleanWikiBody(body) {
  let s = body
    .replace(/\{\{[^}]+\}\}/g, "")
    .replace(/^={3,}.+$/gm, "")
    .replace(/IPA\(key\):[^\n]*/gi, "")
    .replace(/Rhymes:[^\n]*/gi, "")
    .replace(/Syllabification:[^\n]*/gi, "")
    .replace(/Homophone[^\n]*/gi, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!s.length) return null;

  /* Strip common Wiktionary preamble noise inside language sections */
  s = s.replace(/^[Ii]nherited from [^.]+\.\s*/u, "");
  s = s.replace(/^[Bb]orrowed from [^.]+\.\s*/u, "");
  s = s.replace(/^[Ff]rom Latin [^.]+\.\s*/u, "");
  /* Lemma line before gloss: “word f (plural …)” */
  s = s.replace(/\b[\p{L}]+\s+[fm]\s+\([^)]*\)\s*/gu, "");

  /* Descendants / derivational chains → … */
  const arrowIdx = s.indexOf("→");
  if (arrowIdx !== -1) s = s.slice(0, arrowIdx).trim();

  if (s.length > 540) s = `${s.slice(0, 537)}…`;
  return s.length >= 4 ? s : null;
}

/** @param {'en'|'es'|'tw'} lang @param {string} word NFC trimmed lowercase */
export async function lookupWordDefinition(lang, word) {
  if (!word || typeof word !== "string") return null;

  if (lang === "en") {
    const dict = await fetchEnglishDefinitions(word);
    if (dict) return dict;
    const ex = await fetchEnWiktionaryExtract(word);
    return extractWikiLangSection(ex, "English");
  }

  if (lang === "es") {
    const ex = await fetchEnWiktionaryExtract(word);
    return extractWikiLangSection(ex, "Spanish");
  }

  if (lang === "tw") {
    const dict = await fetchEnglishDefinitions(word);
    if (dict) return dict;
    const ex = await fetchEnWiktionaryExtract(word);
    return (
      extractWikiLangSection(ex, "Twi") ??
      extractWikiLangSection(ex, "Akan") ??
      extractWikiLangSection(ex, "English")
    );
  }

  return null;
}

function sanitizeWord(raw) {
  if (typeof raw !== "string") return "";
  const w = raw.normalize("NFC").trim().toLowerCase();
  if (!w.length || w.length > 48) return "";
  if (/[\x00-\x1f\x7f]/.test(w)) return "";
  return w;
}

/**
 * GET /api/word-definition?lang=en|es|tw&word=...
 */
export async function getWordDefinition(req, res) {
  const langRaw = req.query?.lang;
  const wordRaw = req.query?.word;
  const lang =
    typeof langRaw === "string" && LANGS.has(langRaw) ? langRaw : null;
  const word = sanitizeWord(wordRaw);

  if (!lang || !word) {
    return res.status(400).json({ error: "bad_query", definition: null });
  }

  try {
    const definition = await lookupWordDefinition(
      /** @type {'en'|'es'|'tw'} */ (lang),
      word,
    );
    res.json({ definition });
  } catch {
    res.status(502).json({ definition: null });
  }
}
