import {
  bzip2Decompress, lzwCompress, lzwDecompress,
  Bzip2Decompressor, LzwDecompressor, LzwCompressor,
  bzip2DecompressStream, lzwCompressStream,
  Bzip2FormatError, LzwFormatError, LzwConfigError,
  type LzwOptions,
} from '../index.js';

const opts: LzwOptions = { order: 'lsb', litWidth: 8 };
const raw: Uint8Array = lzwCompress(new Uint8Array([1]), opts);
const plain: Uint8Array = lzwDecompress(raw, opts);
const unzipped: Uint8Array = bzip2Decompress(plain);
const stream: AsyncIterable<Uint8Array> = bzip2DecompressStream((async function* () { yield plain; })());
const encoded: AsyncIterable<Uint8Array> = lzwCompressStream((async function* () { yield plain; })(), opts);
const d = new Bzip2Decompressor({ chunkSize: 1024 });
d.write(plain);
const part: Uint8Array = d.read(8);
d.end();
d.reset();
const lzd = new LzwDecompressor(opts);
lzd.write(raw);
lzd.read();
lzd.end();
const lzc = new LzwCompressor(opts);
lzc.write(plain);
const finished: Uint8Array = lzc.finish();
const format: Bzip2FormatError = new Bzip2FormatError('x', 0);
const lzwErr: LzwFormatError = new LzwFormatError('x', 1);
const cfg: LzwConfigError = new LzwConfigError('lzw: litWidth 1 out of range');
void [unzipped, stream, encoded, part, finished, format, lzwErr, cfg];

// @ts-expect-error strings are not bytes
bzip2Decompress('data');
// @ts-expect-error litWidth is required
lzwCompress(plain, { order: 'lsb' });
// @ts-expect-error order is a closed union
new LzwCompressor({ order: 'gif', litWidth: 8 });
// @ts-expect-error no Promise core API
const wrong: Promise<Uint8Array> = bzip2Decompress(plain);
// @ts-expect-error offset is readonly
format.offset = 2;
