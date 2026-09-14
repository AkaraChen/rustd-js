use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::color::{self, Model, Rgba16};
use crate::geom::{Point, Rect};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Subsample {
    S444,
    S422,
    S420,
    S440,
    S411,
    S410,
}

impl Subsample {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "444" => Self::S444,
            "422" => Self::S422,
            "420" => Self::S420,
            "440" => Self::S440,
            "411" => Self::S411,
            "410" => Self::S410,
            _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::S444 => "444",
            Self::S422 => "422",
            Self::S420 => "420",
            Self::S440 => "440",
            Self::S411 => "411",
            Self::S410 => "410",
        }
    }
}

struct Store {
    bytes: Mutex<Vec<u8>>,
    disposed: AtomicBool,
}

#[derive(Clone)]
pub struct Image {
    model: Model,
    rect: Rect,
    stride: usize,
    offset: usize,
    store: Arc<Store>,
    palette: Option<Vec<[u8; 4]>>,
    ycbcr: Option<YcbcrPlanes>,
    uniform: Option<Rgba16>,
}

#[derive(Clone)]
struct YcbcrPlanes {
    subsample: Subsample,
    y_stride: usize,
    c_stride: usize,
    y_off: usize,
    cb_off: usize,
    cr_off: usize,
}

#[derive(Debug)]
pub struct ImageError {
    pub code: &'static str,
    pub message: String,
}

impl ImageError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl Image {
    pub fn alloc(model: Model, rect: Rect, palette: Option<Vec<[u8; 4]>>) -> Result<Self, ImageError> {
        let rect = rect.canon();
        if rect.dx() < 0 || rect.dy() < 0 {
            return Err(ImageError::new("ImageFormatError", "image: invalid rectangle"));
        }
        let w = rect.dx() as usize;
        let h = rect.dy() as usize;
        if model == Model::Ycbcr {
            return Err(ImageError::new("ImageFormatError", "image: ycbcr requires subsample"));
        }
        if model == Model::Paletted && palette.as_ref().map(|p| p.is_empty()).unwrap_or(true) {
            return Err(ImageError::new("ImageFormatError", "image: paletted requires a palette"));
        }
        let bpp = model.bytes_per_pixel();
        let stride = w.saturating_mul(bpp);
        let len = stride.saturating_mul(h);
        Ok(Self {
            model,
            rect,
            stride,
            offset: 0,
            store: Arc::new(Store {
                bytes: Mutex::new(vec![0; len]),
                disposed: AtomicBool::new(false),
            }),
            palette,
            ycbcr: None,
            uniform: None,
        })
    }

    pub fn uniform(rect: Rect, c: Rgba16) -> Self {
        Self {
            model: Model::Rgba,
            rect: rect.canon(),
            stride: 0,
            offset: 0,
            store: Arc::new(Store {
                bytes: Mutex::new(Vec::new()),
                disposed: AtomicBool::new(false),
            }),
            palette: None,
            ycbcr: None,
            uniform: Some(c),
        }
    }

    pub fn ycbcr(rect: Rect, subsample: Subsample) -> Result<Self, ImageError> {
        let rect = rect.canon();
        let w = rect.dx() as usize;
        let h = rect.dy() as usize;
        let (cw, ch) = chroma_size(w, h, subsample);
        let y_stride = w;
        let c_stride = cw;
        let y_len = y_stride * h;
        let c_len = c_stride * ch;
        let mut bytes = vec![0u8; y_len + 2 * c_len];
        let y_off = 0;
        let cb_off = y_len;
        let cr_off = y_len + c_len;
        let _ = &mut bytes;
        Ok(Self {
            model: Model::Ycbcr,
            rect,
            stride: y_stride,
            offset: 0,
            store: Arc::new(Store {
                bytes: Mutex::new(bytes),
                disposed: AtomicBool::new(false),
            }),
            palette: None,
            ycbcr: Some(YcbcrPlanes {
                subsample,
                y_stride,
                c_stride,
                y_off,
                cb_off,
                cr_off,
            }),
            uniform: None,
        })
    }

    pub fn from_parts(
        model: Model,
        rect: Rect,
        stride: usize,
        pix: Vec<u8>,
        palette: Option<Vec<[u8; 4]>>,
    ) -> Self {
        Self {
            model,
            rect: rect.canon(),
            stride,
            offset: 0,
            store: Arc::new(Store {
                bytes: Mutex::new(pix),
                disposed: AtomicBool::new(false),
            }),
            palette,
            ycbcr: None,
            uniform: None,
        }
    }

    pub fn model(&self) -> Model {
        if self.uniform.is_some() {
            return Model::Rgba;
        }
        self.model
    }
    pub fn rect(&self) -> Rect {
        self.rect
    }
    pub fn width(&self) -> i32 {
        self.rect.dx()
    }
    pub fn height(&self) -> i32 {
        self.rect.dy()
    }
    pub fn stride(&self) -> usize {
        self.stride
    }
    pub fn disposed(&self) -> bool {
        self.store.disposed.load(Ordering::SeqCst)
    }
    pub fn palette(&self) -> Option<&[[u8; 4]]> {
        self.palette.as_deref()
    }
    pub fn subsample(&self) -> Option<Subsample> {
        self.ycbcr.as_ref().map(|y| y.subsample)
    }

    fn live(&self) -> Result<(), ImageError> {
        if self.disposed() {
            Err(ImageError::new("ImageDisposedError", "image: image has been disposed"))
        } else {
            Ok(())
        }
    }

    pub fn dispose(&self) {
        self.store.disposed.store(true, Ordering::SeqCst);
    }

    pub fn at_rgba(&self, x: i32, y: i32) -> Result<Rgba16, ImageError> {
        self.live()?;
        if let Some(c) = self.uniform {
            return Ok(if (Point { x, y }).in_rect(self.rect) {
                c
            } else {
                Rgba16 { r: 0, g: 0, b: 0, a: 0 }
            });
        }
        if !(Point { x, y }).in_rect(self.rect) {
            return Ok(Rgba16 { r: 0, g: 0, b: 0, a: 0 });
        }
        let pix = self.store.bytes.lock().expect("pix lock");
        Ok(self.read_pixel(&pix, x, y))
    }

    pub(crate) fn pix_index(&self, x: i32, y: i32) -> usize {
        let bpp = self.model.bytes_per_pixel();
        self.offset
            + (y.wrapping_sub(self.rect.min.y) as usize) * self.stride
            + (x.wrapping_sub(self.rect.min.x) as usize) * bpp
    }

    pub(crate) fn with_pix_mut<R>(&self, f: impl FnOnce(&mut [u8]) -> R) -> Result<R, ImageError> {
        self.live()?;
        let mut pix = self.store.bytes.lock().expect("pix lock");
        Ok(f(&mut pix))
    }

    fn read_pixel(&self, pix: &[u8], x: i32, y: i32) -> Rgba16 {
        if let Some(yc) = &self.ycbcr {
            return self.read_ycbcr(pix, yc, x, y);
        }
        let i = self.pix_index(x, y);
        match self.model {
            Model::Rgba => Rgba16::from_rgba8(pix[i], pix[i + 1], pix[i + 2], pix[i + 3]),
            Model::Nrgba => Rgba16::from_nrgba8(pix[i], pix[i + 1], pix[i + 2], pix[i + 3]),
            Model::Rgba64 => Rgba16 {
                r: u16::from_be_bytes([pix[i], pix[i + 1]]),
                g: u16::from_be_bytes([pix[i + 2], pix[i + 3]]),
                b: u16::from_be_bytes([pix[i + 4], pix[i + 5]]),
                a: u16::from_be_bytes([pix[i + 6], pix[i + 7]]),
            },
            Model::Nrgba64 => {
                let r = u16::from_be_bytes([pix[i], pix[i + 1]]);
                let g = u16::from_be_bytes([pix[i + 2], pix[i + 3]]);
                let b = u16::from_be_bytes([pix[i + 4], pix[i + 5]]);
                let a = u16::from_be_bytes([pix[i + 6], pix[i + 7]]);
                if a == 0xffff {
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
                }
            }
            Model::Alpha => Rgba16::from_alpha8(pix[i]),
            Model::Alpha16 => Rgba16::from_alpha16(u16::from_be_bytes([pix[i], pix[i + 1]])),
            Model::Gray => Rgba16::from_gray8(pix[i]),
            Model::Gray16 => Rgba16::from_gray16(u16::from_be_bytes([pix[i], pix[i + 1]])),
            Model::Cmyk => {
                let (r, g, b) = color::cmyk_to_rgb(pix[i], pix[i + 1], pix[i + 2], pix[i + 3]);
                Rgba16::from_rgba8(r, g, b, 255)
            }
            Model::Paletted => {
                let pal = self.palette.as_deref().unwrap_or(&[]);
                let idx = pix[i] as usize;
                if let Some(p) = pal.get(idx) {
                    Rgba16::from_nrgba8(p[0], p[1], p[2], p[3])
                } else {
                    Rgba16 { r: 0, g: 0, b: 0, a: 0 }
                }
            }
            Model::Ycbcr => unreachable!(),
        }
    }

    fn read_ycbcr(&self, pix: &[u8], yc: &YcbcrPlanes, x: i32, y: i32) -> Rgba16 {
        let (yi, ci) = ycbcr_offsets(self.rect, yc, x, y);
        let yy = pix[yc.y_off + yi];
        let cb = pix[yc.cb_off + ci];
        let cr = pix[yc.cr_off + ci];
        let (r, g, b) = color::ycbcr_to_rgb(yy, cb, cr);
        Rgba16::from_rgba8(r, g, b, 255)
    }

    pub fn set_rgba(&self, x: i32, y: i32, c: Rgba16) -> Result<(), ImageError> {
        self.live()?;
        if self.uniform.is_some() {
            return Err(ImageError::new("ImageFormatError", "image: uniform image is immutable"));
        }
        if !(Point { x, y }).in_rect(self.rect) {
            return Ok(());
        }
        let mut pix = self.store.bytes.lock().expect("pix lock");
        self.write_pixel(&mut pix, x, y, c);
        Ok(())
    }

    fn write_pixel(&self, pix: &mut [u8], x: i32, y: i32, c: Rgba16) {
        if let Some(yc) = &self.ycbcr {
            let (r, g, b) = (c.r_hi(), c.g_hi(), c.b_hi());
            let (yy, cb, cr) = color::rgb_to_ycbcr(r, g, b);
            let (yi, ci) = ycbcr_offsets(self.rect, yc, x, y);
            pix[yc.y_off + yi] = yy;
            pix[yc.cb_off + ci] = cb;
            pix[yc.cr_off + ci] = cr;
            return;
        }
        let i = self.pix_index(x, y);
        match self.model {
            Model::Rgba => {
                let p = c.to_rgba8();
                pix[i..i + 4].copy_from_slice(&p);
            }
            Model::Nrgba => {
                let p = c.to_nrgba8();
                pix[i..i + 4].copy_from_slice(&p);
            }
            Model::Rgba64 => {
                pix[i..i + 2].copy_from_slice(&c.r.to_be_bytes());
                pix[i + 2..i + 4].copy_from_slice(&c.g.to_be_bytes());
                pix[i + 4..i + 6].copy_from_slice(&c.b.to_be_bytes());
                pix[i + 6..i + 8].copy_from_slice(&c.a.to_be_bytes());
            }
            Model::Nrgba64 => {
                let n = if c.a == 0 {
                    [0, 0, 0, 0]
                } else if c.a == 0xffff {
                    [c.r, c.g, c.b, c.a]
                } else {
                    [
                        (u32::from(c.r) * 0xffff / u32::from(c.a)) as u16,
                        (u32::from(c.g) * 0xffff / u32::from(c.a)) as u16,
                        (u32::from(c.b) * 0xffff / u32::from(c.a)) as u16,
                        c.a,
                    ]
                };
                pix[i..i + 2].copy_from_slice(&n[0].to_be_bytes());
                pix[i + 2..i + 4].copy_from_slice(&n[1].to_be_bytes());
                pix[i + 4..i + 6].copy_from_slice(&n[2].to_be_bytes());
                pix[i + 6..i + 8].copy_from_slice(&n[3].to_be_bytes());
            }
            Model::Alpha => pix[i] = c.a_hi(),
            Model::Alpha16 => pix[i..i + 2].copy_from_slice(&c.a.to_be_bytes()),
            Model::Gray => pix[i] = c.to_gray8(),
            Model::Gray16 => pix[i..i + 2].copy_from_slice(&c.to_gray16().to_be_bytes()),
            Model::Cmyk => {
                let (cc, m, yv, k) = color::rgb_to_cmyk(c.r_hi(), c.g_hi(), c.b_hi());
                pix[i] = cc;
                pix[i + 1] = m;
                pix[i + 2] = yv;
                pix[i + 3] = k;
            }
            Model::Paletted => {
                let pal = self.palette.as_deref().unwrap_or(&[]);
                pix[i] = color::palette_index(pal, c) as u8;
            }
            Model::Ycbcr => {}
        }
    }

    pub fn opaque(&self) -> Result<bool, ImageError> {
        self.live()?;
        if let Some(c) = self.uniform {
            return Ok(c.a == 0xffff);
        }
        for y in self.rect.min.y..self.rect.max.y {
            for x in self.rect.min.x..self.rect.max.x {
                if self.at_rgba(x, y)?.a != 0xffff {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    pub fn sub_image(&self, r: Rect) -> Result<Self, ImageError> {
        self.live()?;
        let r = r.intersect(self.rect);
        if r.empty() {
            let mut child = self.clone();
            child.rect = Rect::zr();
            return Ok(child);
        }
        if self.uniform.is_some() || self.ycbcr.is_some() {
            let mut child = self.clone();
            child.rect = r;
            return Ok(child);
        }
        let mut child = self.clone();
        child.offset = self.pix_index(r.min.x, r.min.y);
        child.rect = r;
        Ok(child)
    }

    pub fn pix(&self) -> Result<Vec<u8>, ImageError> {
        self.live()?;
        if self.uniform.is_some() {
            return Ok(Vec::new());
        }
        let pix = self.store.bytes.lock().expect("pix lock");
        if self.offset >= pix.len() {
            return Ok(Vec::new());
        }
        Ok(pix[self.offset..].to_vec())
    }

    pub fn set_pix(&self, data: &[u8]) -> Result<(), ImageError> {
        self.live()?;
        let mut pix = self.store.bytes.lock().expect("pix lock");
        if self.offset >= pix.len() {
            return Ok(());
        }
        let dst = &mut pix[self.offset..];
        let n = dst.len().min(data.len());
        dst[..n].copy_from_slice(&data[..n]);
        Ok(())
    }
}

fn chroma_size(w: usize, h: usize, subsample: Subsample) -> (usize, usize) {
    match subsample {
        Subsample::S444 => (w, h),
        Subsample::S422 => ((w + 1) / 2, h),
        Subsample::S420 => ((w + 1) / 2, (h + 1) / 2),
        Subsample::S440 => (w, (h + 1) / 2),
        Subsample::S411 => ((w + 3) / 4, h),
        Subsample::S410 => ((w + 3) / 4, (h + 1) / 2),
    }
}

fn ycbcr_offsets(rect: Rect, yc: &YcbcrPlanes, x: i32, y: i32) -> (usize, usize) {
    let px = (x - rect.min.x) as usize;
    let py = (y - rect.min.y) as usize;
    let yi = py * yc.y_stride + px;
    let (cx, cy) = match yc.subsample {
        Subsample::S444 => (px, py),
        Subsample::S422 => (px / 2, py),
        Subsample::S420 => (px / 2, py / 2),
        Subsample::S440 => (px, py / 2),
        Subsample::S411 => (px / 4, py),
        Subsample::S410 => (px / 4, py / 2),
    };
    (yi, cy * yc.c_stride + cx)
}
