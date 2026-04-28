import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, "..", "data", "ip-play-store.json");

/** @type {{ played: Record<string, true> }} */
let store = { played: {} };

function load() {
  if (!existsSync(STORE_PATH)) {
    store = { played: {} };
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    if (raw && typeof raw.played === "object" && raw.played !== null) {
      store = { played: raw.played };
    } else {
      store = { played: {} };
    }
  } catch {
    store = { played: {} };
  }
}

function save() {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

load();

/**
 * One new game start per IP per calendar day per language (en / es / tw).
 */
export function ipPlaySlotKey(localDate, lang, ip) {
  return `${localDate}|${lang}|${ip}`;
}

/** @returns {boolean} true if slot was free and is now claimed. */
export function claimIpPlaySlot(localDate, lang, ip) {
  const k = ipPlaySlotKey(localDate, lang, ip);
  if (store.played[k]) return false;
  store.played[k] = true;
  save();
  return true;
}
