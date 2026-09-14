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

/** Go `net/textproto.MIMEHeader` (`map[string][]string`) for `Part.header` / `FileHeader.header`. Keys are canonical. */
export type MIMEHeader = Record<string, string[]>
export function canonicalMIMEHeaderKey(s: string): string
export function mimeHeaderGet(header: MIMEHeader | null | undefined, key: string): string
export function mimeHeaderValues(header: MIMEHeader | null | undefined, key: string): string[]
export function mimeHeaderSet(header: MIMEHeader, key: string, value: string): void
export function mimeHeaderAdd(header: MIMEHeader, key: string, value: string): void
export function mimeHeaderDel(header: MIMEHeader, key: string): void

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

export class MultipartError extends MimeError {}
export interface MultipartPartWriter {
  write(data: Uint8Array): void
  end(): void
}
export class MultipartWriter {
  constructor(opts?: { boundary?: string })
  setBoundary(boundary: string): void
  boundary(): string
  formDataContentType(): string
  createPart(header: MIMEHeader): MultipartPartWriter
  createFormField(fieldname: string): MultipartPartWriter
  createFormFile(fieldname: string, filename: string): MultipartPartWriter
  writeField(fieldname: string, value: string): void
  bytes(): Uint8Array
}
export function fileContentDisposition(fieldname: string, filename: string): string
export class MultipartReader {
  constructor(opts: { boundary: string; maxHeadersPerPart?: number; maxTotalHeaders?: number })
  write(chunk: Uint8Array): void
  nextPart(): MultipartPart | null
  nextRawPart(): MultipartPart | null
}
export class MultipartPart {
  readonly header: MIMEHeader
  formName(): string
  fileName(): string
  read(): Uint8Array
  readChunk(maxBytes?: number): Uint8Array
  close(): void
}
