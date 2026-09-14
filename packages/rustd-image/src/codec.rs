use std::io::Cursor;

use crate::color::{self, Model, Rgba16};
use crate::geom::Rect;
use crate::image::{Image, ImageError};

pub struct Config {
    pub width: u32,
    pub height: u32,
    pub color_model: Model,
}

fn too_large(w: u32, h: u32, max_pixels: Option<u64>) -> Result<(), ImageError> {
    let n = u64::from(w).saturating_mul(u64::from(h));
    if let Some(max) = max_pixels {
        if n > max {
            return Err(ImageError::new(
                "ImageTooLargeError",
                format!("image: {w}x{h} exceeds maxPixels {max}"),
            ));
        }
    }
    Ok(())
}

fn map_png(err: png::DecodingError) -> ImageError {
    ImageError::new("PngFormatError", err.to_string())
}
fn map_png_enc(err: png::EncodingError) -> ImageError {
    ImageError::new("PngFormatError", err.to_string())
}

const PNG_SIG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

fn png_format_err(msg: impl Into<String>) -> ImageError {
    ImageError::new("PngFormatError", msg)
}

/// Go's `png.Decode` refuses every truncated prefix (usually `unexpected EOF`).
/// The `png` crate can succeed once IDAT is complete even if IEND is missing;
/// issue #19 §4.7 requires `PngFormatError` on every strict prefix.
fn png_require_iend(buf: &[u8]) -> Result<(), ImageError> {
    if buf.len() < 8 || &buf[..8] != PNG_SIG {
        return Err(png_format_err("png: invalid format: not a PNG file"));
    }
    let mut i = 8usize;
    loop {
        if i.checked_add(8).map(|n| n > buf.len()).unwrap_or(true) {
            return Err(png_format_err("png: unexpected EOF"));
        }
        let len = u32::from_be_bytes(buf[i..i + 4].try_into().unwrap()) as usize;
        let typ = &buf[i + 4..i + 8];
        let chunk_end = i
            .checked_add(12)
            .and_then(|n| n.checked_add(len))
            .ok_or_else(|| png_format_err("png: invalid format: chunk too large"))?;
        if chunk_end > buf.len() {
            return Err(png_format_err("png: unexpected EOF"));
        }
        if typ == b"IEND" {
            return Ok(());
        }
        i = chunk_end;
    }
}

fn png_reject_empty(width: u32, height: u32) -> Result<(), ImageError> {
    if width == 0 || height == 0 {
        return Err(png_format_err(format!(
            "png: invalid format: non-positive dimension: {width}x{height}"
        )));
    }
    Ok(())
}

/// Go verifies zlib Adler-32 (`png: invalid format: zlib: invalid checksum`).
/// The `png` crate defaults to `ignore_adler32 = true`.
fn png_decoder(buf: &[u8]) -> png::Decoder<Cursor<&[u8]>> {
    let mut opts = png::DecodeOptions::default();
    opts.set_ignore_adler32(false);
    png::Decoder::new_with_options(Cursor::new(buf), opts)
}

pub fn png_decode_config(buf: &[u8]) -> Result<Config, ImageError> {
    let decoder = png_decoder(buf);
    let reader = decoder.read_info().map_err(map_png)?;
    let info = reader.info();
    png_reject_empty(info.width, info.height)?;
    Ok(Config {
        width: info.width,
        height: info.height,
        // Match Go DecodeConfig: tRNS does not change gray/RGB models here.
        color_model: png_config_model(info.color_type, info.bit_depth),
    })
}

fn png_config_model(ct: png::ColorType, depth: png::BitDepth) -> Model {
    match (ct, depth) {
        (png::ColorType::Grayscale, png::BitDepth::Sixteen) => Model::Gray16,
        (png::ColorType::Grayscale, _) => Model::Gray,
        (png::ColorType::GrayscaleAlpha, png::BitDepth::Sixteen) => Model::Nrgba64,
        (png::ColorType::GrayscaleAlpha, _) => Model::Nrgba,
        (png::ColorType::Rgb, png::BitDepth::Sixteen) => Model::Rgba64,
        (png::ColorType::Rgb, _) => Model::Rgba,
        (png::ColorType::Rgba, png::BitDepth::Sixteen) => Model::Nrgba64,
        (png::ColorType::Rgba, _) => Model::Nrgba,
        (png::ColorType::Indexed, _) => Model::Paletted,
    }
}

fn bit_depth_u8(d: png::BitDepth) -> u8 {
    match d {
        png::BitDepth::One => 1,
        png::BitDepth::Two => 2,
        png::BitDepth::Four => 4,
        png::BitDepth::Eight => 8,
        png::BitDepth::Sixteen => 16,
    }
}

fn scale_gray8(bits: u16, depth: u8) -> u8 {
    match depth {
        1 => (bits as u8) * 0xff,
        2 => (bits as u8) * 0x55,
        4 => (bits as u8) * 0x11,
        _ => bits as u8,
    }
}

fn unpack_samples(
    src: &[u8],
    width: usize,
    height: usize,
    depth: u8,
    channels: usize,
) -> Result<Vec<u16>, ImageError> {
    let row_bytes = (width * channels * depth as usize + 7) / 8;
    let need = row_bytes.saturating_mul(height);
    if src.len() < need {
        return Err(ImageError::new(
            "PngFormatError",
            format!("png: short frame {} < {need}", src.len()),
        ));
    }
    let mut out = vec![0u16; width * height * channels];
    for y in 0..height {
        let row = &src[y * row_bytes..(y + 1) * row_bytes];
        let mut bit = 0usize;
        for x in 0..width {
            for c in 0..channels {
                out[(y * width + x) * channels + c] = read_bits(row, bit, depth)?;
                bit += depth as usize;
            }
        }
    }
    Ok(out)
}

fn read_bits(row: &[u8], bit: usize, depth: u8) -> Result<u16, ImageError> {
    if depth == 16 {
        let i = bit / 8;
        if i + 1 >= row.len() {
            return Err(ImageError::new("PngFormatError", "png: short 16-bit sample"));
        }
        return Ok(u16::from_be_bytes([row[i], row[i + 1]]));
    }
    let i = bit / 8;
    if i >= row.len() {
        return Err(ImageError::new("PngFormatError", "png: short packed sample"));
    }
    let shift = 8 - depth as usize - (bit % 8);
    let mask = (1u16 << depth) - 1;
    Ok((u16::from(row[i]) >> shift) & mask)
}

fn put_nrgba8(pix: &mut [u8], i: usize, r: u8, g: u8, b: u8, a: u8) {
    pix[i] = r;
    pix[i + 1] = g;
    pix[i + 2] = b;
    pix[i + 3] = a;
}

fn put_rgba8(pix: &mut [u8], i: usize, r: u8, g: u8, b: u8, a: u8) {
    put_nrgba8(pix, i, r, g, b, a);
}

fn put_nrgba64(pix: &mut [u8], i: usize, r: u16, g: u16, b: u16, a: u16) {
    pix[i..i + 2].copy_from_slice(&r.to_be_bytes());
    pix[i + 2..i + 4].copy_from_slice(&g.to_be_bytes());
    pix[i + 4..i + 6].copy_from_slice(&b.to_be_bytes());
    pix[i + 6..i + 8].copy_from_slice(&a.to_be_bytes());
}

pub fn png_decode(buf: &[u8], max_pixels: Option<u64>) -> Result<Image, ImageError> {
    png_require_iend(buf)?;
    let decoder = png_decoder(buf);
    let mut reader = decoder.read_info().map_err(map_png)?;
    let info = reader.info().clone();
    png_reject_empty(info.width, info.height)?;
    too_large(info.width, info.height, max_pixels)?;
    let mut frame = vec![
        0;
        reader
            .output_buffer_size()
            .ok_or_else(|| ImageError::new("PngFormatError", "png: overflow computing output size"))?
    ];
    let output = reader.next_frame(&mut frame).map_err(map_png)?;
    let rect = Rect::new(0, 0, info.width as i32, info.height as i32);
    let w = info.width as usize;
    let h = info.height as usize;
    let depth = bit_depth_u8(output.bit_depth);
    let trns = info.trns.as_deref();
    let samples = unpack_samples(&frame[..output.buffer_size()], w, h, depth, output.color_type.samples())?;

    match output.color_type {
        png::ColorType::Grayscale => {
            let use_trns = trns.map(|t| t.len() >= 2).unwrap_or(false);
            if depth == 16 {
                if use_trns {
                    let ty = u16::from_be_bytes([trns.unwrap()[0], trns.unwrap()[1]]);
                    let img = Image::alloc(Model::Nrgba64, rect, None)?;
                    img.with_pix_mut(|pix| {
                        for y in 0..h {
                            for x in 0..w {
                                let ycol = samples[y * w + x];
                                let a = if ycol == ty { 0 } else { 0xffff };
                                let i = img.pix_index(x as i32, y as i32);
                                put_nrgba64(pix, i, ycol, ycol, ycol, a);
                            }
                        }
                    })?;
                    Ok(img)
                } else {
                    let img = Image::alloc(Model::Gray16, rect, None)?;
                    img.with_pix_mut(|pix| {
                        for y in 0..h {
                            for x in 0..w {
                                let i = img.pix_index(x as i32, y as i32);
                                pix[i..i + 2].copy_from_slice(&samples[y * w + x].to_be_bytes());
                            }
                        }
                    })?;
                    Ok(img)
                }
            } else {
                // Go scales the tRNS gray sample for 1/2/4-bit before comparing.
                let raw = match trns {
                    Some(t) if t.len() >= 2 => t[1],
                    Some(t) if !t.is_empty() => t[0],
                    _ => 0,
                };
                let ty8 = scale_gray8(u16::from(raw), depth);
                let use_trns8 = trns.map(|t| !t.is_empty()).unwrap_or(false);
                if use_trns8 {
                    let img = Image::alloc(Model::Nrgba, rect, None)?;
                    img.with_pix_mut(|pix| {
                        for y in 0..h {
                            for x in 0..w {
                                let ycol = scale_gray8(samples[y * w + x], depth);
                                let a = if ycol == ty8 { 0 } else { 0xff };
                                let i = img.pix_index(x as i32, y as i32);
                                put_nrgba8(pix, i, ycol, ycol, ycol, a);
                            }
                        }
                    })?;
                    Ok(img)
                } else {
                    let img = Image::alloc(Model::Gray, rect, None)?;
                    img.with_pix_mut(|pix| {
                        for y in 0..h {
                            for x in 0..w {
                                let i = img.pix_index(x as i32, y as i32);
                                pix[i] = scale_gray8(samples[y * w + x], depth);
                            }
                        }
                    })?;
                    Ok(img)
                }
            }
        }
        png::ColorType::GrayscaleAlpha => {
            if depth == 16 {
                let img = Image::alloc(Model::Nrgba64, rect, None)?;
                img.with_pix_mut(|pix| {
                    for y in 0..h {
                        for x in 0..w {
                            let o = (y * w + x) * 2;
                            let ycol = samples[o];
                            let a = samples[o + 1];
                            let i = img.pix_index(x as i32, y as i32);
                            put_nrgba64(pix, i, ycol, ycol, ycol, a);
                        }
                    }
                })?;
                Ok(img)
            } else {
                let img = Image::alloc(Model::Nrgba, rect, None)?;
                img.with_pix_mut(|pix| {
                    for y in 0..h {
                        for x in 0..w {
                            let o = (y * w + x) * 2;
                            let ycol = samples[o] as u8;
                            let a = samples[o + 1] as u8;
                            let i = img.pix_index(x as i32, y as i32);
                            put_nrgba8(pix, i, ycol, ycol, ycol, a);
                        }
                    }
                })?;
                Ok(img)
            }
        }
        png::ColorType::Rgb => {
            let use_trns = trns.map(|t| t.len() >= 6).unwrap_or(false);
            if depth == 16 {
                if use_trns {
                    let t = trns.unwrap();
                    let tr = u16::from_be_bytes([t[0], t[1]]);
                    let tg = u16::from_be_bytes([t[2], t[3]]);
                    let tb = u16::from_be_bytes([t[4], t[5]]);
                    let img = Image::alloc(Model::Nrgba64, rect, None)?;
                    img.with_pix_mut(|pix| {
                        for y in 0..h {
                            for x in 0..w {
                                let o = (y * w + x) * 3;
                                let r = samples[o];
                                let g = samples[o + 1];
                                let b = samples[o + 2];
                                let a = if r == tr && g == tg && b == tb { 0 } else { 0xffff };
                                let i = img.pix_index(x as i32, y as i32);
                                put_nrgba64(pix, i, r, g, b, a);
                            }
                        }
                    })?;
                    Ok(img)
                } else {
                    let img = Image::alloc(Model::Rgba64, rect, None)?;
                    img.with_pix_mut(|pix| {
                        for y in 0..h {
                            for x in 0..w {
                                let o = (y * w + x) * 3;
                                let i = img.pix_index(x as i32, y as i32);
                                put_nrgba64(pix, i, samples[o], samples[o + 1], samples[o + 2], 0xffff);
                            }
                        }
                    })?;
                    Ok(img)
                }
            } else if trns.map(|t| t.len() >= 3).unwrap_or(false) {
                let t = trns.unwrap();
                let (tr, tg, tb) = if t.len() >= 6 {
                    (t[1], t[3], t[5])
                } else {
                    (t[0], t[1], t[2])
                };
                let img = Image::alloc(Model::Nrgba, rect, None)?;
                img.with_pix_mut(|pix| {
                    for y in 0..h {
                        for x in 0..w {
                            let o = (y * w + x) * 3;
                            let r = samples[o] as u8;
                            let g = samples[o + 1] as u8;
                            let b = samples[o + 2] as u8;
                            let a = if r == tr && g == tg && b == tb { 0 } else { 0xff };
                            let i = img.pix_index(x as i32, y as i32);
                            put_nrgba8(pix, i, r, g, b, a);
                        }
                    }
                })?;
                Ok(img)
            } else {
                let img = Image::alloc(Model::Rgba, rect, None)?;
                img.with_pix_mut(|pix| {
                    for y in 0..h {
                        for x in 0..w {
                            let o = (y * w + x) * 3;
                            let i = img.pix_index(x as i32, y as i32);
                            put_rgba8(pix, i, samples[o] as u8, samples[o + 1] as u8, samples[o + 2] as u8, 0xff);
                        }
                    }
                })?;
                Ok(img)
            }
        }
        png::ColorType::Rgba => {
            if depth == 16 {
                let img = Image::alloc(Model::Nrgba64, rect, None)?;
                img.with_pix_mut(|pix| {
                    for y in 0..h {
                        for x in 0..w {
                            let o = (y * w + x) * 4;
                            let i = img.pix_index(x as i32, y as i32);
                            put_nrgba64(pix, i, samples[o], samples[o + 1], samples[o + 2], samples[o + 3]);
                        }
                    }
                })?;
                Ok(img)
            } else {
                let img = Image::alloc(Model::Nrgba, rect, None)?;
                img.with_pix_mut(|pix| {
                    for y in 0..h {
                        for x in 0..w {
                            let o = (y * w + x) * 4;
                            let i = img.pix_index(x as i32, y as i32);
                            put_nrgba8(
                                pix,
                                i,
                                samples[o] as u8,
                                samples[o + 1] as u8,
                                samples[o + 2] as u8,
                                samples[o + 3] as u8,
                            );
                        }
                    }
                })?;
                Ok(img)
            }
        }
        png::ColorType::Indexed => {
            let pal = info
                .palette
                .as_ref()
                .map(|p| {
                    p.chunks(3)
                        .enumerate()
                        .map(|(i, rgb)| {
                            let a = info.trns.as_ref().and_then(|t| t.get(i).copied()).unwrap_or(255);
                            [rgb[0], rgb[1], rgb[2], a]
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_else(|| vec![[0, 0, 0, 255]]);
            let img = Image::alloc(Model::Paletted, rect, Some(pal))?;
            img.with_pix_mut(|pix| {
                for y in 0..h {
                    for x in 0..w {
                        let i = img.pix_index(x as i32, y as i32);
                        pix[i] = samples[y * w + x] as u8;
                    }
                }
            })?;
            Ok(img)
        }
    }
}

pub fn png_encode(img: &Image, level: i32) -> Result<Vec<u8>, ImageError> {
    let w = img.width() as u32;
    let h = img.height() as u32;
    if w == 0 || h == 0 {
        return Err(png_format_err(format!(
            "png: invalid format: invalid image size: {w}x{h}"
        )));
    }
    let mut rgba = vec![0u8; (w as usize) * (h as usize) * 4];
    for y in 0..img.height() {
        for x in 0..img.width() {
            let c = img.at_rgba(x, y)?;
            let n = c.to_nrgba8();
            let i = ((y as u32 * w + x as u32) as usize) * 4;
            rgba[i..i + 4].copy_from_slice(&n);
        }
    }
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(match level {
        -1 => png::Compression::NoCompression,
        -2 => png::Compression::Fast,
        -3 => png::Compression::High,
        _ => png::Compression::Balanced,
    });
    let mut writer = encoder.write_header().map_err(map_png_enc)?;
    writer.write_image_data(&rgba).map_err(map_png_enc)?;
    writer.finish().map_err(map_png_enc)?;
    Ok(out)
}

fn jpeg_config_from_bytes(buf: &[u8]) -> Result<Config, ImageError> {
    // Scan SOF markers. Baseline/extended/progressive only.
    if buf.len() < 2 || buf[0] != 0xff || buf[1] != 0xd8 {
        return Err(ImageError::new("JpegFormatError", "jpeg: missing SOI"));
    }
    let mut i = 2usize;
    while i + 4 <= buf.len() {
        if buf[i] != 0xff {
            i += 1;
            continue;
        }
        while i < buf.len() && buf[i] == 0xff {
            i += 1;
        }
        if i >= buf.len() {
            break;
        }
        let marker = buf[i];
        i += 1;
        if marker == 0xd8 || marker == 0xd9 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if i + 2 > buf.len() {
            break;
        }
        let len = u16::from_be_bytes([buf[i], buf[i + 1]]) as usize;
        if len < 2 || i + len > buf.len() {
            return Err(ImageError::new("JpegFormatError", "jpeg: truncated marker"));
        }
        let data = &buf[i + 2..i + len];
        i += len;
        match marker {
            0xc0 | 0xc1 | 0xc2 | 0xc9 | 0xca => {
                if data.len() < 6 {
                    return Err(ImageError::new("JpegFormatError", "jpeg: truncated SOF"));
                }
                let height = u16::from_be_bytes([data[1], data[2]]) as u32;
                let width = u16::from_be_bytes([data[3], data[4]]) as u32;
                let nf = data[5];
                let color_model = match nf {
                    1 => Model::Gray,
                    4 => Model::Cmyk,
                    _ => Model::Ycbcr,
                };
                return Ok(Config { width, height, color_model });
            }
            0xc3 | 0xc5 | 0xc6 | 0xc7 | 0xcb | 0xcd | 0xce | 0xcf => {
                return Err(ImageError::new(
                    "JpegUnsupportedError",
                    format!("jpeg: unsupported SOF marker 0x{marker:02x}"),
                ));
            }
            _ => {}
        }
    }
    Err(ImageError::new("JpegFormatError", "jpeg: missing SOF"))
}

pub fn jpeg_decode_config(buf: &[u8]) -> Result<Config, ImageError> {
    jpeg_config_from_bytes(buf)
}

/// Go's `jpeg.Decode` errors with `uninitialized Huffman table` when no DHT
/// appears before SOS. `DecodeConfig` only needs SOF and must still succeed.
fn jpeg_require_dht(buf: &[u8]) -> Result<(), ImageError> {
    if buf.len() < 2 || buf[0] != 0xff || buf[1] != 0xd8 {
        return Err(ImageError::new("JpegFormatError", "jpeg: missing SOI"));
    }
    let mut i = 2usize;
    let mut seen_dht = false;
    while i + 1 <= buf.len() {
        if buf[i] != 0xff {
            i += 1;
            continue;
        }
        while i < buf.len() && buf[i] == 0xff {
            i += 1;
        }
        if i >= buf.len() {
            break;
        }
        let marker = buf[i];
        i += 1;
        if marker == 0xd8 || marker == 0xd9 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if i + 2 > buf.len() {
            break;
        }
        let len = u16::from_be_bytes([buf[i], buf[i + 1]]) as usize;
        if len < 2 || i + len > buf.len() {
            return Err(ImageError::new("JpegFormatError", "jpeg: truncated marker"));
        }
        i += len;
        match marker {
            0xc4 => seen_dht = true,
            0xda => {
                if !seen_dht {
                    return Err(ImageError::new(
                        "JpegFormatError",
                        "jpeg: uninitialized Huffman table",
                    ));
                }
                return Ok(());
            }
            _ => {}
        }
    }
    if !seen_dht {
        return Err(ImageError::new(
            "JpegFormatError",
            "jpeg: uninitialized Huffman table",
        ));
    }
    Ok(())
}

pub fn jpeg_decode(buf: &[u8], max_pixels: Option<u64>) -> Result<Image, ImageError> {
    let cfg = jpeg_config_from_bytes(buf)?;
    too_large(cfg.width, cfg.height, max_pixels)?;
    jpeg_require_dht(buf)?;
    let mut decoder = jpeg_decoder::Decoder::new(Cursor::new(buf));
    let pixels = decoder
        .decode()
        .map_err(|e| ImageError::new("JpegFormatError", e.to_string()))?;
    let info = decoder.info().ok_or_else(|| ImageError::new("JpegFormatError", "jpeg: missing info"))?;
    let w = info.width as usize;
    let h = info.height as usize;
    let rect = Rect::new(0, 0, info.width as i32, info.height as i32);
    match info.pixel_format {
        jpeg_decoder::PixelFormat::L8 => {
            let img = Image::alloc(Model::Gray, rect, None)?;
            for y in 0..h {
                for x in 0..w {
                    img.set_rgba(x as i32, y as i32, Rgba16::from_gray8(pixels[y * w + x]))?;
                }
            }
            Ok(img)
        }
        jpeg_decoder::PixelFormat::RGB24 => {
            // DecodeConfig still reports ycbcr (SOF). Pixels come from jpeg-decoder as RGB.
            let img = Image::alloc(Model::Nrgba, rect, None)?;
            for y in 0..h {
                for x in 0..w {
                    let i = (y * w + x) * 3;
                    img.set_rgba(
                        x as i32,
                        y as i32,
                        Rgba16::from_nrgba8(pixels[i], pixels[i + 1], pixels[i + 2], 255),
                    )?;
                }
            }
            Ok(img)
        }
        jpeg_decoder::PixelFormat::CMYK32 => {
            let img = Image::alloc(Model::Cmyk, rect, None)?;
            for y in 0..h {
                for x in 0..w {
                    let i = (y * w + x) * 4;
                    let (r, g, b) = color::cmyk_to_rgb(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]);
                    img.set_rgba(x as i32, y as i32, Rgba16::from_rgba8(r, g, b, 255))?;
                }
            }
            Ok(img)
        }
        other => Err(ImageError::new("JpegUnsupportedError", format!("jpeg: unsupported {other:?}"))),
    }
}

pub fn jpeg_encode(img: &Image, quality: i32) -> Result<Vec<u8>, ImageError> {
    let q = if quality <= 0 { 75 } else { quality.clamp(1, 100) as u8 };
    let w = img.width() as u16;
    let h = img.height() as u16;
    if w == 0 || h == 0 {
        return Err(ImageError::new("JpegFormatError", "jpeg: empty image"));
    }
    let mut rgb = vec![0u8; (w as usize) * (h as usize) * 3];
    for y in 0..img.height() {
        for x in 0..img.width() {
            let c = img.at_rgba(x, y)?;
            let i = ((y as usize) * (w as usize) + x as usize) * 3;
            rgb[i] = c.r_hi();
            rgb[i + 1] = c.g_hi();
            rgb[i + 2] = c.b_hi();
        }
    }
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, q)
        .encode(&rgb, w, h, jpeg_encoder::ColorType::Rgb)
        .map_err(|e| ImageError::new("JpegFormatError", e.to_string()))?;
    Ok(out)
}

pub struct GifData {
    pub frames: Vec<Image>,
    pub delay: Vec<i32>,
    pub loop_count: i32,
    pub disposal: Vec<i32>,
    pub background_index: i32,
    pub config: Config,
}

pub fn gif_decode_config(buf: &[u8]) -> Result<Config, ImageError> {
    let mut opts = gif::DecodeOptions::new();
    opts.set_color_output(gif::ColorOutput::Indexed);
    let decoder = opts.read_info(Cursor::new(buf)).map_err(|e| ImageError::new("GifFormatError", e.to_string()))?;
    Ok(Config {
        width: decoder.width() as u32,
        height: decoder.height() as u32,
        color_model: Model::Paletted,
    })
}

pub fn gif_decode(buf: &[u8], max_pixels: Option<u64>) -> Result<Image, ImageError> {
    let all = gif_decode_all(buf, max_pixels)?;
    all.frames.into_iter().next().ok_or_else(|| ImageError::new("GifFormatError", "gif: no frames"))
}

pub fn gif_decode_all(buf: &[u8], max_pixels: Option<u64>) -> Result<GifData, ImageError> {
    let mut opts = gif::DecodeOptions::new();
    opts.set_color_output(gif::ColorOutput::Indexed);
    let mut decoder = opts
        .read_info(Cursor::new(buf))
        .map_err(|e| ImageError::new("GifFormatError", e.to_string()))?;
    let lw = decoder.width() as u32;
    let lh = decoder.height() as u32;
    too_large(lw, lh, max_pixels)?;
    let bg = decoder.bg_color().unwrap_or(0) as i32;
    let global_palette = decoder.global_palette().map(|p| p.to_vec());
    let mut frames = Vec::new();
    let mut delay = Vec::new();
    let mut disposal = Vec::new();
    while let Some(frame) = decoder
        .read_next_frame()
        .map_err(|e| ImageError::new("GifFormatError", e.to_string()))?
    {
        let pal_bytes = frame
            .palette
            .as_deref()
            .or(global_palette.as_deref());
        let mut pal = pal_bytes
            .map(|p| {
                p.chunks(3)
                    .map(|rgb| [rgb[0], rgb[1], rgb[2], 255])
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| vec![[0, 0, 0, 255]]);
        if let Some(t) = frame.transparent {
            if let Some(slot) = pal.get_mut(t as usize) {
                slot[3] = 0;
            }
        }
        let rect = Rect::new(
            frame.left as i32,
            frame.top as i32,
            frame.left as i32 + frame.width as i32,
            frame.top as i32 + frame.height as i32,
        );
        too_large(frame.width as u32, frame.height as u32, max_pixels)?;
        let img = Image::alloc(Model::Paletted, rect, Some(pal))?;
        let w = frame.width as usize;
        let h = frame.height as usize;
        for y in 0..h {
            for x in 0..w {
                let idx = frame.buffer[y * w + x];
                let pal = img.palette().unwrap_or(&[]);
                if let Some(p) = pal.get(idx as usize) {
                    img.set_rgba(
                        rect.min.x + x as i32,
                        rect.min.y + y as i32,
                        Rgba16::from_nrgba8(p[0], p[1], p[2], p[3]),
                    )?;
                }
            }
        }
        frames.push(img);
        delay.push(frame.delay as i32);
        disposal.push(match frame.dispose {
            gif::DisposalMethod::Any => 0,
            gif::DisposalMethod::Keep => 1,
            gif::DisposalMethod::Background => 2,
            gif::DisposalMethod::Previous => 3,
        });
    }
    let loop_count = match decoder.repeat() {
        gif::Repeat::Infinite => 0,
        gif::Repeat::Finite(0) => -1,
        gif::Repeat::Finite(n) => i32::from(n),
    };
    Ok(GifData {
        frames,
        delay,
        loop_count,
        disposal,
        background_index: bg,
        config: Config { width: lw, height: lh, color_model: Model::Paletted },
    })
}

pub fn gif_encode(img: &Image, num_colors: i32) -> Result<Vec<u8>, ImageError> {
    gif_encode_all(&[img.clone()], &[10], 0, &[0], num_colors)
}

pub fn gif_encode_all(
    frames: &[Image],
    delay: &[i32],
    loop_count: i32,
    disposal: &[i32],
    num_colors: i32,
) -> Result<Vec<u8>, ImageError> {
    if frames.is_empty() {
        return Err(ImageError::new("GifFormatError", "gif: no frames"));
    }
    let w = frames[0].width() as u16;
    let h = frames[0].height() as u16;
    let n = if num_colors <= 0 { 256 } else { num_colors.clamp(1, 256) as usize };
    let pal = crate::color::plan9();
    let pal = &pal[..n.min(pal.len())];
    let mut global = Vec::with_capacity(pal.len() * 3);
    for p in pal {
        global.extend_from_slice(&p[..3]);
    }
    let mut out = Vec::new();
    {
        let mut encoder = gif::Encoder::new(&mut out, w, h, &global)
            .map_err(|e| ImageError::new("GifFormatError", e.to_string()))?;
        // Match Go EncodeAll: NETSCAPE only when there are 2+ frames and LoopCount >= 0.
        // LoopCount 0 = infinite; negative = play once (omit the extension).
        if frames.len() > 1 && loop_count >= 0 {
            encoder
                .set_repeat(if loop_count == 0 {
                    gif::Repeat::Infinite
                } else {
                    gif::Repeat::Finite(loop_count as u16)
                })
                .map_err(|e| ImageError::new("GifFormatError", e.to_string()))?;
        }
        for (i, frame_img) in frames.iter().enumerate() {
            let mut indices = vec![0u8; (w as usize) * (h as usize)];
            for y in 0..frame_img.height() {
                for x in 0..frame_img.width() {
                    let c = frame_img.at_rgba(x, y)?;
                    indices[(y as usize) * (w as usize) + x as usize] = color::palette_index(pal, c) as u8;
                }
            }
            let mut frame = gif::Frame::from_indexed_pixels(w, h, indices, None);
            frame.delay = *delay.get(i).unwrap_or(&10) as u16;
            frame.dispose = match *disposal.get(i).unwrap_or(&0) {
                2 => gif::DisposalMethod::Background,
                3 => gif::DisposalMethod::Previous,
                1 => gif::DisposalMethod::Keep,
                _ => gif::DisposalMethod::Any,
            };
            encoder
                .write_frame(&frame)
                .map_err(|e| ImageError::new("GifFormatError", e.to_string()))?;
        }
    }
    Ok(out)
}
