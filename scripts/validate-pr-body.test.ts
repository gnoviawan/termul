import { describe, expect, it } from 'vitest'
import { validatePrBody } from './validate-pr-body'

// A fully, correctly filled template.
const validBody = `## Summary

This fixes a crash when opening the settings page with no saved layout.

## Related Issue

Closes #123

## Type of Change

- [x] fix: bug fix

## What Changed

- Guard against undefined layout in SettingsLayout
- Add fallback default config

## How It Was Tested

- [x] \`bun run test\`
- [x] Manual verification completed

## Checklist

- [x] My PR title follows the conventional commit format used by this repo
`

describe('validatePrBody', () => {
  it('passes a fully filled template', () => {
    const result = validatePrBody(validBody)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('rejects an empty body', () => {
    const result = validatePrBody('')
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/empty/i)
  })

  it('rejects undefined body', () => {
    expect(validatePrBody(undefined).ok).toBe(false)
  })

  it('flags an empty Summary with only a bare bullet', () => {
    const body = validBody.replace(
      'This fixes a crash when opening the settings page with no saved layout.',
      '-'
    )
    const result = validatePrBody(body)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => /Summary.*empty/i.test(e))).toBe(true)
  })

  it('treats HTML-comment-only sections as empty', () => {
    const body = validBody.replace(
      '## Summary\n\nThis fixes a crash when opening the settings page with no saved layout.',
      '## Summary\n\n<!-- describe here -->'
    )
    const result = validatePrBody(body)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => /Summary/i.test(e))).toBe(true)
  })

  it('requires a linked issue or an explicit no-issue note', () => {
    const body = validBody.replace('Closes #123', 'Closes #')
    const result = validatePrBody(body)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => /Related Issue/i.test(e))).toBe(true)
  })

  it('accepts an explicit "no related issue" explanation', () => {
    const body = validBody.replace('Closes #123', 'No related issue — internal tooling tweak.')
    const result = validatePrBody(body)
    expect(result.errors.some((e) => /Related Issue/i.test(e))).toBe(false)
  })

  it('accepts Fixes/Resolves keywords', () => {
    expect(
      validatePrBody(validBody.replace('Closes #123', 'Fixes #99')).errors.some((e) =>
        /Related Issue/i.test(e)
      )
    ).toBe(false)
    expect(
      validatePrBody(validBody.replace('Closes #123', 'Resolves #99')).errors.some((e) =>
        /Related Issue/i.test(e)
      )
    ).toBe(false)
  })

  it('requires at least one Type of Change box checked', () => {
    const body = validBody.replace('- [x] fix: bug fix', '- [ ] fix: bug fix')
    const result = validatePrBody(body)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => /Type of Change/i.test(e))).toBe(true)
  })

  it('requires non-empty What Changed', () => {
    const body = validBody.replace(
      '- Guard against undefined layout in SettingsLayout\n- Add fallback default config',
      '-'
    )
    const result = validatePrBody(body)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => /What Changed/i.test(e))).toBe(true)
  })

  it('requires at least one How It Was Tested box checked', () => {
    const body = validBody
      .replace('- [x] `bun run test`', '- [ ] `bun run test`')
      .replace('- [x] Manual verification completed', '- [ ] Manual verification completed')
    const result = validatePrBody(body)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => /How It Was Tested/i.test(e))).toBe(true)
  })

  it('reports missing sections when the template is gutted', () => {
    const result = validatePrBody('Just some random text with no headings.')
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(5)
  })

  it('handles CRLF line endings', () => {
    const result = validatePrBody(validBody.replace(/\n/g, '\r\n'))
    expect(result.ok).toBe(true)
  })

  it('validates a required section even when it is the last one in the body', () => {
    // Body where "How It Was Tested" is the final section (no trailing heading).
    const body = `## Summary

Real summary text.

## Related Issue

Closes #1

## Type of Change

- [x] fix: bug fix

## What Changed

- did a thing

## How It Was Tested

- [ ] \`bun run test\`
`
    const result = validatePrBody(body)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => /How It Was Tested/i.test(e))).toBe(true)
  })
})
