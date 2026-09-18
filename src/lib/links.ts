/** Pure helpers for titles and daily notes. */

export const normTitle = (t: string) => t.trim().toLowerCase()

export const DAILY_RE = /^\d{4}-\d{2}-\d{2}$/
export const isDailyTitle = (t: string) => DAILY_RE.test(t.trim())

export function dateTitle(d: Date): string {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
export const todayTitle = () => dateTitle(new Date())

export function shiftDay(title: string, delta: number): string {
  const [y, m, d] = title.split('-').map(Number)
  return dateTitle(new Date(y, m - 1, d + delta))
}

export function prettyDate(title: string, short = false): string {
  const [y, m, d] = title.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return short
    ? date.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
    : date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

export const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim())

const PROMPTS = [
  'What is one thing you want to remember about today?',
  'What did you say you would do that you have not started yet?',
  'What idea has been circling in your head this week?',
  'What went better than expected recently, and why?',
  'What are you avoiding right now?',
  'Who did you talk to today, and what stuck with you?',
  'What would make tomorrow feel like a good day?',
  'What did you learn, or unlearn, today?',
  'What is one small decision you keep postponing?',
  'Describe a moment from today in detail.',
  'What are you grateful for that you usually take for granted?',
  'If you had an extra free hour today, what would you have done with it?',
  'What is something you changed your mind about recently?',
  'What is a question you do not have an answer to yet?',
  'What drained your energy today? What restored it?',
  'What would you tell a friend who was in your situation today?',
  'Which project or idea deserves more of your attention?',
  'What did you notice today that most people would have missed?',
  'What is one thing to let go of this week?',
  'What are you looking forward to?',
]

/** Deterministic prompt for a given daily title, so it is stable across reloads/devices. (Hidden in the UI for now.) */
export function promptFor(title: string): string {
  let h = 0
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PROMPTS[h % PROMPTS.length]
}
