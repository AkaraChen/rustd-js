use crate::color::{sq_diff, Rgba16};
use crate::geom::{Point, Rect};
use crate::image::{Image, ImageError};

const M: u32 = 0xffff;

pub fn draw(dst: &Image, r: Rect, src: &Image, sp: Point, op_over: bool) -> Result<(), ImageError> {
    draw_mask(dst, r, src, sp, None, Point { x: 0, y: 0 }, op_over)
}

/// Matches Go image/draw.clip: intersect r with dst/src/mask bounds and shift sp/mp.
fn clip(
    dst: &Image,
    r: &mut Rect,
    src: &Image,
    sp: &mut Point,
    mask: Option<&Image>,
    mp: &mut Point,
) {
    let orig = r.min;
    *r = r.intersect(dst.rect());
    *r = r.intersect(src.rect().add(orig.sub(*sp)));
    if let Some(mask) = mask {
        *r = r.intersect(mask.rect().add(orig.sub(*mp)));
    }
    let dx = r.min.x - orig.x;
    let dy = r.min.y - orig.y;
    if dx == 0 && dy == 0 {
        return;
    }
    sp.x += dx;
    sp.y += dy;
    mp.x += dx;
    mp.y += dy;
}

pub fn draw_mask(
    dst: &Image,
    r: Rect,
    src: &Image,
    mut sp: Point,
    mask: Option<&Image>,
    mut mp: Point,
    op_over: bool,
) -> Result<(), ImageError> {
    let mut r = r;
    clip(dst, &mut r, src, &mut sp, mask, &mut mp);
    if r.empty() {
        return Ok(());
    }

    let mut x0 = r.min.x;
    let mut x1 = r.max.x;
    let mut dx = 1;
    let mut y0 = r.min.y;
    let mut y1 = r.max.y;
    let mut dy = 1;
    if overlapping(dst, r, src, sp) {
        if sp.y < r.min.y || (sp.y == r.min.y && sp.x < r.min.x) {
            x0 = r.max.x - 1;
            x1 = r.min.x - 1;
            dx = -1;
            y0 = r.max.y - 1;
            y1 = r.min.y - 1;
            dy = -1;
        }
    }

    let mut sy = sp.y + y0 - r.min.y;
    let mut my = mp.y + y0 - r.min.y;
    let mut y = y0;
    while y != y1 {
        let mut sx = sp.x + x0 - r.min.x;
        let mut mx = mp.x + x0 - r.min.x;
        let mut x = x0;
        while x != x1 {
            let s = src.at_rgba(sx, sy)?;
            let ma = if let Some(mask) = mask {
                u32::from(mask.at_rgba(mx, my)?.a)
            } else {
                M
            };
            if op_over {
                if ma == 0 {
                    // no-op
                } else {
                    let d = dst.at_rgba(x, y)?;
                    let a = M - (u32::from(s.a) * ma / M);
                    dst.set_rgba(
                        x,
                        y,
                        Rgba16 {
                            r: ((u32::from(d.r) * a + u32::from(s.r) * ma) / M) as u16,
                            g: ((u32::from(d.g) * a + u32::from(s.g) * ma) / M) as u16,
                            b: ((u32::from(d.b) * a + u32::from(s.b) * ma) / M) as u16,
                            a: ((u32::from(d.a) * a + u32::from(s.a) * ma) / M) as u16,
                        },
                    )?;
                }
            } else if ma == 0 {
                dst.set_rgba(x, y, Rgba16 { r: 0, g: 0, b: 0, a: 0 })?;
            } else if ma == M {
                dst.set_rgba(x, y, s)?;
            } else {
                dst.set_rgba(
                    x,
                    y,
                    Rgba16 {
                        r: (u32::from(s.r) * ma / M) as u16,
                        g: (u32::from(s.g) * ma / M) as u16,
                        b: (u32::from(s.b) * ma / M) as u16,
                        a: (u32::from(s.a) * ma / M) as u16,
                    },
                )?;
            }
            x += dx;
            sx += dx;
            mx += dx;
        }
        y += dy;
        sy += dy;
        my += dy;
    }
    Ok(())
}

fn overlapping(dst: &Image, r: Rect, src: &Image, sp: Point) -> bool {
    std::ptr::eq(dst, src) && r.overlaps(r.add(sp.sub(r.min)))
}

fn clamp_u16(i: i32) -> i32 {
    i.clamp(0, 0xffff)
}

/// Matches Go image/draw.drawPaletted, including Floyd–Steinberg error diffusion.
fn draw_paletted(
    dst: &Image,
    r: Rect,
    src: &Image,
    sp: Point,
    floyd: bool,
) -> Result<(), ImageError> {
    let pal_rgba: Option<Vec<[i32; 4]>> = dst.palette().map(|p| {
        p.iter()
            .map(|c| {
                let rgba = Rgba16::from_nrgba8(c[0], c[1], c[2], c[3]);
                [i32::from(rgba.r), i32::from(rgba.g), i32::from(rgba.b), i32::from(rgba.a)]
            })
            .collect()
    });
    let w = r.dx() as usize;
    let mut curr = if floyd { vec![[0i32; 4]; w + 2] } else { Vec::new() };
    let mut next = if floyd { vec![[0i32; 4]; w + 2] } else { Vec::new() };

    for y in 0..r.dy() {
        for x in 0..r.dx() {
            let s = src.at_rgba(sp.x + x, sp.y + y)?;
            let mut er = i32::from(s.r);
            let mut eg = i32::from(s.g);
            let mut eb = i32::from(s.b);
            let mut ea = i32::from(s.a);
            if floyd {
                let q = curr[x as usize + 1];
                er = clamp_u16(er + q[0] / 16);
                eg = clamp_u16(eg + q[1] / 16);
                eb = clamp_u16(eb + q[2] / 16);
                ea = clamp_u16(ea + q[3] / 16);
            }

            if let Some(pal) = &pal_rgba {
                let mut best_index = 0usize;
                let mut best_sum = u32::MAX;
                for (index, p) in pal.iter().enumerate() {
                    let sum = sq_diff(er as u32, p[0] as u32)
                        + sq_diff(eg as u32, p[1] as u32)
                        + sq_diff(eb as u32, p[2] as u32)
                        + sq_diff(ea as u32, p[3] as u32);
                    if sum < best_sum {
                        best_index = index;
                        best_sum = sum;
                        if sum == 0 {
                            break;
                        }
                    }
                }
                dst.with_pix_mut(|pix| {
                    let i = dst.pix_index(r.min.x + x, r.min.y + y);
                    pix[i] = best_index as u8;
                })?;
                if !floyd {
                    continue;
                }
                er -= pal[best_index][0];
                eg -= pal[best_index][1];
                eb -= pal[best_index][2];
                ea -= pal[best_index][3];
            } else {
                let c = Rgba16 { r: er as u16, g: eg as u16, b: eb as u16, a: ea as u16 };
                dst.set_rgba(r.min.x + x, r.min.y + y, c)?;
                if !floyd {
                    continue;
                }
                let got = dst.at_rgba(r.min.x + x, r.min.y + y)?;
                er -= i32::from(got.r);
                eg -= i32::from(got.g);
                eb -= i32::from(got.b);
                ea -= i32::from(got.a);
            }

            let xi = x as usize;
            next[xi][0] += er * 3;
            next[xi][1] += eg * 3;
            next[xi][2] += eb * 3;
            next[xi][3] += ea * 3;
            next[xi + 1][0] += er * 5;
            next[xi + 1][1] += eg * 5;
            next[xi + 1][2] += eb * 5;
            next[xi + 1][3] += ea * 5;
            next[xi + 2][0] += er;
            next[xi + 2][1] += eg;
            next[xi + 2][2] += eb;
            next[xi + 2][3] += ea;
            curr[xi + 2][0] += er * 7;
            curr[xi + 2][1] += eg * 7;
            curr[xi + 2][2] += eb * 7;
            curr[xi + 2][3] += ea * 7;
        }
        if floyd {
            std::mem::swap(&mut curr, &mut next);
            for cell in &mut next {
                *cell = [0; 4];
            }
        }
    }
    Ok(())
}

pub fn floyd_steinberg(dst: &Image, r: Rect, src: &Image, sp: Point) -> Result<(), ImageError> {
    let mut r = r;
    let mut sp = sp;
    let mut mp = Point { x: 0, y: 0 };
    clip(dst, &mut r, src, &mut sp, None, &mut mp);
    if r.empty() {
        return Ok(());
    }
    draw_paletted(dst, r, src, sp, true)
}

pub fn quantize(palette: &[[u8; 4]], src: &Image, floyd: bool) -> Result<Image, ImageError> {
    let dst = Image::alloc(crate::color::Model::Paletted, src.rect(), Some(palette.to_vec()))?;
    let mut r = src.rect();
    let mut sp = src.rect().min;
    let mut mp = Point { x: 0, y: 0 };
    clip(&dst, &mut r, src, &mut sp, None, &mut mp);
    if !r.empty() {
        draw_paletted(&dst, r, src, sp, floyd)?;
    }
    Ok(dst)
}
