import { Extension, InputRule, type Editor } from '@tiptap/core'
import { PluginKey, TextSelection } from '@tiptap/pm/state'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'
import type { SuggestItem } from './wikilinkSuggest'

/** Journaling prompts: "/p" lists them (type words after it to filter), "/pr" drops in a random one. */
export const JOURNAL_PROMPTS = [
  'What am I avoiding feeling today?',
  'What would the simpler version look like?',
  'What does the tiny next step look like right now?',
  'What am I assuming here?',
  'What am I believing right now?',
  'What am I pretending not to know?',
  'What am I afraid might happen if I stop trying to control this?',
  'Whose validation feels important in the moment?',
  'What made you smile today?',
  'Wouldn’t it be great if…',
  'What would I like someone I love to understand about me?',
  'What am I unconsciously optimising for?',
  'If I didn’t have to sound reasonable or mature, what would I say?',
]

export const randomPrompt = () => JOURNAL_PROMPTS[Math.floor(Math.random() * JOURNAL_PROMPTS.length)]

/** Prompts matching what's typed after "/p" (every word must appear). */
export function matchPrompts(query: string): SuggestItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return JOURNAL_PROMPTS.filter(p => words.every(w => p.toLowerCase().includes(w))).map(title => ({ title, prompt: true }))
}

/**
 * Put `prompt` in the note in place of [from, to] (the "/p…" typed): on a line of its own, in bold, with an empty
 * line under it and the cursor there, ready for the answer. Typed at the end of a line with text, it goes below it.
 */
export function insertPrompt(editor: Editor, from: number, to: number, prompt: string) {
  editor.chain().focus().deleteRange({ from, to }).command(({ tr, state }) => {
    const { paragraph } = state.schema.nodes
    const question = paragraph.create(null, state.schema.text(prompt, [state.schema.marks.bold.create()]))
    const answer = paragraph.create()
    const $at = tr.selection.$from
    if (!$at.parent.isTextblock) return false
    const empty = $at.parent.content.size === 0
    const start = empty ? $at.before() : $at.after()
    tr.replaceWith(start, empty ? $at.after() : start, [question, answer])
    tr.setSelection(TextSelection.create(tr.doc, start + question.nodeSize + 1))
    return true
  }).run()
}

type PromptOptions = Pick<SuggestionOptions<SuggestItem>, 'render'>

export const JournalPrompts = Extension.create<PromptOptions>({
  name: 'journalPrompts',

  addOptions() { return { render: () => ({}) } },

  // "/pr": a random prompt at once
  addInputRules() {
    const editor = this.editor
    return [new InputRule({
      find: /(?:^|\s)(\/pr)$/,
      handler: ({ range, match }) => {
        const from = range.from + match[0].length - match[1].length
        // after the input rule has run, so the typed "r" is in the document
        setTimeout(() => insertPrompt(editor, from, from + 3, randomPrompt()), 0)
      },
    })]
  },

  addProseMirrorPlugins() {
    return [Suggestion<SuggestItem>({
      editor: this.editor,
      pluginKey: new PluginKey('journalPrompts'),
      char: '/p',
      allowSpaces: true,           // "/p afraid" filters by words
      items: ({ query }) => (query.startsWith('r') && !query.includes(' ') ? [] : matchPrompts(query)),
      command: ({ editor, range, props }) => insertPrompt(editor, range.from, range.to, props.title),
      render: this.options.render,
    })]
  },
})
