import { supabase } from './supabase'

/** AI tools run in the nt-ai edge function, which holds the Gemini key. Only the selected text is sent. */

export type AiTask = 'summarise'

async function readError(error: unknown): Promise<Error> {
  const ctx = (error as { context?: Response }).context
  if (ctx && typeof ctx.json === 'function') {
    try { const b = await ctx.json(); if (b?.error) return new Error(b.error) } catch { /* not JSON */ }
  }
  return error instanceof Error ? error : new Error(String(error))
}

let configured: Promise<boolean> | null = null
/** Is a Gemini key set on the server? Asked once per session. */
export function aiAvailable(): Promise<boolean> {
  configured ??= supabase.functions.invoke('nt-ai', { body: { action: 'status' } })
    .then(({ data, error }) => !error && !!data?.configured)
    .catch(() => false)
  return configured
}

export async function runAi(task: AiTask, text: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('nt-ai', { body: { task, text } })
  if (error) throw await readError(error)
  return (data?.text as string) ?? ''
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Plain-text AI output → editor content. Blank lines separate paragraphs, "- " lines become a bullet list.
 * A single short paragraph comes back as plain text so it can replace words inside a sentence.
 */
export function aiTextToContent(raw: string): { inline: string } | { html: string } {
  const text = raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '').trim()
  const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
  if (blocks.length === 1 && !/^[-*•]\s/m.test(blocks[0])) return { inline: blocks[0].replace(/\s*\n\s*/g, ' ') }
  const html = blocks.map(b => {
    const lines = b.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.every(l => /^[-*•]\s/.test(l))) return `<ul>${lines.map(l => `<li><p>${esc(l.replace(/^[-*•]\s+/, ''))}</p></li>`).join('')}</ul>`
    return `<p>${esc(lines.join(' '))}</p>`
  }).join('')
  return { html }
}
