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

pub fn png_decode_config(buf: &[u8]) -> Result<Config, ImageError> {
    let decoder = png::Decoder::new(Cursor::new(buf));
    let reader = decoder.read_info().map_err(map_png)?;
    let info = reader.info();
    Ok(Config {
        width: info.width,
        height: info.height,
        color_model: png_model(info.color_type, info.bit_depth, info.trns.is_some()),
    })
}

fn png_model(ct: png::ColorType, depth: png::BitDepth, trns: bool) -> Model {
    match (ct, depth) {
        (png::ColorType::Grayscale, png::BitDepth::Sixteen) => Model::Gray16,
        (png::ColorType::Grayscale, _) => Model::Gray,
        (png::ColorType::GrayscaleAlpha, png::BitDepth::Sixteen) => Model::Nrgba64,
        (png::ColorType::GrayscaleAlpha, _) => Model::Nrgba,
        (png::ColorType::Rgb, png::BitDepth::Sixteen) => {
            if trns { Model::Nrgba64 } else { Model::Rgba64 }
        }
        (png::ColorType::Rgb, _) => {
            if trns { Model::Nrgba } else { Model::Rgba }
        }
        (png::ColorType::Rgba, png::BitDepth::Sixteen) => Model::Nrgba64,
        (png::ColorType::Rgba, _) => Model::Nrgba,
        (png::ColorType::Indexed, _) => Model::Paletted,
    }
}

pub fn png_decode(buf: &[u8], max_pixels: Option<u64>) -> Result<Image, ImageError> {
    let decoder = png::Decoder::new(Cursor::new(buf));
    let mut reader = decoder.read_info().map_err(map_png)?;
    let info = reader.info().clone();
    too_large(info.width, info.height, max_pixels)?;
    let mut frame = vec![
        0;
        reader
            .output_buffer_size()
            .ok_or_else(|| ImageError::new("PngFormatError", "png: overflow computing output size"))?
    ];
    let output = reader.next_frame(&mut frame).map_err(map_png)?;
    let rect = Rect::new(0, 0, info.width as i32, info.height as i32);
    let model = png_model(info.color_type, info.bit_depth, info.trns.is_some());
    let w = info.width as usize;
    let h = info.height as usize;
    match output.color_type {
        png::ColorType::Rgba if output.bit_depth == png::BitDepth::Eight => {
            let img = Image::alloc(if matches!(model, Model::Rgba) { Model::Rgba } else { Model::Nrgba }, rect, None)?;
            for y in 0..h {
                for x in 0..w {
                    let i = (y * w + x) * 4;
                    let c = if matches!(model, Model::Rgba) {
                        Rgba16::from_rgba8(frame[i], frame[i + 1], frame[i + 2], frame[i + 3])
                    } else {
                        Rgba16::from_nrgba8(frame[i], frame[i + 1], frame[i + 2], frame[i + 3])
                    };
                    img.set_rgba(x as i32, y as i32, c)?;
                }
            }
            Ok(img)
        }
        png::ColorType::Rgb if output.bit_depth == png::BitDepth::Eight => {
            let img = Image::alloc(Model::Rgba, rect, None)?;
            for y in 0..h {
                for x in 0..w {
                    let i = (y * w + x) * 3;
                    img.set_rgba(x as i32, y as i32, Rgba16::from_rgba8(frame[i], frame[i + 1], frame[i + 2], 255))?;
                }
            }
            Ok(img)
        }
        png::ColorType::Grayscale if output.bit_depth == png::BitDepth::Eight => {
            let img = Image::alloc(Model::Gray, rect, None)?;
            for y in 0..h {
                for x in 0..w {
                    img.set_rgba(x as i32, y as i32, Rgba16::from_gray8(frame[y * w + x]))?;
                }
            }
            Ok(img)
        }
        png::ColorType::Grayscale if output.bit_depth == png::BitDepth::Sixteen => {
            let img = Image::alloc(Model::Gray16, rect, None)?;
            for y in 0..h {
                for x in 0..w {
                    let i = (y * w + x) * 2;
                    img.set_rgba(x as i32, y as i32, Rgba16::from_gray16(u16::from_be_bytes([frame[i], frame[i + 1]])))?;
                }
            }
            Ok(img)
        }
        png::ColorType::GrayscaleAlpha if output.bit_depth == png::BitDepth::Eight => {
            let img = Image::alloc(Model::Nrgba, rect, None)?;
            for y in 0..h {
                for x in 0..w {
                    let i = (y * w + x) * 2;
                    img.set_rgba(x as i32, y as i32, Rgba16::from_nrgba8(frame[i], frame[i], frame[i], frame[i + 1]))?;
                }
            }
            Ok(img)
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
                .unwrap_or_default();
            let img = Image::alloc(Model::Paletted, rect, Some(pal))?;
            for y in 0..h {
                for x in 0..w {
                    let idx = frame[y * w + x];
                    let pal = img.palette().unwrap_or(&[]);
                    if let Some(p) = pal.get(idx as usize) {
                        img.set_rgba(x as i32, y as i32, Rgba16::from_nrgba8(p[0], p[1], p[2], p[3]))?;
                    }
                }
            }
            Ok(img)
        }
        png::ColorType::Rgba if output.bit_depth == png::BitDepth::Sixteen => {
            let img = Image::alloc(Model::Nrgba64, rect, None)?;
            for y in 0..h {
                for x in 0..w {
                    let i = (y * w + x) * 8;
                    let r = u16::from_be_bytes([frame[i], frame[i + 1]]);
                    let g = u16::from_be_bytes([frame[i + 2], frame[i + 3]]);
                    let b = u16::from_be_bytes([frame[i + 4], frame[i + 5]]);
                    let a = u16::from_be_bytes([frame[i + 6], frame[i + 7]]);
                    let c = if a == 0xffff {
                        Rgba16 { r, g, b, a }
                    } else if a == 0 {
                        Rgba16 { r: 0, g: 0, b: 0, a: 0 }
                    } else {
                        Rgba16 {
                            r: (u32::from(r) * u32::from(a) / 0xffff) as u16,
                            g: (u32::from(g) * u32::from(a) / 0xffff) as u16,
                            b: (u32::from(b) * u32::from(a) / 0xffff) as u16,
                            a,
                        }
                    };
                    img.set_rgba(x as i32, y as i32, c)?;
                }
            }
            Ok(img)
        }
        other => Err(ImageError::new(
            "PngUnsupportedError",
            format!("png: unsupported output {other:?} {:?}", output.bit_depth),
        )),
    }
}

pub fn png_encode(img: &Image, level: i32) -> Result<Vec<u8>, ImageError> {
    let w = img.width() as u32;
    let h = img.height() as u32;
    if w == 0 || h == 0 {
        return Err(ImageError::new("PngFormatError", "png: empty image"));
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

pub fn jpeg_decode(buf: &[u8], max_pixels: Option<u64>) -> Result<Image, ImageError> {
    let cfg = jpeg_config_from_bytes(buf)?;
    too_large(cfg.width, cfg.height, max_pixels)?;
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
    let loop_count = 0i32;
    while let Some(frame) = decoder
        .read_next_frame()
        .map_err(|e| ImageError::new("GifFormatError", e.to_string()))?
    {
        let pal_bytes = frame
            .palette
            .as_deref()
            .or(global_palette.as_deref());
        let pal = pal_bytes
            .map(|p| {
                p.chunks(3)
                    .map(|rgb| [rgb[0], rgb[1], rgb[2], 255])
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| vec![[0, 0, 0, 255]]);
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
        encoder
            .set_repeat(if loop_count < 0 {
                gif::Repeat::Infinite
            } else {
                gif::Repeat::Finite(loop_count as u16)
            })
            .map_err(|e| ImageError::new("GifFormatError", e.to_string()))?;
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
