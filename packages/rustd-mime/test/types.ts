import {
  parseMediaType, formatMediaType, typeByExtension, extensionsByType, addExtensionType,
  loadSystemMimeTypes, encodeWord, MimeWordDecoder, quotedPrintableEncode, quotedPrintableDecode,
  QuotedPrintableReader, QuotedPrintableWriter, InvalidMediaParameterError, type MediaType,
  canonicalMIMEHeaderKey, mimeHeaderGet, mimeHeaderValues, mimeHeaderSet, mimeHeaderAdd, mimeHeaderDel,
  type MIMEHeader, MultipartWriter, MultipartReader, MultipartPart, MultipartError,
  fileContentDisposition,
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
const mimeHeader: MIMEHeader = {};
mimeHeaderAdd(mimeHeader, 'content-type', 'text/plain');
mimeHeaderSet(mimeHeader, 'X-Foo', 'bar');
const canon: string = canonicalMIMEHeaderKey('content-type');
const first: string = mimeHeaderGet(mimeHeader, 'Content-Type');
const all: string[] = mimeHeaderValues(mimeHeader, 'x-foo');
mimeHeaderDel(mimeHeader, 'x-foo');
const mp = new MultipartWriter({ boundary: 'boundary' });
mp.writeField('foo', 'bar');
const part = mp.createFormField('baz');
part.write(new Uint8Array([1, 2]));
part.end();
const filePart = mp.createFormFile('file', 'a.txt');
filePart.write(new Uint8Array([3]));
filePart.end();
const disp: string = fileContentDisposition('file', 'a.txt');
const mpBytes: Uint8Array = mp.bytes();
const mpReader = new MultipartReader({ boundary: 'boundary' });
mpReader.write(mpBytes);
const next: MultipartPart | null = mpReader.nextPart();
const raw: MultipartPart | null = mpReader.nextRawPart();
const formName: string = next?.formName() ?? '';
const fileName: string = next?.fileName() ?? '';
const partBody: Uint8Array = next?.read() ?? new Uint8Array();
const mpErr: MultipartError = new MultipartError('x');
// @ts-expect-error parseMediaType is not a number
const wrong: number = parsed;
// @ts-expect-error encoding must be b or q
encodeWord('utf-8', 'x', 'x');
// @ts-expect-error bytes required
quotedPrintableEncode('ascii');
void [formatted, typ, exts, loaded, header, decoded, chunk, finished, err, canon, first, all, mpBytes, formName, fileName, partBody, mpErr, raw, disp];
