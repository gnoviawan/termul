import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickAttachmentFilesBrowser } from './composer-attachments-io'

afterEach(() => vi.restoreAllMocks())

/** Opens the picker and cancels it, returning the input the browser was shown. */
async function shownInput(
  options?: Parameters<typeof pickAttachmentFilesBrowser>[0]
): Promise<HTMLInputElement> {
  let shown: HTMLInputElement | null = null
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
    this: HTMLInputElement
  ) {
    shown = this
    this.dispatchEvent(new Event('cancel'))
  })
  await expect(pickAttachmentFilesBrowser(options)).resolves.toBeNull()
  if (!shown) throw new Error('the picker never opened')
  return shown
}

describe('pickAttachmentFilesBrowser', () => {
  it('opens a multi-file picker for any file by default', async () => {
    const input = await shownInput()
    expect(input.multiple).toBe(true)
    expect(input.accept).toBe('')
    expect(input.hasAttribute('capture')).toBe(false)
  })

  it('opens an image-only picker for Photos', async () => {
    const input = await shownInput({ accept: 'image/*' })
    expect(input.accept).toBe('image/*')
    expect(input.multiple).toBe(true)
  })

  it('asks for the rear camera, one shot, for Camera', async () => {
    const input = await shownInput({ accept: 'image/*', capture: 'environment' })
    expect(input.getAttribute('capture')).toBe('environment')
    expect(input.multiple).toBe(false)
  })
})
