use crate::palette_data;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Model {
    Rgba,
    Rgba64,
    Nrgba,
    Nrgba64,
    Alpha,
    Alpha16,
    Gray,
    Gray16,
    Ycbcr,
    Cmyk,
    Paletted,
}

impl Model {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rgba => "rgba",
            Self::Rgba64 => "rgba64",
            Self::Nrgba => "nrgba",
            Self::Nrgba64 => "nrgba64",
            Self::Alpha => "alpha",
            Self::Alpha16 => "alpha16",
            Self::Gray => "gray",
            Self::Gray16 => "gray16",
            Self::Ycbcr => "ycbcr",
            Self::Cmyk => "cmyk",
            Self::Paletted => "paletted",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "rgba" => Self::Rgba,
            "rgba64" => Self::Rgba64,
            "nrgba" => Self::Nrgba,
            "nrgba64" => Self::Nrgba64,
            "alpha" => Self::Alpha,
            "alpha16" => Self::Alpha16,
            "gray" => Self::Gray,
            "gray16" => Self::Gray16,
            "ycbcr" => Self::Ycbcr,
            "cmyk" => Self::Cmyk,
            "paletted" => Self::Paletted,
            _ => return None,
        })
    }

    pub fn bytes_per_pixel(self) -> usize {
        match self {
            Self::Rgba | Self::Nrgba | Self::Cmyk => 4,
            Self::Rgba64 | Self::Nrgba64 => 8,
            Self::Alpha | Self::Gray | Self::Paletted => 1,
            Self::Alpha16 | Self::Gray16 => 2,
            Self::Ycbcr => 1,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Rgba16 {
    pub r: u16,
    pub g: u16,
    pub b: u16,
    pub a: u16,
}

impl Rgba16 {
    pub fn from_nrgba8(r: u8, g: u8, b: u8, a: u8) -> Self {
        let expand = |c: u8| -> u32 {
            let v = u32::from(c);
            v | (v << 8)
        };
        let r = expand(r) * u32::from(a) / 0xff;
        let g = expand(g) * u32::from(a) / 0xff;
        let b = expand(b) * u32::from(a) / 0xff;
        let a = expand(a);
        Self { r: r as u16, g: g as u16, b: b as u16, a: a as u16 }
    }

    pub fn from_rgba8(r: u8, g: u8, b: u8, a: u8) -> Self {
        let expand = |c: u8| -> u16 {
            let v = u16::from(c);
            v | (v << 8)
        };
        Self { r: expand(r), g: expand(g), b: expand(b), a: expand(a) }
    }

    pub fn from_gray8(y: u8) -> Self {
        let v = u16::from(y);
        let y = v | (v << 8);
        Self { r: y, g: y, b: y, a: 0xffff }
    }

    pub fn from_gray16(y: u16) -> Self {
        Self { r: y, g: y, b: y, a: 0xffff }
    }

    pub fn from_alpha8(a: u8) -> Self {
        let v = u16::from(a);
        Self { r: 0, g: 0, b: 0, a: v | (v << 8) }
    }

    pub fn from_alpha16(a: u16) -> Self {
        Self { r: 0, g: 0, b: 0, a }
    }

    pub fn to_rgba8(self) -> [u8; 4] {
        [self.r_hi(), self.g_hi(), self.b_hi(), self.a_hi()]
    }

    pub fn r_hi(self) -> u8 {
        (self.r >> 8) as u8
    }
    pub fn g_hi(self) -> u8 {
        (self.g >> 8) as u8
    }
    pub fn b_hi(self) -> u8 {
        (self.b >> 8) as u8
    }
    pub fn a_hi(self) -> u8 {
        (self.a >> 8) as u8
    }

    pub fn to_nrgba8(self) -> [u8; 4] {
        if self.a == 0xffff {
            return [self.r_hi(), self.g_hi(), self.b_hi(), 0xff];
        }
        if self.a == 0 {
            return [0, 0, 0, 0];
        }
        let a = u32::from(self.a);
        [
            ((u32::from(self.r) * 0xffff / a) >> 8) as u8,
            ((u32::from(self.g) * 0xffff / a) >> 8) as u8,
            ((u32::from(self.b) * 0xffff / a) >> 8) as u8,
            self.a_hi(),
        ]
    }

    pub fn to_gray8(self) -> u8 {
        // Go color.GrayModel uses color.Gray{Y: uint8((19595*r + 38470*g + 7471*b + 1<<15) >> 24)}
        // after converting via RGBA().
        let r = u32::from(self.r);
        let g = u32::from(self.g);
        let b = u32::from(self.b);
        ((19595 * r + 38470 * g + 7471 * b + (1 << 15)) >> 24) as u8
    }

    pub fn to_gray16(self) -> u16 {
        ((19595 * u32::from(self.r) + 38470 * u32::from(self.g) + 7471 * u32::from(self.b) + (1 << 15)) >> 16) as u16
    }
}

/// Go image/color sqDiff: ((x-y) as i32 bits reinterpreted) squared, shifted by 2.
pub fn sq_diff(x: u32, y: u32) -> u32 {
    let d = x.wrapping_sub(y);
    d.wrapping_mul(d) >> 2
}

pub fn palette_index(palette: &[[u8; 4]], c: Rgba16) -> usize {
    let cr = u32::from(c.r);
    let cg = u32::from(c.g);
    let cb = u32::from(c.b);
    let ca = u32::from(c.a);
    let mut ret = 0usize;
    let mut best = u32::MAX;
    for (i, p) in palette.iter().enumerate() {
        let pr = Rgba16::from_nrgba8(p[0], p[1], p[2], p[3]);
        let sum = sq_diff(cr, u32::from(pr.r))
            + sq_diff(cg, u32::from(pr.g))
            + sq_diff(cb, u32::from(pr.b))
            + sq_diff(ca, u32::from(pr.a));
        if sum < best {
            if sum == 0 {
                return i;
            }
            ret = i;
            best = sum;
        }
    }
    ret
}

pub fn plan9() -> Vec<[u8; 4]> {
    palette_data::PLAN9.to_vec()
}

pub fn web_safe() -> Vec<[u8; 4]> {
    palette_data::WEBSAFE.to_vec()
}

// Copied from Go image/color/ycbcr.go RGBToYCbCr / YCbCrToRGB.
pub fn rgb_to_ycbcr(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    let r = i32::from(r);
    let g = i32::from(g);
    let b = i32::from(b);
    let yy = (19595 * r + 38470 * g + 7471 * b + (1 << 15)) >> 16;
    let cb = ((-11056 * r - 21712 * g + 32768 * b + (257 << 15)) >> 16).clamp(0, 255);
    let cr = ((32768 * r - 27440 * g - 5328 * b + (257 << 15)) >> 16).clamp(0, 255);
    (yy as u8, cb as u8, cr as u8)
}

pub fn ycbcr_to_rgb(y: u8, cb: u8, cr: u8) -> (u8, u8, u8) {
    let yy1 = i32::from(y) * 0x10101;
    let cb1 = i32::from(cb) - 128;
    let cr1 = i32::from(cr) - 128;
    let r = yy1 + 91881 * cr1;
    let g = yy1 - 22554 * cb1 - 46802 * cr1;
    let b = yy1 + 116130 * cb1;
    (
        (r >> 16).clamp(0, 255) as u8,
        (g >> 16).clamp(0, 255) as u8,
        (b >> 16).clamp(0, 255) as u8,
    )
}

pub fn cmyk_to_rgb(c: u8, m: u8, y: u8, k: u8) -> (u8, u8, u8) {
    let w = 0xffff - u32::from(k) * 0x101;
    let r = ((0xffff - u32::from(c) * 0x101) * w / 0xffff) >> 8;
    let g = ((0xffff - u32::from(m) * 0x101) * w / 0xffff) >> 8;
    let b = ((0xffff - u32::from(y) * 0x101) * w / 0xffff) >> 8;
    (r as u8, g as u8, b as u8)
}

pub fn rgb_to_cmyk(r: u8, g: u8, b: u8) -> (u8, u8, u8, u8) {
    let rr = u32::from(r);
    let gg = u32::from(g);
    let bb = u32::from(b);
    let w = rr.max(gg).max(bb);
    if w == 0 {
        return (0, 0, 0, 0xff);
    }
    let c = ((w - rr) * 0xff / w) as u8;
    let m = ((w - gg) * 0xff / w) as u8;
    let y = ((w - bb) * 0xff / w) as u8;
    let k = (0xff - w) as u8;
    (c, m, y, k)
}
