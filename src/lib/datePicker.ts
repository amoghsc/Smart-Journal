import { todayTitle } from './links'

/**
 * One date picker for the whole app (the calendar button, "/date" in a title or in the text). Callers ask for a
 * date with pickDateAt; the <DatePickerHost/> mounted once in the app shows the calendar and answers.
 */
export interface DateRequest { anchor: { x: number; y: number }; value: string }
type Listener = (req: DateRequest | null) => void

let listener: Listener | null = null
let pending: { req: DateRequest; resolve: (d: string | null) => void } | null = null

/** Show the calendar at `anchor` (viewport px, below-left corner); resolves the chosen YYYY-MM-DD, or null if dismissed. */
export function pickDateAt(anchor: { x: number; y: number }, value = todayTitle()): Promise<string | null> {
  pending?.resolve(null)
  return new Promise(resolve => {
    pending = { req: { anchor, value }, resolve }
    listener?.(pending.req)
  })
}

export function onDateRequest(fn: Listener): () => void {
  listener = fn
  if (pending) fn(pending.req)
  return () => { if (listener === fn) listener = null }
}

export function answerDate(date: string | null) {
  const p = pending
  pending = null
  listener?.(null)
  p?.resolve(date)
}
