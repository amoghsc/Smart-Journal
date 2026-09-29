import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, Clock, Globe, Pencil, Plus, Send, Trash2, WandSparkles, X } from 'lucide-react'
import { toast } from '../lib/toast'
import { useStore } from '../lib/store'
import { detectLanguage, parseChoices, runAi, toolDef, toolTokens } from '../lib/ai'
import { aiTwoVersions } from '../lib/settings'
import type { AiTool } from '../lib/types'

type Draft = Omit<AiTool, 'id' | 'sort_order' | 'owner' | 'status' | 'author_name'> & { id?: string }

const SCOPES: { id: AiTool['scope']; label: string; hint: string }[] = [
  { id: 'word', label: 'A word', hint: 'Offered when one word is selected' },
  { id: 'sentence', label: 'A sentence', hint: 'Offered for a selection within one line or paragraph' },
  { id: 'any', label: 'Any text', hint: 'Offered for any selection' },
]
const OUTPUTS: { id: AiTool['output']; label: string; hint: string }[] = [
  { id: 'replace', label: 'Replace it', hint: 'The result takes the place of the selected text' },
  { id: 'after', label: 'Add below', hint: 'The result is added below, labelled with the tool’s name' },
  { id: 'choose', label: 'Show choices', hint: 'Up to 8 options to pick from; the one you pick replaces the text' },
  { id: 'comment', label: 'Add a comment', hint: 'The result is pinned beside the text as a comment; the text stays as it is' },
]
const STYLES: { id: AiTool['creativity']; label: string }[] = [
  { id: 'precise', label: 'Precise' }, { id: 'balanced', label: 'Balanced' }, { id: 'creative', label: 'Creative' },
]
/** Ready-made starting points. */
const EXAMPLES: Draft[] = [
  { name: 'Action items', scope: 'any', output: 'after', creativity: 'precise', single: true, prompt: 'List every task, promise or next step in the text as a short checklist item starting with a verb. Leave out anything that is not an action.' },
  { name: 'Emotional words', scope: 'any', output: 'choose', creativity: 'balanced', single: true, prompt: 'Pick out the words and short phrases in the text that carry emotion.' },
  { name: 'Is this sound?', scope: 'any', output: 'comment', creativity: 'precise', single: true, prompt: 'Check whether the reasoning holds up. Name the weakest point or the unstated assumption, briefly and kindly.' },
  { name: 'Stronger verb', scope: 'word', output: 'choose', creativity: 'balanced', single: true, prompt: 'Suggest stronger, more vivid verbs that could replace this one in the sentence.' },
  { name: 'Key points', scope: 'any', output: 'after', creativity: 'precise', single: true, prompt: 'Capture the key points of the text as 3 to 5 short bullet points.' },
  { name: 'Title ideas', scope: 'any', output: 'choose', creativity: 'creative', single: true, prompt: 'Suggest short, catchy titles for this text.' },
]

const blank: Draft = { name: '', scope: 'any', output: 'replace', creativity: 'balanced', single: true, prompt: '' }

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string; hint?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg wide tool-seg" role="radiogroup">
      {options.map(o => <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? 'on' : ''} title={o.hint} onClick={() => onChange(o.id)}>{o.label}</button>)}
    </div>
  )
}

const fields = (t: AiTool): Draft => ({ id: t.id, name: t.name, scope: t.scope, output: t.output, prompt: t.prompt, creativity: t.creativity, single: t.single })
const sameAs = (d: Draft, t: AiTool) => JSON.stringify(fields(t)) === JSON.stringify({ ...d, id: t.id })

/**
 * Make or change one AI tool, and try it on some text before saving. Its maker can ask for it to be shared with
 * everyone; `review` is the admin looking at one waiting for approval: nothing can be changed, only tried and published.
 */
export function AiToolEditor({ tool, sample = '', review = false, onClose }: { tool?: AiTool; sample?: string; review?: boolean; onClose: () => void }) {
  const { saveAiTool, deleteAiTool, submitAiTool, publishAiTool } = useStore()
  const [d, setD] = useState<Draft>(tool ? fields(tool) : blank)
  const [text, setText] = useState(sample)
  const [result, setResult] = useState<string | string[] | null>(null)
  const [busy, setBusy] = useState<'try' | 'save' | 'share' | 'publish' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setD(x => ({ ...x, [k]: v })); setResult(null) }
  const ready = d.name.trim() && d.prompt.trim()

  const tryIt = async () => {
    if (!ready || !text.trim()) return
    setBusy('try'); setErr(null); setResult(null)
    try {
      const input = d.scope === 'word' ? `Word: ${text.trim().split(/\s+/)[0]}\nSentence: ${text.trim()}` : text.trim()
      const out = await runAi('custom', input, { tool: toolDef(d), lang: detectLanguage(text) })
      setResult(d.output === 'choose' ? parseChoices(out, '', 8, { maxLen: 120, linesOnly: true }) : out)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }
  const save = async () => {
    if (!ready) return
    setBusy('save'); setErr(null)
    try { await saveAiTool(d); onClose() } catch (e) { setErr((e as Error).message); setBusy(null) }
  }
  /** Ask the admin to publish it for everyone (saving any changes first). */
  const share = async () => {
    if (!ready || !tool) return
    if (!confirm(`Share “${d.name.trim()}” with everyone?\n\nIt goes to the admin to try first. Once it’s approved, every Smart Journal user gets it in their ✨ menu, and you’ll get a notification.`)) return
    setBusy('share'); setErr(null)
    try {
      if (!sameAs(d, tool)) await saveAiTool(d)
      await submitAiTool(tool.id)
      toast('Sent for approval', 'You’ll get a notification when it’s live for everyone')
      onClose()
    } catch (e) { setErr((e as Error).message); setBusy(null) }
  }
  /** (Admin) publish it: every user gets it, and its maker is told. */
  const publish = async () => {
    if (!tool) return
    setBusy('publish'); setErr(null)
    try {
      await publishAiTool(tool.id)
      toast(`“${tool.name}” is live for everyone`, tool.author_name ? `${tool.author_name} has been told — with congratulations` : undefined)
      onClose()
    } catch (e) { setErr((e as Error).message); setBusy(null) }
  }
  const status = tool?.status ?? 'private'
  const remove = async () => {
    if (!tool || !confirm(`Delete the AI tool “${tool.name}”?`)) return
    try { await deleteAiTool(tool.id); onClose() } catch (e) { setErr((e as Error).message) }
  }

  return createPortal(
    <div className="modal-bg" onMouseDown={() => { if (!busy) onClose() }}>
      <div className="modal tool-editor" role="dialog" aria-label={tool ? `Edit ${tool.name}` : 'New AI tool'} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2><WandSparkles size={16} /> {review ? 'Review AI tool' : tool ? 'Edit AI tool' : 'New AI tool'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="tool-body">
          {review && (
            <p className="tool-review-note">
              <strong>{tool?.author_name ?? 'Someone'}</strong> wants to share this tool with everyone. Try it below; nothing here can be changed.
              Publishing puts it in every user’s ✨ menu.
            </p>
          )}
          <fieldset className="tool-fields" disabled={review}>
          {!tool && (
            <div className="tool-examples">
              <span className="muted small">Start from</span>
              {EXAMPLES.map(x => <button key={x.name} type="button" className="ai-chip" onClick={() => { setD({ ...x }); setResult(null) }}>{x.name}</button>)}
            </div>
          )}
          <label className="tool-field"><span>Name <em className="muted">— how it shows in the ✨ menu</em></span>
            <input value={d.name} maxLength={60} placeholder="e.g. Emotional words" onChange={e => set('name', e.target.value)} autoFocus={!tool} />
          </label>
          <div className="tool-field"><span>Works on</span><Seg value={d.scope} options={SCOPES} onChange={v => set('scope', v)} /></div>
          <div className="tool-field"><span>Result</span><Seg value={d.output} options={OUTPUTS} onChange={v => set('output', v)} />
            <em className="muted small">{OUTPUTS.find(o => o.id === d.output)!.hint}</em>
            {(d.output === 'replace' || d.output === 'after') && (
              <label className="tool-check"><input type="checkbox" checked={d.single} onChange={e => set('single', e.target.checked)} />
                <span>Restrict AI output to a single option <em className="muted">(even with 2 AI text options on)</em></span></label>
            )}
          </div>
          <label className="tool-field"><span>What should it do? <em className="muted">— your instructions for the AI</em></span>
            <textarea rows={4} maxLength={2000} value={d.prompt} placeholder="e.g. Pick out the words that carry emotion." onChange={e => set('prompt', e.target.value)} />
          </label>
          <div className="tool-field"><span>Style</span><Seg value={d.creativity} options={STYLES} onChange={v => set('creativity', v)} /></div>
          </fieldset>
          <p className="tool-cost muted small" title="An estimate: instructions and house rules, a typical selection and a typical answer. Marathi and Hindi use about 2–3× as many tokens.">
            ≈ {toolTokens(d, aiTwoVersions()).toLocaleString()} Gemini tokens each time you use it
            {d.scope === 'any' ? ' (on a ~120-word paragraph)' : d.scope === 'sentence' ? ' (on a sentence)' : ' (on a word)'}</p>
          {tool && !review && status !== 'private' && (
            <p className={'tool-status ' + status}>
              {status === 'published' ? <><Globe size={13} /> Shared with everyone.</> : <><Clock size={13} /> Waiting for the admin’s approval.</>}
              {' '}Saving changes sends it back for approval{status === 'published' ? ', and others won’t have it until then' : ''}.
            </p>
          )}

          <div className="tool-try">
            <label className="tool-field"><span>Try it on</span>
              <textarea rows={3} value={text} placeholder={d.scope === 'word' ? 'A word, then the sentence it’s in' : 'Some text to test the tool with'} onChange={e => { setText(e.target.value); setResult(null) }} />
            </label>
            <button className="btn small" onClick={tryIt} disabled={!ready || !text.trim() || !!busy}>{busy === 'try' ? 'Trying…' : 'Try it'}</button>
            {result != null && (
              <div className="tool-result">
                {Array.isArray(result)
                  ? <div className="ai-chips">{result.length ? result.map(o => <span key={o} className="ai-chip">{o}</span>) : <span className="muted small">No options came back</span>}</div>
                  : <div className="tool-result-text">{result}</div>}
              </div>
            )}
          </div>
          {err && <div className="err">{err}</div>}
        </div>
        <div className="tool-actions">
          {tool && !review && <button className="btn danger small" onClick={remove} disabled={!!busy}><Trash2 size={14} /> Delete</button>}
          {tool && !review && status === 'private' && (
            <button className="btn small" onClick={share} disabled={!ready || !!busy} title="Ask for it to be published to every Smart Journal user">
              <Send size={13} /> {busy === 'share' ? 'Sending…' : 'Share with everyone'}</button>
          )}
          <span className="spacer" />
          <button className="btn small" onClick={onClose} disabled={!!busy}>Cancel</button>
          {review
            ? <button className="btn primary small" onClick={publish} disabled={!!busy}><Globe size={14} /> {busy === 'publish' ? 'Publishing…' : 'Publish'}</button>
            : <button className="btn primary small" onClick={save} disabled={!ready || !!busy}>{busy === 'save' ? 'Saving…' : 'Save tool'}</button>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Settings → My AI tools: the list, in menu order, to add, edit, reorder or delete. */
export function AiToolsDialog({ onClose, reviewId }: { onClose: () => void; reviewId?: string }) {
  const { aiTools, moveAiTool, deleteAiTool, pendingTools } = useStore()
  const [editing, setEditing] = useState<AiTool | 'new' | null>(null)
  // opened from a notice: straight to that tool's review, if it's still waiting
  const [reviewing, setReviewing] = useState<AiTool | null>(() => pendingTools.find(t => t.id === reviewId) ?? null)
  if (reviewing) return <AiToolEditor tool={reviewing} review onClose={() => (reviewId ? onClose() : setReviewing(null))} />
  if (editing) return <AiToolEditor tool={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />
  const two = aiTwoVersions()
  return createPortal(
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal tool-list" role="dialog" aria-label="My AI tools" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2><WandSparkles size={16} /> My AI tools</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        {pendingTools.length > 0 && <>
          <h3 className="tool-section">Waiting for your approval</h3>
          <ul className="tool-rows pending">
            {pendingTools.map(t => (
              <li key={t.id} className="tool-row">
                <button className="tool-row-main" onClick={() => setReviewing(t)} title="Review and publish">
                  <span className="tool-row-name">{t.name} <span className="tool-badge draft">draft</span></span>
                  <span className="tool-row-meta">by {t.author_name ?? 'someone'} · {SCOPES.find(x => x.id === t.scope)!.label} · {OUTPUTS.find(o => o.id === t.output)!.label} · ≈ {toolTokens(t, aiTwoVersions()).toLocaleString()} tokens</span>
                  <span className="tool-row-prompt">{t.prompt}</span>
                </button>
                <span className="tool-row-actions"><button className="btn small" onClick={() => setReviewing(t)}>Review</button></span>
              </li>
            ))}
          </ul>
          <h3 className="tool-section">My AI tools</h3>
        </>}
        <p className="tool-intro">Your own tools, in the ✨ menu just for you — unless you share one with everyone. They’re listed here in menu order.</p>
        {aiTools.length ? (
          <ul className="tool-rows">
            {aiTools.map((t, i) => (
              <li key={t.id} className="tool-row">
                <button className="tool-row-main" onClick={() => setEditing(t)} title="Edit">
                  <span className="tool-row-name">{t.name}
                    {t.status === 'submitted' && <span className="tool-badge draft" title="Waiting for the admin’s approval">waiting</span>}
                    {t.status === 'published' && <span className="tool-badge shared" title="Shared with everyone"><Globe size={10} /> shared</span>}</span>
                  <span className="tool-row-meta">
                    {SCOPES.find(x => x.id === t.scope)!.label} · {OUTPUTS.find(o => o.id === t.output)!.label} · {STYLES.find(x => x.id === t.creativity)!.label} · ≈ {toolTokens(t, two).toLocaleString()} tokens
                  </span>
                  <span className="tool-row-prompt">{t.prompt}</span>
                </button>
                <span className="tool-row-actions">
                  <button className="icon-btn" title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => moveAiTool(t.id, -1)}><ArrowUp size={15} /></button>
                  <button className="icon-btn" title="Move down" aria-label="Move down" disabled={i === aiTools.length - 1} onClick={() => moveAiTool(t.id, 1)}><ArrowDown size={15} /></button>
                  <button className="icon-btn" title="Edit" aria-label="Edit" onClick={() => setEditing(t)}><Pencil size={15} /></button>
                  <button className="icon-btn" title="Delete" aria-label="Delete" onClick={() => { if (confirm(`Delete the AI tool “${t.name}”?`)) deleteAiTool(t.id).catch(e => alert((e as Error).message)) }}><Trash2 size={15} /></button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="tool-empty"><WandSparkles size={22} /><span>No tools yet. Make one for something you do often — pulling out action items, spotting emotional words, questioning an argument.</span></div>
        )}
        <div className="tool-actions"><span className="spacer" /><button className="btn primary small" onClick={() => setEditing('new')}><Plus size={14} /> New AI tool</button></div>
      </div>
    </div>,
    document.body,
  )
}
