import { describe, expect, it } from 'vitest'
import { parseBaseArgsInput } from '@/lib/agents/parse-base-args'

describe('parseBaseArgsInput', () => {
	it('preserves quoted paths with spaces', () => {
		expect(parseBaseArgsInput('--config "C:\\path with space\\cfg.json"')).toEqual([
			'--config',
			'C:\\path with space\\cfg.json',
		])
	})

	it('splits unquoted tokens on whitespace', () => {
		expect(parseBaseArgsInput('-i --verbose')).toEqual(['-i', '--verbose'])
	})

	it('preserves empty quoted tokens', () => {
		expect(parseBaseArgsInput('""')).toEqual([''])
		expect(parseBaseArgsInput("''")).toEqual([''])
		expect(parseBaseArgsInput('--flag ""')).toEqual(['--flag', ''])
	})
})
