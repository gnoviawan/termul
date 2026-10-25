import { expect, test } from 'bun:test'
import { bundleTail } from './bundle-proxy'

test('bundle paths name a file under the bundle root', () => {
  expect(bundleTail('/canvas/cv1/tok/')).toBe('index.html')
  expect(bundleTail('/canvas/cv1/tok/app.js')).toBe('app.js')
  expect(bundleTail('/canvas/cv1/tok/fonts/a.woff2')).toBe('fonts/a.woff2')
})

test('API routes, short forms and escaping paths are not bundle files', () => {
  expect(bundleTail('/canvas/open')).toBeNull()
  expect(bundleTail('/canvas/read-document/x/y')).toBeNull()
  expect(bundleTail('/canvas/cv1/tok')).toBeNull()
  expect(bundleTail('/canvas/cv1/tok/../secret')).toBeNull()
  expect(bundleTail('/canvas/cv1/tok/a//b')).toBeNull()
  expect(bundleTail('/canvas/cv1/tok/c:\\x')).toBeNull()
  expect(bundleTail('/projects')).toBeNull()
})
