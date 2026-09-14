# rustd-image

Go `image` / `image/color` / `image/color/palette` / `image/draw` / `image/png` /
`image/jpeg` / `image/gif` for Node via Rust + N-API. Issue
[#19](https://github.com/AkaraChen/rustd-js/issues/19). Runtime Node >=20; no JS
runtime dependencies. Native classes are private.

```js
import { Image, rect, pngEncode, pngDecode, nrgba } from 'rustd-image';

const img = Image.nrgba(rect(0, 0, 16, 16));
img.set(0, 0, nrgba({ r: 255, g: 0, b: 0, a: 255 }));
const bytes = pngEncode(img);
const round = pngDecode(bytes);
console.log(round.atRgba(0, 0));
img.dispose();
```

Hot pixel loops must use `atRgba(x, y, out)` to reuse the output object. `at()`
allocates. `SubImage` **aliases** the parent buffer: writing the child writes the
parent. Call `dispose()` (or `using`) when finished; `at`/`pix` after dispose
throw `ImageDisposedError`.

Untrusted input: call `pngDecodeConfig` / `jpegDecodeConfig` / `gifDecodeConfig`
before allocating pixels, and pass `maxPixels` to `*Decode`. Config paths do not
allocate a pixel buffer.

## Format matrix

| Format | Decode | Encode | Notes |
| --- | --- | --- | --- |
| PNG Gray/GA/RGB/RGBA 8/16, palette, tRNS, Adam7 | yes (`png` crate) | yes (8-bit RGBA) | `iCCP`/`gAMA`/`cHRM`/`sRGB` not applied |
| JPEG baseline + progressive | yes (`jpeg-decoder`, no rayon) | 4:2:0 baseline (`jpeg-encoder`), default quality 75 | lossless/arithmetic SOF → `JpegUnsupportedError`; no EXIF orientation |
| GIF | yes (`gif` crate, no `color_quant`) | Plan9 palette + optional Floyd–Steinberg | LZW from `gif`; quantize/dither is ours |

## Differences from Go

- `pix()` returns a **copy** of the parent buffer tail (offset through end).
  Shared mutation still works through `set` / `subImage`. Zero-copy `ArrayBuffer`
  views are deferred until dispose can detach the buffer without UAF.
- PNG encode always emits 8-bit RGBA. Go's encoder chooses a colour type; Go
  also does not promise byte-identical PNG output.
- Truncated PNG `pngDecode` always throws `PngFormatError` (every prefix of a
  valid file). Go's `png.Decode` usually returns `unexpected EOF` (`io.ErrUnexpectedEOF`)
  rather than `png.FormatError`; the JS error class is the issue #19 mapping.
  `pngDecodeConfig` still succeeds once IHDR is complete, matching Go.
- JPEG colour JPEGs are stored as `ycbcr` 4:4:4 after `jpeg-decoder` RGB output
  is converted with Go's `RGBToYCbCr`/`YCbCrToRGB`. DecodeConfig matches Go
  (`gray` / `ycbcr` / `cmyk` from SOF).
- GIF encode uses the Plan9 palette (first `numColors` entries), not Go's
  default median-cut quantizer. Decode of Go-produced GIFs is the
  interoperability path.
- `rustd-compress` is not on `main` yet; PNG uses the `png` crate's Rust
  deflate (`miniz_oxide` / `fdeflate`), not a C zlib and not `rustd-compress`.
- No `RegisterFormat`, APNG, WebP, canvas, ICC application, or EXIF rewrite.
- Stream helpers (`pngDecodeStream`, …) concatenate the async iterable then
  decode; they do not emit scanlines incrementally (issue non-goal).

## Size

Linux x64 GNU release + strip, Rust 1.97.1 (2026-09-14): **882,232 bytes** / 3,000,000.

Go `image/png` testdata + pngsuite + generated JPEG/GIF/boundary fixtures: **46** files. PNG
`DecodeConfig` fields and RGBA64 pixdumps match Go, including 1/2/4/8/16-bit,
Adam7, tRNS, 1×1, gray, and fully-transparent. Every truncated prefix of the Go
1×1 PNG throws `PngFormatError`. JPEG is config-only (IDCT is not pixel-identical). GIF
`DecodeAll` matches loop/delay/disposal/pixdump on the two-frame fixture.

```text
$ ls -l packages/rustd-image/*.node
-rwxrwxr-x 1 akrc akrc 882232 Sep 14 17:09 packages/rustd-image/rustd-image.linux-x64-gnu.node
```
