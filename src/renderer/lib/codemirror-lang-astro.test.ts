import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { highlightTree, tags } from '@lezer/highlight'
import { afterEach, describe, expect, it } from 'vitest'
import { astro, findFrontmatter } from './codemirror-lang-astro'

const SAMPLE = `---
import Icon from "./Icon.astro";
const name = "Faiz";
// peek clips the card
---
<div class="relative" data-state={state} {...props}>
  <span class="text">{name}</span>
  <Icon client:load />
  {flag && <span class="x">{name}</span>}
  {/* note */}
</div>
<style>
  .a { color: red; }
</style>
<script>
  const ready = true
</script>
`

function stylesFor(text: string): Map<string, string> {
  const tree = astro().language.parser.parse(text)
  const found = new Map<string, string>()
  highlightTree(
    tree,
    {
      style(tagSet) {
        const names: string[] = []
        for (const tag of tagSet) names.push(tag.name || String(tag.id))
        return names.join(' ')
      }
    },
    (from, to, style) => {
      const slice = text.slice(from, to)
      if (slice && !found.has(slice)) found.set(slice, style)
    }
  )
  return found
}

describe('findFrontmatter', () => {
  it('reads the script between fences', () => {
    const span = findFrontmatter('---\nconst n = 1\n---\n<div></div>\n')
    expect(span).not.toBeNull()
    expect('---\nconst n = 1\n---\n<div></div>\n'.slice(span!.contentFrom, span!.contentTo)).toBe(
      'const n = 1\n'
    )
  })

  it('accepts CRLF fences', () => {
    const text = '---\r\nconst n = 1\r\n---\r\n'
    const span = findFrontmatter(text)
    expect(text.slice(span!.contentFrom, span!.contentTo)).toBe('const n = 1\r\n')
  })

  it('returns null when the fence is not closed', () => {
    expect(findFrontmatter('---\nconst n = 1\n')).toBeNull()
    expect(findFrontmatter('<div></div>')).toBeNull()
  })
})

describe('astro syntax highlighting', () => {
  const styles = stylesFor(SAMPLE)

  it('colors the component script', () => {
    expect(styles.get('import')).toContain('moduleKeyword')
    expect(styles.get('"./Icon.astro"')).toContain('string')
    expect(styles.get('const')).toContain('definitionKeyword')
    expect(styles.get('"Faiz"')).toContain('string')
    expect(styles.get('// peek clips the card')).toContain('lineComment')
  })

  it('colors the HTML template, attributes, and expressions', () => {
    expect(styles.get('div')).toContain('tagName')
    expect(styles.get('class')).toContain('attributeName')
    expect(styles.get('"relative"')).toContain('attributeValue')
    expect(styles.get('client:load')).toContain('attributeName')
    expect(styles.get('state')).toContain('variableName')
    expect(styles.get('props')).toContain('variableName')
    expect(styles.get('name')).toContain('variableName')
    expect(styles.get('flag')).toContain('variableName')
    expect(styles.get('/* note */')).toContain('blockComment')
  })

  it('colors nested style and script', () => {
    expect(styles.get('color')).toContain('propertyName')
    expect(styles.get('ready')).toContain('variableName')
    expect(styles.get('true')).toContain('bool')
  })

  it('colors a fence-free script line the way a diff line is parsed', () => {
    const line = stylesFor('import Icon from "./Icon.astro"')
    expect(line.get('import')).toContain('moduleKeyword')
    expect(line.get('"./Icon.astro"')).toContain('string')
  })
})

describe('astro editor marks', () => {
  const containers: HTMLDivElement[] = []

  afterEach(() => {
    for (const container of containers.splice(0)) container.remove()
  })

  it('paints keyword, string, tag, and expression colors in the editor', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    containers.push(container)

    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: SAMPLE,
        extensions: [
          astro(),
          syntaxHighlighting(
            HighlightStyle.define([
              { tag: tags.keyword, color: '#c586c0' },
              { tag: tags.string, color: '#ce9178' },
              { tag: tags.tagName, color: '#569cd6' },
              { tag: tags.comment, color: '#6a9955' },
              { tag: tags.variableName, color: '#9cdcfe' },
              { tag: tags.attributeName, color: '#9cdcfe' }
            ])
          )
        ]
      })
    })

    const line = (snippet: string): string => {
      const match = [...view.dom.querySelectorAll('.cm-line')].find((node) =>
        node.textContent?.includes(snippet)
      )
      return match?.innerHTML ?? ''
    }

    expect(line('import Icon')).toContain('>import</span>')
    expect(line('import Icon')).toContain('>"./Icon.astro"</span>')
    expect(line('peek clips')).toContain('>// peek clips the card</span>')
    expect(line('data-state')).toContain('>div</span>')
    expect(line('data-state')).toContain('>class</span>')
    expect(line('data-state')).toContain('>state</span>')
    expect(line('{name}')).toContain('>name</span>')
    expect(line('client:load')).toContain('>client:load</span>')

    const css = [...document.querySelectorAll('style')]
      .map((node) => node.textContent ?? '')
      .join('\n')
    expect(css).toContain('#c586c0')
    expect(css).toContain('#ce9178')
    expect(css).toContain('#569cd6')
    expect(css).toContain('#6a9955')
    expect(css).toContain('#9cdcfe')
    view.destroy()
  })
})
