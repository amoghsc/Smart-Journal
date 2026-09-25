import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import type { EditorView } from '@tiptap/pm/view'
import { PluginKey, Selection } from '@tiptap/pm/state'
import type { Fragment, Slice } from '@tiptap/pm/model'
import { Bold, Check, ChevronRight, Highlighter, Italic, Link2, Link2Off, Loader2, MessageSquarePlus, Plus, Sparkles, Strikethrough, Unlink, X } from 'lucide-react'
import { AI_TASKS, LANGS, aiAvailable, detectLanguage, parseChoices, runAi, runAiOptions, selectionToText, singleWord, translateTargets, wordInContext, type AiTask, type Lang } from '../lib/ai'
import { planAi, previewHtml, resultContent } from '../lib/aiPlace'
import { AI_INSERT, AiText } from '../lib/aiText'
import { sanitize } from '../lib/html'
import { aiTwoVersions } from '../lib/settings'
import { toast } from '../lib/toast'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import Highlight from '@tiptap/extension-highlight'
import Youtube from '@tiptap/extension-youtube'
import type { SuggestionProps } from '@tiptap/suggestion'
import { EditorKeys, SwallowTab, Wikilink } from '../lib/wikilink'
import { WikilinkSuggest, matchTitles, type SuggestItem } from '../lib/wikilinkSuggest'
import { Comment } from '../lib/comment'
import { AI_FRESH_MS, AiFresh, aiCompareKey, aiFreshKey, clearCompare, markAiFresh, showCompare } from '../lib/aiFresh'
import { Undo2 } from 'lucide-react'
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
/** How long the versions you didn't pick take to fade away (keep in step with .ai-option.gone in index.css). */
const OPTION_OUT_MS = 280

/** Where a small hover button goes: just above the line, or just below it if there's no room above. */
const popTop = (r: DOMRect) => (r.top - 30 >= 4 ? r.top - 30 : r.bottom + 4)

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
  // text the AI just wrote has an Undo badge pinned to its top-right corner while it is highlighted
  const [undoBadges, setUndoBadges] = useState<{ id: string; x: number; y: number; age: number }[]>([])
  const badgeLayer = useRef<HTMLElement | null>(null)
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
  // Translate › opens a small menu to its right; `translateAt` is where
  const [translateAt, setTranslateAt] = useState<{ left: number; top: number } | null>(null)
  const translateTimer = useRef<number | null>(null)
  const [aiBusy, setAiBusy] = useState<AiTask | null>(null)
  // options from a 'choose' task (similar words), waiting for a pick
  const [choices, setChoices] = useState<{ word: string; from: number; to: number; options: string[] } | null>(null)
  // AI versions shown in the note, one under the other, until one is picked; the note is untouched meanwhile.
  // `result` names them for the hover label; `picked` is set while the chosen one settles in.
  // While they show, the note is locked: nothing else can be selected, edited or run until you pick one or undo.
  const [compare, setCompare] = useState<{ task: AiTask; result: string; options: (string | Fragment)[]; previews: string[]; picked?: number } | null>(null)
  const compareDom = useRef<HTMLElement | null>(null)
  if (!compareDom.current) { compareDom.current = document.createElement('div'); compareDom.current.className = 'ai-compare-slot'; compareDom.current.contentEditable = 'false' }

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
      AiFresh,
      AiText,
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
          const target = e.target as HTMLElement
          const el = target.closest<HTMLElement>('a.wikilink')
          if (el) { clearHide(); const r = el.getBoundingClientRect(); setHoverLink({ el, x: r.left, y: popTop(r) }) }
          return false
        },
        mouseout: (_view, e) => {
          const target = e.target as HTMLElement
          if (target.closest('a.wikilink')) scheduleHide()
          return false
        },
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
  useEffect(() => { if (!aiMode) setTranslateAt(null) }, [aiMode])

  // choosing between versions locks the note (other notes stay editable); focus goes to the first version
  const comparing = !!compare
  useEffect(() => {
    if (!editor) return
    editor.setEditable(!comparing, false)
    editor.view.dom.classList.toggle('ai-locked', comparing)
    if (comparing) requestAnimationFrame(() => {
      compareDom.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      compareDom.current?.querySelector<HTMLElement>('.ai-option')?.focus({ preventScroll: true })
    })
  }, [comparing, editor])

  // Undo badges: at the top-right corner of each fresh highlight, placed in a layer that scrolls with the note
  useEffect(() => {
    if (!editor) return
    const wrap = editor.view.dom.parentElement
    if (!wrap) return
    wrap.style.position = 'relative'
    const layer = document.createElement('div')
    layer.className = 'ai-undo-layer'
    wrap.appendChild(layer)
    badgeLayer.current = layer
    let frame = 0
    const place = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (editor.isDestroyed) return
        const entries = aiFreshKey.getState(editor.state) ?? []
        const base = wrap.getBoundingClientRect()
        // in the right margin, just past the text column, so it never sits over words
        const dom = editor.view.dom, box = dom.getBoundingClientRect()
        const margin = Math.min(box.right - parseFloat(getComputedStyle(dom).paddingRight) + 6, box.right - 24) - base.left
        const now = Date.now()
        setUndoBadges(entries.flatMap(e => {
          const rects = [...dom.querySelectorAll(`[data-ai-fresh="${e.id}"]`)].flatMap(el => [...el.getClientRects()])
          if (!rects.length) return []
          const first = rects.reduce((a, r) => (r.top < a.top ? r : a))
          return [{ id: e.id, x: margin, y: first.top + first.height / 2 - base.top, age: now - e.at }]
        }))
      })
    }
    editor.on('transaction', place)
    const ro = new ResizeObserver(place)
    ro.observe(editor.view.dom)
    return () => { editor.off('transaction', place); ro.disconnect(); cancelAnimationFrame(frame); layer.remove(); badgeLayer.current = null }
  }, [editor])

  // content changed elsewhere (another device / compile) while this editor is idle
  useEffect(() => {
    // not while versions are showing: their positions would be lost
    if (editor && !editor.isFocused && !aiCompareKey.getState(editor.state) && editor.getHTML() !== html) editor.commands.setContent(html, { emitUpdate: false })
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

  /**
   * Run an AI tool on the selection: replace it, or add the result below it. Undo (⌘Z) reverts either.
   * The result is written in the selection's main language; `target` is the language to translate into.
   */
  const runTask = async (task: AiTask, target?: Lang) => {
    if (!editor || aiBusy) return
    if (!(await aiAvailable())) { toast('AI isn’t set up yet', 'Add GEMINI_API_KEY to the Supabase function secrets'); return }
    const { from, to } = editor.state.selection
    const word = singleWord(editor.state.doc, from, to)
    if (task.wordOnly && !word) return
    // where the result will go, at the selection's level (see lib/aiPlace)
    const plan = planAi(editor.state.doc, from, to, task.mode === 'after' ? 'after' : 'replace')
    const text = task.wordOnly ? wordInContext(editor.state.doc, from, word!) : plan.text
    if (!text.trim()) return
    const docBefore = editor.state.doc
    const opts = { lang: detectLanguage(text), target }
    const result = target ? `translated to ${LANGS[target]}` : task.result
    flags.current.aiBusy = true
    setAiBusy(target ? { ...task, busy: `Translating to ${LANGS[target]}…` } : task)
    try {
      if (task.mode !== 'choose' && aiTwoVersions()) {
        const outs = await runAiOptions(task.id, text, opts)
        flags.current.aiBusy = false
        if (editor.state.doc !== docBefore) { toast('The note changed while the AI was working', 'Select the text and try again'); return }
        if (!outs.length) { toast('The AI returned nothing', 'Try again'); return }
        const options = outs.map(o => resultContent(editor.schema, plan, o, task.heading))
        // only one distinct version: nothing to choose, so it goes straight in
        if (options.length === 1) { applyFresh(plan.from, plan.to, options[0], plan.to > plan.from ? editor.state.doc.slice(plan.from, plan.to) : null); setAiMode(false); return }
        editor.chain().command(({ tr }) => {
          showCompare(tr, { at: plan.at, from: plan.from, to: plan.to, dom: compareDom.current! })
          tr.setMeta(bubbleKey, 'hide')
          tr.setSelection(Selection.near(tr.doc.resolve(to), -1))
          return true
        }).run()
        setCompare({ task, result, options, previews: options.map(o => previewHtml(editor.schema, o)) })
        setAiMode(false)
        return
      }
      const out = await runAi(task.id, text, opts)
      flags.current.aiBusy = false
      if (editor.state.doc !== docBefore) { toast('The note changed while the AI was working', 'Select the text and try again'); return }
      if (task.mode === 'choose') {
        const options = parseChoices(out, word ?? '')
        if (!options.length) { toast('No similar words found'); return }
        setChoices({ word: word ?? '', from, to, options })
        return
      }
      applyFresh(plan.from, plan.to, resultContent(editor.schema, plan, out, task.heading), plan.to > plan.from ? editor.state.doc.slice(plan.from, plan.to) : null)
      setAiMode(false)
    } catch (e) {
      toast(`Couldn’t ${task.label.toLowerCase()}`, (e as Error).message)
    } finally {
      setAiBusy(null)
    }
  }

  /**
   * Put AI output at [from, to] (a range to replace, or a single point to insert at): HTML, or list items built
   * for that spot. It is marked as AI-written (saved with the note until you edit it) and highlighted as fresh,
   * and the cursor goes after it — a collapsed selection, so the toolbar closes.
   */
  const applyFresh = (from: number, to: number, content: string | Fragment, original: Slice | null) => {
    if (!editor) return
    const id = crypto.randomUUID()
    const chain = editor.chain().focus()
    const inserted = typeof content === 'string'
      ? chain.insertContentAt({ from, to }, content, { updateSelection: false })
      : chain.command(({ tr }) => { tr.replaceWith(from, to, content); return true })
    inserted.command(({ tr }) => {
      const start = tr.mapping.map(from, -1), end = tr.mapping.map(to, 1)
      tr.addMark(start, end, editor.schema.marks.aiText.create({ id }))
      tr.setMeta(AI_INSERT, true)
      markAiFresh(tr, start, end, original)
      tr.setMeta(bubbleKey, 'hide')
      tr.setSelection(Selection.near(tr.doc.resolve(end), -1))
      return true
    }).run()
  }

  /**
   * Use option `i`: the others fade and fold away, then it goes in where the comparison pointed, highlighted as
   * fresh — so it reads as settling into the note. The note unlocks.
   */
  const pickOption = (i: number) => {
    if (!editor || !compare || compare.picked !== undefined) return
    const content = compare.options[i]
    if (content === undefined) return
    const animate = document.documentElement.dataset.anim !== 'off'
    // fold the others from their real height, so the text below slides up rather than jumps
    compareDom.current?.querySelectorAll<HTMLElement>('.ai-option').forEach((el, j) => {
      if (j === i || !animate) return
      el.style.maxHeight = `${el.scrollHeight}px`
      void el.offsetHeight
      el.style.maxHeight = '0px'
    })
    setCompare({ ...compare, picked: i })
    window.setTimeout(() => {
      setCompare(null)
      const c = aiCompareKey.getState(editor.state)
      if (!c) return
      editor.setEditable(true, false)
      editor.view.dispatch(clearCompare(editor.state.tr))
      applyFresh(c.from, c.to, content, c.to > c.from ? editor.state.doc.slice(c.from, c.to) : null)
    }, animate ? OPTION_OUT_MS : 0)
  }
  /** Undo the whole AI operation: drop the versions, keep your text, unlock the note. */
  const cancelCompare = () => {
    if (!editor) return
    setCompare(null)
    editor.setEditable(true, false)
    if (aiCompareKey.getState(editor.state)) editor.view.dispatch(clearCompare(editor.state.tr))
    editor.commands.focus()
  }

  /** Swap the chosen word in, keeping the original's formatting (bold, highlight, link…). */
  const pickChoice = (option: string) => {
    if (!editor || !choices) return
    const { from, to } = choices
    const original = editor.state.doc.slice(from, to)
    editor.chain().focus().command(({ tr }) => {
      tr.insertText(option, from, to)
      markAiFresh(tr, from, from + option.length, original)
      tr.setMeta(bubbleKey, 'hide')
      return true
    }).setTextSelection(from + option.length).run()
    setChoices(null); setAiMode(false)
  }

  // the toolbar decides whether to show on editor changes, so it must read live flags, not a stale render's
  const bubbleKey = useRef(new PluginKey('noteBubble')).current
  const flags = useRef({ linkMode, aiBusy: !!aiBusy, choices: !!choices })
  flags.current = { linkMode, aiBusy: !!aiBusy, choices: !!choices }

  const addComment = () => {
    if (!editor) return
    const id = crypto.randomUUID()
    editor.chain().focus().setComment(id).run()
    onAddComment?.(id)
  }

  const keep = (e: React.MouseEvent) => e.preventDefault()   // buttons must not steal the editor's selection
  const stayTranslate = () => { if (translateTimer.current) { clearTimeout(translateTimer.current); translateTimer.current = null } }
  const closeTranslateSoon = () => { stayTranslate(); translateTimer.current = window.setTimeout(() => setTranslateAt(null), 250) }
  /** Show the language menu beside the Translate item (on its left when there's no room on the right). */
  const openTranslate = (item: HTMLElement) => {
    stayTranslate()
    const r = item.getBoundingClientRect(), width = 130
    setTranslateAt({ left: r.right + 4 + width < window.innerWidth ? r.right + 4 : Math.max(4, r.left - width - 4), top: r.top - 4 })
  }
  const label = (t: string) => isDailyTitle(t) ? prettyDate(t, true) : t
  const aiGroups = AI_TASKS.filter(t => !t.wordOnly || active?.word).reduce<[number, AiTask[]][]>((acc, t) => {
    const g = acc.find(([n]) => n === t.group)
    if (g) g[1].push(t); else acc.push([t.group, [t]])
    return acc
  }, [])
  // translate offers the two languages the selection isn't in
  const targets = translateAt && editor
    ? translateTargets(detectLanguage(selectionToText(editor.state.doc, editor.state.selection.from, editor.state.selection.to)))
    : []

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
        <BubbleMenu editor={editor} pluginKey={bubbleKey} className="bubble"
          shouldShow={({ editor: e, state }) => (!state.selection.empty || flags.current.linkMode || flags.current.aiBusy || flags.current.choices) && e.isEditable}>
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
                  {tasks.map(t => t.id === 'translate' ? (
                    <button key={t.id} role="menuitem" aria-haspopup="menu" aria-expanded={!!translateAt} className={'ai-item' + (translateAt ? ' open' : '')}
                      onMouseDown={keep} onMouseEnter={e => openTranslate(e.currentTarget)} onMouseLeave={closeTranslateSoon}
                      onClick={e => (translateAt ? setTranslateAt(null) : openTranslate(e.currentTarget))}>
                      {t.label}<ChevronRight size={14} className="ai-chev" />
                    </button>
                  ) : (
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
      {compare && compareDom.current && createPortal(
        <div className={'ai-compare' + (compare.picked !== undefined ? ' picking' : '')} role="group" aria-label={`AI: ${compare.result} — pick a version, or undo`}>
          {compare.previews.map((html, i) => {
            const tip = `AI: ${compare.result} · Option ${i + 1}`
            return (
              <div key={i} role="button" tabIndex={0} aria-label={`Use ${tip}`}
                className={'ai-option' + (compare.picked === i ? ' chosen' : compare.picked !== undefined ? ' gone' : '')}
                onMouseDown={e => e.preventDefault()} onClick={() => pickOption(i)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickOption(i) }
                  if (e.key === 'Escape') { e.preventDefault(); cancelCompare() }
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    const all = [...(compareDom.current?.querySelectorAll<HTMLElement>('.ai-option') ?? [])]
                    all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
                  }
                }}>
                <span className="ai-option-tip" aria-hidden>{tip}</span>
                <div className="ai-option-body note" dangerouslySetInnerHTML={{ __html: sanitize(html) }} />
              </div>
            )
          })}
          <button className="ai-compare-cancel" onMouseDown={e => e.preventDefault()} onClick={cancelCompare} title="Undo — keep my text (Esc)" aria-label="Undo, keep my text"><Undo2 size={14} /></button>
        </div>,
        compareDom.current,
      )}
      {badgeLayer.current && editor && undoBadges.length > 0 && createPortal(
        undoBadges.map(b => (
          <button key={b.id} className="ai-undo" style={{ left: b.x, top: b.y, animationDelay: `-${Math.min(AI_FRESH_MS, b.age) / 1000}s` }}
            title="Undo this AI change (⌘Z)" aria-label="Undo this AI change" onMouseDown={e => e.preventDefault()}
            onClick={() => editor.chain().focus().revertAiFresh(b.id).run()}>
            <Undo2 size={12} />
          </button>
        )),
        badgeLayer.current,
      )}
      {translateAt && aiMode && editor && createPortal(
        <div className="bubble ai-flyout" role="menu" aria-label="Translate to" style={{ left: translateAt.left, top: translateAt.top }}
          onMouseEnter={stayTranslate} onMouseLeave={closeTranslateSoon}>
          {targets.map(l => (
            <button key={l} role="menuitem" className="ai-item" lang={l} onMouseDown={keep} onClick={() => { setTranslateAt(null); runTask(AI_TASKS.find(t => t.id === 'translate')!, l) }}
              title="Replaces the selected text (⌘Z to undo)">{LANGS[l]}</button>
          ))}
        </div>,
        document.body,
      )}
      {hoverLink && editor && (
        <div className="unlink-pop" style={{ left: hoverLink.x, top: hoverLink.y }} onMouseEnter={clearHide} onMouseLeave={scheduleHide}>
          <button onMouseDown={e => e.preventDefault()} onClick={() => { unlinkElement(editor.view, hoverLink.el); setHoverLink(null) }}><Unlink size={13} /><span>Unlink</span></button>
        </div>
      )}
    </>
  )
}
