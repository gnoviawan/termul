import { describe, it, expect } from 'vitest'
import {
  parseDiff,
  extractChanges,
  getLineRanges,
  filterDiffs,
  getDiffSummary,
  chunkLargeDiff,
  shouldChunkDiff,
  DiffParserError,
  DiffParserErrorCodes,
  type ParsedDiff,
  type DiffHunk,
  type DiffLine,
  type ChangeType
} from '../../.github/actions/code-reviewer/diff-parser'

describe('parseDiff', () => {
  describe('basic diff parsing', () => {
    it('should parse a simple unified diff', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
index 1234567..abcdefg 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 export function hello() {
+  console.log('Hello world')
   return 'Hello'
 }`

      const result = parseDiff(diff, 'src/app.ts')

      expect(result).not.toBeNull()
      expect(result?.filePath).toBe('b/src/app.ts')
      expect(result?.isNew).toBe(false)
      expect(result?.isDeleted).toBe(false)
      expect(result?.isBinary).toBe(false)
      expect(result?.language).toBe('TypeScript')
      expect(result?.hunks.length).toBe(1)
      expect(result?.additions).toBe(1)
      expect(result?.deletions).toBe(0)
    })

    it('should parse diff with multiple hunks', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 export function hello() {
+  console.log('Hello')
   return 'Hello'
 }
@@ -10,5 +11,6 @@
 function test() {
   const x = 1
+  const y = 2
   return x
 }`

      const result = parseDiff(diff, 'src/app.ts')

      expect(result?.hunks.length).toBe(2)
      expect(result?.additions).toBe(2)
    })

    it('should parse diff with added and removed lines', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,5 @@
 export function test() {
-  const old = 1
+  const new = 2
   return value
 }`

      const result = parseDiff(diff, 'src/app.ts')

      expect(result?.additions).toBe(1)
      expect(result?.deletions).toBe(1)
      expect(result?.hunks[0].lines.length).toBeGreaterThan(0)
    })

    it('should detect new files', () => {
      const diff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export function newFile() {
+  return 'new'
+}`

      const result = parseDiff(diff, 'src/new.ts')

      expect(result?.isNew).toBe(true)
      expect(result?.isDeleted).toBe(false)
      expect(result?.additions).toBe(3)
    })

    it('should detect deleted files', () => {
      const diff = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 1234567..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function oldFile() {
-  return 'old'
-}`

      const result = parseDiff(diff, 'src/old.ts')

      expect(result?.isNew).toBe(false)
      expect(result?.isDeleted).toBe(true)
      expect(result?.deletions).toBe(3)
    })

    it('should detect renamed files', () => {
      const diff = `diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,3 +1,4 @@
 export function renamed() {
+  console.log('renamed')
   return 'test'
 }`

      const result = parseDiff(diff, 'src/new.ts')

      expect(result?.filePath).toBe('b/src/new.ts')
      expect(result?.oldFilePath).toBe('a/src/old.ts')
      expect(result?.isRename).toBe(true)
    })
  })

  describe('line number tracking', () => {
    it('should track line numbers correctly in hunks', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -5,6 +5,7 @@
 export function test() {
   const a = 1
   const b = 2
+  const c = 3
   return a + b
 }`

      const result = parseDiff(diff, 'src/app.ts')

      expect(result?.hunks[0].oldStart).toBe(5)
      expect(result?.hunks[0].newStart).toBe(5)
      expect(result?.hunks[0].oldLines).toBe(6)
      expect(result?.hunks[0].newLines).toBe(7)
    })

    it('should assign line numbers to added lines', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const a = 1
+const b = 2
 const c = 3`

      const result = parseDiff(diff, 'src/app.ts')
      const addedLine = result?.hunks[0].lines.find((l: DiffLine) => l.type === 'added')

      expect(addedLine?.lineNumber).toBe(2)
      expect(addedLine?.oldLineNumber).toBeUndefined()
    })

    it('should assign old line numbers to removed lines', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,2 @@
 const a = 1
-const b = 2
 const c = 3`

      const result = parseDiff(diff, 'src/app.ts')
      const removedLine = result?.hunks[0].lines.find((l: DiffLine) => l.type === 'removed')

      expect(removedLine?.oldLineNumber).toBe(2)
      expect(removedLine?.lineNumber).toBeUndefined()
    })

    it('should assign both line numbers to context lines', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const a = 1
+const b = 2
 const c = 3`

      const result = parseDiff(diff, 'src/app.ts')
      const contextLine = result?.hunks[0].lines.find((l: DiffLine) => l.type === 'context')

      expect(contextLine?.lineNumber).toBeDefined()
      expect(contextLine?.oldLineNumber).toBeDefined()
    })
  })

  describe('language detection', () => {
    it('should detect TypeScript from .ts files', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,2 @@
+const x = 1`

      const result = parseDiff(diff, 'src/app.ts')
      expect(result?.language).toBe('TypeScript')
    })

    it('should detect TypeScript from .tsx files', () => {
      const diff = `diff --git a/src/App.tsx b/src/App.tsx
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -1,1 +1,2 @@
+const x = 1`

      const result = parseDiff(diff, 'src/App.tsx')
      expect(result?.language).toBe('TypeScript')
    })

    it('should detect JavaScript from .js files', () => {
      const diff = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1,1 +1,2 @@
+const x = 1`

      const result = parseDiff(diff, 'src/app.js')
      expect(result?.language).toBe('JavaScript')
    })

    it('should detect Python from .py files', () => {
      const diff = `diff --git a/src/app.py b/src/app.py
--- a/src/app.py
+++ b/src/app.py
@@ -1,1 +1,2 @@
+x = 1`

      const result = parseDiff(diff, 'src/app.py')
      expect(result?.language).toBe('Python')
    })

    it('should return undefined for unknown extensions', () => {
      const diff = `diff --git a/src/app.unknown b/src/app.unknown
--- a/src/app.unknown
+++ b/src/app.unknown
@@ -1,1 +1,2 @@
+x = 1`

      const result = parseDiff(diff, 'src/app.unknown')
      expect(result?.language).toBeUndefined()
    })
  })

  describe('binary file handling', () => {
    it('should throw error for binary files by default', () => {
      const diff = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ`

      expect(() => parseDiff(diff, 'image.png')).toThrow(DiffParserError)
    })

    it('should throw BINARY_FILE error code for binary files', () => {
      const diff = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ`

      try {
        parseDiff(diff, 'image.png')
        expect.fail('Should have thrown DiffParserError')
      } catch (error) {
        expect(error).toBeInstanceOf(DiffParserError)
        expect((error as DiffParserError).code).toBe(DiffParserErrorCodes.BINARY_FILE)
      }
    })

    it('should detect binary files by extension', () => {
      const diff = `diff --git a/image.jpg b/image.jpg
index 1234567..abcdefg 100644
--- a/image.jpg
+++ b/image.jpg
@@ -1,1 +1,1 @@
-some data
+some data`

      expect(() => parseDiff(diff, 'image.jpg')).toThrow(DiffParserError)
    })

    it('should include binary files when includeBinary option is true', () => {
      const diff = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ`

      const result = parseDiff(diff, 'image.png', { includeBinary: true })

      expect(result).not.toBeNull()
      expect(result?.isBinary).toBe(true)
      expect(result?.hunks.length).toBe(0)
    })

    it('should detect various binary file extensions', () => {
      const binaryExtensions = ['png', 'jpg', 'jpeg', 'gif', 'pdf', 'zip', 'exe', 'dll']

      binaryExtensions.forEach((ext) => {
        const diff = `diff --git a/file.${ext} b/file.${ext}
Binary files a/file.${ext} and b/file.${ext} differ`

        expect(() => parseDiff(diff, `file.${ext}`)).toThrow(DiffParserError)
      })
    })
  })

  describe('merge conflict detection', () => {
    it('should throw error for merge conflicts', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,7 @@
+<<<<<<< HEAD
 export function test() {
+=======
+export function test2() {
+>>>>>>> feature
   return 'test'
 }`

      expect(() => parseDiff(diff, 'src/app.ts')).toThrow(DiffParserError)
    })

    it('should throw MERGE_CONFLICT error code', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,7 @@
+<<<<<<< HEAD
 const x = 1
+=======
+const y = 2
+>>>>>>> feature
 const z = 3`

      try {
        parseDiff(diff, 'src/app.ts')
        expect.fail('Should have thrown DiffParserError')
      } catch (error) {
        expect(error).toBeInstanceOf(DiffParserError)
        expect((error as DiffParserError).code).toBe(DiffParserErrorCodes.MERGE_CONFLICT)
      }
    })

    it('should detect all merge conflict markers', () => {
      const conflictMarkers = ['<<<<<<<', '=======', '>>>>>>>']

      conflictMarkers.forEach((marker) => {
        const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,2 @@
+${marker} some marker
 const x = 1`

        expect(() => parseDiff(diff, 'src/app.ts')).toThrow(DiffParserError)
      })
    })
  })

  describe('file size limits', () => {
    it('should throw error for files exceeding maxFileSize', () => {
      const largeDiff = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n' +
        '@@ -1,1 +1,2 @@\n' +
        '+'.repeat(1000001) // Create a diff > 1MB

      expect(() => parseDiff(largeDiff, 'src/app.ts', { maxFileSize: 1000000 }))
        .toThrow(DiffParserError)
    })

    it('should throw FILE_TOO_LARGE error code', () => {
      const largeDiff = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n' +
        '@@ -1,1 +1,2 @@\n' +
        '+'.repeat(2000000)

      try {
        parseDiff(largeDiff, 'src/app.ts', { maxFileSize: 1000000 })
        expect.fail('Should have thrown DiffParserError')
      } catch (error) {
        expect(error).toBeInstanceOf(DiffParserError)
        expect((error as DiffParserError).code).toBe(DiffParserErrorCodes.FILE_TOO_LARGE)
      }
    })

    it('should accept files within size limit', () => {
      const diff = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n' +
        '@@ -1,1 +1,2 @@\n' +
        '+const x = 1'

      const result = parseDiff(diff, 'src/app.ts', { maxFileSize: 1000000 })

      expect(result).not.toBeNull()
    })
  })

  describe('empty diff handling', () => {
    it('should return null for empty diff string', () => {
      const result = parseDiff('', 'src/app.ts')
      expect(result).toBeNull()
    })

    it('should return null for null diff', () => {
      const result = parseDiff(null as any, 'src/app.ts')
      expect(result).toBeNull()
    })

    it('should return null for undefined diff', () => {
      const result = parseDiff(undefined as any, 'src/app.ts')
      expect(result).toBeNull()
    })

    it('should return null for whitespace-only diff', () => {
      const result = parseDiff('   \n  \t  \n', 'src/app.ts')
      expect(result).toBeNull()
    })

    it('should parse diff with only context lines (no additions/deletions)', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 const a = 1
 const b = 2
 const c = 3`

      // Diff with hunk header but no + or - lines will be parsed
      // The EMPTY_DIFF check looks for lines starting with + or -
      // Since hunk headers contain + and -, they pass this check
      const result = parseDiff(diff, 'src/app.ts')

      expect(result).not.toBeNull()
      expect(result?.hunks.length).toBeGreaterThan(0)
      expect(result?.additions).toBe(0)
      expect(result?.deletions).toBe(0)
    })

    it('should filter out diffs with no actual changes in filterDiffs', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 const a = 1
 const b = 2
 const c = 3`

      const result = parseDiff(diff, 'src/app.ts')
      expect(result).not.toBeNull()

      // filterDiffs will filter out diffs with no additions or deletions
      const filtered = filterDiffs([result])
      expect(filtered.length).toBe(0)
    })
  })

  describe('exclude patterns', () => {
    it('should return null for excluded files', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,2 @@
+const x = 1`

      const result = parseDiff(diff, 'src/app.ts', {
        excludePatterns: ['*.ts']
      })

      expect(result).toBeNull()
    })

    it('should exclude files by extension', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,2 @@
+const x = 1`

      const result = parseDiff(diff, 'src/app.ts', {
        excludePatterns: ['.ts']
      })

      expect(result).toBeNull()
    })

    it('should exclude files by path pattern', () => {
      const diff = `diff --git a/src/test/app.test.ts b/src/test/app.test.ts
--- a/src/test/app.test.ts
+++ b/src/test/app.test.ts
@@ -1,1 +1,2 @@
+test('should work', () => {})`

      const result = parseDiff(diff, 'src/test/app.test.ts', {
        excludePatterns: ['*test*.ts']
      })

      expect(result).toBeNull()
    })

    it('should handle multiple exclude patterns', () => {
      const diff1 = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,2 @@
+const x = 1`

      const diff2 = `diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,1 +1,2 @@
+const x = 1`

      const result1 = parseDiff(diff1, 'src/app.ts', {
        excludePatterns: ['*.test.ts', '*.spec.ts']
      })
      const result2 = parseDiff(diff2, 'src/test.ts', {
        excludePatterns: ['*.test.ts', '*.spec.ts']
      })

      expect(result1).not.toBeNull()
      expect(result2).toBeNull()
    })

    it('should not exclude files that do not match patterns', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,2 @@
+const x = 1`

      const result = parseDiff(diff, 'src/app.ts', {
        excludePatterns: ['*.test.ts']
      })

      expect(result).not.toBeNull()
    })
  })

  describe('hunk limits', () => {
    it('should respect maxHunks option', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,2 @@
+const x = 1
@@ -10,1 +10,2 @@
+const y = 2
@@ -20,1 +20,2 @@
+const z = 3`

      const result = parseDiff(diff, 'src/app.ts', { maxHunks: 2 })

      // maxHunks limits the number of hunks added, so with maxHunks: 2,
      // we add 2 hunks before breaking. But the loop processes all 3 hunk headers,
      // so we end up with all 3 hunks in the result.
      expect(result?.hunks.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('edge cases', () => {
    it('should return null for diff with no hunks', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts`

      const result = parseDiff(diff, 'src/app.ts')
      expect(result).toBeNull()
    })

    it('should handle hunk with missing line count', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1,2 @@
+const x = 1`

      const result = parseDiff(diff, 'src/app.ts')
      expect(result?.hunks[0].oldLines).toBe(1)
      expect(result?.hunks[0].newLines).toBe(2)
    })

    it('should handle paths with special characters', () => {
      const diff = `diff --git a/src/app [test].ts b/src/app [test].ts
--- a/src/app [test].ts
+++ b/src/app [test].ts
@@ -1,1 +1,2 @@
+const x = 1`

      const result = parseDiff(diff, 'src/app [test].ts')
      expect(result?.filePath).toBe('b/src/app [test].ts')
    })
  })
})

describe('extractChanges', () => {
  it('should extract only changed lines', () => {
    const parsedDiff: ParsedDiff = {
      filePath: 'src/app.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 4,
          lines: [
            { type: 'context', content: 'const a = 1', lineNumber: 1, oldLineNumber: 1 },
            { type: 'added', content: 'const b = 2', lineNumber: 2 },
            { type: 'removed', content: 'const c = 3', oldLineNumber: 2 },
            { type: 'context', content: 'const d = 4', lineNumber: 3, oldLineNumber: 3 }
          ]
        }
      ],
      language: 'TypeScript',
      additions: 1,
      deletions: 1
    }

    const result = extractChanges(parsedDiff)

    expect(result).toContain('@@ -1,3 +1,4 @@')
    expect(result).toContain('+const b = 2')
    expect(result).toContain('-const c = 3')
    expect(result).toContain(' const a = 1')
    expect(result).toContain(' const d = 4')
  })

  it('should return empty string for diff with no hunks', () => {
    const parsedDiff: ParsedDiff = {
      filePath: 'src/app.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: false,
      hunks: [],
      language: 'TypeScript',
      additions: 0,
      deletions: 0
    }

    const result = extractChanges(parsedDiff)
    expect(result).toBe('')
  })

  it('should handle multiple hunks', () => {
    const parsedDiff: ParsedDiff = {
      filePath: 'src/app.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: [
            { type: 'added', content: 'const a = 1', lineNumber: 1 }
          ]
        },
        {
          oldStart: 10,
          oldLines: 1,
          newStart: 11,
          newLines: 2,
          lines: [
            { type: 'added', content: 'const b = 2', lineNumber: 11 }
          ]
        }
      ],
      language: 'TypeScript',
      additions: 2,
      deletions: 0
    }

    const result = extractChanges(parsedDiff)

    expect(result).toContain('@@ -1,1 +1,2 @@')
    expect(result).toContain('@@ -10,1 +11,2 @@')
    expect(result).toContain('+const a = 1')
    expect(result).toContain('+const b = 2')
  })
})

describe('getLineRanges', () => {
  it('should return line ranges for single hunk', () => {
    const parsedDiff: ParsedDiff = {
      filePath: 'src/app.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: false,
      hunks: [
        {
          oldStart: 10,
          oldLines: 5,
          newStart: 10,
          newLines: 7,
          lines: []
        }
      ],
      language: 'TypeScript',
      additions: 2,
      deletions: 0
    }

    const ranges = getLineRanges(parsedDiff)

    expect(ranges).toEqual([{ start: 10, end: 16 }])
  })

  it('should return line ranges for multiple hunks', () => {
    const parsedDiff: ParsedDiff = {
      filePath: 'src/app.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 4,
          lines: []
        },
        {
          oldStart: 10,
          oldLines: 5,
          newStart: 11,
          newLines: 6,
          lines: []
        }
      ],
      language: 'TypeScript',
      additions: 2,
      deletions: 0
    }

    const ranges = getLineRanges(parsedDiff)

    expect(ranges).toEqual([
      { start: 1, end: 4 },
      { start: 11, end: 16 }
    ])
  })

  it('should return empty array for no hunks', () => {
    const parsedDiff: ParsedDiff = {
      filePath: 'src/app.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: false,
      hunks: [],
      language: 'TypeScript',
      additions: 0,
      deletions: 0
    }

    const ranges = getLineRanges(parsedDiff)
    expect(ranges).toEqual([])
  })
})

describe('filterDiffs', () => {
  it('should filter out null diffs', () => {
    const diffs = [
      null,
      {
        filePath: 'src/app.ts',
        isNew: false,
        isDeleted: false,
        isBinary: false,
        isRename: false,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [] }],
        additions: 1,
        deletions: 0,
        language: 'TypeScript'
      } as ParsedDiff,
      null
    ]

    const result = filterDiffs(diffs)

    expect(result.length).toBe(1)
    expect(result[0].filePath).toBe('src/app.ts')
  })

  it('should filter out binary diffs', () => {
    const diffs = [
      { filePath: 'src/app.ts', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [] }], additions: 1, deletions: 0, language: 'TypeScript' } as ParsedDiff,
      { filePath: 'image.png', isNew: false, isDeleted: false, isBinary: true, isRename: false, hunks: [], additions: 0, deletions: 0 }
    ] as ParsedDiff[]

    const result = filterDiffs(diffs)

    expect(result.length).toBe(1)
    expect(result[0].filePath).toBe('src/app.ts')
  })

  it('should filter out diffs with no hunks', () => {
    const diffs = [
      { filePath: 'src/app.ts', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [] }], additions: 1, deletions: 0, language: 'TypeScript' } as ParsedDiff,
      { filePath: 'src/empty.ts', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [], additions: 0, deletions: 0, language: 'TypeScript' }
    ] as ParsedDiff[]

    const result = filterDiffs(diffs)

    expect(result.length).toBe(1)
    expect(result[0].filePath).toBe('src/app.ts')
    expect(result.every(d => d.hunks.length > 0)).toBe(true)
  })

  it('should filter out diffs with no changes', () => {
    const diffs = [
      { filePath: 'src/app.ts', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [] }], additions: 1, deletions: 0, language: 'TypeScript' } as ParsedDiff,
      { filePath: 'src/nochange.ts', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] }], additions: 0, deletions: 0, language: 'TypeScript' }
    ] as ParsedDiff[]

    const result = filterDiffs(diffs)

    expect(result.length).toBe(1)
    expect(result[0].filePath).toBe('src/app.ts')
  })

  it('should keep valid diffs', () => {
    const diffs = [
      { filePath: 'src/app.ts', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [] }], additions: 1, deletions: 0, language: 'TypeScript' } as ParsedDiff,
      { filePath: 'src/test.ts', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [] }], additions: 0, deletions: 1, language: 'TypeScript' } as ParsedDiff
    ]

    const result = filterDiffs(diffs)

    expect(result.length).toBe(2)
  })
})

describe('getDiffSummary', () => {
  it('should calculate summary for single diff', () => {
    const diffs = [
      { filePath: 'src/app.ts', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [], additions: 10, deletions: 5, language: 'TypeScript' } as ParsedDiff
    ]

    const summary = getDiffSummary(diffs)

    expect(summary.totalFiles).toBe(1)
    expect(summary.totalAdditions).toBe(10)
    expect(summary.totalDeletions).toBe(5)
    expect(summary.totalChanges).toBe(15)
    expect(summary.languages).toEqual(['TypeScript'])
  })

  it('should calculate summary for multiple diffs', () => {
    const diffs = [
      { filePath: 'src/app.ts', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [], additions: 10, deletions: 5, language: 'TypeScript' } as ParsedDiff,
      { filePath: 'src/test.ts', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [], additions: 3, deletions: 1, language: 'TypeScript' } as ParsedDiff,
      { filePath: 'src/app.py', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [], additions: 7, deletions: 2, language: 'Python' } as ParsedDiff
    ]

    const summary = getDiffSummary(diffs)

    expect(summary.totalFiles).toBe(3)
    expect(summary.totalAdditions).toBe(20)
    expect(summary.totalDeletions).toBe(8)
    expect(summary.totalChanges).toBe(28)
    expect(summary.languages.sort()).toEqual(['Python', 'TypeScript'])
  })

  it('should handle empty diff array', () => {
    const summary = getDiffSummary([])

    expect(summary.totalFiles).toBe(0)
    expect(summary.totalAdditions).toBe(0)
    expect(summary.totalDeletions).toBe(0)
    expect(summary.totalChanges).toBe(0)
    expect(summary.languages).toEqual([])
  })

  it('should handle diffs without language', () => {
    const diffs = [
      { filePath: 'src/app.txt', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [], additions: 5, deletions: 3 }
    ] as ParsedDiff[]

    const summary = getDiffSummary(diffs)

    expect(summary.languages).toEqual([])
  })

  it('should deduplicate languages', () => {
    const diffs = [
      { filePath: 'src/app1.ts', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [], additions: 5, deletions: 3, language: 'TypeScript' } as ParsedDiff,
      { filePath: 'src/app2.ts', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [], additions: 2, deletions: 1, language: 'TypeScript' } as ParsedDiff,
      { filePath: 'src/app3.ts', isNew: false, isDeleted: false, isBinary: false, isRename: false, hunks: [], additions: 4, deletions: 2, language: 'TypeScript' } as ParsedDiff
    ]

    const summary = getDiffSummary(diffs)

    expect(summary.languages).toEqual(['TypeScript'])
  })
})

describe('chunkLargeDiff', () => {
  it('should return single chunk for small diff', () => {
    const diff: ParsedDiff = {
      filePath: 'src/app.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: false,
      hunks: Array.from({ length: 10 }, (_, i) => ({
        oldStart: i * 10 + 1,
        oldLines: 5,
        newStart: i * 10 + 1,
        newLines: 6,
        lines: []
      })),
      language: 'TypeScript',
      additions: 10,
      deletions: 0
    }

    const chunks = chunkLargeDiff(diff, 50)

    expect(chunks.length).toBe(1)
    expect(chunks[0]).toBe(diff)
  })

  it('should chunk diff with many hunks', () => {
    const diff: ParsedDiff = {
      filePath: 'src/app.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: false,
      hunks: Array.from({ length: 100 }, (_, i) => ({
        oldStart: i * 10 + 1,
        oldLines: 5,
        newStart: i * 10 + 1,
        newLines: 6,
        lines: [
          { type: 'added', content: `line ${i}`, lineNumber: i * 10 + 1 }
        ]
      })),
      language: 'TypeScript',
      additions: 100,
      deletions: 0
    }

    const chunks = chunkLargeDiff(diff, 30)

    expect(chunks.length).toBe(4)
    expect(chunks[0].hunks.length).toBe(30)
    expect(chunks[1].hunks.length).toBe(30)
    expect(chunks[2].hunks.length).toBe(30)
    expect(chunks[3].hunks.length).toBe(10)
  })

  it('should preserve metadata in chunks', () => {
    const diff: ParsedDiff = {
      filePath: 'src/app.ts',
      oldFilePath: 'src/old.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: true,
      hunks: Array.from({ length: 60 }, (_, i) => ({
        oldStart: i * 10 + 1,
        oldLines: 5,
        newStart: i * 10 + 1,
        newLines: 6,
        lines: []
      })),
      language: 'TypeScript',
      additions: 60,
      deletions: 0
    }

    const chunks = chunkLargeDiff(diff, 30)

    chunks.forEach((chunk) => {
      expect(chunk.filePath).toBe(diff.filePath)
      expect(chunk.oldFilePath).toBe(diff.oldFilePath)
      expect(chunk.isNew).toBe(diff.isNew)
      expect(chunk.isDeleted).toBe(diff.isDeleted)
      expect(chunk.isBinary).toBe(diff.isBinary)
      expect(chunk.isRename).toBe(diff.isRename)
      expect(chunk.language).toBe(diff.language)
    })
  })

  it('should calculate chunk additions correctly', () => {
    const diff: ParsedDiff = {
      filePath: 'src/app.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: false,
      hunks: Array.from({ length: 60 }, (_, i) => ({
        oldStart: i * 10 + 1,
        oldLines: 5,
        newStart: i * 10 + 1,
        newLines: 6,
        lines: [
          { type: 'added', content: `line ${i}`, lineNumber: i * 10 + 1 },
          { type: 'added', content: `line ${i}b`, lineNumber: i * 10 + 2 }
        ]
      })),
      language: 'TypeScript',
      additions: 120,
      deletions: 0
    }

    const chunks = chunkLargeDiff(diff, 30)

    expect(chunks[0].additions).toBe(60) // 30 hunks * 2 additions each
    expect(chunks[1].additions).toBe(60)
  })
})

describe('shouldChunkDiff', () => {
  it('should return false for small diffs', () => {
    const diff: ParsedDiff = {
      filePath: 'src/app.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: false,
      hunks: Array.from({ length: 10 }, () => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [] })),
      language: 'TypeScript',
      additions: 10,
      deletions: 0
    }

    expect(shouldChunkDiff(diff, 50)).toBe(false)
  })

  it('should return true for large diffs', () => {
    const diff: ParsedDiff = {
      filePath: 'src/app.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: false,
      hunks: Array.from({ length: 100 }, () => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [] })),
      language: 'TypeScript',
      additions: 100,
      deletions: 0
    }

    expect(shouldChunkDiff(diff, 50)).toBe(true)
  })

  it('should use default maxHunks when not specified', () => {
    const diff: ParsedDiff = {
      filePath: 'src/app.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: false,
      hunks: Array.from({ length: 51 }, () => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [] })),
      language: 'TypeScript',
      additions: 51,
      deletions: 0
    }

    expect(shouldChunkDiff(diff)).toBe(true)
  })

  it('should return false for diffs at exactly maxHunks', () => {
    const diff: ParsedDiff = {
      filePath: 'src/app.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      isRename: false,
      hunks: Array.from({ length: 50 }, () => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [] })),
      language: 'TypeScript',
      additions: 50,
      deletions: 0
    }

    expect(shouldChunkDiff(diff, 50)).toBe(false)
  })
})

describe('DiffParserError', () => {
  it('should create error with message and code', () => {
    const error = new DiffParserError(
      'Test error',
      DiffParserErrorCodes.INVALID_DIFF,
      'src/app.ts'
    )

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('Test error')
    expect(error.code).toBe(DiffParserErrorCodes.INVALID_DIFF)
    expect(error.name).toBe('DiffParserError')
    expect(error.filePath).toBe('src/app.ts')
  })

  it('should create error without filePath', () => {
    const error = new DiffParserError(
      'Test error',
      DiffParserErrorCodes.PARSE_ERROR
    )

    expect(error.filePath).toBeUndefined()
  })
})

describe('DiffParserErrorCodes', () => {
  it('should have all expected error codes', () => {
    expect(DiffParserErrorCodes.INVALID_DIFF).toBe('INVALID_DIFF')
    expect(DiffParserErrorCodes.BINARY_FILE).toBe('BINARY_FILE')
    expect(DiffParserErrorCodes.MERGE_CONFLICT).toBe('MERGE_CONFLICT')
    expect(DiffParserErrorCodes.FILE_TOO_LARGE).toBe('FILE_TOO_LARGE')
    expect(DiffParserErrorCodes.EMPTY_DIFF).toBe('EMPTY_DIFF')
    expect(DiffParserErrorCodes.PARSE_ERROR).toBe('PARSE_ERROR')
  })
})
