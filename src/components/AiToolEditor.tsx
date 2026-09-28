import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, WandSparkles, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { detectLanguage, parseChoices, runAi, toolDef } from '../lib/ai'
import type { AiTool } from '../lib/types'

type Draft = Omit<AiTool, 'id' | 'sort_order'> & { id?: string }

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
  { name: 'Action items', scope: 'any', output: 'after', creativity: 'precise', prompt: 'List every task, promise or next step in the text as a short checklist item starting with a verb. Leave out anything that is not an action.' },
  { name: 'Emotional words', scope: 'any', output: 'choose', creativity: 'balanced', prompt: 'Pick out the words and short phrases in the text that carry emotion.' },
  { name: 'Is this sound?', scope: 'any', output: 'comment', creativity: 'precise', prompt: 'Check whether the reasoning holds up. Name the weakest point or the unstated assumption, briefly and kindly.' },
  { name: 'Stronger verb', scope: 'word', output: 'choose', creativity: 'balanced', prompt: 'Suggest stronger, more vivid verbs that could replace this one in the sentence.' },
  { name: 'Key points', scope: 'any', output: 'after', creativity: 'precise', prompt: 'Capture the key points of the text as 3 to 5 short bullet points.' },
  { name: 'Title ideas', scope: 'any', output: 'choose', creativity: 'creative', prompt: 'Suggest short, catchy titles for this text.' },
]

const blank: Draft = { name: '', scope: 'any', output: 'replace', creativity: 'balanced', prompt: '' }

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string; hint?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg wide tool-seg" role="radiogroup">
      {options.map(o => <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? 'on' : ''} title={o.hint} onClick={() => onChange(o.id)}>{o.label}</button>)}
    </div>
  )
}

/** Make or change one AI tool, and try it on some text before saving. */
export function AiToolEditor({ tool, sample = '', onClose }: { tool?: AiTool; sample?: string; onClose: () => void }) {
  const { saveAiTool, deleteAiTool } = useStore()
  const [d, setD] = useState<Draft>(tool ? { ...tool } : blank)
  const [text, setText] = useState(sample)
  const [result, setResult] = useState<string | string[] | null>(null)
  const [busy, setBusy] = useState<'try' | 'save' | null>(null)
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
  const remove = async () => {
    if (!tool || !confirm(`Delete the AI tool “${tool.name}”?`)) return
    try { await deleteAiTool(tool.id); onClose() } catch (e) { setErr((e as Error).message) }
  }

  return createPortal(
    <div className="modal-bg" onMouseDown={() => { if (!busy) onClose() }}>
      <div className="modal tool-editor" role="dialog" aria-label={tool ? `Edit ${tool.name}` : 'New AI tool'} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2><WandSparkles size={16} /> {tool ? 'Edit AI tool' : 'New AI tool'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="tool-body">
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
            <em className="muted small">{OUTPUTS.find(o => o.id === d.output)!.hint}</em></div>
          <label className="tool-field"><span>What should it do? <em className="muted">— your instructions for the AI</em></span>
            <textarea rows={4} maxLength={2000} value={d.prompt} placeholder="e.g. Pick out the words that carry emotion." onChange={e => set('prompt', e.target.value)} />
          </label>
          <div className="tool-field"><span>Style</span><Seg value={d.creativity} options={STYLES} onChange={v => set('creativity', v)} /></div>

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
          {tool && <button className="btn danger small" onClick={remove} disabled={!!busy}><Trash2 size={14} /> Delete</button>}
          <span className="spacer" />
          <button className="btn small" onClick={onClose} disabled={!!busy}>Cancel</button>
          <button className="btn primary small" onClick={save} disabled={!ready || !!busy}>{busy === 'save' ? 'Saving…' : 'Save tool'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Settings → My AI tools: the list, in menu order, to add, edit, reorder or delete. */
export function AiToolsDialog({ onClose }: { onClose: () => void }) {
  const { aiTools, moveAiTool, deleteAiTool } = useStore()
  const [editing, setEditing] = useState<AiTool | 'new' | null>(null)
  if (editing) return <AiToolEditor tool={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />
  return createPortal(
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal tool-list" role="dialog" aria-label="My AI tools" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2><WandSparkles size={16} /> My AI tools</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <p className="muted small tool-intro">Your own tools appear at the bottom of the ✨ menu, just for you.</p>
        <ul className="tool-rows">
          {aiTools.map((t, i) => (
            <li key={t.id}>
              <span className="tool-row-name">{t.name}</span>
              <span className="muted small">{SCOPES.find(s => s.id === t.scope)!.label} · {OUTPUTS.find(o => o.id === t.output)!.label}</span>
              <span className="spacer" />
              <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => moveAiTool(t.id, -1)}><ArrowUp size={14} /></button>
              <button className="icon-btn" title="Move down" disabled={i === aiTools.length - 1} onClick={() => moveAiTool(t.id, 1)}><ArrowDown size={14} /></button>
              <button className="icon-btn" title="Edit" onClick={() => setEditing(t)}><Pencil size={14} /></button>
              <button className="icon-btn" title="Delete" onClick={() => { if (confirm(`Delete the AI tool “${t.name}”?`)) deleteAiTool(t.id).catch(e => alert((e as Error).message)) }}><Trash2 size={14} /></button>
            </li>
          ))}
          {aiTools.length === 0 && <li className="muted small">No tools yet.</li>}
        </ul>
        <div className="tool-actions"><span className="spacer" /><button className="btn primary small" onClick={() => setEditing('new')}><Plus size={14} /> New AI tool</button></div>
      </div>
    </div>,
    document.body,
  )
}
