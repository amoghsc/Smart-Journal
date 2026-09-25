/** Small preferences kept in this browser. */

const AI_TWO = 'ai-two-versions'

/** Offer two AI versions to choose from (default), or apply a single response straight away. */
export function aiTwoVersions(): boolean {
  try { return localStorage.getItem(AI_TWO) !== '0' } catch { return true }
}
export function setAiTwoVersions(on: boolean) {
  try { localStorage.setItem(AI_TWO, on ? '1' : '0') } catch { /* private mode */ }
}

// AI score: how much of each piece of AI-written text is still the AI's, shown next to its ✦
const AI_SCORE = 'ai-score'
const AI_SCORE_GEMINI = 'ai-score-gemini'
/** Fired on window when a setting changes, so open notes can redraw. */
export const SETTINGS_EVENT = 'sj-settings'

const flag = (key: string) => { try { return localStorage.getItem(key) !== '0' } catch { return true } }
const setFlag = (key: string, on: boolean) => {
  try { localStorage.setItem(key, on ? '1' : '0') } catch { /* private mode */ }
  window.dispatchEvent(new Event(SETTINGS_EVENT))
}

/** Show the AI share (%) beside AI-written text (default on). */
export const aiScoreOn = () => flag(AI_SCORE)
export const setAiScoreOn = (on: boolean) => setFlag(AI_SCORE, on)
/** Let Gemini judge the meaning part of the score (default on); off scores words and sentences only. */
export const aiScoreGemini = () => flag(AI_SCORE_GEMINI)
export const setAiScoreGemini = (on: boolean) => setFlag(AI_SCORE_GEMINI, on)

// Write first: the AI tools open in a note only once you've typed this many words of your own in it (default off)
const AI_WRITE_FIRST = 'ai-write-first'
export const WRITE_FIRST_WORDS = 100
export const aiWriteFirst = () => { try { return localStorage.getItem(AI_WRITE_FIRST) === '1' } catch { return false } }
export const setAiWriteFirst = (on: boolean) => setFlag(AI_WRITE_FIRST, on)
