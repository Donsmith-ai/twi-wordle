/**
 * Pluggable dictionary surface (future: swap local JSON for DB, etc.).
 * Current validation uses server/services/wordStore.js directly.
 */
export function describeProvider() {
  return { id: "local-json", version: 1 };
}
