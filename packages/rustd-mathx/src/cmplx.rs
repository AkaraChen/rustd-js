//! Go `math/cmplx` (C99 Annex G special cases), translated from Go 1.24.
//! Explicit NaN payloads use Go's `uvnan = 0x7FF8000000000001`.

pub type C = (f64, f64);

const GO_NAN: u64 = 0x7FF8000000000001;
const REDUCE_THRESHOLD: f64 = (1u64 << 30) as f64;
const TWO54: f64 = 1.8014398509481984e16; // 2**54
const TWOM27: f64 = 7.450580596923828125e-9; // 2**-27
const MACHEP: f64 = 1.0 / ((1u64 << 53) as f64);
const PI1: f64 = 3.141592502593994; // 0x400921fb40000000
const PI2: f64 = 1.5099578831723193e-07; // 0x3e84442d00000000
const PI3: f64 = 1.0780605716316238e-14; // 0x3d08469898cc5170

const MPI: [u64; 20] = [
    0x0000000000000000,
    0x517cc1b727220a94,
    0xfe13abe8fa9a6ee0,
    0x6db14acc9e21c820,
    0xff28b1d5ef5de2b0,
    0xdb92371d2126e970,
    0x0324977504e8c90e,
    0x7f0ef58e5894d39f,
    0x74411afa975da242,
    0x74ce38135a2fbf20,
    0x9cc8eb1cc1a99cfa,
    0x4e422fc5defc941d,
    0x8ffc4bffef02cc07,
    0xf79788c5ad05368f,
    0xb69b3f6793e584db,
    0xa7a31fb34f2ff516,
    0xba93dd63f5f2f8bd,
    0x9e839cfbc5294975,
    0x35fdafd88fc6ae84,
    0x2b0198237e3db5d5,
];

pub fn go_nan() -> f64 {
    f64::from_bits(GO_NAN)
}

fn is_inf(x: f64) -> bool {
    x.is_infinite()
}

fn is_nan(x: f64) -> bool {
    x.is_nan()
}

fn copysign(x: f64, y: f64) -> f64 {
    x.copysign(y)
}

/// Go `math.Hypot` software path (Inf beats NaN).
fn hypot(p: f64, q: f64) -> f64 {
    let (mut p, mut q) = (p.abs(), q.abs());
    if p.is_infinite() || q.is_infinite() {
        return f64::INFINITY;
    }
    if p.is_nan() || q.is_nan() {
        return go_nan();
    }
    if p < q {
        core::mem::swap(&mut p, &mut q);
    }
    if p == 0.0 {
        return 0.0;
    }
    q /= p;
    p * (1.0 + q * q).sqrt()
}

fn cmul(a: C, b: C) -> C {
    (a.0 * b.0 - a.1 * b.1, a.0 * b.1 + a.1 * b.0)
}

fn cadd(a: C, b: C) -> C {
    (a.0 + b.0, a.1 + b.1)
}

pub fn abs(x: C) -> f64 {
    hypot(x.0, x.1)
}

pub fn arg(x: C) -> f64 {
    x.1.atan2(x.0)
}

/// |z|². Not in Go `math/cmplx`; issue #21 exports it as `cNorm`.
pub fn norm(x: C) -> f64 {
    x.0 * x.0 + x.1 * x.1
}

pub fn conj(x: C) -> C {
    (x.0, -x.1)
}

pub fn rect(r: f64, theta: f64) -> C {
    let (s, c) = theta.sin_cos();
    (r * c, r * s)
}

pub fn polar(x: C) -> (f64, f64) {
    (abs(x), arg(x))
}

pub fn inf_c() -> C {
    (f64::INFINITY, f64::INFINITY)
}

pub fn nan_c() -> C {
    (go_nan(), go_nan())
}

pub fn is_inf_c(x: C, sign: i32) -> bool {
    is_inf_sign(x.0, sign) || is_inf_sign(x.1, sign)
}

fn is_inf_sign(f: f64, sign: i32) -> bool {
    // Go math.IsInf: sign >= 0 matches +Inf; sign <= 0 matches -Inf; 0 matches either.
    (sign >= 0 && f > f64::MAX) || (sign <= 0 && f < -f64::MAX)
}

pub fn is_nan_c(x: C) -> bool {
    if is_inf(x.0) || is_inf(x.1) {
        return false;
    }
    is_nan(x.0) || is_nan(x.1)
}

pub fn exp(x: C) -> C {
    let (re, im) = x;
    if is_inf(re) {
        if re > 0.0 && im == 0.0 {
            return x;
        }
        if is_inf(im) || is_nan(im) {
            if re < 0.0 {
                return (0.0, copysign(0.0, im));
            }
            return (f64::INFINITY, go_nan());
        }
    } else if is_nan(re) && im == 0.0 {
        return (go_nan(), im);
    }
    let r = re.exp();
    let (s, c) = im.sin_cos();
    (r * c, r * s)
}

pub fn log(x: C) -> C {
    (abs(x).ln(), arg(x))
}

/// Go `cmplx.Log10`: `Log(x) * complex(math.Log10E, 0)`.
pub fn log10(x: C) -> C {
    let (re, im) = log(x);
    (re * std::f64::consts::LOG10_E, im * std::f64::consts::LOG10_E)
}

pub fn pow(x: C, y: C) -> C {
    if x.0 == 0.0 && x.1 == 0.0 {
        if is_nan_c(y) {
            return nan_c();
        }
        let (r, i) = (y.0, y.1);
        if r == 0.0 {
            return (1.0, 0.0);
        }
        if r < 0.0 {
            if i == 0.0 {
                return (f64::INFINITY, 0.0);
            }
            return inf_c();
        }
        if r > 0.0 {
            return (0.0, 0.0);
        }
    }
    let modulus = abs(x);
    if modulus == 0.0 {
        return (0.0, 0.0);
    }
    let mut r = modulus.powf(y.0);
    let arg = arg(x);
    let mut theta = y.0 * arg;
    if y.1 != 0.0 {
        r *= (-y.1 * arg).exp();
        // Go's ARM64 compiler fuses this multiply-add. Near a zero of sin/cos,
        // rounding the multiplication separately magnifies the final ULP error.
        #[cfg(target_arch = "aarch64")]
        { theta = y.1.mul_add(modulus.ln(), theta); }
        #[cfg(not(target_arch = "aarch64"))]
        { theta += y.1 * modulus.ln(); }
    }
    let (s, c) = theta.sin_cos();
    (r * c, r * s)
}

pub fn sqrt(x: C) -> C {
    if x.1 == 0.0 {
        if x.0 == 0.0 {
            return (0.0, x.1);
        }
        if x.0 < 0.0 {
            return (0.0, copysign((-x.0).sqrt(), x.1));
        }
        return (x.0.sqrt(), x.1);
    } else if is_inf(x.1) {
        return (f64::INFINITY, x.1);
    }
    if x.0 == 0.0 {
        if x.1 < 0.0 {
            let r = (-0.5 * x.1).sqrt();
            return (r, -r);
        }
        let r = (0.5 * x.1).sqrt();
        return (r, r);
    }
    let mut a = x.0;
    let mut b = x.1;
    let scale;
    if a.abs() > 4.0 || b.abs() > 4.0 {
        a *= 0.25;
        b *= 0.25;
        scale = 2.0;
    } else {
        a *= TWO54;
        b *= TWO54;
        scale = TWOM27;
    }
    let mut r = hypot(a, b);
    let t = if a > 0.0 {
        let mut t = (0.5 * r + 0.5 * a).sqrt();
        r = scale * ((0.5 * b) / t).abs();
        t *= scale;
        t
    } else {
        r = (0.5 * r - 0.5 * a).sqrt();
        let t = scale * ((0.5 * b) / r).abs();
        r *= scale;
        t
    };
    if b < 0.0 {
        (t, -r)
    } else {
        (t, r)
    }
}

fn sinhcosh(x: f64) -> (f64, f64) {
    if x.abs() <= 0.5 {
        return (x.sinh(), x.cosh());
    }
    let mut e = x.exp();
    let ei = 0.5 / e;
    e *= 0.5;
    (e - ei, e + ei)
}

pub fn sin(x: C) -> C {
    let (re, im) = x;
    if im == 0.0 && (is_inf(re) || is_nan(re)) {
        return (go_nan(), im);
    }
    if is_inf(im) {
        if re == 0.0 {
            return x;
        }
        if is_inf(re) || is_nan(re) {
            return (go_nan(), im);
        }
    } else if re == 0.0 && is_nan(im) {
        return x;
    }
    let (s, c) = re.sin_cos();
    let (sh, ch) = sinhcosh(im);
    (s * ch, c * sh)
}

pub fn sinh(x: C) -> C {
    let (re, im) = x;
    if re == 0.0 && (is_inf(im) || is_nan(im)) {
        return (re, go_nan());
    }
    if is_inf(re) {
        if im == 0.0 {
            return (re, im);
        }
        if is_inf(im) || is_nan(im) {
            return (re, go_nan());
        }
    } else if im == 0.0 && is_nan(re) {
        return (go_nan(), im);
    }
    let (s, c) = im.sin_cos();
    let (sh, ch) = sinhcosh(re);
    (c * sh, s * ch)
}

pub fn cos(x: C) -> C {
    let (re, im) = x;
    if im == 0.0 && (is_inf(re) || is_nan(re)) {
        return (go_nan(), -im * copysign(0.0, re));
    }
    if is_inf(im) {
        if re == 0.0 {
            return (f64::INFINITY, -re * copysign(0.0, im));
        }
        if is_inf(re) || is_nan(re) {
            return (f64::INFINITY, go_nan());
        }
    } else if re == 0.0 && is_nan(im) {
        return (go_nan(), 0.0);
    }
    let (s, c) = re.sin_cos();
    let (sh, ch) = sinhcosh(im);
    (c * ch, -s * sh)
}

pub fn cosh(x: C) -> C {
    let (re, im) = x;
    if re == 0.0 && (is_inf(im) || is_nan(im)) {
        return (go_nan(), re * copysign(0.0, im));
    }
    if is_inf(re) {
        if im == 0.0 {
            return (f64::INFINITY, im * copysign(0.0, re));
        }
        if is_inf(im) || is_nan(im) {
            return (f64::INFINITY, go_nan());
        }
    } else if im == 0.0 && is_nan(re) {
        return (go_nan(), im);
    }
    let (s, c) = im.sin_cos();
    let (sh, ch) = sinhcosh(re);
    (c * ch, s * sh)
}

pub fn tan(x: C) -> C {
    let (re, im) = x;
    if is_inf(im) {
        if is_inf(re) || is_nan(re) {
            return (copysign(0.0, re), copysign(1.0, im));
        }
        return (copysign(0.0, (2.0 * re).sin()), copysign(1.0, im));
    }
    if re == 0.0 && is_nan(im) {
        return x;
    }
    let mut d = (2.0 * re).cos() + (2.0 * im).cosh();
    if d.abs() < 0.25 {
        d = tan_series(x);
    }
    if d == 0.0 {
        return inf_c();
    }
    ((2.0 * re).sin() / d, (2.0 * im).sinh() / d)
}

pub fn tanh(x: C) -> C {
    let (re, im) = x;
    if is_inf(re) {
        if is_inf(im) || is_nan(im) {
            return (copysign(1.0, re), copysign(0.0, im));
        }
        return (copysign(1.0, re), copysign(0.0, (2.0 * im).sin()));
    }
    if im == 0.0 && is_nan(re) {
        return x;
    }
    let d = (2.0 * re).cosh() + (2.0 * im).cos();
    if d == 0.0 {
        return inf_c();
    }
    ((2.0 * re).sinh() / d, (2.0 * im).sin() / d)
}

pub fn cot(x: C) -> C {
    let mut d = (2.0 * x.1).cosh() - (2.0 * x.0).cos();
    if d.abs() < 0.25 {
        d = tan_series(x);
    }
    if d == 0.0 {
        return inf_c();
    }
    ((2.0 * x.0).sin() / d, -(2.0 * x.1).sinh() / d)
}

fn mul64(x: u64, y: u64) -> (u64, u64) {
    let z = (x as u128) * (y as u128);
    ((z >> 64) as u64, z as u64)
}

fn add64(x: u64, y: u64, carry: u64) -> (u64, u64) {
    let sum = x.wrapping_add(y).wrapping_add(carry);
    let carry_out = ((x & y) | ((x | y) & !sum)) >> 63;
    (sum, carry_out)
}

fn shift_pair(a: u64, b: u64, bitshift: u32) -> u64 {
    if bitshift == 0 {
        a
    } else {
        (a << bitshift) | (b >> (64 - bitshift))
    }
}

/// Go `reducePi`: map x into (-Pi/2, Pi/2].
pub fn reduce_pi(x: f64) -> f64 {
    if x.abs() < REDUCE_THRESHOLD {
        let mut t = x / std::f64::consts::PI;
        t += 0.5;
        t = t as i64 as f64;
        return ((x - t * PI1) - t * PI2) - t * PI3;
    }
    const MASK: u64 = 0x7FF;
    const SHIFT: u32 = 64 - 11 - 1;
    const BIAS: i32 = 1023;
    const FRAC_MASK: u64 = (1u64 << SHIFT) - 1;
    let mut ix = x.to_bits();
    let exp = (ix >> SHIFT & MASK) as i32 - BIAS - SHIFT as i32;
    ix &= FRAC_MASK;
    ix |= 1u64 << SHIFT;
    let digit = ((exp + 64) as u32) / 64;
    let bitshift = ((exp + 64) as u32) % 64;
    let z0 = shift_pair(MPI[digit as usize], MPI[digit as usize + 1], bitshift);
    let z1 = shift_pair(MPI[digit as usize + 1], MPI[digit as usize + 2], bitshift);
    let z2 = shift_pair(MPI[digit as usize + 2], MPI[digit as usize + 3], bitshift);
    let (z2hi, _) = mul64(z2, ix);
    let (z1hi, z1lo) = mul64(z1, ix);
    let z0lo = z0.wrapping_mul(ix);
    let (lo, c) = add64(z1lo, z2hi, 0);
    let (mut hi, _) = add64(z0lo, z1hi, c);
    let lz = hi.leading_zeros();
    let e = (BIAS as u64).wrapping_sub((lz + 1) as u64);
    hi = (hi << (lz + 1)) | (lo >> (64 - (lz + 1)));
    hi >>= 64 - SHIFT;
    hi |= e << SHIFT;
    let mut x = f64::from_bits(hi);
    if x > 0.5 {
        x -= 1.0;
    }
    std::f64::consts::PI * x
}

fn tan_series(z: C) -> f64 {
    let mut x = (2.0 * z.0).abs();
    let mut y = (2.0 * z.1).abs();
    x = reduce_pi(x);
    x *= x;
    y *= y;
    let mut x2 = 1.0;
    let mut y2 = 1.0;
    let mut f = 1.0;
    let mut rn = 0.0;
    let mut d = 0.0;
    loop {
        rn += 1.0;
        f *= rn;
        rn += 1.0;
        f *= rn;
        x2 *= x;
        y2 *= y;
        let mut t = y2 + x2;
        t /= f;
        d += t;

        rn += 1.0;
        f *= rn;
        rn += 1.0;
        f *= rn;
        x2 *= x;
        y2 *= y;
        t = y2 - x2;
        t /= f;
        d += t;
        if !((t / d).abs() > MACHEP) {
            break;
        }
    }
    d
}

pub fn asin(x: C) -> C {
    let (re, im) = x;
    if im == 0.0 && re.abs() <= 1.0 {
        return (re.asin(), im);
    }
    if re == 0.0 && im.abs() <= 1.0 {
        return (re, im.asinh());
    }
    if is_nan(im) {
        if re == 0.0 {
            return (re, go_nan());
        }
        if is_inf(re) {
            return (go_nan(), re);
        }
        return nan_c();
    }
    if is_inf(im) {
        if is_nan(re) {
            return x;
        }
        if is_inf(re) {
            return (copysign(std::f64::consts::PI / 4.0, re), im);
        }
        return (copysign(0.0, re), im);
    }
    if is_inf(re) {
        return (copysign(std::f64::consts::PI / 2.0, re), copysign(re, im));
    }
    let ct = (-im, re);
    let xx = cmul(x, x);
    let x1 = (1.0 - xx.0, -xx.1);
    let x2 = sqrt(x1);
    let w = log(cadd(ct, x2));
    (w.1, -w.0)
}

pub fn asinh(x: C) -> C {
    let (re, im) = x;
    if im == 0.0 && re.abs() <= 1.0 {
        return (re.asinh(), im);
    }
    if re == 0.0 && im.abs() <= 1.0 {
        return (re, im.asin());
    }
    if is_inf(re) {
        if is_inf(im) {
            return (re, copysign(std::f64::consts::PI / 4.0, im));
        }
        if is_nan(im) {
            return x;
        }
        return (re, copysign(0.0, im));
    }
    if is_nan(re) {
        if im == 0.0 {
            return x;
        }
        if is_inf(im) {
            return (im, re);
        }
        return nan_c();
    }
    if is_inf(im) {
        return (copysign(im, re), copysign(std::f64::consts::PI / 2.0, im));
    }
    let xx = cmul(x, x);
    let x1 = (1.0 + xx.0, xx.1);
    log(cadd(x, sqrt(x1)))
}

pub fn acos(x: C) -> C {
    let w = asin(x);
    (std::f64::consts::PI / 2.0 - w.0, -w.1)
}

pub fn acosh(x: C) -> C {
    if x.0 == 0.0 && x.1 == 0.0 {
        return (0.0, copysign(std::f64::consts::PI / 2.0, x.1));
    }
    let w = acos(x);
    if w.1 <= 0.0 {
        return (-w.1, w.0);
    }
    (w.1, -w.0)
}

pub fn atan(x: C) -> C {
    let (re, im) = x;
    if im == 0.0 {
        return (re.atan(), im);
    }
    if re == 0.0 && im.abs() <= 1.0 {
        return (re, im.atanh());
    }
    if is_inf(im) || is_inf(re) {
        if is_nan(re) {
            return (go_nan(), copysign(0.0, im));
        }
        return (
            copysign(std::f64::consts::PI / 2.0, re),
            copysign(0.0, im),
        );
    }
    if is_nan(re) || is_nan(im) {
        return nan_c();
    }
    let x2 = re * re;
    let a = 1.0 - x2 - im * im;
    if a == 0.0 {
        return nan_c();
    }
    let t = 0.5 * (2.0 * re).atan2(a);
    let w = reduce_pi(t);
    let t = im - 1.0;
    let b = x2 + t * t;
    if b == 0.0 {
        return nan_c();
    }
    let t = im + 1.0;
    let c = (x2 + t * t) / b;
    (w, 0.25 * c.ln())
}

pub fn atanh(x: C) -> C {
    let z = atan((-x.1, x.0));
    (z.1, -z.0)
}
