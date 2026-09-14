import {
  CsvReader, CsvWriter, CsvParseError, CsvEncodingError,
  type CsvReaderOptions, type CsvWriterOptions, type CsvFieldPos,
  pemDecode, pemDecodeAll, pemEncode, PemEncodeError,
  type PemBlock, type PemDecodeResult,
  asn1Marshal, asn1Unmarshal, Asn1SyntaxError, Asn1StructuralError,
  type Asn1Schema, type Asn1BitString, type Asn1RawValue,
  XmlDecoder, XmlEncoder, xmlMarshal, xmlUnmarshal, xmlEscape, xmlMarshalIndent,
  XML_HEADER, HTML_ENTITY, HTML_AUTO_CLOSE, getHtmlEntity, getHtmlAutoClose,
  XmlSyntaxError, XmlUnsupportedTypeError,
  type XmlSchema, type XmlToken, type XmlDecoderOptions,
} from '../index.js';

const opts: CsvReaderOptions = { comma: ',', fieldsPerRecord: -1, lazyQuotes: true, trimLeadingSpace: true };
const reader = new CsvReader(new Uint8Array([97, 44, 98, 10]), opts);
const row: string[] | null = reader.read();
const raw: Uint8Array[] | null = new CsvReader(new Uint8Array([97])).readBytes();
const all: string[][] = new CsvReader(new Uint8Array([97, 10])).readAll();
const pos: CsvFieldPos = reader.fieldPos(0);
const off: number = reader.inputOffset();
const wopts: CsvWriterOptions = { comma: ';', useCRLF: true };
const writer = new CsvWriter(wopts);
writer.write(['a', 'b']);
writer.write([new Uint8Array([99])]);
writer.writeAll([['x'], ['y']]);
const out: Uint8Array = writer.bytes();
const err: Error | null = writer.error();
const parse: CsvParseError = new CsvParseError('x', 1, 1, 1);
const enc: CsvEncodingError = new CsvEncodingError('x');
const pem: PemDecodeResult | null = pemDecode(new Uint8Array());
const blocks: PemBlock[] = pemDecodeAll(new Uint8Array([45]));
const encoded: Uint8Array = pemEncode({ type: 'FOO', bytes: new Uint8Array([1]) });
const pemErr: PemEncodeError = new PemEncodeError('x');
const intSchema: Asn1Schema = { kind: 'int' };
const seqSchema: Asn1Schema = {
  kind: 'sequence',
  fields: [{ name: 'n', schema: intSchema, optional: true }],
};
const der: Uint8Array = asn1Marshal({ n: 1n }, seqSchema);
const decoded: { value: { n: bigint }; rest: Uint8Array } = asn1Unmarshal(der, seqSchema);
const bits: Asn1BitString = { bytes: new Uint8Array([0x80]), bitLength: 1 };
const rawVal: Asn1RawValue = { class: 0, tag: 2, isCompound: false, bytes: new Uint8Array([1]), fullBytes: new Uint8Array([2, 1, 1]) };
const syn: Asn1SyntaxError = new Asn1SyntaxError('x');
const st: Asn1StructuralError = new Asn1StructuralError('x');
const xmlOpts: XmlDecoderOptions = { strict: true, autoClose: getHtmlAutoClose(), entity: getHtmlEntity() };
const xd = new XmlDecoder('<a/>', xmlOpts);
const tok: XmlToken | null = xd.token();
const xmlSchema: XmlSchema = { name: 'person', kind: 'element', children: [{ name: 'id', kind: 'attr', type: 'int' }] };
const xmlBytes: Uint8Array = xmlMarshal({ id: 1 }, xmlSchema);
const xmlVal = xmlUnmarshal(xmlBytes, xmlSchema);
const esc: Uint8Array = xmlEscape(new Uint8Array([60]));
const indented: Uint8Array = xmlMarshalIndent({ id: 1 }, xmlSchema, '', '  ');
const xe = new XmlEncoder({ indent: '  ' });
xe.encodeToken({ type: 'start', name: { space: '', local: 'a' }, attr: [] });
xe.flush();
const xout: Uint8Array = xe.bytes();
const xsyn: XmlSyntaxError = new XmlSyntaxError('x', 1);
const xun: XmlUnsupportedTypeError = new XmlUnsupportedTypeError('x', 'chan');
const header: string = XML_HEADER;
const ent = HTML_ENTITY.nbsp;
const ac = HTML_AUTO_CLOSE[0];
void [row, raw, all, pos, off, out, err, parse, enc, pem, blocks, encoded, pemErr, decoded, bits, rawVal, syn, st, tok, xmlVal, esc, indented, xout, xsyn, xun, header, ent, ac, xd];

// @ts-expect-error bytes required
new CsvReader('a,b');
// @ts-expect-error comma is a string
new CsvReader(new Uint8Array(), { comma: 44 });
// @ts-expect-error no Promise core API
const wrong: Promise<string[] | null> = reader.read();
// @ts-expect-error code is readonly
parse.code = 'OTHER';
// @ts-expect-error startLine is readonly
parse.startLine = 2;
// @ts-expect-error PEM input is bytes
pemDecode('-----BEGIN');
// @ts-expect-error type is a string
pemEncode({ type: 1, bytes: new Uint8Array() });
// @ts-expect-error code is readonly
pemErr.code = 'OTHER';
// @ts-expect-error schema kind is required
asn1Marshal(1, { tag: 1 });
// @ts-expect-error params is a string
asn1Unmarshal(new Uint8Array(), { kind: 'int' }, 1);
// @ts-expect-error code is readonly
syn.code = 'OTHER';
// @ts-expect-error XmlDecoder input is bytes or string, not number
new XmlDecoder(1);
// @ts-expect-error schema kind is required
xmlMarshal({}, { name: 'a' });
// @ts-expect-error line is readonly
xsyn.line = 2;
