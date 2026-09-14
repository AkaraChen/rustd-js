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
before allocating pixels, and pass `maxPixels` to `*Decode` / `gifDecodeAll`.
Config paths do not allocate a pixel buffer: a 100000×100000 PNG IHDR must not
grow process RSS by 10MB. `maxPixels` is checked from the PNG IHDR / GIF
logical screen **before** frame buffers are allocated (`ImageTooLargeError`).

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

Linux x64 GNU release + strip, Rust 1.97.1 (2026-09-14): **882,856 bytes** / 3,000,000.

Go `image/png` testdata + pngsuite + generated JPEG/GIF/boundary fixtures: **46** files. PNG
`DecodeConfig` fields and RGBA64 pixdumps match Go, including 1/2/4/8/16-bit,
Adam7, tRNS, 1×1, gray, and fully-transparent. Every truncated prefix of the Go
1×1 PNG throws `PngFormatError`. JPEG is config-only (IDCT is not pixel-identical). GIF
`DecodeAll` matches loop/delay/disposal/pixdump on the two-frame fixture.

Reverse (issue #19 §4.2): `pngEncode` at CompressionLevel `0/-1/-2/-3` round-trips
through Go `png.Decode` with identical RGBA64 pixdump. `jpegEncode` is checked with
PSNR ≥ 40 dB against the source (not pixel-identical). `gifEncode` bytes decode
under Go `gif.Decode` to the same pixdump as `gifDecode`.

```text
$ ls -l packages/rustd-image/*.node
-rwxrwxr-x 1 akrc akrc 882856 Sep 14 17:46 packages/rustd-image/rustd-image.linux-x64-gnu.node
```

## Performance (issue #19 §4.9)

Run `nice -n 10 node packages/rustd-image/test/benchmark.mjs`. Recorded on
2026-09-14, AMD EPYC 9645, Linux x64, Node 24.20.0, Go 1.25.0, `GOMAXPROCS=1`:
one sequential pass of a 512×512 seeded-random NRGBA (PNG 787,545 bytes, JPEG
158,294 bytes, quality 75), 8 iterations each. Shared host with concurrent
workers; these numbers describe the observed run, not a speedup claim.
Machine-readable output: `test/benchmark-results.json`.

Issue #19 requires **decode** throughput ≥ 60% of same-host Go. Encode is
reported for completeness and is not a floor.

| Op | rustd-image MP/s | Go MP/s | % of Go |
| --- | ---: | ---: | ---: |
| pngDecode | 30.08 | 84.34 | 36 |
| jpegDecode | 13.36 | 28.15 | 47 |
| pngEncode | 2.49 | 3.60 | 69 |
| jpegEncode | 14.45 | 12.53 | 115 |

Decode is below the 60% floor on this host. Causes and follow-up (not silent):

- **pngDecode (36%)**: the `png` crate uses `miniz_oxide` / `fdeflate` (pure
  Rust, no C zlib). After inflate we unpack samples and copy into Go stride
  models (NRGBA/Gray/… plus an IEND-presence scan so truncated prefixes match
  Go). That second pass is extra work Go's `image/png` does not do as a
  separate copy. Next: wire `rustd-compress` once it is on `main`; only then
  consider `spng` (C) if inflate is still the bottleneck. Issue #19 §6 keeps
  `spng` out of the first release.
- **jpegDecode (47%)**: `jpeg-decoder` with `rayon` **off** (napi + size). Go's
  `image/jpeg` IDCT is faster here. Next: switch to `zune-jpeg` (pure Rust) and
  re-run the full JPEG interop matrix, as issue #19 §6 already names that
  fallback. Do not turn `rayon` on.

`jpegEncode` already meets Go on this run. `pngEncode` is 69% of Go with the
same pure-Rust deflate backend.
