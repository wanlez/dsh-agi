import { describe, expect, it } from 'vitest'
import {
  bitmapLooksDegenerate,
  captureWithFallback,
} from '../src/capture-strategy.ts'

describe('capture fallback', () => {
  it('flushes, then uses BitBlt when the frame is healthy', () => {
    const order: string[] = []
    const choice = captureWithFallback({
      enabled: true,
      dwmFlush: () => { order.push('flush') },
      bitblt: () => { order.push('bitblt'); return 'healthy' },
      printWindow: () => { order.push('printwindow'); return 'rescue' },
      isDegenerate: () => false,
    })
    expect(order).toEqual(['flush', 'bitblt'])
    expect(choice).toMatchObject({ data: 'healthy', backend: 'bitblt', dwmFlush: 'ok' })
  })

  it('switches to PrintWindow after BitBlt throws', () => {
    const order: string[] = []
    const choice = captureWithFallback({
      enabled: true,
      dwmFlush: () => { order.push('flush') },
      bitblt: () => { order.push('bitblt'); throw new Error('gdi failed') },
      printWindow: () => { order.push('printwindow'); return 'rescue' },
      isDegenerate: () => false,
    })
    expect(order).toEqual(['flush', 'bitblt', 'printwindow'])
    expect(choice).toMatchObject({
      data: 'rescue',
      backend: 'printwindow',
      fallbackReason: 'bitblt-failed',
      printWindowAttempted: true,
    })
  })

  it('switches to PrintWindow after a successful but all-black BitBlt frame', () => {
    const choice = captureWithFallback({
      enabled: true,
      dwmFlush: () => undefined,
      bitblt: () => 'black',
      printWindow: () => 'rendered',
      isDegenerate: value => value === 'black',
    })
    expect(choice).toMatchObject({
      data: 'rendered',
      backend: 'printwindow',
      fallbackReason: 'bitblt-degenerate',
    })
  })

  it('keeps the original frame when PrintWindow throws', () => {
    const choice = captureWithFallback({
      enabled: true,
      dwmFlush: () => undefined,
      bitblt: () => 'black',
      printWindow: () => { throw new Error('print failed') },
      isDegenerate: value => value === 'black',
    })
    expect(choice).toMatchObject({ data: 'black', backend: 'bitblt', printWindowAttempted: true })
    expect(choice.rescueError).toContain('print failed')
  })

  it('reports a combined error when both backends fail and no frame exists', () => {
    expect(() => captureWithFallback({
      enabled: true,
      dwmFlush: () => undefined,
      bitblt: () => { throw new Error('bitblt fail') },
      printWindow: () => { throw new Error('print fail') },
    })).toThrow(/BitBlt: bitblt fail; PrintWindow: print fail/u)
  })

  it('ignores a DwmFlush failure and still captures', () => {
    const choice = captureWithFallback({
      enabled: true,
      dwmFlush: () => { throw new Error('no dwm') },
      bitblt: () => 'frame',
    })
    expect(choice).toMatchObject({ data: 'frame', backend: 'bitblt', dwmFlush: 'failed' })
  })

  it('does not attempt PrintWindow when fallback is disabled or no HWND is known', () => {
    let rescue = 0
    const disabled = captureWithFallback({
      enabled: false,
      dwmFlush: () => undefined,
      bitblt: () => 'black',
      printWindow: () => { rescue += 1; return 'rescue' },
      isDegenerate: () => true,
    })
    expect(disabled.backend).toBe('bitblt')
    expect(rescue).toBe(0)
    const noWindow = captureWithFallback({
      enabled: true,
      dwmFlush: () => undefined,
      bitblt: () => 'black',
      isDegenerate: () => true,
    })
    expect(noWindow.backend).toBe('bitblt')
  })
})

describe('degenerate bitmap sampling', () => {
  function frame(width: number, height: number, bgra: readonly number[]): Buffer {
    return Buffer.from(Array.from({ length: width * height }, () => bgra).flat())
  }

  it('flags all black and all one-color frames', () => {
    expect(bitmapLooksDegenerate(frame(32, 32, [0, 0, 0, 0]), 32, 32)).toMatchObject({
      degenerate: true,
      reason: 'black',
    })
    expect(bitmapLooksDegenerate(frame(32, 32, [30, 120, 220, 0]), 32, 32)).toMatchObject({
      degenerate: true,
      reason: 'uniform',
    })
  })

  it('accepts a varied frame', () => {
    const pixels = Buffer.alloc(32 * 32 * 4)
    for (let i = 0; i < 32 * 32; i += 1) {
      pixels[i * 4] = i % 255
      pixels[i * 4 + 1] = (i * 3) % 255
      pixels[i * 4 + 2] = (i * 7) % 255
    }
    expect(bitmapLooksDegenerate(pixels, 32, 32).degenerate).toBe(false)
  })

  it('rejects a buffer smaller than its declared dimensions', () => {
    expect(() => bitmapLooksDegenerate(Buffer.alloc(4), 10, 10)).toThrow(/smaller/u)
  })
})
