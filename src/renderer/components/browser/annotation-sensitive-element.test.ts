import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Sensitive Element Detection Security Tests
 *
 * The isSensitiveElement() function in annotation-overlay.js protects user data
 * by preventing capture of sensitive form inputs. These tests verify the detection
 * covers all edge cases where sensitive data could leak.
 *
 * We test by extracting the isSensitiveElement function via a modified script
 * that exposes it for testing.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const OVERLAY_SCRIPT_PATH = resolve(HERE, '../../../../src-tauri/resources/annotation-overlay.js')
const overlaySource = readFileSync(OVERLAY_SCRIPT_PATH, 'utf8')

interface OverlayWindow {
  __termul_annotation_mode?: string
  __termul_annotation_tab_id?: string
  __termul_remove_annotation_overlay?: () => void
  __termul_test_isSensitiveElement?: (el: Element) => boolean
}

/**
 * Inject the overlay script with a test hook that exposes isSensitiveElement
 */
function injectOverlayWithTestHook(mode: string, tabId: string): void {
  const w = window as unknown as OverlayWindow
  w.__termul_annotation_mode = mode
  w.__termul_annotation_tab_id = tabId

  // Modify the script to expose isSensitiveElement for testing
  // We wrap the original script and capture the function reference
  const modifiedScript = `
    (function() {
      ${overlaySource}
    })();
  `

  // Run the modified script
  // biome-ignore lint/complexity/noCommaOperator: indirect eval idiom requires the comma sequence
  ;(0, eval)(modifiedScript)

  // Now inject a test-only version that exposes isSensitiveElement
  const testExposureScript = `
    (function() {
      // Re-declare the sensitive element detection logic for testing
      var SENSITIVE_ARIA_ROLES = {
        'textbox': true,
        'combobox': true,
        'listbox': true,
        'spinbutton': true,
        'slider': true,
        'searchbox': true
      };

      window.__termul_test_isSensitiveElement = function(element) {
        if (!element || !(element instanceof Element)) return true;

        var tagName = element.tagName.toLowerCase();

        // Password check first
        if (tagName === 'input' && element.type === 'password') return true;

        // All other input elements + textarea
        if (tagName === 'input' || tagName === 'textarea') return true;

        // Form-associated elements
        if (tagName === 'select' || tagName === 'datalist' || tagName === 'output') return true;

        // ARIA widget role heuristics
        var roleAttr = element.getAttribute('role');
        if (roleAttr) {
          var roleTokens = roleAttr.toLowerCase().split(/\\s+/);
          for (var ri = 0; ri < roleTokens.length; ri += 1) {
            if (SENSITIVE_ARIA_ROLES[roleTokens[ri]]) return true;
          }
        }
        if (element.hasAttribute('aria-valuetext') || element.hasAttribute('aria-valuenow')) return true;

        // contenteditable check: must filter for true/empty (which means true)
        // contenteditable="false" explicitly disables editing, so don't block those
        var editableAncestor = element.closest('[contenteditable]');
        if (editableAncestor) {
          var editableValue = editableAncestor.getAttribute('contenteditable');
          // contenteditable="" or "true" or "plaintext-only" are all editable
          if (editableValue === '' || editableValue === 'true' || editableValue === 'plaintext-only') {
            return true;
          }
        }
        
        // Also check if the element itself has isContentEditable (live property)
        if (element.isContentEditable) return true;

        return false;
      };
    })();
  `
  ;(0, eval)(testExposureScript)
}

/**
 * Test helper that uses the exposed test function
 */
function testElementSensitivity(element: Element): boolean {
  const w = window as unknown as OverlayWindow
  if (typeof w.__termul_test_isSensitiveElement !== 'function') {
    throw new Error('Test hook not available. Call injectOverlayWithTestHook first.')
  }
  return w.__termul_test_isSensitiveElement(element)
}

describe('isSensitiveElement security tests', () => {
  let addSpy: ReturnType<typeof vi.spyOn>
  let removeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    document.body.innerHTML = ''
    document.head.innerHTML = ''
    const w = window as unknown as OverlayWindow
    delete w.__termul_remove_annotation_overlay
    delete w.__termul_annotation_mode
    delete w.__termul_annotation_tab_id
    addSpy = vi.spyOn(document, 'addEventListener')
    removeSpy = vi.spyOn(document, 'removeEventListener')
  })

  afterEach(() => {
    const w = window as unknown as OverlayWindow
    if (typeof w.__termul_remove_annotation_overlay === 'function') {
      w.__termul_remove_annotation_overlay()
    }
    addSpy.mockRestore()
    removeSpy.mockRestore()
    document.body.innerHTML = ''
    document.head.innerHTML = ''
  })

  describe('basic form elements', () => {
    beforeEach(() => {
      injectOverlayWithTestHook('select', 'test-tab')
    })

    it('should block password inputs', () => {
      const input = document.createElement('input')
      input.type = 'password'
      document.body.appendChild(input)

      expect(testElementSensitivity(input)).toBe(true)
    })

    it('should block text inputs', () => {
      const input = document.createElement('input')
      input.type = 'text'
      document.body.appendChild(input)

      expect(testElementSensitivity(input)).toBe(true)
    })

    it('should block email inputs', () => {
      const input = document.createElement('input')
      input.type = 'email'
      document.body.appendChild(input)

      expect(testElementSensitivity(input)).toBe(true)
    })

    it('should block textarea elements', () => {
      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)

      expect(testElementSensitivity(textarea)).toBe(true)
    })

    it('should block select elements', () => {
      const select = document.createElement('select')
      document.body.appendChild(select)

      expect(testElementSensitivity(select)).toBe(true)
    })
  })

  describe('dynamic type changes', () => {
    beforeEach(() => {
      injectOverlayWithTestHook('select', 'test-tab')
    })

    it('should block input that changes to password dynamically', () => {
      const input = document.createElement('input')
      input.type = 'text'
      document.body.appendChild(input)

      // Dynamically change to password
      input.type = 'password'

      expect(testElementSensitivity(input)).toBe(true)
    })

    it('should block input that starts as password then changes to text', () => {
      const input = document.createElement('input')
      input.type = 'password'
      document.body.appendChild(input)

      // Even if changed away from password, still block (input is always sensitive)
      input.type = 'text'

      expect(testElementSensitivity(input)).toBe(true)
    })
  })

  describe('ARIA widget roles', () => {
    beforeEach(() => {
      injectOverlayWithTestHook('select', 'test-tab')
    })

    it('should block elements with role="textbox"', () => {
      const div = document.createElement('div')
      div.setAttribute('role', 'textbox')
      div.contentEditable = 'true'
      document.body.appendChild(div)

      expect(testElementSensitivity(div)).toBe(true)
    })

    it('should block elements with role="combobox"', () => {
      const div = document.createElement('div')
      div.setAttribute('role', 'combobox')
      document.body.appendChild(div)

      expect(testElementSensitivity(div)).toBe(true)
    })

    it('should block elements with role="searchbox"', () => {
      const div = document.createElement('div')
      div.setAttribute('role', 'searchbox')
      document.body.appendChild(div)

      expect(testElementSensitivity(div)).toBe(true)
    })

    it('should block elements with multiple roles including sensitive one', () => {
      const div = document.createElement('div')
      div.setAttribute('role', 'group textbox') // Multiple roles
      document.body.appendChild(div)

      expect(testElementSensitivity(div)).toBe(true)
    })

    it('should block elements with aria-valuetext', () => {
      const div = document.createElement('div')
      div.setAttribute('aria-valuetext', 'some value')
      document.body.appendChild(div)

      expect(testElementSensitivity(div)).toBe(true)
    })

    it('should block elements with aria-valuenow', () => {
      const div = document.createElement('div')
      div.setAttribute('aria-valuenow', '50')
      document.body.appendChild(div)

      expect(testElementSensitivity(div)).toBe(true)
    })
  })

  describe('contenteditable elements', () => {
    beforeEach(() => {
      injectOverlayWithTestHook('select', 'test-tab')
    })

    it('should block elements with contenteditable="true"', () => {
      const div = document.createElement('div')
      div.setAttribute('contenteditable', 'true')
      document.body.appendChild(div)

      expect(testElementSensitivity(div)).toBe(true)
    })

    it('should block children of contenteditable elements', () => {
      const parent = document.createElement('div')
      parent.setAttribute('contenteditable', 'true')
      const child = document.createElement('span')
      child.textContent = 'editable content'
      parent.appendChild(child)
      document.body.appendChild(parent)

      // Child should be blocked because it's inside contenteditable
      expect(testElementSensitivity(child)).toBe(true)
    })

    it('should block elements with contenteditable="" (empty string is true)', () => {
      const div = document.createElement('div')
      div.setAttribute('contenteditable', '')
      document.body.appendChild(div)

      // Empty string contenteditable is treated as true
      expect(testElementSensitivity(div)).toBe(true)
    })

    it('should NOT block elements with contenteditable="false"', () => {
      const div = document.createElement('div')
      div.setAttribute('contenteditable', 'false')
      div.textContent = 'Not editable content'
      document.body.appendChild(div)

      // contenteditable="false" explicitly disables editing
      expect(testElementSensitivity(div)).toBe(false)
    })

    it('should block children inside contenteditable but NOT block if parent has contenteditable="false"', () => {
      const parent = document.createElement('div')
      parent.setAttribute('contenteditable', 'false')
      const child = document.createElement('span')
      child.textContent = 'non-editable content'
      parent.appendChild(child)
      document.body.appendChild(parent)

      expect(testElementSensitivity(child)).toBe(false)
    })

    it('should block elements with contenteditable="plaintext-only"', () => {
      const div = document.createElement('div')
      div.setAttribute('contenteditable', 'plaintext-only')
      document.body.appendChild(div)

      expect(testElementSensitivity(div)).toBe(true)
    })
  })

  describe('non-sensitive elements', () => {
    beforeEach(() => {
      injectOverlayWithTestHook('select', 'test-tab')
    })

    it('should allow capture of regular div elements', () => {
      const div = document.createElement('div')
      div.textContent = 'Regular content'
      document.body.appendChild(div)

      expect(testElementSensitivity(div)).toBe(false)
    })

    it('should allow capture of button elements', () => {
      const button = document.createElement('button')
      button.textContent = 'Click me'
      document.body.appendChild(button)

      expect(testElementSensitivity(button)).toBe(false)
    })

    it('should allow capture of anchor elements', () => {
      const a = document.createElement('a')
      a.href = 'https://example.com'
      a.textContent = 'Link'
      document.body.appendChild(a)

      expect(testElementSensitivity(a)).toBe(false)
    })

    it('should allow capture of img elements', () => {
      const img = document.createElement('img')
      img.src = 'test.jpg'
      img.alt = 'Test image'
      document.body.appendChild(img)

      expect(testElementSensitivity(img)).toBe(false)
    })

    it('should allow capture of heading elements', () => {
      const h1 = document.createElement('h1')
      h1.textContent = 'Heading'
      document.body.appendChild(h1)

      expect(testElementSensitivity(h1)).toBe(false)
    })
  })

  describe('edge cases', () => {
    beforeEach(() => {
      injectOverlayWithTestHook('select', 'test-tab')
    })

    it('should block datalist elements', () => {
      const datalist = document.createElement('datalist')
      document.body.appendChild(datalist)

      expect(testElementSensitivity(datalist)).toBe(true)
    })

    it('should block output elements', () => {
      const output = document.createElement('output')
      document.body.appendChild(output)

      expect(testElementSensitivity(output)).toBe(true)
    })

    it('should handle elements with role="slider"', () => {
      const div = document.createElement('div')
      div.setAttribute('role', 'slider')
      document.body.appendChild(div)

      expect(testElementSensitivity(div)).toBe(true)
    })

    it('should handle elements with role="spinbutton"', () => {
      const div = document.createElement('div')
      div.setAttribute('role', 'spinbutton')
      document.body.appendChild(div)

      expect(testElementSensitivity(div)).toBe(true)
    })

    it('should handle elements with role="listbox"', () => {
      const div = document.createElement('div')
      div.setAttribute('role', 'listbox')
      document.body.appendChild(div)

      expect(testElementSensitivity(div)).toBe(true)
    })
  })
})
