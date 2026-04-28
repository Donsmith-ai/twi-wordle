/** Strip combining marks (é→e); keeps ñ (NFC one codepoint). */
const COMBINING = /[\u0300-\u036f]/g;

/**
 * @param {string} ch one codepoint (iterates NFC string)
 */
function stripMarksFromLetter(ch) {
  const nfc = ch.normalize("NFC");
  if (nfc === "ñ") return "ñ";
  return nfc.normalize("NFD").replace(COMBINING, "");
}

/**
 * Spanish guess/answer: match dictionary keys without requiring typed accents.
 * @param {string} raw
 */
export function foldSpanishGuess(raw) {
  const t = raw.normalize("NFC").toLowerCase();
  let out = "";
  for (const ch of t) {
    out += stripMarksFromLetter(ch);
  }
  return out;
}

/**
 * English / Twi: strip diacritics from loanwords (naïve → naive).
 * @param {string} raw
 */
export function foldEnglishOrTwiGuess(raw) {
  return raw
    .normalize("NFC")
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING, "");
}
