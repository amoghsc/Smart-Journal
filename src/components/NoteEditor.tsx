import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import type { EditorView } from '@tiptap/pm/view'
import { Bold, Check, Highlighter, Italic, Link2, Link2Off, Loader2, MessageSquarePlus, Plus, Sparkles, Strikethrough, Unlink, X } from 'lucide-react'
import { AI_TASKS, aiAvailable, parseChoices, runAi, selectionToText, singleWord, textToContent, wordInContext, type AiTask } from '../lib/ai'
import { toast } from '../lib/toast'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import Highlight from '@tiptap/extension-highlight'
import Youtube from '@tiptap/extension-youtube'
import type { SuggestionProps } from '@tiptap/suggestion'
import { EditorKeys, SwallowTab, Wikilink } from '../lib/wikilink'
import { WikilinkSuggest, matchTitles, type SuggestItem } from '../lib/wikilinkSuggest'
import { Comment } from '../lib/comment'
import { isDailyTitle, prettyDate } from '../lib/links'

interface Props {
  html: string
  onChange: (html: string) => void
  onOpenLink: (title: string) => void
  onCreatePage: (title: string) => void
  /** Canonical title of an existing page for the typed text (case-insensitive), else the text itself. */
  resolveTitle: (title: string) => string
  /** Notes that can be linked with `[[`, most recently edited first. */
  titles: string[]
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

/** "example.com/x" → "https://example.com/x"; keeps mailto:, tel: and explicit schemes. */
function normaliseUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)) return `https://${s}`
  return null
}

interface SuggestState { items: SuggestItem[]; index: number; rect: DOMRect | null; command: (item: SuggestItem) => void }

/** Single-surface editor: what you type is what you see. Bullets, numbering, links, [[wikilinks]], comments, YouTube paste. */
export function NoteEditor({ html, onChange, onOpenLink, onCreatePage, resolveTitle, titles, pickDate, comments, onAddComment, onReady, autoFocus }: Props) {
  // latest callbacks, readable from editor options that are captured once
  const open = useRef(onOpenLink); open.current = onOpenLink
  const create = useRef(onCreatePage); create.current = onCreatePage
  const change = useRef(onChange); change.current = onChange
  const resolve = useRef(resolveTitle); resolve.current = resolveTitle
  const titlesRef = useRef(titles); titlesRef.current = titles
  const date = useRef(pickDate); date.current = pickDate
  const ready = useRef(onReady); ready.current = onReady

  // hover "unlink" affordance (pointer devices) and long-press unlink (touch)
  const [hoverLink, setHoverLink] = useState<{ el: HTMLElement; x: number; y: number } | null>(null)
  const hideTimer = useRef<number | null>(null)
  const pressTimer = useRef<number | null>(null)
  const clearHide = () => { if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null } }
  const scheduleHide = () => { clearHide(); hideTimer.current = window.setTimeout(() => setHoverLink(null), 250) }
  const clearPress = () => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null } }

  // external link field inside the selection menu
  const [linkMode, setLinkMode] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkErr, setLinkErr] = useState(false)
  const openLinkField = useRef<() => void>(() => {})

  // AI tools (✨): a row in the selection menu; the request runs on the server
  const [aiMode, setAiMode] = useState(false)
  const [aiBusy, setAiBusy] = useState<AiTask | null>(null)
  // options from a 'choose' task (similar words), waiting for a pick
  const [choices, setChoices] = useState<{ word: string; from: number; to: number; options: string[] } | null>(null)

  // [[ picker
  const [suggest, setSuggest] = useState<SuggestState | null>(null)
  const suggestRef = useRef<SuggestState | null>(null)
  const setSuggestBoth = (s: SuggestState | null) => { suggestRef.current = s; setSuggest(s) }
  const fromProps = (p: SuggestionProps<SuggestItem>, index = 0): SuggestState =>
    ({ items: p.items, index: Math.min(index, Math.max(0, p.items.length - 1)), rect: p.clientRect?.() ?? null, command: p.command })

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // openOnClick off: its handler would also fire on wikilinks; external links are handled in handleClick below
        link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: 'noopener' } },
      }),
      Placeholder.configure({ placeholder: 'Write… "- " for bullets, "1. " for numbers, [[ to link a note' }),
      Highlight,
      Youtube.configure({ nocookie: true, width: 480, height: 270 }),
      Wikilink.configure({ resolve: t => resolve.current(t), onCreate: t => create.current(t), pickDate: a => date.current(a) }),
      WikilinkSuggest.configure({
        items: ({ query }) => matchTitles(titlesRef.current, query),
        command: ({ editor, range, props }) => {
          const title = resolve.current(props.title)
          create.current(title)
          editor.chain().focus().insertContentAt(range, [{ type: 'wikilink', attrs: { title } }, { type: 'text', text: ' ' }]).run()
        },
        render: () => ({
          onStart: p => setSuggestBoth(fromProps(p)),
          onUpdate: p => setSuggestBoth(fromProps(p)),
          onExit: () => setSuggestBoth(null),
          onKeyDown: ({ event }) => {
            const s = suggestRef.current
            if (!s || !s.items.length) return false
            if (event.key === 'ArrowDown') { setSuggestBoth({ ...s, index: (s.index + 1) % s.items.length }); return true }
            if (event.key === 'ArrowUp') { setSuggestBoth({ ...s, index: (s.index - 1 + s.items.length) % s.items.length }); return true }
            if (event.key === 'Enter' || event.key === 'Tab') { s.command(s.items[s.index]); return true }
            return false
          },
        }),
      }),
      Comment,
      EditorKeys,
      SwallowTab,
    ],
    content: html,
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: 'note', spellcheck: 'true' },
      handleKeyDown: (view, event) => {
        // ⌘K / Ctrl+K: link the selected words
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          if (!view.state.selection.empty) openLinkField.current()
          return true
        }
        return false
      },
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
    onSelectionUpdate: () => { setLinkMode(false); setLinkErr(false); setAiMode(false); setChoices(null) },
  })

  useEffect(() => { ready.current?.(editor); return () => ready.current?.(null) }, [editor])

  // content changed elsewhere (another device / compile) while this editor is idle
  useEffect(() => {
    if (editor && !editor.isFocused && editor.getHTML() !== html) editor.commands.setContent(html, { emitUpdate: false })
  }, [html, editor])

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive('bold') ?? false,
      italic: e?.isActive('italic') ?? false,
      highlight: e?.isActive('highlight') ?? false,
      strike: e?.isActive('strike') ?? false,
      word: e ? singleWord(e.state.doc, e.state.selection.from, e.state.selection.to) : null,
      link: e?.isActive('link') ?? false,
    }),
  })

  openLinkField.current = () => {
    if (!editor) return
    setLinkUrl((editor.getAttributes('link').href as string | undefined) ?? '')
    setLinkErr(false)
    setLinkMode(true)
  }

  const applyLink = () => {
    if (!editor) return
    const href = normaliseUrl(linkUrl)
    if (!href) { setLinkErr(true); return }
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    setLinkMode(false)
  }
  const removeLink = () => { editor?.chain().focus().extendMarkRange('link').unsetLink().run(); setLinkMode(false) }
  const cancelLink = () => { setLinkMode(false); editor?.commands.focus() }

  /** Run an AI tool on the selection: replace it, or add the result below it. Undo (⌘Z) reverts either. */
  const runTask = async (task: AiTask) => {
    if (!editor || aiBusy) return
    if (!(await aiAvailable())) { toast('AI isn’t set up yet', 'Add GEMINI_API_KEY to the Supabase function secrets'); return }
    const { from, to } = editor.state.selection
    const word = singleWord(editor.state.doc, from, to)
    if (task.wordOnly && !word) return
    const text = task.wordOnly ? wordInContext(editor.state.doc, from, word!) : selectionToText(editor.state.doc, from, to)
    if (!text.trim()) return
    const docBefore = editor.state.doc
    setAiBusy(task)
    try {
      const out = await runAi(task.id, text)
      if (editor.state.doc !== docBefore) { toast('The note changed while the AI was working', 'Select the text and try again'); return }
      if (task.mode === 'choose') {
        const options = parseChoices(out, word ?? '')
        if (!options.length) { toast('No similar words found'); return }
        setChoices({ word: word ?? '', from, to, options })
        return
      }
      if (task.mode === 'replace') {
        editor.chain().focus().insertContentAt({ from, to }, textToContent(out)).run()
      } else {
        // after the top-level block the selection ends in (after the whole list, if it's in one)
        const $to = editor.state.doc.resolve(to)
        const at = $to.depth > 0 ? $to.after(1) : to
        const label = task.heading ? `<p><em>${task.heading}</em></p>` : ''
        editor.chain().focus().insertContentAt(at, label + textToContent(out, false)).run()
      }
      setAiMode(false)
    } catch (e) {
      toast(`Couldn’t ${task.label.toLowerCase()}`, (e as Error).message)
    } finally {
      setAiBusy(null)
    }
  }

  /** Swap the chosen word in, keeping the original's formatting (bold, highlight, link…). */
  const pickChoice = (option: string) => {
    if (!editor || !choices) return
    const { from, to } = choices
    editor.chain().focus().command(({ tr }) => { tr.insertText(option, from, to); return true })
      .setTextSelection({ from, to: from + option.length }).run()
    setChoices(null); setAiMode(false)
  }

  const addComment = () => {
    if (!editor) return
    const id = crypto.randomUUID()
    editor.chain().focus().setComment(id).run()
    onAddComment?.(id)
  }

  const keep = (e: React.MouseEvent) => e.preventDefault()   // buttons must not steal the editor's selection
  const label = (t: string) => isDailyTitle(t) ? prettyDate(t, true) : t
  const aiGroups = AI_TASKS.filter(t => !t.wordOnly || active?.word).reduce<[string, AiTask[]][]>((acc, t) => {
    const g = acc.find(([name]) => name === t.group)
    if (g) g[1].push(t); else acc.push([t.group, [t]])
    return acc
  }, [])

  // [[ picker position: under the caret, or above it near the bottom of the window
  const suggestStyle = (() => {
    const r = suggest?.rect
    if (!r) return undefined
    const below = r.bottom + 280 < window.innerHeight
    return below ? { left: r.left, top: r.bottom + 6 } : { left: r.left, bottom: window.innerHeight - r.top + 6 }
  })()

  return (
    <>
      {editor && (
        <BubbleMenu editor={editor} className="bubble" shouldShow={({ editor: e, state }) => (!state.selection.empty || linkMode || !!aiBusy || !!choices) && e.isEditable}>
          {aiBusy ? (
            <div className="bubble-row bubble-ai"><span className="ai-busy"><Loader2 size={14} className="spin" /> {aiBusy.busy}</span></div>
          ) : choices ? (
            <div className="ai-menu ai-choices" role="menu" aria-label={`Similar to ${choices.word}`}>
              <div className="ai-menu-head">
                <Sparkles size={13} /> Similar to “{choices.word}”
                <button title="Back" aria-label="Back" onMouseDown={keep} onClick={() => setChoices(null)}><X size={13} /></button>
              </div>
              <div className="ai-chips">
                {choices.options.map(o => <button key={o} role="menuitem" className="ai-chip" onMouseDown={keep} onClick={() => pickChoice(o)}>{o}</button>)}
              </div>
            </div>
          ) : aiMode ? (
            <div className="ai-menu" role="menu" aria-label="AI">
              <div className="ai-menu-head">
                <Sparkles size={13} /> AI
                <button title="Back" aria-label="Back" onMouseDown={keep} onClick={() => setAiMode(false)}><X size={13} /></button>
              </div>
              {aiGroups.map(([group, tasks]) => (
                <div key={group} className="ai-group">
                  <div className="ai-group-name">{group}</div>
                  {tasks.map(t => (
                    <button key={t.id} role="menuitem" className="ai-item" onMouseDown={keep} onClick={() => runTask(t)}
                      title={t.mode === 'after' ? 'Adds the result below your text' : 'Replaces the selected text (⌘Z to undo)'}>
                      {t.label}{t.mode === 'after' && <span className="ai-note">adds below</span>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : linkMode ? (
            <div className="bubble-row bubble-link">
              <Link2 size={14} className="bubble-link-icon" />
              <input autoFocus value={linkUrl} placeholder="Paste or type a link…" aria-label="Link address" className={linkErr ? 'bad' : ''}
                onChange={e => { setLinkUrl(e.target.value); setLinkErr(false) }}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyLink() } if (e.key === 'Escape') { e.preventDefault(); cancelLink() } }} />
              <button title="Apply link" onMouseDown={keep} onClick={applyLink}><Check size={15} /></button>
              {active?.link && <button title="Remove link" onMouseDown={keep} onClick={removeLink}><Link2Off size={15} /></button>}
            </div>
          ) : (
            <div className="bubble-row">
              <button className={active?.bold ? 'on' : ''} title="Bold (⌘B)" onMouseDown={keep} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} /></button>
              <button className={active?.italic ? 'on' : ''} title="Italic (⌘I)" onMouseDown={keep} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} /></button>
              <button className={active?.strike ? 'on' : ''} title="Strikethrough (⌘⇧S)" onMouseDown={keep} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={15} /></button>
              <button className={active?.highlight ? 'on' : ''} title="Highlight" onMouseDown={keep} onClick={() => editor.chain().focus().toggleHighlight().run()}><Highlighter size={15} /></button>
              <button className={active?.link ? 'on' : ''} title="Link to a website (⌘K)" onMouseDown={keep} onClick={() => openLinkField.current()}><Link2 size={15} /></button>
              <span className="bubble-sep" />
              <button className="ai-btn" title="AI" onMouseDown={keep} onClick={() => setAiMode(true)}><Sparkles size={15} /></button>
              {comments && <>
                <span className="bubble-sep" />
                <button title="Comment on this text" onMouseDown={keep} onClick={addComment}><MessageSquarePlus size={15} /></button>
              </>}
            </div>
          )}
        </BubbleMenu>
      )}
      <EditorContent editor={editor} className="note-wrap" />
      {suggest && suggest.items.length > 0 && suggestStyle && (
        <ul className="suggest" style={suggestStyle} role="listbox" aria-label="Link a note">
          {suggest.items.map((it, i) => (
            <li key={(it.create ? '+' : '') + it.title} role="option" aria-selected={i === suggest.index} className={(i === suggest.index ? 'on' : '') + (it.create ? ' create' : '')}
              onMouseDown={e => { e.preventDefault(); suggest.command(it) }}
              onMouseEnter={() => setSuggestBoth({ ...suggest, index: i })}>
              {it.create ? <><Plus size={13} /> New note “{it.title}”</> : label(it.title)}
            </li>
          ))}
        </ul>
      )}
      {hoverLink && editor && (
        <div className="unlink-pop" style={{ left: hoverLink.x, top: hoverLink.y - 30 }} onMouseEnter={clearHide} onMouseLeave={scheduleHide}>
          <button onMouseDown={e => e.preventDefault()} onClick={() => { unlinkElement(editor.view, hoverLink.el); setHoverLink(null) }}><Unlink size={13} /><span>Unlink</span></button>
        </div>
      )}
    </>
  )
}
