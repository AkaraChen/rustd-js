import { Image, rect, pngDecode, jpegEncode, ZR } from '../index.js';
const r = rect(0, 0, 1, 1);
const img: Image = Image.rgba(r);
const _z = ZR;
const encoded: Uint8Array = jpegEncode(img);
const _decoded: Image = pngDecode(encoded);
// @ts-expect-error strings are not images
pngDecode('nope');
// @ts-expect-error width is a number
const wrong: string = img.width;
