import { describe, expect, it } from 'vitest'
import {
  compareHoverFrames,
  judgeHoverFeedback,
  unavailableHoverFeedback,
} from '../src/hover.ts'

function frame(width: number, height: number): Buffer {
  return Buffer.alloc(width * height * 4)
}

function paint(pixels: Buffer, width: number, indexes: readonly number[], bgra: readonly [number, number, number, number]): void {
  for (const index of indexes) {
    pixels[index * 4] = bgra[0]
    pixels[index * 4 + 1] = bgra[1]
    pixels[index * 4 + 2] = bgra[2]
    pixels[index * 4 + 3] = bgra[3]
  }
}

describe('hover differencing', () => {
  it('marks a significant local repaint as feedback', () => {
    const before = frame(20, 20)
    const after = frame(20, 20)
    paint(after, 20, Array.from({ length: 20 }, (_, index) => index), [255, 255, 255, 255])
    const diff = compareHoverFrames(before, after, 20, 20, { pixelTolerance: 8, sampleStride: 1 })
    expect(diff.changedPixels).toBe(20)
    expect(diff.changedRatio).toBe(0.05)
    const feedback = judgeHoverFeedback(diff, { pixelTolerance: 8, minChangedRatio: 0.02, minChangedPixels: 16 }, {
      before: 'arrow',
      after: 'hand',
      changed: true,
    })
    expect(feedback).toMatchObject({ available: true, hasFeedback: true, confidence: 'likely', cursorAssist: true })
    expect(feedback.summary).toContain('Hover feedback detected')
  })

  it('does not count a difference below the per-channel tolerance', () => {
    const before = frame(10, 10)
    const after = frame(10, 10)
    paint(after, 10, Array.from({ length: 10 }, (_, index) => index), [4, 4, 4, 255])
    const diff = compareHoverFrames(before, after, 10, 10, { pixelTolerance: 8, sampleStride: 1 })
    expect(diff.changedPixels).toBe(0)
    expect(judgeHoverFeedback(diff, { pixelTolerance: 8 }).hasFeedback).toBe(false)
  })

  it('requires enough changed pixels as well as a ratio', () => {
    const before = frame(100, 100)
    const after = frame(100, 100)
    paint(after, 100, [0, 1, 2], [255, 255, 255, 255])
    const diff = compareHoverFrames(before, after, 100, 100, { sampleStride: 1 })
    expect(judgeHoverFeedback(diff, { minChangedPixels: 16, minChangedRatio: 0.02 }).hasFeedback).toBe(false)
  })

  it('treats a cursor-only change as uncertain, never as proof of hover', () => {
    const diff = compareHoverFrames(frame(10, 10), frame(10, 10), 10, 10)
    const feedback = judgeHoverFeedback(diff, {}, { before: 'arrow', after: 'hand', changed: true })
    expect(feedback.hasFeedback).toBe(false)
    expect(feedback.confidence).toBe('uncertain')
    expect(feedback.summary).toContain('only an auxiliary signal')
  })

  it('reports unavailable when no baseline exists', () => {
    const feedback = unavailableHoverFeedback('pointer was already over the target')
    expect(feedback).toMatchObject({
      available: false,
      hasFeedback: false,
      confidence: 'uncertain',
      unavailableReason: 'pointer was already over the target',
    })
  })

  it('rejects mismatched frame dimensions', () => {
    expect(() => compareHoverFrames(frame(10, 10), frame(20, 20), 10, 10)).toThrow(/same size/u)
  })
})
