mod codec;
mod color;
mod draw;
mod geom;
mod image;
mod palette_data;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use color::Rgba16;
use geom::{Point, Rect};
use image::{Image, ImageError};

fn fail(err: ImageError) -> Error {
    Error::new(Status::InvalidArg, format!("{}: {}", err.code, err.message))
}

fn map_res<T>(r: std::result::Result<T, ImageError>) -> Result<T> {
    r.map_err(fail)
}

#[napi(object)]
pub struct JsRect {
    pub min_x: i32,
    pub min_y: i32,
    pub max_x: i32,
    pub max_y: i32,
}

#[napi(object)]
pub struct JsPoint {
    pub x: i32,
    pub y: i32,
}

#[napi(object)]
pub struct JsRgba {
    pub r: u32,
    pub g: u32,
    pub b: u32,
    pub a: u32,
}

#[napi(object)]
pub struct JsConfig {
    pub width: u32,
    pub height: u32,
    pub color_model: String,
}

impl From<Rect> for JsRect {
    fn from(r: Rect) -> Self {
        Self { min_x: r.min.x, min_y: r.min.y, max_x: r.max.x, max_y: r.max.y }
    }
}
impl From<JsRect> for Rect {
    fn from(r: JsRect) -> Self {
        Rect::new(r.min_x, r.min_y, r.max_x, r.max_y)
    }
}
impl From<Rgba16> for JsRgba {
    fn from(c: Rgba16) -> Self {
        Self { r: c.r as u32, g: c.g as u32, b: c.b as u32, a: c.a as u32 }
    }
}
impl From<JsRgba> for Rgba16 {
    fn from(c: JsRgba) -> Self {
        Self { r: c.r as u16, g: c.g as u16, b: c.b as u16, a: c.a as u16 }
    }
}

#[napi]
pub fn rect(x0: i32, y0: i32, x1: i32, y1: i32) -> JsRect {
    Rect::new(x0, y0, x1, y1).into()
}
#[napi]
pub fn zr() -> JsRect {
    Rect::zr().into()
}
#[napi]
pub fn rect_size(r: JsRect) -> JsPoint {
    let s = Rect::from(r).size();
    JsPoint { x: s.x, y: s.y }
}
#[napi]
pub fn rect_dx(r: JsRect) -> i32 {
    Rect::from(r).dx()
}
#[napi]
pub fn rect_dy(r: JsRect) -> i32 {
    Rect::from(r).dy()
}
#[napi]
pub fn rect_empty(r: JsRect) -> bool {
    Rect::from(r).empty()
}
#[napi]
pub fn rect_eq(a: JsRect, b: JsRect) -> bool {
    Rect::from(a).eq(Rect::from(b))
}
#[napi]
pub fn rect_in(a: JsRect, b: JsRect) -> bool {
    Rect::from(a).in_rect(Rect::from(b))
}
#[napi]
pub fn rect_overlaps(a: JsRect, b: JsRect) -> bool {
    Rect::from(a).overlaps(Rect::from(b))
}
#[napi]
pub fn rect_intersect(a: JsRect, b: JsRect) -> JsRect {
    Rect::from(a).intersect(Rect::from(b)).into()
}
#[napi]
pub fn rect_union(a: JsRect, b: JsRect) -> JsRect {
    Rect::from(a).union(Rect::from(b)).into()
}
#[napi]
pub fn rect_add(r: JsRect, x: i32, y: i32) -> JsRect {
    Rect::from(r).add(Point { x, y }).into()
}
#[napi]
pub fn rect_sub(r: JsRect, x: i32, y: i32) -> JsRect {
    Rect::from(r).sub(Point { x, y }).into()
}
#[napi]
pub fn rect_inset(r: JsRect, n: i32) -> JsRect {
    Rect::from(r).inset(n).into()
}
#[napi]
pub fn rect_canon(r: JsRect) -> JsRect {
    Rect::from(r).canon().into()
}

#[napi]
pub fn palette_index(colors: Vec<JsRgba>, c: JsRgba) -> u32 {
    let pal: Vec<[u8; 4]> = colors
        .into_iter()
        .map(|p| Rgba16::from(p).to_nrgba8())
        .collect();
    color::palette_index(&pal, Rgba16::from(c)) as u32
}

#[napi]
pub fn plan9_palette() -> Vec<JsRgba> {
    color::plan9()
        .into_iter()
        .map(|p| JsRgba::from(Rgba16::from_nrgba8(p[0], p[1], p[2], p[3])))
        .collect()
}

#[napi]
pub fn web_safe_palette() -> Vec<JsRgba> {
    color::web_safe()
        .into_iter()
        .map(|p| JsRgba::from(Rgba16::from_nrgba8(p[0], p[1], p[2], p[3])))
        .collect()
}

#[napi]
pub struct NativeImage {
    inner: Image,
}

#[napi]
impl NativeImage {
    #[napi(factory)]
    pub fn create(model: String, r: JsRect) -> Result<Self> {
        let model = color::Model::parse(&model).ok_or_else(|| {
            Error::new(Status::InvalidArg, "ImageFormatError: unknown color model")
        })?;
        let pal = if model == color::Model::Paletted {
            Some(color::plan9())
        } else {
            None
        };
        Ok(Self { inner: map_res(Image::alloc(model, r.into(), pal))? })
    }

    #[napi(factory)]
    pub fn create_paletted(r: JsRect, colors: Vec<JsRgba>) -> Result<Self> {
        let pal: Vec<[u8; 4]> = colors.into_iter().map(|p| Rgba16::from(p).to_nrgba8()).collect();
        Ok(Self { inner: map_res(Image::alloc(color::Model::Paletted, r.into(), Some(pal)))? })
    }

    #[napi(factory)]
    pub fn create_ycbcr(r: JsRect, subsample: String) -> Result<Self> {
        let sub = image::Subsample::parse(&subsample).ok_or_else(|| {
            Error::new(Status::InvalidArg, "ImageFormatError: unknown ycbcr subsample")
        })?;
        Ok(Self { inner: map_res(Image::ycbcr(r.into(), sub))? })
    }

    #[napi(factory)]
    pub fn create_uniform(r: JsRect, c: JsRgba) -> Self {
        Self { inner: Image::uniform(r.into(), c.into()) }
    }

    #[napi(getter)]
    pub fn model(&self) -> String {
        self.inner.model().as_str().to_string()
    }
    #[napi(getter)]
    pub fn rect(&self) -> JsRect {
        self.inner.rect().into()
    }
    #[napi(getter)]
    pub fn width(&self) -> i32 {
        self.inner.width()
    }
    #[napi(getter)]
    pub fn height(&self) -> i32 {
        self.inner.height()
    }
    #[napi(getter)]
    pub fn stride(&self) -> u32 {
        self.inner.stride() as u32
    }
    #[napi(getter)]
    pub fn disposed(&self) -> bool {
        self.inner.disposed()
    }

    #[napi]
    pub fn at_rgba(&self, x: i32, y: i32) -> Result<JsRgba> {
        Ok(map_res(self.inner.at_rgba(x, y))?.into())
    }

    #[napi]
    pub fn opaque(&self) -> Result<bool> {
        map_res(self.inner.opaque())
    }

    #[napi]
    pub fn set_rgba(&self, x: i32, y: i32, c: JsRgba) -> Result<()> {
        map_res(self.inner.set_rgba(x, y, c.into()))
    }

    #[napi]
    pub fn sub_image(&self, r: JsRect) -> Result<Self> {
        Ok(Self { inner: map_res(self.inner.sub_image(r.into()))? })
    }

    #[napi]
    pub fn pix(&self) -> Result<Uint8Array> {
        Ok(map_res(self.inner.pix())?.into())
    }

    #[napi]
    pub fn pix_copy(&self) -> Result<Uint8Array> {
        self.pix()
    }

    #[napi]
    pub fn dispose(&self) {
        self.inner.dispose();
    }
}

#[napi]
pub fn draw_native(
    dst: &NativeImage,
    r: JsRect,
    src: &NativeImage,
    sp_x: i32,
    sp_y: i32,
    op: String,
) -> Result<()> {
    map_res(draw::draw(&dst.inner, r.into(), &src.inner, Point { x: sp_x, y: sp_y }, op != "src"))
}

#[napi]
pub fn draw_mask_native(
    dst: &NativeImage,
    r: JsRect,
    src: &NativeImage,
    sp_x: i32,
    sp_y: i32,
    mask: &NativeImage,
    mp_x: i32,
    mp_y: i32,
    op: String,
) -> Result<()> {
    map_res(draw::draw_mask(
        &dst.inner,
        r.into(),
        &src.inner,
        Point { x: sp_x, y: sp_y },
        Some(&mask.inner),
        Point { x: mp_x, y: mp_y },
        op != "src",
    ))
}

#[napi]
pub fn quantize_native(colors: Vec<JsRgba>, src: &NativeImage, floyd: bool) -> Result<NativeImage> {
    let pal: Vec<[u8; 4]> = colors.into_iter().map(|p| Rgba16::from(p).to_nrgba8()).collect();
    Ok(NativeImage { inner: map_res(draw::quantize(&pal, &src.inner, floyd))? })
}

fn max_pixels(v: Option<i64>) -> Result<Option<u64>> {
    match v {
        None => Ok(None),
        Some(n) if n >= 0 => Ok(Some(n as u64)),
        Some(_) => Err(Error::new(Status::InvalidArg, "ImageTooLargeError: maxPixels must be >= 0")),
    }
}

#[napi]
pub fn png_decode(buf: Uint8Array, max_pixels_opt: Option<i64>) -> Result<NativeImage> {
    Ok(NativeImage { inner: map_res(codec::png_decode(buf.as_ref(), max_pixels(max_pixels_opt)?))? })
}
#[napi]
pub fn png_decode_config(buf: Uint8Array) -> Result<JsConfig> {
    let c = map_res(codec::png_decode_config(buf.as_ref()))?;
    Ok(JsConfig { width: c.width, height: c.height, color_model: c.color_model.as_str().to_string() })
}
#[napi]
pub fn png_encode(img: &NativeImage, level: Option<i32>) -> Result<Uint8Array> {
    Ok(map_res(codec::png_encode(&img.inner, level.unwrap_or(0)))?.into())
}
#[napi]
pub fn jpeg_decode(buf: Uint8Array, max_pixels_opt: Option<i64>) -> Result<NativeImage> {
    Ok(NativeImage { inner: map_res(codec::jpeg_decode(buf.as_ref(), max_pixels(max_pixels_opt)?))? })
}
#[napi]
pub fn jpeg_decode_config(buf: Uint8Array) -> Result<JsConfig> {
    let c = map_res(codec::jpeg_decode_config(buf.as_ref()))?;
    Ok(JsConfig { width: c.width, height: c.height, color_model: c.color_model.as_str().to_string() })
}
#[napi]
pub fn jpeg_encode(img: &NativeImage, quality: Option<i32>) -> Result<Uint8Array> {
    Ok(map_res(codec::jpeg_encode(&img.inner, quality.unwrap_or(75)))?.into())
}
#[napi]
pub fn gif_decode(buf: Uint8Array, max_pixels_opt: Option<i64>) -> Result<NativeImage> {
    Ok(NativeImage { inner: map_res(codec::gif_decode(buf.as_ref(), max_pixels(max_pixels_opt)?))? })
}
#[napi]
pub fn gif_decode_config(buf: Uint8Array) -> Result<JsConfig> {
    let c = map_res(codec::gif_decode_config(buf.as_ref()))?;
    Ok(JsConfig { width: c.width, height: c.height, color_model: c.color_model.as_str().to_string() })
}

#[napi]
pub struct NativeGif {
    frames: Vec<Image>,
    delay: Vec<i32>,
    loop_count: i32,
    disposal: Vec<i32>,
    background_index: i32,
    width: u32,
    height: u32,
    color_model: String,
}

#[napi]
impl NativeGif {
    #[napi]
    pub fn frame_count(&self) -> u32 {
        self.frames.len() as u32
    }
    #[napi]
    pub fn frame(&self, i: u32) -> Result<NativeImage> {
        self.frames
            .get(i as usize)
            .cloned()
            .map(|inner| NativeImage { inner })
            .ok_or_else(|| Error::new(Status::InvalidArg, "GifFormatError: frame index"))
    }
    #[napi(getter)]
    pub fn delay(&self) -> Vec<i32> {
        self.delay.clone()
    }
    #[napi(getter)]
    pub fn loop_count(&self) -> i32 {
        self.loop_count
    }
    #[napi(getter)]
    pub fn disposal(&self) -> Vec<i32> {
        self.disposal.clone()
    }
    #[napi(getter)]
    pub fn background_index(&self) -> i32 {
        self.background_index
    }
    #[napi]
    pub fn config(&self) -> JsConfig {
        JsConfig {
            width: self.width,
            height: self.height,
            color_model: self.color_model.clone(),
        }
    }
}

#[napi]
pub fn gif_decode_all(buf: Uint8Array, max_pixels_opt: Option<i64>) -> Result<NativeGif> {
    let g = map_res(codec::gif_decode_all(buf.as_ref(), max_pixels(max_pixels_opt)?))?;
    Ok(NativeGif {
        frames: g.frames,
        delay: g.delay,
        loop_count: g.loop_count,
        disposal: g.disposal,
        background_index: g.background_index,
        width: g.config.width,
        height: g.config.height,
        color_model: g.config.color_model.as_str().to_string(),
    })
}

#[napi]
pub fn gif_encode(img: &NativeImage, num_colors: Option<i32>) -> Result<Uint8Array> {
    Ok(map_res(codec::gif_encode(&img.inner, num_colors.unwrap_or(256)))?.into())
}

#[napi]
pub fn gif_encode_all(
    frames: Vec<&NativeImage>,
    delay: Vec<i32>,
    loop_count: i32,
    disposal: Vec<i32>,
    num_colors: Option<i32>,
) -> Result<Uint8Array> {
    let imgs: Vec<Image> = frames.iter().map(|f| f.inner.clone()).collect();
    Ok(map_res(codec::gif_encode_all(&imgs, &delay, loop_count, &disposal, num_colors.unwrap_or(256)))?.into())
}
