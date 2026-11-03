/**
 * Test-only `zoom` crop for a fake backend.
 *
 * The production Windows backend is the only backend with a zoom implementation, so a
 * fake desktop used by preview tests must supply one too. The crop maths mirrors
 * `src/windows.ts`: the pointer lands on the mapped pixel point, the square is clamped
 * to the window, and the PNG is the backend's fixture image.
 */

import type { ZoomInput, ZoomResult } from '../../src/backend.ts'
import type { DesktopBackend } from '../../src/backend.ts'
import { mapNormalizedToGlobal } from '../../src/coordinates.ts'
import { FAKE_DESKTOP_PNG } from '../../src/fake.ts'

/** One recorded zoom request and its returned crop. */
export interface ZoomCall {
  readonly input: ZoomInput
  readonly result: ZoomResult
}

/** A backend plus the zoom crops it produced. */
export type ZoomableBackend<T extends DesktopBackend> = T & {
  zoom(input: ZoomInput): Promise<ZoomResult>
  readonly zooms: readonly ZoomCall[]
}

/**
 * Add a recording `zoom` to a fake backend.
 * @param backend - fake desktop to extend; the object is mutated in place.
 * @param png - bytes every crop reports. Default: the fake desktop PNG.
 * @returns the same backend, now zoom-capable, with a `zooms` log.
 */
export function withFakeZoom<T extends DesktopBackend>(
  backend: T,
  png: Uint8Array = FAKE_DESKTOP_PNG,
): ZoomableBackend<T> {
  const zooms: ZoomCall[] = []
  const data = new Uint8Array(png)
  Object.assign(backend, {
    get zooms() {
      return zooms
    },
    async zoom(input: ZoomInput): Promise<ZoomResult> {
      const mapped = mapNormalizedToGlobal(input.position, input.screen)
      const point = { x: Math.round(mapped.x), y: Math.round(mapped.y) }
      const clamp = input.clamp ?? input.screen.bounds
      const side = Math.max(24, Math.round(input.side ?? input.screen.bounds.height / 6))
      const half = Math.floor(side / 2)
      const x = Math.max(clamp.x, Math.min(point.x - half, clamp.x + clamp.width - side))
      const y = Math.max(clamp.y, Math.min(point.y - half, clamp.y + clamp.height - side))
      const result: ZoomResult = {
        point,
        rect: { x, y, width: Math.min(side, clamp.width), height: Math.min(side, clamp.height) },
        data,
        mediaType: 'image/png',
      }
      zooms.push({ input, result })
      return result
    },
  })
  return backend as ZoomableBackend<T>
}
