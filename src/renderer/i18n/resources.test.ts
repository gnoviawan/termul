import { describe, expect, it } from 'vitest'
import { resources } from './resources'

type JsonObject = Record<string, unknown>

function leafKeys(value: JsonObject, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      return leafKeys(child as JsonObject, path)
    }
    return [path]
  })
}

describe('translation catalogs', () => {
  it('keeps English and Simplified Chinese namespace key sets aligned', () => {
    for (const namespace of Object.keys(resources.en) as Array<keyof typeof resources.en>) {
      expect(leafKeys(resources['zh-CN'][namespace])).toEqual(leafKeys(resources.en[namespace]))
    }
  })

  it('does not contain empty translations', () => {
    for (const language of Object.values(resources)) {
      for (const namespace of Object.values(language)) {
        for (const key of leafKeys(namespace)) {
          const value = key.split('.').reduce<unknown>((current, part) => {
            return (current as JsonObject)[part]
          }, namespace)
          expect(value).not.toBe('')
        }
      }
    }
  })
})
