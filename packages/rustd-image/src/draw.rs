use crate::color::{palette_index, Rgba16};
use crate::geom::{Point, Rect};
use crate::image::{Image, ImageError};

const M: u32 = 0xffff;

pub fn draw(dst: &Image, r: Rect, src: &Image, sp: Point, op_over: bool) -> Result<(), ImageError> {
    draw_mask(dst, r, src, sp, None, Point { x: 0, y: 0 }, op_over)
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
    let mut r = r.intersect(dst.rect());
    if r.empty() {
        return Ok(());
    }
    let sr = r.add(sp.sub(r.min)).intersect(src.rect());
    if sr.empty() {
        return Ok(());
    }
    let dx = sr.min.x - r.min.x - (sp.x - r.min.x);
    let dy = sr.min.y - r.min.y - (sp.y - r.min.y);
    r.min.x += dx;
    r.min.y += dy;
    r.max.x = r.min.x + sr.dx();
    r.max.y = r.min.y + sr.dy();
    sp.x = sr.min.x;
    sp.y = sr.min.y;
    if let Some(mask) = mask {
        let mr = r.add(mp.sub(r.min)).intersect(mask.rect());
        if mr.empty() {
            return Ok(());
        }
        r.max.x = r.min.x + mr.dx().min(r.dx());
        r.max.y = r.min.y + mr.dy().min(r.dy());
        mp.x = mr.min.x;
        mp.y = mr.min.y;
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

pub fn floyd_steinberg(dst: &Image, r: Rect, src: &Image, sp: Point) -> Result<(), ImageError> {
    let r = r.intersect(dst.rect());
    if r.empty() {
        return Ok(());
    }
    let pal = dst.palette().map(|p| p.to_vec());
    let w = r.dx() as usize;
    let mut curr = vec![[0i32; 4]; w + 2];
    let mut next = vec![[0i32; 4]; w + 2];
    for y in 0..r.dy() {
        for x in 0..r.dx() {
            let s = src.at_rgba(sp.x + x, sp.y + y)?;
            let mut er = i32::from(s.r) + curr[x as usize + 1][0] / 16;
            let mut eg = i32::from(s.g) + curr[x as usize + 1][1] / 16;
            let mut eb = i32::from(s.b) + curr[x as usize + 1][2] / 16;
            let mut ea = i32::from(s.a) + curr[x as usize + 1][3] / 16;
            er = er.clamp(0, 0xffff);
            eg = eg.clamp(0, 0xffff);
            eb = eb.clamp(0, 0xffff);
            ea = ea.clamp(0, 0xffff);
            let chosen = if let Some(pal) = &pal {
                let idx = palette_index(
                    pal,
                    Rgba16 { r: er as u16, g: eg as u16, b: eb as u16, a: ea as u16 },
                );
                let p = pal[idx];
                let c = Rgba16::from_nrgba8(p[0], p[1], p[2], p[3]);
                dst.set_rgba(r.min.x + x, r.min.y + y, c)?;
                // restore index by setting paletted pixel via color
                c
            } else {
                let c = Rgba16 { r: er as u16, g: eg as u16, b: eb as u16, a: ea as u16 };
                dst.set_rgba(r.min.x + x, r.min.y + y, c)?;
                c
            };
            er -= i32::from(chosen.r);
            eg -= i32::from(chosen.g);
            eb -= i32::from(chosen.b);
            ea -= i32::from(chosen.a);
            // Floyd–Steinberg: +7 right, +3 bottom-left, +5 bottom, +1 bottom-right.
            let xi = x as usize + 1;
            curr[xi + 1][0] += er * 7;
            curr[xi + 1][1] += eg * 7;
            curr[xi + 1][2] += eb * 7;
            curr[xi + 1][3] += ea * 7;
            next[xi - 1][0] += er * 3;
            next[xi - 1][1] += eg * 3;
            next[xi - 1][2] += eb * 3;
            next[xi - 1][3] += ea * 3;
            next[xi][0] += er * 5;
            next[xi][1] += eg * 5;
            next[xi][2] += eb * 5;
            next[xi][3] += ea * 5;
            next[xi + 1][0] += er;
            next[xi + 1][1] += eg;
            next[xi + 1][2] += eb;
            next[xi + 1][3] += ea;
        }
        std::mem::swap(&mut curr, &mut next);
        for cell in &mut next {
            *cell = [0; 4];
        }
    }
    Ok(())
}

pub fn quantize(palette: &[[u8; 4]], src: &Image, floyd: bool) -> Result<Image, ImageError> {
    let dst = Image::alloc(crate::color::Model::Paletted, src.rect(), Some(palette.to_vec()))?;
    if floyd {
        floyd_steinberg(&dst, src.rect(), src, src.rect().min)?;
    } else {
        draw(&dst, src.rect(), src, src.rect().min, false)?;
    }
    Ok(dst)
}
