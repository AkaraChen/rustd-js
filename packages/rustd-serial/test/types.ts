import {
  CsvReader, CsvWriter, CsvParseError, CsvEncodingError,
  type CsvReaderOptions, type CsvWriterOptions, type CsvFieldPos,
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
void [row, raw, all, pos, off, out, err, parse, enc];

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
