/** Small preferences kept in this browser. */

const AI_TWO = 'ai-two-versions'

/** Offer two AI versions to choose from (default), or apply a single response straight away. */
export function aiTwoVersions(): boolean {
  try { return localStorage.getItem(AI_TWO) !== '0' } catch { return true }
}
export function setAiTwoVersions(on: boolean) {
  try { localStorage.setItem(AI_TWO, on ? '1' : '0') } catch { /* private mode */ }
}
