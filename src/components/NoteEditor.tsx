import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import type { EditorView } from '@tiptap/pm/view'
import { Bold, Italic, MessageSquarePlus, Unlink } from 'lucide-react'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import Youtube from '@tiptap/extension-youtube'
import { EditorKeys, SwallowTab, Wikilink } from '../lib/wikilink'
import { Comment } from '../lib/comment'

interface Props {
  html: string
  onChange: (html: string) => void
  onOpenLink: (title: string) => void
  onCreatePage: (title: string) => void
  /** Canonical title of an existing page for the typed text (case-insensitive), else the text itself. */
  resolveTitle: (title: string) => string
  pickDate: (anchor?: { x: number; y: number }) => Promise<string | null>
  /** Offer "comment" in the selection menu. */
  comments?: boolean
  onAddComment?: (id: string) => void
  /** Hands the editor instance to the parent (null on unmount). */
  onReady?: (editor: Editor | null) => void
  autoFocus?: boolean
}

const LONG_PRESS_MS = 550

/** Document position of the wikilink rendered by `el`, or -1. Tries the DOM mapping first, then the element's centre. */
function wikilinkPos(view: EditorView, el: HTMLElement): number {
  const isLink = (p: number) => p >= 0 && view.state.doc.nodeAt(p)?.type.name === 'wikilink'
  try { const p = view.posAtDOM(el, 0); if (isLink(p)) return p; if (isLink(p - 1)) return p - 1 } catch { /* detached element */ }
  const r = el.getBoundingClientRect()
  const c = view.posAtCoords({ left: r.left + r.width / 2, top: r.top + r.height / 2 })
  if (c) { for (const p of [c.inside, c.pos, c.pos - 1]) if (isLink(p)) return p }
  return -1
}

/** Replace the wikilink rendered by `el` with its plain text. */
function unlinkElement(view: EditorView, el: HTMLElement) {
  const pos = wikilinkPos(view, el)
  if (pos < 0) { console.warn('unlink: could not locate link node'); return }
  const node = view.state.doc.nodeAt(pos)!
  view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, view.state.schema.text(node.attrs.title as string)).scrollIntoView())
  view.focus()
}

/** Single-surface editor: what you type is what you see. Bullets, numbering, links, [[wikilinks]], comments, YouTube paste. */
export function NoteEditor({ html, onChange, onOpenLink, onCreatePage, resolveTitle, pickDate, comments, onAddComment, onReady, autoFocus }: Props) {
  // latest callbacks, readable from editor options that are captured once
  const open = useRef(onOpenLink); open.current = onOpenLink
  const create = useRef(onCreatePage); create.current = onCreatePage
  const change = useRef(onChange); change.current = onChange
  const resolve = useRef(resolveTitle); resolve.current = resolveTitle
  const date = useRef(pickDate); date.current = pickDate
  const ready = useRef(onReady); ready.current = onReady

  // hover "unlink" affordance (pointer devices) and long-press unlink (touch)
  const [hoverLink, setHoverLink] = useState<{ el: HTMLElement; x: number; y: number } | null>(null)
  const hideTimer = useRef<number | null>(null)
  const pressTimer = useRef<number | null>(null)
  const clearHide = () => { if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null } }
  const scheduleHide = () => { clearHide(); hideTimer.current = window.setTimeout(() => setHoverLink(null), 250) }
  const clearPress = () => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null } }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // openOnClick off: its handler would also fire on wikilinks; external links are handled in handleClick below
        link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: 'noopener' } },
      }),
      Placeholder.configure({ placeholder: 'Write… "- " for bullets, "1. " for numbers, select a word and press [[ to link' }),
      Youtube.configure({ nocookie: true, width: 480, height: 270 }),
      Wikilink.configure({ resolve: t => resolve.current(t), onCreate: t => create.current(t), pickDate: a => date.current(a) }),
      Comment,
      EditorKeys,
      SwallowTab,
    ],
    content: html,
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: 'note', spellcheck: 'true' },
      handleClickOn: (_view, _pos, node) => {
        if (node.type.name !== 'wikilink') return false
        open.current(node.attrs.title)
        return true
      },
      handleClick: (_view, _pos, event) => {
        const a = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
        if (!a || a.classList.contains('wikilink')) return false
        window.open(a.href, '_blank', 'noopener')
        return true
      },
      handleDOMEvents: {
        mouseover: (_view, e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>('a.wikilink')
          if (el) { clearHide(); const r = el.getBoundingClientRect(); setHoverLink({ el, x: r.left, y: r.top }) }
          return false
        },
        mouseout: (_view, e) => { if ((e.target as HTMLElement).closest('a.wikilink')) scheduleHide(); return false },
        touchstart: (view, e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>('a.wikilink')
          clearPress()
          if (el) pressTimer.current = window.setTimeout(() => {
            pressTimer.current = null
            if (confirm(`Remove the link on “${el.textContent}”? The page stays.`)) unlinkElement(view, el)
          }, LONG_PRESS_MS)
          return false
        },
        touchend: () => { clearPress(); return false },
        touchmove: () => { clearPress(); return false },
        touchcancel: () => { clearPress(); return false },
      },
    },
    onUpdate: ({ editor }) => change.current(editor.getHTML()),
  })

  useEffect(() => { ready.current?.(editor); return () => ready.current?.(null) }, [editor])

  // content changed elsewhere (another device / compile) while this editor is idle
  useEffect(() => {
    if (editor && !editor.isFocused && editor.getHTML() !== html) editor.commands.setContent(html, { emitUpdate: false })
  }, [html, editor])

  const active = useEditorState({ editor, selector: ({ editor: e }) => ({ bold: e?.isActive('bold') ?? false, italic: e?.isActive('italic') ?? false }) })

  const addComment = () => {
    if (!editor) return
    const id = crypto.randomUUID()
    editor.chain().focus().setComment(id).run()
    onAddComment?.(id)
  }

  return (
    <>
      {editor && (
        <BubbleMenu editor={editor} className="bubble" shouldShow={({ editor: e, state }) => !state.selection.empty && e.isEditable}>
          <div className="bubble-row">
            <button className={active?.bold ? 'on' : ''} title="Bold (⌘B)" onMouseDown={e => e.preventDefault()} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} /></button>
            <button className={active?.italic ? 'on' : ''} title="Italic (⌘I)" onMouseDown={e => e.preventDefault()} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} /></button>
            {comments && <>
              <span className="bubble-sep" />
              <button title="Comment on this text" onMouseDown={e => e.preventDefault()} onClick={addComment}><MessageSquarePlus size={15} /></button>
            </>}
          </div>
        </BubbleMenu>
      )}
      <EditorContent editor={editor} className="note-wrap" />
      {hoverLink && editor && (
        <div className="unlink-pop" style={{ left: hoverLink.x, top: hoverLink.y - 30 }} onMouseEnter={clearHide} onMouseLeave={scheduleHide}>
          <button onMouseDown={e => e.preventDefault()} onClick={() => { unlinkElement(editor.view, hoverLink.el); setHoverLink(null) }}><Unlink size={13} /><span>Unlink</span></button>
        </div>
      )}
    </>
  )
}
