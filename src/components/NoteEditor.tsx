import { useEffect, useRef } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Bold, Italic, Unlink } from 'lucide-react'
import { NodeSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import Youtube from '@tiptap/extension-youtube'
import { EditorKeys, SwallowTab, Wikilink } from '../lib/wikilink'

interface Props {
  html: string
  onChange: (html: string) => void
  onOpenLink: (title: string) => void
  onCreatePage: (title: string) => void
  /** Canonical title of an existing page for the typed text (case-insensitive), else the text itself. */
  resolveTitle: (title: string) => string
  pickDate: (anchor?: { x: number; y: number }) => Promise<string | null>
  autoFocus?: boolean
}

/** Single-surface editor: what you type is what you see. Bullets, numbering, links, [[wikilinks]], YouTube paste. */
export function NoteEditor({ html, onChange, onOpenLink, onCreatePage, resolveTitle, pickDate, autoFocus }: Props) {
  // latest callbacks, readable from editor options that are captured once
  const open = useRef(onOpenLink); open.current = onOpenLink
  const create = useRef(onCreatePage); create.current = onCreatePage
  const change = useRef(onChange); change.current = onChange
  const resolve = useRef(resolveTitle); resolve.current = resolveTitle
  const date = useRef(pickDate); date.current = pickDate

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: true, autolink: true, linkOnPaste: true, HTMLAttributes: { target: '_blank', rel: 'noopener' } },
      }),
      Placeholder.configure({ placeholder: 'Write… "- " for bullets, "1. " for numbers, select a word and press [[ to link' }),
      Youtube.configure({ nocookie: true, width: 480, height: 270 }),
      Wikilink.configure({ resolve: t => resolve.current(t), onCreate: t => create.current(t), pickDate: a => date.current(a) }),
      EditorKeys,
      SwallowTab,
    ],
    content: html,
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: 'note', spellcheck: 'true' },
      // click a link: open it beside, and keep it selected here so the "unlink" menu shows
      handleClickOn: (view, _pos, node, nodePos) => {
        if (node.type.name !== 'wikilink') return false
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos)))
        open.current(node.attrs.title)
        return true
      },
    },
    onUpdate: ({ editor }) => change.current(editor.getHTML()),
  })

  // content changed elsewhere (another device / compile) while this editor is idle
  useEffect(() => {
    if (editor && !editor.isFocused && editor.getHTML() !== html) editor.commands.setContent(html, { emitUpdate: false })
  }, [html, editor])

  const active = useEditorState({ editor, selector: ({ editor: e }) => ({ bold: e?.isActive('bold') ?? false, italic: e?.isActive('italic') ?? false }) })

  return (
    <>
      {editor && (
        <BubbleMenu editor={editor} className="bubble" shouldShow={({ editor: e, state }) => !state.selection.empty && e.isEditable && !(state.selection instanceof NodeSelection)}>
          <div className="bubble-row">
            <button className={active?.bold ? 'on' : ''} title="Bold (⌘B)" onMouseDown={e => e.preventDefault()} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} /></button>
            <button className={active?.italic ? 'on' : ''} title="Italic (⌘I)" onMouseDown={e => e.preventDefault()} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} /></button>
          </div>
        </BubbleMenu>
      )}
      {editor && (
        <BubbleMenu editor={editor} className="bubble" shouldShow={({ state }) => state.selection instanceof NodeSelection && state.selection.node.type.name === 'wikilink'}>
          <div className="bubble-row">
            <button title="Remove link (keeps the word and the page)" onMouseDown={e => e.preventDefault()} onClick={() => editor.chain().focus().unsetWikilink().run()}><Unlink size={14} /><span>Unlink</span></button>
          </div>
        </BubbleMenu>
      )}
      <EditorContent editor={editor} className="note-wrap" />
    </>
  )
}
