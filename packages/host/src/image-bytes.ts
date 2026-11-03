/**
 * Read what an upload actually is: the raster type from its file header, and the
 * intrinsic size the ball shows before the attachment service answers.
 * The page declares a media type, but a renamed or re-encoded file lies often
 * enough that the bytes decide.
 */

/** Media types the official attachment service stores. */
export type UploadMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Every type the sniffer can name; BMP is recognised but not storable. */
export type SniffedMediaType = UploadMediaType | 'image/bmp'

/** Intrinsic pixel size of one encoded raster. */
export interface ImageSize {
  readonly width: number
  readonly height: number
}

/** The size the ball reports when a header cannot be read: 16:9 at 960×540. */
const FALLBACK_SIZE: ImageSize = { width: 960, height: 540 }

/** Name the encoded bytes by their header, undefined when they are no known raster. */
export function detectImageType(buffer: Uint8Array): SniffedMediaType | undefined {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length > 12 && ascii(buffer.subarray(0, 4)) === 'RIFF' && ascii(buffer.subarray(8, 12)) === 'WEBP') return 'image/webp'
  if (buffer.length > 6 && ascii(buffer.subarray(0, 3)) === 'GIF') return 'image/gif'
  if (buffer.length > 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'
  return undefined
}

/**
 * Read the pixel size from a PNG or JPEG header. The attachment service always
 * reports one; this is the fallback for a reference that arrives without it.
 */
export function imageSizeOf(buffer: Uint8Array): ImageSize {
  try {
    const data = Buffer.from(buffer)
    if (data[0] === 0x89 && data[1] === 0x50) {
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
    }
    if (data[0] === 0xff && data[1] === 0xd8) {
      let index = 2
      while (index < data.length - 9) {
        if (data[index] !== 0xff) {
          index += 1
          continue
        }
        const marker = data[index + 1]
        // SOF0–SOF3 carry the frame header: height, width, then the component count.
        if (marker !== undefined && marker >= 0xc0 && marker <= 0xc3) {
          return { width: data.readUInt16BE(index + 7), height: data.readUInt16BE(index + 5) }
        }
        const length = data.readUInt16BE(index + 2)
        if (length < 2) return FALLBACK_SIZE
        index += 2 + length
      }
    }
  } catch {
    return FALLBACK_SIZE
  }
  return FALLBACK_SIZE
}

/** An ASCII view over the first bytes of one upload. */
function ascii(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('ascii')
}
