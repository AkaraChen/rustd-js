import {
  parseMediaType, formatMediaType, typeByExtension, extensionsByType, addExtensionType,
  loadSystemMimeTypes, encodeWord, MimeWordDecoder, quotedPrintableEncode, quotedPrintableDecode,
  QuotedPrintableReader, QuotedPrintableWriter, InvalidMediaParameterError, type MediaType,
} from '../index.js';
const parsed: MediaType = parseMediaType('text/plain; charset=utf-8');
const formatted: string = formatMediaType('text/plain', { charset: 'utf-8' });
const typ: string = typeByExtension('.json');
const exts: string[] = extensionsByType('application/json');
addExtensionType('.x', 'application/x-test');
const loaded: number = loadSystemMimeTypes();
const word: string = encodeWord('utf-8', 'Café', 'b');
const header: string = new MimeWordDecoder().decodeHeader(word);
const encoded: Uint8Array = quotedPrintableEncode(new Uint8Array([1]), { binary: true });
const decoded: Uint8Array = quotedPrintableDecode(encoded);
const reader = new QuotedPrintableReader(encoded);
const chunk: Uint8Array = reader.read(8);
reader.end();
const writer = new QuotedPrintableWriter({ binary: false });
writer.write(encoded);
const finished: Uint8Array = writer.finish();
const err: InvalidMediaParameterError = new InvalidMediaParameterError('x', { mediaType: 'text/plain', params: {} });
// @ts-expect-error parseMediaType is not a number
const wrong: number = parsed;
// @ts-expect-error encoding must be b or q
encodeWord('utf-8', 'x', 'x');
// @ts-expect-error bytes required
quotedPrintableEncode('ascii');
void [formatted, typ, exts, loaded, header, decoded, chunk, finished, err];
