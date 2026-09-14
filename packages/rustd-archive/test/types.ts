import { tarCreate, tarExtract, zipCreate, zipExtract, TarFormatError, ZipReader } from '../index.js';
const bytes: Uint8Array = tarCreate([{ name: 'a.txt', data: new Uint8Array([1]) }]);
const entries = tarExtract(bytes);
const zip = zipCreate([{ name: 'a.txt', data: new Uint8Array([1]), method: 8 }]);
zipExtract(zip);
const err: TarFormatError = new TarFormatError('archive/tar: invalid tar header');
const offset: number = err.offset;
const reader = new ZipReader();
reader.on('entry', (e) => { const n: string = e.name; });
// @ts-expect-error Names are required.
tarCreate([{ data: new Uint8Array() }]);
// @ts-expect-error Zip method 8 | 0 only.
zipCreate([{ name: 'a', method: 9 }]);
// @ts-expect-error Byte archives are not strings.
const wrong: string = bytes;
void entries; void offset; void reader;
