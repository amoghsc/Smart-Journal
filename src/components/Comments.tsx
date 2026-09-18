import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { X } from 'lucide-react'
import { listComments, type CommentInfo } from '../lib/comment'

interface Props {
  editor: Editor
  /** The scrolling container the cards are positioned in. */
  scrollEl: HTMLElement
  /** Comment whose card should grab focus (just created). */
  focusId: string | null
  onFocused: () => void
}

const MIN_GUTTER = 200
const estimateHeight = (text: string) => 40 + Math.max(1, Math.ceil(text.length / 28)) * 18

/** Comment cards in the right-hand margin, each aligned with the text it belongs to. */
export function Comments({ editor, scrollEl, focusId, onFocused }: Props) {
  const [items, setItems] = useState<CommentInfo[]>([])
  const [tops, setTops] = useState<Map<string, number>>(new Map())
  const [gutter, setGutter] = useState(0)
  const [left, setLeft] = useState(0)
  const [hover, setHover] = useState<string | null>(null)

  const layout = useCallback(() => {
    const list = listComments(editor.state.doc)
    const box = scrollEl.getBoundingClientRect()
    const g = parseFloat(getComputedStyle(editor.view.dom).paddingRight) || 0
    setGutter(g)
    // cards start just past the text column, not at the far edge of the margin
    setLeft(editor.view.dom.getBoundingClientRect().right - g - box.left + 20)
    const t = new Map<string, number>()
    let prevBottom = 0
    for (const c of list) {
      let y = 0
      try { y = editor.view.coordsAtPos(c.from).top - box.top + scrollEl.scrollTop } catch { /* position not rendered yet */ }
      const top = Math.max(y, prevBottom)
      t.set(c.id, top)
      prevBottom = top + estimateHeight(c.text) + 8
    }
    setItems(list); setTops(t)
  }, [editor, scrollEl])

  useEffect(() => {
    layout()
    editor.on('update', layout)
    const ro = new ResizeObserver(layout)
    ro.observe(scrollEl); ro.observe(editor.view.dom)
    return () => { editor.off('update', layout); ro.disconnect() }
  }, [editor, scrollEl, layout])

  // hovering commented text lights up its card
  useEffect(() => {
    const dom = editor.view.dom
    const over = (e: Event) => setHover((e.target as HTMLElement).closest<HTMLElement>('[data-comment-id]')?.dataset.commentId ?? null)
    dom.addEventListener('mouseover', over)
    return () => dom.removeEventListener('mouseover', over)
  }, [editor])

  // hovering a card lights up its text
  const highlight = (id: string | null) => {
    editor.view.dom.querySelectorAll('.comment.hl').forEach(el => el.classList.remove('hl'))
    if (id) editor.view.dom.querySelectorAll(`[data-comment-id="${CSS.escape(id)}"]`).forEach(el => el.classList.add('hl'))
  }

  if (gutter < MIN_GUTTER || items.length === 0) return null
  return (
    <div className="comments" style={{ left, width: Math.min(260, gutter - 36) }}>
      {items.map(c => (
        <CommentCard key={c.id} c={c} top={tops.get(c.id) ?? 0} active={hover === c.id} autoFocus={focusId === c.id} onFocused={onFocused}
          onHover={on => highlight(on ? c.id : null)}
          onChange={text => editor.commands.updateComment(c.id, text)}
          onDelete={() => editor.chain().focus().removeComment(c.id).run()} />
      ))}
    </div>
  )
}

interface CardProps {
  c: CommentInfo; top: number; active: boolean; autoFocus: boolean
  onFocused: () => void; onHover: (on: boolean) => void; onChange: (text: string) => void; onDelete: () => void
}

function CommentCard({ c, top, active, autoFocus, onFocused, onHover, onChange, onDelete }: CardProps) {
  const ta = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }, [c.text])
  useEffect(() => { if (autoFocus) { ta.current?.focus(); onFocused() } }, [autoFocus, onFocused])
  return (
    <div className={'comment-card' + (active ? ' hl' : '')} style={{ top }} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
      <textarea ref={ta} rows={1} value={c.text} placeholder="Comment…" onChange={e => onChange(e.target.value)}
        onBlur={() => { if (!c.text.trim()) onDelete() }} />
      <button className="comment-del" title="Delete comment" onMouseDown={e => e.preventDefault()} onClick={onDelete}><X size={13} /></button>
    </div>
  )
}
