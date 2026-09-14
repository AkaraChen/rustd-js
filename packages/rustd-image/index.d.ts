export type ColorModel = 'rgba' | 'rgba64' | 'nrgba' | 'nrgba64' | 'alpha' | 'alpha16' | 'gray' | 'gray16' | 'ycbcr' | 'cmyk' | 'paletted';
export interface Rect { minX: number; minY: number; maxX: number; maxY: number }
export interface Point { x: number; y: number }
export function rect(x0: number, y0: number, x1: number, y1: number): Rect;
export const ZR: Rect;
export function rectSize(r: Rect): Point;
export function rectDx(r: Rect): number;
export function rectDy(r: Rect): number;
export function rectEmpty(r: Rect): boolean;
export function rectEq(a: Rect, b: Rect): boolean;
export function rectIn(a: Rect, b: Rect): boolean;
export function rectOverlaps(a: Rect, b: Rect): boolean;
export function rectIntersect(a: Rect, b: Rect): Rect;
export function rectUnion(a: Rect, b: Rect): Rect;
export function rectAdd(r: Rect, p: Point): Rect;
export function rectSub(r: Rect, p: Point): Rect;
export function rectInset(r: Rect, n: number): Rect;
export function rectCanon(r: Rect): Rect;

export interface Rgba { r: number; g: number; b: number; a: number }
export type YCbCrSubsampleRatio = '444' | '422' | '420' | '440' | '411' | '410';
export class Color {
  constructor(kind: Color['kind'], bytes: Uint8Array);
  readonly kind: 'rgba' | 'rgba64' | 'nrgba' | 'nrgba64' | 'alpha' | 'alpha16' | 'gray' | 'gray16' | 'ycbcr' | 'cmyk';
  readonly bytes: Uint8Array;
  rgba(): Rgba;
}
export function gray(c: number): Color;
export function nrgba(c: { r: number; g: number; b: number; a: number }): Color;
export class Palette {
  constructor(colors: Color[]);
  readonly length: number;
  readonly colors: Color[];
  readonly lut8: Uint8Array;
  convert(c: Color): Color;
  index(c: Color): number;
}
export function plan9Palette(): Palette;
export function webSafePalette(): Palette;

export class Image {
  readonly model: ColorModel;
  readonly rect: Rect;
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly disposed: boolean;
  at(x: number, y: number): Rgba;
  atRgba(x: number, y: number, out?: Rgba): Rgba;
  rgba64At(x: number, y: number, out?: Rgba): Rgba;
  opaque(): boolean;
  set(x: number, y: number, c: Color | Rgba): void;
  subImage(r: Rect): Image;
  pix(): Uint8Array;
  pixCopy(): Uint8Array;
  dispose(): void;
  [Symbol.dispose](): void;
  static rgba(r: Rect): Image;
  static rgba64(r: Rect): Image;
  static nrgba(r: Rect): Image;
  static nrgba64(r: Rect): Image;
  static alpha(r: Rect): Image;
  static alpha16(r: Rect): Image;
  static gray(r: Rect): Image;
  static gray16(r: Rect): Image;
  static paletted(r: Rect, palette: Palette): Image;
  static ycbcr(r: Rect, subsample: YCbCrSubsampleRatio): Image;
  static cmyk(r: Rect): Image;
  static uniform(r: Rect, c: Color | Rgba): Image;
}

export interface DecodeOptions { maxPixels?: number }
export interface Config { width: number; height: number; colorModel: string }
export interface Gif { image: Image[]; delay: number[]; loopCount: number; disposal: number[]; config: Config; backgroundIndex: number }
export interface GifOptions { numColors?: number; quantizer?: 'floyd-steinberg' | null; drawer?: 'floyd-steinberg' | null }

export function pngDecode(buf: Uint8Array, opts?: DecodeOptions): Image;
export function pngDecodeConfig(buf: Uint8Array): Config;
export function pngEncode(img: Image, opts?: { compressionLevel?: 0 | -1 | -2 | -3 }): Uint8Array;
export function jpegDecode(buf: Uint8Array, opts?: DecodeOptions): Image;
export function jpegDecodeConfig(buf: Uint8Array): Config;
export function jpegEncode(img: Image, opts?: { quality?: number }): Uint8Array;
export function gifDecode(buf: Uint8Array, opts?: DecodeOptions): Image;
export function gifDecodeAll(buf: Uint8Array, opts?: DecodeOptions): Gif;
export function gifDecodeConfig(buf: Uint8Array): Config;
export function gifEncode(img: Image, opts?: GifOptions): Uint8Array;
export function gifEncodeAll(gif: Gif): Uint8Array;

export type AsyncByteSource = AsyncIterable<Uint8Array>;
export function pngDecodeStream(src: AsyncByteSource, opts?: DecodeOptions): Promise<Image>;
export function jpegDecodeStream(src: AsyncByteSource, opts?: DecodeOptions): Promise<Image>;
export function gifDecodeAllStream(src: AsyncByteSource, opts?: DecodeOptions): Promise<Gif>;
export class PngEncoder { constructor(opts?: { compressionLevel?: number }); write(img: Image): Promise<void>; toBytes(): Uint8Array }
export class JpegEncoder { constructor(opts?: { quality?: number }); write(img: Image): Promise<void>; toBytes(): Uint8Array }
export class GifWriter {
  constructor(opts?: GifOptions);
  addFrame(img: Image, delayMs: number, disposal?: number): Promise<void>;
  setLoopCount(n: number): void;
  toBytes(): Uint8Array;
}

export function draw(dst: Image, r: Rect, src: Image, sp: Point, op?: 'over' | 'src'): void;
export function drawMask(dst: Image, r: Rect, src: Image, sp: Point, mask: Image, mp: Point, op?: 'over' | 'src'): void;
export function quantize(p: Palette, m: Image, opts?: { drawer?: 'floyd-steinberg' | null }): Image;
export function drawGeneric(img: Image, r: Rect, src: Image, sp: Point, mask: Image, mp: Point, op: 'over' | 'src'): void;

export class ImageError extends Error { readonly code: string }
export class ImageDisposedError extends ImageError {}
export class ImageTooLargeError extends ImageError {}
export class ImageFormatError extends ImageError {}
export class PngFormatError extends ImageError {}
export class PngUnsupportedError extends ImageError {}
export class JpegFormatError extends ImageError {}
export class JpegUnsupportedError extends ImageError {}
export class GifFormatError extends ImageError {}
export class GifUnsupportedError extends ImageError {}
