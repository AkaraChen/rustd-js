export interface MediaType { mediaType: string; params: Record<string, string> }
export function parseMediaType(v: string): MediaType
export function formatMediaType(t: string, params?: Record<string, string>): string
export class MimeError extends Error { readonly code: string; constructor(message?: string, options?: ErrorOptions) }
export class MediaTypeError extends MimeError {}
export class InvalidMediaParameterError extends MediaTypeError {
  constructor(message?: string, options?: ErrorOptions & { mediaType?: string; params?: Record<string, string> })
  readonly mediaType: string
  readonly params: Record<string, string>
}
export function typeByExtension(ext: string): string
export function extensionsByType(typ: string): string[]
export function addExtensionType(ext: string, typ: string): void
export function loadSystemMimeTypes(paths?: string[]): number

export function encodeWord(charset: string, s: string, enc: 'b' | 'q'): string
export class MimeWordDecoder {
  constructor(opts?: { charsetReader?: (charset: string, input: Uint8Array) => Uint8Array })
  decode(word: string): string
  decodeHeader(header: string): string
}
export class MimeWordError extends MimeError {}

export function quotedPrintableEncode(data: Uint8Array, opts?: { binary?: boolean }): Uint8Array
export function quotedPrintableDecode(data: Uint8Array | string): Uint8Array
export class QuotedPrintableReader {
  constructor(input: Uint8Array)
  read(maxBytes?: number): Uint8Array
  end(): void
}
export class QuotedPrintableWriter {
  constructor(opts?: { binary?: boolean })
  write(data: Uint8Array): void
  finish(): Uint8Array
}
export class QuotedPrintableError extends MimeError {
  constructor(message?: string, options?: ErrorOptions & { byteOffset?: number; decoded?: Uint8Array })
  readonly byteOffset?: number
  readonly decoded?: Uint8Array
}
