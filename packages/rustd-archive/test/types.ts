import { tarCreate, tarExtract, zipCreate, zipExtract, TarFormatError, ZipReader } from '../index.js';
const bytes: Uint8Array = tarCreate([{ name: 'a.txt', data: new Uint8Array([1]) }]);
const entries = tarExtract(bytes);
const zip = zipCreate([{ name: 'a.txt', data: new Uint8Array([1]), method: 8 }]);
const zipEntries = zipExtract(zip);
const zipMethod: 0 | 8 = zipEntries[0]!.method;
void zipMethod;
const zipComment: string | undefined = zipEntries[0]!.comment;
void zipComment;
// @ts-expect-error ZipEntry has no extra field (do not invent FileHeader.Extra).
const zipExtra = zipEntries[0]!.extra;
void zipExtra;
// @ts-expect-error zipExtract returns ZipEntry[]; no archive-level comment.
const archiveComment = zipExtract(zip).archiveComment;
void archiveComment;
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
