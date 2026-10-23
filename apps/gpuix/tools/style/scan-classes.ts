/**
 * Counts the Tailwind class tokens Termul's renderer writes in className
 * attributes and cn()/cva()/clsx() calls, then reports how many of those
 * occurrences tw() turns into GPUIX styles.
 *
 *   bun tools/style/scan-classes.ts [--json out.json] [--top 60]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse } from '@babel/parser'
import { type ClassSupport, classifyClass } from '../../src/style/tw'

const REPO = resolve(import.meta.dir, '../../../..')
const RENDERER = join(REPO, 'src/renderer')
const CLASS_CALLS = new Set(['cn', 'cva', 'clsx', 'cx', 'twMerge', 'twJoin'])
const CLASS_ATTR = /^(className|class|[A-Za-z]+ClassName)$/
const CLASS_VAR = /(class|classes|classname|cls)$/i

type Node = { type: string; [key: string]: unknown }

function listTsx(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'test-utils' || name === 'node_modules') continue
      listTsx(path, out)
    } else if (name.endsWith('.tsx') && !/\.(test|spec|stories)\.tsx$/.test(name)) {
      out.push(path)
    }
  }
  return out
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'
}

/** String pieces of a class expression. Calls are skipped: the call visitor owns them. */
function collectStrings(node: unknown, out: string[]): void {
  if (!isNode(node)) return
  switch (node.type) {
    case 'StringLiteral':
      out.push(node.value as string)
      return
    case 'TemplateLiteral':
      ;(node.quasis as Node[]).forEach((quasi, i, all) => {
        let text = (quasi.value as { cooked?: string }).cooked ?? ''
        if (i > 0) text = text.replace(/^\S+/, '')
        if (i < all.length - 1) text = text.replace(/\S+$/, '')
        out.push(text)
      })
      for (const expr of node.expressions as Node[]) collectStrings(expr, out)
      return
    case 'ConditionalExpression':
      collectStrings(node.consequent, out)
      collectStrings(node.alternate, out)
      return
    case 'LogicalExpression':
      collectStrings(node.left, out)
      collectStrings(node.right, out)
      return
    case 'ArrayExpression':
      for (const el of node.elements as Node[]) collectStrings(el, out)
      return
    case 'JSXExpressionContainer':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'ParenthesizedExpression':
      collectStrings(node.expression, out)
      return
    case 'ObjectExpression':
      for (const prop of node.properties as Node[]) {
        if (prop.type !== 'ObjectProperty') continue
        const key = prop.key as Node
        if (key.type === 'StringLiteral') out.push(key.value as string)
        else if (key.type === 'Identifier' && prop.computed !== true)
          collectStrings(prop.value, out)
      }
      return
    default:
      return
  }
}

/** cva(base, { variants, compoundVariants }) without defaultVariants' variant names. */
function collectCva(args: Node[], out: string[]): void {
  collectStrings(args[0], out)
  const config = args[1]
  if (!isNode(config) || config.type !== 'ObjectExpression') return
  for (const prop of config.properties as Node[]) {
    const key = (prop.key as Node | undefined)?.name
    if (key === 'variants' && isNode(prop.value) && prop.value.type === 'ObjectExpression') {
      for (const variant of prop.value.properties as Node[]) {
        if (!isNode(variant.value) || variant.value.type !== 'ObjectExpression') continue
        for (const option of variant.value.properties as Node[]) collectStrings(option.value, out)
      }
    }
    if (key === 'compoundVariants' && isNode(prop.value)) {
      for (const entry of (prop.value.elements as Node[]) ?? []) {
        for (const field of (entry.properties as Node[]) ?? []) {
          const name = (field.key as Node).name
          if (name === 'className' || name === 'class') collectStrings(field.value, out)
        }
      }
    }
  }
}

function visit(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, out)
    return
  }
  if (!isNode(node)) return
  if (node.type === 'JSXAttribute') {
    const name = (node.name as Node).name
    if (typeof name === 'string' && CLASS_ATTR.test(name)) collectStrings(node.value, out)
  } else if (node.type === 'CallExpression') {
    const callee = node.callee as Node
    if (callee.type === 'Identifier' && CLASS_CALLS.has(callee.name as string)) {
      const args = node.arguments as Node[]
      if (callee.name === 'cva') collectCva(args, out)
      else for (const arg of args) collectStrings(arg, out)
    }
  } else if (node.type === 'VariableDeclarator') {
    const id = node.id as Node
    if (id.type === 'Identifier' && CLASS_VAR.test(id.name as string))
      collectStrings(node.init, out)
  } else if (node.type === 'ObjectProperty') {
    const key = node.key as Node
    const name = key.type === 'Identifier' ? key.name : key.value
    if (typeof name === 'string' && CLASS_ATTR.test(name)) collectStrings(node.value, out)
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue
    if (typeof child === 'object' && child !== null) visit(child, out)
  }
}

export interface ScanResult {
  files: number
  occurrences: number
  counts: Map<string, number>
}

export function scanRenderer(): ScanResult {
  const counts = new Map<string, number>()
  const files = listTsx(RENDERER)
  let occurrences = 0
  for (const file of files) {
    const strings: string[] = []
    const ast = parse(readFileSync(file, 'utf8'), {
      sourceType: 'module',
      plugins: ['typescript', 'jsx']
    })
    visit(ast.program, strings)
    for (const token of strings.join(' ').split(/\s+/)) {
      if (!token) continue
      occurrences += 1
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
  }
  return { files: files.length, occurrences, counts }
}

function main(): void {
  const args = process.argv.slice(2)
  const top = Number(args[args.indexOf('--top') + 1]) || 60
  const jsonPath = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined
  const { files, occurrences, counts } = scanRenderer()
  const bySupport: Record<ClassSupport['kind'], number> = {
    supported: 0,
    approximate: 0,
    unsupported: 0,
    unknown: 0
  }
  const misses = new Map<string, { count: number; support: ClassSupport }>()
  for (const [token, count] of counts) {
    const support = classifyClass(token)
    bySupport[support.kind] += count
    if (support.kind !== 'supported') misses.set(token, { count, support })
  }
  const pct = (n: number) => `${((100 * n) / occurrences).toFixed(1)}%`
  const sorted = [...counts].sort((a, b) => b[1] - a[1])
  console.log(`files ${files}  occurrences ${occurrences}  distinct ${counts.size}`)
  console.log(
    `tw coverage: supported ${bySupport.supported} (${pct(bySupport.supported)})  ` +
      `approximate ${bySupport.approximate} (${pct(bySupport.approximate)})  ` +
      `unsupported ${bySupport.unsupported} (${pct(bySupport.unsupported)})  ` +
      `unknown ${bySupport.unknown} (${pct(bySupport.unknown)})`
  )
  console.log(`\ntop ${top} tokens:`)
  for (const [token, count] of sorted.slice(0, top)) {
    console.log(`${String(count).padStart(6)}  ${token}  ${classifyClass(token).kind}`)
  }
  const missSorted = [...misses].sort((a, b) => b[1].count - a[1].count)
  console.log(`\ntop ${top} misses:`)
  for (const [token, { count, support }] of missSorted.slice(0, top)) {
    const why = support.kind === 'supported' ? '' : support.reason
    console.log(`${String(count).padStart(6)}  ${token}  ${support.kind}: ${why}`)
  }
  if (jsonPath) {
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          files,
          occurrences,
          distinct: counts.size,
          coverage: bySupport,
          tokens: sorted.map(([token, count]) => ({ token, count, ...classifyClass(token) }))
        },
        null,
        1
      )
    )
    console.log(`\nwrote ${relative(process.cwd(), jsonPath)}`)
  }
}

if (import.meta.main) main()
