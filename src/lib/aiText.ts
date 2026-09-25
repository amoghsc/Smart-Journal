import { Mark, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { MarkType, Node as PMNode } from '@tiptap/pm/model'
import type { Score } from './aiScore'

/**
 * Text the AI wrote: a `<span data-ai="id">` saved with the note. Lines of it get a thin purple rule, and each
 * piece a ✦ in the margin with its AI share (see lib/aiScore): how much is still the AI's after your edits.
 * Your edits inside a piece stay part of it (that's what the score measures), and so does typing on at its end;
 * a new line is yours. Once none of the AI's wording is left, the marker goes (the span stays, harmlessly, so
 * undo brings it back).
 */

interface ScoreState { scores: Map<string, Score>; show: boolean }
interface State extends ScoreState { decos: DecorationSet }
const aiTextKey = new PluginKey<State>('aiText')

/** Hand the plugin fresh scores (and whether to show numbers). Not an edit: kept out of undo history. */
export function setAiScores(tr: Transaction, scores: Map<string, Score>, show: boolean) {
  return tr.setMeta(aiTextKey, { scores, show } satisfies ScoreState).setMeta('addToHistory', false)
}

const pct = (x: number) => `${Math.round(x * 100)}%`

function badge(id: string, score: Score | undefined, show: boolean): HTMLElement {
  const el = document.createElement('span')
  el.className = 'ai-score'
  el.contentEditable = 'false'
  el.dataset.aiPiece = id
  const star = document.createElement('span')
  star.className = 'ai-star'
  star.textContent = '✦'
  el.append(star)
  if (show && score) {
    const num = document.createElement('span')
    num.className = 'ai-pct'
    num.textContent = pct(score.ai)
    el.append(num)
  }
  el.dataset.tip = !show ? 'Written by AI'
    : !score ? 'Written by AI — working out the score…'
    : `AI share ${pct(score.ai)} · words ${pct(score.words)} · sentences ${pct(score.sentences)} · meaning ` +
      (score.meaning == null ? 'off' : pct(score.meaning) + (score.stale ? ' (updating…)' : ''))
  return el
}

/** Rules for lines that are all AI text, dotted underlines where it's part of a line, a badge where each piece starts. */
function build(doc: PMNode, type: MarkType, { scores, show }: ScoreState): DecorationSet {
  const decos: Decoration[] = []
  const seen = new Set<string>()
  const live = (id: string | undefined) => !!id && !scores.get(id)?.rewritten
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let total = 0, ai = 0
    const starts: string[] = []
    node.forEach(child => {
      const size = child.isText ? child.text!.length : 1
      total += size
      const id = child.marks.find(m => m.type === type)?.attrs.id as string | undefined
      if (!live(id)) return
      ai += size
      if (!seen.has(id!)) { seen.add(id!); starts.push(id!) }
    })
    if (!ai) return false
    decos.push(Decoration.node(pos, pos + node.nodeSize, { class: ai === total ? 'ai-block' : 'ai-part' }))
    starts.forEach((id, k) => {
      const s = scores.get(id)
      const label = show && s ? `${pct(s.ai)}|${s.stale}|${s.meaning}` : String(show)
      decos.push(Decoration.widget(pos + 1, () => {
        const el = badge(id, s, show)
        if (k) el.style.marginTop = `${k * 1.3}em`
        return el
      }, { side: -1, key: `ai-score-${id}-${label}-${k}`, ignoreSelection: true }))
    })
    return false
  })
  return DecorationSet.create(doc, decos)
}

export const AiText = Mark.create({
  name: 'aiText',
  // typing on at the end of a piece joins it; a new line doesn't
  inclusive: true,
  keepOnSplit: false,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: el => el.getAttribute('data-ai'),
        renderHTML: attrs => (attrs.id ? { 'data-ai': attrs.id } : {}),
      },
    }
  },
  parseHTML() { return [{ tag: 'span[data-ai]' }] },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { class: 'ai-text' }), 0] },

  addProseMirrorPlugins() {
    const type = this.type
    return [new Plugin<State>({
      key: aiTextKey,
      state: {
        init: (_, state) => { const s = { scores: new Map(), show: false }; return { ...s, decos: build(state.doc, type, s) } },
        apply: (tr, cur) => {
          const meta = tr.getMeta(aiTextKey) as ScoreState | undefined
          if (meta) return { ...meta, decos: build(tr.doc, type, meta) }
          return tr.docChanged ? { ...cur, decos: build(tr.doc, type, cur) } : cur
        },
      },
      props: { decorations: state => aiTextKey.getState(state)?.decos },
    })]
  },
})
