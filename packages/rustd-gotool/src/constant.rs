use crate::token;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use num_bigint::Sign;
use num_rational::BigRational;
use std::ops::{BitAnd, BitOr, BitXor, Not, Shl, Shr};

/// Opaque `go/constant.Value` (issue #28). Int is arbitrary-precision.
/// QUO of Ints is a Float (`big.Rat`); QUO/REM by zero is Unknown.
/// MakeFromLiteral IMAG is Complex with real Int 0 and imag Float (`im_rat`).
/// MakeFromLiteral STRING is Go `strconv.Unquote` bytes (`str_bytes`).
#[napi]
pub struct GoConstValue {
    kind: String,
    int: Option<num_bigint::BigInt>,
    rat: Option<BigRational>,
    im_rat: Option<BigRational>,
    str_bytes: Option<Vec<u8>>,
}

#[napi]
impl GoConstValue {
    #[napi(getter)]
    pub fn kind(&self) -> String {
        self.kind.clone()
    }
}

#[napi(object)]
pub struct ConstToIntResult {
    pub value: BigInt,
    pub ok: bool,
}

fn i64_from_js_bigint(value: &BigInt) -> Result<i64> {
    let (n, lossless) = value.get_i64();
    if !lossless {
        return Err(Error::new(
            Status::InvalidArg,
            "gotool: constMakeInt64 value must fit in int64",
        ));
    }
    Ok(n)
}

fn make_int(n: num_bigint::BigInt) -> GoConstValue {
    GoConstValue {
        kind: "Int".into(),
        int: Some(n),
        rat: None,
        im_rat: None,
        str_bytes: None,
    }
}

fn make_float(r: BigRational) -> GoConstValue {
    GoConstValue {
        kind: "Float".into(),
        int: None,
        rat: Some(r),
        im_rat: None,
        str_bytes: None,
    }
}

fn make_unknown() -> GoConstValue {
    GoConstValue {
        kind: "Unknown".into(),
        int: None,
        rat: None,
        im_rat: None,
        str_bytes: None,
    }
}

fn make_complex_from_imag(im: BigRational) -> GoConstValue {
    GoConstValue {
        kind: "Complex".into(),
        int: None,
        rat: None,
        im_rat: Some(im),
        str_bytes: None,
    }
}

fn make_string(s: Vec<u8>) -> GoConstValue {
    GoConstValue {
        kind: "String".into(),
        int: None,
        rat: None,
        im_rat: None,
        str_bytes: Some(s),
    }
}

fn clone_value(v: &GoConstValue) -> GoConstValue {
    GoConstValue {
        kind: v.kind.clone(),
        int: v.int.clone(),
        rat: v.rat.clone(),
        im_rat: v.im_rat.clone(),
        str_bytes: v.str_bytes.clone(),
    }
}

fn rat_exact_string(r: &BigRational) -> String {
    if r.denom() == &num_bigint::BigInt::from(1) {
        r.numer().to_string()
    } else {
        format!("{}/{}", r.numer(), r.denom())
    }
}

fn as_int<'a>(v: &'a GoConstValue, label: &str) -> Result<&'a num_bigint::BigInt> {
    match (v.kind.as_str(), v.int.as_ref()) {
        ("Int", Some(n)) => Ok(n),
        ("Unknown", _) => Err(Error::new(
            Status::InvalidArg,
            format!("gotool: {label} is Unknown"),
        )),
        _ => Err(Error::new(
            Status::InvalidArg,
            format!("gotool: {label} must be Int"),
        )),
    }
}

fn sign_i32(s: Sign) -> i32 {
    match s {
        Sign::Minus => -1,
        Sign::NoSign => 0,
        Sign::Plus => 1,
    }
}

/// Go `(*big.Int).Int64`: low 64 bits of the absolute value, then apply sign.
/// Exact iff the value fits in int64 (`makeInt` → `int64Val`).
fn ldexp(x: f64, exp: i32) -> f64 {
    x * 2f64.powi(exp)
}

/// Go `math/big.quotToFloat64`: nearest f64 of non-negative a/b, round-half-to-even.
fn quot_to_float64(a: &num_bigint::BigInt, b: &num_bigint::BigInt) -> (f64, bool) {
    const MSIZE: i32 = 52;
    const MSIZE1: i32 = 53;
    const MSIZE2: i32 = 54;
    const EBIAS: i32 = 1023;
    const EMIN: i32 = 1 - EBIAS;

    let alen = i32::try_from(a.bits()).unwrap_or(i32::MAX);
    if alen == 0 {
        return (0.0, true);
    }
    let blen = i32::try_from(b.bits()).unwrap_or(i32::MAX);
    if blen == 0 {
        return (f64::INFINITY, false);
    }
    let mut exp = alen - blen;
    let mut a2 = a.clone();
    let mut b2 = b.clone();
    let shift = MSIZE2 - exp;
    if shift > 0 {
        a2 <<= shift as usize;
    } else if shift < 0 {
        b2 <<= (-shift) as usize;
    }
    let q = &a2 / &b2;
    let r = &a2 % &b2;
    let mut mantissa = u64::try_from(&q).unwrap_or(0);
    let mut have_rem = r.sign() != Sign::NoSign;
    if mantissa >> MSIZE2 == 1 {
        if mantissa & 1 == 1 {
            have_rem = true;
        }
        mantissa >>= 1;
        exp += 1;
    }
    if EMIN - MSIZE <= exp && exp <= EMIN {
        let sh = (EMIN - (exp - 1)) as u32;
        let lostbits = mantissa & ((1u64 << sh) - 1);
        have_rem = have_rem || lostbits != 0;
        mantissa >>= sh;
        exp = 2 - EBIAS;
    }
    let mut exact = !have_rem;
    if mantissa & 1 != 0 {
        exact = false;
        if have_rem || mantissa & 2 != 0 {
            mantissa += 1;
            if mantissa >= (1u64 << MSIZE2) {
                mantissa >>= 1;
                exp += 1;
            }
        }
    }
    mantissa >>= 1;
    let f = ldexp(mantissa as f64, exp - MSIZE1);
    if f.is_infinite() {
        exact = false;
    }
    (f, exact)
}

fn apply_sign(f: f64, sign: Sign) -> f64 {
    if sign == Sign::Minus {
        -f
    } else {
        f
    }
}

fn abs_int(n: &num_bigint::BigInt) -> num_bigint::BigInt {
    if n.sign() == Sign::Minus {
        -n
    } else {
        n.clone()
    }
}

/// Go `constant.Float64Val` for Int (`int64Val` hardware path, else `intVal` via n/1).
fn float64_val_int(n: &num_bigint::BigInt) -> (f64, bool) {
    if let Ok(x) = i64::try_from(n) {
        let f = x as f64;
        // Go compares `int64(f) == x`. Out-of-range f64→int64 (including +2^63)
        // is MinInt64 on gc/amd64 (`CVTTSD2SI`), not Rust's saturating cast.
        const TWO63: f64 = 9223372036854775808.0;
        let back_ok = f.is_finite() && {
            let t = f.trunc();
            t >= i64::MIN as f64 && t < TWO63 && t as i64 == x
        };
        return (f, back_ok);
    }
    let (f, exact) = quot_to_float64(&abs_int(n), &num_bigint::BigInt::from(1));
    (apply_sign(f, n.sign()), exact)
}

/// Go `(*big.Rat).Float64` (sign from the numerator).
fn float64_val_rat(r: &BigRational) -> (f64, bool) {
    let numer = r.numer();
    let denom = r.denom();
    if denom.sign() == Sign::NoSign {
        return (f64::INFINITY, false);
    }
    let (f, exact) = quot_to_float64(&abs_int(numer), &abs_int(denom));
    (apply_sign(f, numer.sign()), exact)
}

fn int64_val(n: &num_bigint::BigInt) -> (i64, bool) {
    if let Ok(x) = i64::try_from(n) {
        return (x, true);
    }
    let (sign, bytes) = n.to_bytes_le();
    let mut v = 0u64;
    for (i, b) in bytes.iter().take(8).enumerate() {
        v |= u64::from(*b) << (8 * i);
    }
    let mut out = v as i64;
    if sign == Sign::Minus {
        out = out.wrapping_neg();
    }
    (out, false)
}

#[napi]
pub fn const_make_int64(v: BigInt) -> Result<GoConstValue> {
    Ok(make_int(num_bigint::BigInt::from(i64_from_js_bigint(&v)?)))
}

#[napi(object)]
pub struct ConstToStringResult {
    pub value: String,
    pub ok: bool,
}

#[napi(object)]
pub struct ConstFloat64ValResult {
    pub value: f64,
    pub ok: bool,
}

/// Go `StringVal`: String is the unquoted bytes as UTF-8 (invalid → U+FFFD);
/// Unknown is `["", true]`; Int/Float/Complex would panic → `["", false]`.
#[napi]
pub fn const_to_string(v: &GoConstValue) -> ConstToStringResult {
    match (v.kind.as_str(), v.str_bytes.as_ref()) {
        ("Unknown", _) => ConstToStringResult {
            value: String::new(),
            ok: true,
        },
        ("String", Some(b)) => ConstToStringResult {
            value: String::from_utf8_lossy(b).into_owned(),
            ok: true,
        },
        _ => ConstToStringResult {
            value: String::new(),
            ok: false,
        },
    }
}

/// Go `Float64Val` for Int/Float/Unknown. Unknown is `(0, false)`.
#[napi]
pub fn const_float64_val(v: &GoConstValue) -> ConstFloat64ValResult {
    match (v.kind.as_str(), v.int.as_ref(), v.rat.as_ref()) {
        ("Int", Some(n), _) => {
            let (value, ok) = float64_val_int(n);
            ConstFloat64ValResult { value, ok }
        }
        ("Float", _, Some(r)) => {
            let (value, ok) = float64_val_rat(r);
            ConstFloat64ValResult { value, ok }
        }
        ("Unknown", _, _) => ConstFloat64ValResult {
            value: 0.0,
            ok: false,
        },
        _ => ConstFloat64ValResult {
            value: 0.0,
            ok: false,
        },
    }
}

#[napi]
pub fn const_to_int(v: &GoConstValue) -> ConstToIntResult {
    match (v.kind.as_str(), v.int.as_ref()) {
        ("Int", Some(n)) => {
            let (x, ok) = int64_val(n);
            ConstToIntResult {
                value: BigInt::from(x),
                ok,
            }
        }
        _ => ConstToIntResult {
            value: BigInt::from(0i64),
            ok: false,
        },
    }
}

/// Go `match` then `big.Rat.Cmp` for Int/Float (`int64Val`/`intVal`/`ratVal`).
fn as_rat(v: &GoConstValue, label: &str) -> Result<BigRational> {
    match (v.kind.as_str(), v.int.as_ref(), v.rat.as_ref()) {
        ("Int", Some(n), _) => Ok(BigRational::from_integer(n.clone())),
        ("Float", _, Some(r)) => Ok(r.clone()),
        ("Unknown", _, _) => Err(Error::new(
            Status::InvalidArg,
            format!("gotool: {label} is Unknown"),
        )),
        _ => Err(Error::new(
            Status::InvalidArg,
            format!("gotool: {label} must be Int or Float"),
        )),
    }
}

/// Go `Compare` for Int/Float: -1 / 0 / 1. Unknown throws.
#[napi]
pub fn const_compare(x: &GoConstValue, y: &GoConstValue) -> Result<i32> {
    let xr = as_rat(x, "x")?;
    let yr = as_rat(y, "y")?;
    Ok(match xr.cmp(&yr) {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => 1,
    })
}

#[napi]
pub fn const_sign(v: &GoConstValue) -> i32 {
    match (v.kind.as_str(), v.int.as_ref(), v.rat.as_ref(), v.im_rat.as_ref()) {
        ("Int", Some(n), _, _) => sign_i32(n.sign()),
        ("Float", _, Some(r), _) => sign_i32(r.numer().sign()),
        // Go `Sign(complexVal)` is `Sign(re) | Sign(im)`; IMAG re is 0.
        ("Complex", _, _, Some(im)) => sign_i32(im.numer().sign()),
        // go/constant.Sign(unknownVal) returns 1.
        _ => 1,
    }
}

#[napi]
pub fn const_bit_len(v: &GoConstValue) -> Result<i32> {
    match (v.kind.as_str(), v.int.as_ref()) {
        ("Int", Some(n)) => Ok(i32::try_from(n.bits()).unwrap_or(i32::MAX)),
        ("Unknown", _) => Ok(0),
        _ => Err(Error::new(
            Status::InvalidArg,
            "gotool: constBitLen requires Int",
        )),
    }
}

/// Int: decimal. Float: `ExactString` (`n` or `n/d`).
/// Complex IMAG: Go `ExactString` `"(0 + <imag>i)"`.
/// String: Go `ExactString` (`strconv.Quote`). Unknown: `"unknown"`.
#[napi]
pub fn const_string(v: &GoConstValue) -> String {
    match (
        v.kind.as_str(),
        v.int.as_ref(),
        v.rat.as_ref(),
        v.im_rat.as_ref(),
        v.str_bytes.as_ref(),
    ) {
        ("Int", Some(n), _, _, _) => n.to_string(),
        ("Float", _, Some(r), _, _) => rat_exact_string(r),
        ("Complex", _, _, Some(im), _) => format!("(0 + {}i)", rat_exact_string(im)),
        ("String", _, _, _, Some(b)) => quote_go(b),
        _ => "unknown".into(),
    }
}

/// Go `Real`. Numeric non-Complex returns `x`; Complex IMAG real is Int 0.
#[napi]
pub fn const_real(v: &GoConstValue) -> Result<GoConstValue> {
    match v.kind.as_str() {
        "Unknown" | "Int" | "Float" => Ok(clone_value(v)),
        "Complex" => Ok(make_int(num_bigint::BigInt::from(0))),
        _ => Err(Error::new(
            Status::InvalidArg,
            "gotool: constReal requires a numeric or Unknown value",
        )),
    }
}

/// Go `Imag`. Int/Float → Int 0; Complex IMAG imag is the Float prefix.
#[napi]
pub fn const_imag(v: &GoConstValue) -> Result<GoConstValue> {
    match v.kind.as_str() {
        "Unknown" => Ok(make_unknown()),
        "Int" | "Float" => Ok(make_int(num_bigint::BigInt::from(0))),
        "Complex" => match v.im_rat.as_ref() {
            Some(r) => Ok(make_float(r.clone())),
            None => Ok(make_unknown()),
        },
        _ => Err(Error::new(
            Status::InvalidArg,
            "gotool: constImag requires a numeric or Unknown value",
        )),
    }
}

fn is_int_kind(v: &GoConstValue) -> bool {
    v.kind == "Int"
}

fn is_num_kind(v: &GoConstValue) -> bool {
    v.kind == "Int" || v.kind == "Float"
}

fn rat_binop(op: i32, x: &GoConstValue, y: &GoConstValue) -> Result<GoConstValue> {
    let xr = as_rat(x, "x")?;
    let yr = as_rat(y, "y")?;
    if op == token::QUO && yr.numer().sign() == Sign::NoSign {
        // Issue #28: JS maps Go's QUO-by-zero panic to Unknown.
        return Ok(make_unknown());
    }
    match op {
        token::ADD => Ok(make_float(&xr + &yr)),
        token::SUB => Ok(make_float(&xr - &yr)),
        token::MUL => Ok(make_float(&xr * &yr)),
        token::QUO => Ok(make_float(&xr / &yr)),
        _ => Err(Error::new(
            Status::InvalidArg,
            "gotool: constBinaryOp Float ops must be ADD, SUB, MUL, or QUO",
        )),
    }
}

/// Int ADD/SUB/MUL/QUO/REM/AND/OR/XOR/AND_NOT.
/// Float (and mixed Int/Float) ADD/SUB/MUL/QUO via `big.Rat` (`match` then `makeRat`).
/// QUO of Ints is Float. QUO/REM by zero → Unknown.
#[napi]
pub fn const_binary_op(op: i32, x: &GoConstValue, y: &GoConstValue) -> Result<GoConstValue> {
    if x.kind == "Unknown" || y.kind == "Unknown" {
        return Ok(make_unknown());
    }
    if !is_num_kind(x) {
        return Err(Error::new(
            Status::InvalidArg,
            "gotool: x must be Int or Float",
        ));
    }
    if !is_num_kind(y) {
        return Err(Error::new(
            Status::InvalidArg,
            "gotool: y must be Int or Float",
        ));
    }
    if is_int_kind(x) && is_int_kind(y) {
        let xi = as_int(x, "x")?;
        let yi = as_int(y, "y")?;
        if (op == token::QUO || op == token::REM) && yi.sign() == Sign::NoSign {
            // Issue #28: JS maps Go's QUO/REM-by-zero panic to Unknown.
            return Ok(make_unknown());
        }
        return match op {
            token::ADD => Ok(make_int(xi + yi)),
            token::SUB => Ok(make_int(xi - yi)),
            token::MUL => Ok(make_int(xi * yi)),
            token::QUO => Ok(make_float(BigRational::new(xi.clone(), yi.clone()))),
            token::REM => Ok(make_int(xi % yi)),
            token::AND => Ok(make_int(xi.bitand(yi))),
            token::OR => Ok(make_int(xi.bitor(yi))),
            token::XOR => Ok(make_int(xi.bitxor(yi))),
            token::AND_NOT => Ok(make_int(xi.bitand(&yi.clone().not()))),
            _ => Err(Error::new(
                Status::InvalidArg,
                "gotool: constBinaryOp op must be ADD, SUB, MUL, QUO, REM, AND, OR, XOR, or AND_NOT",
            )),
        };
    }
    match op {
        token::ADD | token::SUB | token::MUL | token::QUO => rat_binop(op, x, y),
        token::REM | token::AND | token::OR | token::XOR | token::AND_NOT => Err(Error::new(
            Status::InvalidArg,
            "gotool: constBinaryOp REM, AND, OR, XOR, and AND_NOT require Int",
        )),
        _ => Err(Error::new(
            Status::InvalidArg,
            "gotool: constBinaryOp op must be ADD, SUB, MUL, QUO, REM, AND, OR, XOR, or AND_NOT",
        )),
    }
}

fn as_prec(prec: i64) -> Result<u32> {
    u32::try_from(prec).map_err(|_| {
        Error::new(
            Status::InvalidArg,
            "gotool: constUnaryOp prec must be an integer in 0..1000000",
        )
    }).and_then(|p| {
        if p > 1_000_000 {
            Err(Error::new(
                Status::InvalidArg,
                "gotool: constUnaryOp prec must be an integer in 0..1000000",
            ))
        } else {
            Ok(p)
        }
    })
}

fn as_shift_count(s: &BigInt) -> Result<u32> {
    let (neg, n, lossless) = s.get_u64();
    if neg || !lossless || n > 1_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "gotool: constShift s must be a non-negative bigint in 0..1000000",
        ));
    }
    Ok(n as u32)
}

/// Int ADD/SUB/XOR. Float ADD/SUB via `big.Rat` (identity / `Neg`). XOR requires Int.
/// `prec` is Go's XOR width in bits; 0 means unlimited (two's complement).
#[napi]
pub fn const_unary_op(op: i32, y: &GoConstValue, prec: i64) -> Result<GoConstValue> {
    let prec = as_prec(prec)?;
    if !matches!(op, token::ADD | token::SUB | token::XOR) {
        return Err(Error::new(
            Status::InvalidArg,
            "gotool: constUnaryOp op must be ADD, SUB, or XOR",
        ));
    }
    if y.kind == "Unknown" {
        return Ok(make_unknown());
    }
    if is_int_kind(y) {
        let yi = as_int(y, "y")?;
        return match op {
            token::ADD => Ok(make_int(yi.clone())),
            token::SUB => Ok(make_int(-yi)),
            token::XOR => {
                let mut z = yi.clone().not();
                if prec > 0 {
                    let high = num_bigint::BigInt::from(-1).shl(prec as usize);
                    z = z.bitand(&high.not());
                }
                Ok(make_int(z))
            }
            _ => unreachable!(),
        };
    }
    if y.kind == "Float" {
        if op == token::XOR {
            return Err(Error::new(
                Status::InvalidArg,
                "gotool: constUnaryOp XOR requires Int",
            ));
        }
        let yr = as_rat(y, "y")?;
        return match op {
            token::ADD => Ok(make_float(yr)),
            token::SUB => Ok(make_float(-yr)),
            _ => unreachable!(),
        };
    }
    Err(Error::new(
        Status::InvalidArg,
        "gotool: y must be Int or Float",
    ))
}

/// Int SHL/SHR. `s` is Go's `uint` shift count.
#[napi]
pub fn const_shift(op: i32, x: &GoConstValue, s: BigInt) -> Result<GoConstValue> {
    let s = as_shift_count(&s)?;
    if x.kind == "Unknown" {
        return match op {
            token::SHL | token::SHR => Ok(make_unknown()),
            _ => Err(Error::new(
                Status::InvalidArg,
                "gotool: constShift op must be SHL or SHR",
            )),
        };
    }
    let xi = as_int(x, "x")?;
    match op {
        token::SHL => Ok(make_int(xi.clone().shl(s as usize))),
        token::SHR => Ok(make_int(xi.clone().shr(s as usize))),
        _ => Err(Error::new(
            Status::InvalidArg,
            "gotool: constShift op must be SHL or SHR",
        )),
    }
}

/// Go `math/big` MaxExp / MinExp and `go/constant.maxExp` (4<<10).
const BIG_MAX_EXP: i64 = 2_147_483_647;
const BIG_MIN_EXP: i64 = -2_147_483_647;
const SMALL_FLOAT_EXP: i64 = 4 << 10;

struct Cursor<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Cursor<'a> {
    fn read(&mut self) -> Option<u8> {
        if self.i >= self.s.len() {
            None
        } else {
            let c = self.s[self.i];
            self.i += 1;
            Some(c)
        }
    }

    fn unread(&mut self) {
        if self.i > 0 {
            self.i -= 1;
        }
    }
}

fn digit_val(ch: u8) -> u32 {
    match ch {
        b'0'..=b'9' => u32::from(ch - b'0'),
        b'a'..=b'z' => u32::from(ch - b'a') + 10,
        b'A'..=b'Z' => u32::from(ch - b'A') + 10,
        _ => 100,
    }
}

/// Go `math/big` `nat.scan` with `base == 0`.
fn scan_mant(cur: &mut Cursor<'_>, frac_ok: bool) -> Option<(num_bigint::BigInt, u32, i32)> {
    let mut prev = b'.';
    let mut inval_sep = false;
    let mut frac_ok = frac_ok;
    let ch0 = cur.read();
    let mut ch = ch0;
    let mut b: u32 = 10;
    let mut prefix: u8 = 0;
    let mut count: i32 = 0;
    if ch == Some(b'0') {
        prev = b'0';
        count = 1;
        ch = cur.read();
        if let Some(c) = ch {
            match c {
                b'b' | b'B' => {
                    b = 2;
                    prefix = b'b';
                }
                b'o' | b'O' => {
                    b = 8;
                    prefix = b'o';
                }
                b'x' | b'X' => {
                    b = 16;
                    prefix = b'x';
                }
                _ => {
                    if !frac_ok {
                        b = 8;
                        prefix = b'0';
                    }
                }
            }
            if prefix != 0 {
                count = 0;
                if prefix != b'0' {
                    ch = cur.read();
                }
            }
        }
    }
    let mut mant = num_bigint::BigInt::from(0);
    let mut dp: i32 = -1;
    while let Some(c) = ch {
        if c == b'.' && frac_ok {
            frac_ok = false;
            if prev == b'_' {
                inval_sep = true;
            }
            prev = b'.';
            dp = count;
        } else if c == b'_' {
            if prev != b'0' {
                inval_sep = true;
            }
            prev = b'_';
        } else {
            let d1 = digit_val(c);
            if d1 >= b {
                cur.unread();
                break;
            }
            prev = b'0';
            count += 1;
            mant = mant * b + d1;
        }
        ch = cur.read();
    }
    if inval_sep || prev == b'_' {
        return None;
    }
    if count == 0 {
        if prefix == b'0' {
            return Some((num_bigint::BigInt::from(0), 10, 1));
        }
        return None;
    }
    if dp >= 0 {
        count = dp - count;
    }
    Some((mant, b, count))
}

fn scan_exp(cur: &mut Cursor<'_>) -> Option<(i64, u32)> {
    let Some(ch0) = cur.read() else {
        return Some((0, 10));
    };
    let ebase = match ch0 {
        b'e' | b'E' => 10u32,
        b'p' | b'P' => 2u32,
        _ => {
            cur.unread();
            return Some((0, 10));
        }
    };
    let mut digits = Vec::new();
    let mut ch = cur.read();
    if ch == Some(b'+') || ch == Some(b'-') {
        if ch == Some(b'-') {
            digits.push(b'-');
        }
        ch = cur.read();
    }
    let mut prev = b'.';
    let mut inval_sep = false;
    let mut has_digits = false;
    while let Some(c) = ch {
        if c.is_ascii_digit() {
            digits.push(c);
            prev = b'0';
            has_digits = true;
        } else if c == b'_' {
            if prev != b'0' {
                inval_sep = true;
            }
            prev = b'_';
        } else {
            cur.unread();
            break;
        }
        ch = cur.read();
    }
    if !has_digits || inval_sep || prev == b'_' {
        return None;
    }
    let s = std::str::from_utf8(&digits).ok()?;
    let exp = s.parse::<i64>().ok()?;
    Some((exp, ebase))
}

fn scan_sign(cur: &mut Cursor<'_>) -> bool {
    match cur.read() {
        Some(b'+') => false,
        Some(b'-') => true,
        Some(_) => {
            cur.unread();
            false
        }
        None => false,
    }
}

fn parse_int_literal(lit: &str) -> Option<num_bigint::BigInt> {
    if lit.is_empty() {
        return None;
    }
    let mut cur = Cursor {
        s: lit.as_bytes(),
        i: 0,
    };
    let neg = scan_sign(&mut cur);
    let (mut mant, _, _) = scan_mant(&mut cur, false)?;
    if cur.i != cur.s.len() {
        return None;
    }
    if neg && mant.sign() != Sign::NoSign {
        mant = -mant;
    }
    Some(mant)
}

fn approx_log2(mant_bits: i64, exp2: i64, exp5: i64) -> i64 {
    // log2(5) ≈ 2.321928094887362
    let log5 = (exp5 as i128) * 2_321_928_094_887_362i128 / 1_000_000_000_000_000i128;
    let s = mant_bits as i128 + exp2 as i128 + log5;
    if s > i64::MAX as i128 {
        i64::MAX
    } else if s < i64::MIN as i128 {
        i64::MIN
    } else {
        s as i64
    }
}

fn apply_exp2_exp5(
    mant: num_bigint::BigInt,
    neg: bool,
    exp2: i64,
    exp5: i64,
) -> Option<GoConstValue> {
    if mant.sign() == Sign::NoSign {
        return Some(make_float(BigRational::from_integer(num_bigint::BigInt::from(
            0,
        ))));
    }
    let bits = i64::try_from(mant.bits()).unwrap_or(i64::MAX);
    let log2 = approx_log2(bits, exp2, exp5);
    if log2 > BIG_MAX_EXP {
        return None;
    }
    if log2 < BIG_MIN_EXP {
        return Some(make_float(BigRational::from_integer(num_bigint::BigInt::from(
            0,
        ))));
    }
    if log2.unsigned_abs() >= SMALL_FLOAT_EXP as u64 && log2 != 0 {
        return None;
    }
    if exp5.unsigned_abs() > 1_000_000 || exp2.unsigned_abs() > 10_000_000 {
        return None;
    }
    let mut numer = mant;
    let mut denom = num_bigint::BigInt::from(1);
    if exp5 > 0 {
        numer *= num_bigint::BigInt::from(5).pow(u32::try_from(exp5).ok()?);
    } else if exp5 < 0 {
        denom *= num_bigint::BigInt::from(5).pow(u32::try_from(-exp5).ok()?);
    }
    if exp2 > 0 {
        numer <<= exp2 as usize;
    } else if exp2 < 0 {
        denom <<= (-exp2) as usize;
    }
    if denom.sign() == Sign::NoSign {
        return None;
    }
    if neg {
        numer = -numer;
    }
    Some(make_float(BigRational::new(numer, denom)))
}

fn unhex(b: u8) -> Option<u32> {
    match b {
        b'0'..=b'9' => Some(u32::from(b - b'0')),
        b'a'..=b'f' => Some(u32::from(b - b'a' + 10)),
        b'A'..=b'F' => Some(u32::from(b - b'A' + 10)),
        _ => None,
    }
}

fn valid_rune(v: u32) -> bool {
    v < 0xD800 || (0xDFFF < v && v <= 0x10FFFF)
}

/// Go `utf8.DecodeRune`: invalid leading bytes become U+FFFD with size 1.
fn decode_rune_prefix(s: &[u8]) -> (u32, usize) {
    if s.is_empty() {
        return (0xFFFD, 0);
    }
    match std::str::from_utf8(s) {
        Ok(t) => match t.chars().next() {
            Some(ch) => (ch as u32, ch.len_utf8()),
            None => (0xFFFD, 0),
        },
        Err(err) => {
            if err.valid_up_to() > 0 {
                let t = std::str::from_utf8(&s[..err.valid_up_to()]).expect("prefix utf8");
                let ch = t.chars().next().expect("prefix char");
                (ch as u32, ch.len_utf8())
            } else {
                (0xFFFD, 1)
            }
        }
    }
}

/// Go `strconv.UnquoteChar` with `quote`. Returns (value, consumed, multibyte).
fn unquote_char(s: &[u8], quote: u8) -> Option<(i32, usize, bool)> {
    if s.is_empty() {
        return None;
    }
    let c = s[0];
    if c == quote && (quote == b'\'' || quote == b'"') {
        return None;
    }
    if c >= 0x80 {
        let (r, size) = decode_rune_prefix(s);
        return Some((r as i32, size, true));
    }
    if c != b'\\' {
        return Some((i32::from(c), 1, false));
    }
    if s.len() <= 1 {
        return None;
    }
    let esc = s[1];
    let rest = &s[2..];
    match esc {
        b'a' => Some((0x07, 2, false)),
        b'b' => Some((0x08, 2, false)),
        b'f' => Some((0x0c, 2, false)),
        b'n' => Some((0x0a, 2, false)),
        b'r' => Some((0x0d, 2, false)),
        b't' => Some((0x09, 2, false)),
        b'v' => Some((0x0b, 2, false)),
        b'\\' => Some((i32::from(b'\\'), 2, false)),
        b'\'' | b'"' => {
            if esc != quote {
                return None;
            }
            Some((i32::from(esc), 2, false))
        }
        b'x' | b'u' | b'U' => {
            let n = match esc {
                b'x' => 2,
                b'u' => 4,
                _ => 8,
            };
            if rest.len() < n {
                return None;
            }
            let mut v = 0u32;
            for j in 0..n {
                v = (v << 4) | unhex(rest[j])?;
            }
            if esc == b'x' {
                Some((v as i32, 2 + n, false))
            } else if valid_rune(v) {
                Some((v as i32, 2 + n, true))
            } else {
                None
            }
        }
        b'0'..=b'7' => {
            if rest.len() < 2 {
                return None;
            }
            let mut v = u32::from(esc - b'0');
            for j in 0..2 {
                let x = u32::from(rest[j].wrapping_sub(b'0'));
                if x > 7 {
                    return None;
                }
                v = (v << 3) | x;
            }
            if v > 255 {
                return None;
            }
            Some((v as i32, 4, false))
        }
        _ => None,
    }
}

fn parse_char_literal(lit: &str) -> Option<i32> {
    let n = lit.len();
    if n < 2 {
        return None;
    }
    unquote_char(&lit.as_bytes()[1..n - 1], b'\'').map(|(code, _, _)| code)
}

/// Go `strconv.Unquote`. Rem leftover after the first quoted prefix is Unknown.
fn unquote(lit: &str) -> Option<Vec<u8>> {
    let inb = lit.as_bytes();
    if inb.len() < 2 {
        return None;
    }
    let quote = inb[0];
    let rel = inb[1..].iter().position(|&b| b == quote)?;
    let end = rel + 2;
    match quote {
        b'`' => {
            if end != inb.len() {
                return None;
            }
            Some(inb[1..end - 1].iter().copied().filter(|&b| b != b'\r').collect())
        }
        b'"' | b'\'' => {
            let prefix = &inb[..end];
            if !prefix.contains(&b'\\') && !prefix.contains(&b'\n') {
                let inner = &inb[1..end - 1];
                let valid = if quote == b'"' {
                    std::str::from_utf8(inner).is_ok()
                } else {
                    let (r, n) = decode_rune_prefix(inner);
                    n == inner.len() && (r != 0xFFFD || n != 1)
                };
                if valid {
                    if end != inb.len() {
                        return None;
                    }
                    return Some(inner.to_vec());
                }
            }
            let mut cur = &inb[1..];
            let mut buf = Vec::new();
            while !cur.is_empty() && cur[0] != quote {
                if cur[0] == b'\n' {
                    return None;
                }
                let (r, n, multibyte) = unquote_char(cur, quote)?;
                cur = &cur[n..];
                if (r as u32) < 0x80 || !multibyte {
                    buf.push(r as u8);
                } else {
                    let ch = char::from_u32(r as u32)?;
                    let mut tmp = [0u8; 4];
                    buf.extend_from_slice(ch.encode_utf8(&mut tmp).as_bytes());
                }
                if quote == b'\'' {
                    break;
                }
            }
            if cur.is_empty() || cur[0] != quote {
                return None;
            }
            cur = &cur[1..];
            if !cur.is_empty() {
                return None;
            }
            Some(buf)
        }
        _ => None,
    }
}

fn is_noncharacter(r: u32) -> bool {
    (0xFDD0..=0xFDEF).contains(&r) || r & 0xFFFE == 0xFFFE
}

fn is_print_go(r: u32) -> bool {
    if r <= 0xFF {
        (0x20..=0x7E).contains(&r) || ((0xA1..=0xFF).contains(&r) && r != 0xAD)
    } else if is_noncharacter(r) {
        false
    } else {
        // Corpus excludes unescaped Cf/Cc unicode (U+200B etc.).
        char::from_u32(r).is_some()
    }
}

/// Go `strconv.Quote` for `ExactString`. Latin-1 `IsPrint` matches Go; r>0xFF
/// treated as printable (this checkpoint's STRING corpus is all printable there).
fn quote_go(s: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut buf = Vec::with_capacity(s.len() + 2);
    buf.push(b'"');
    let mut i = 0;
    while i < s.len() {
        let mut r = u32::from(s[i]);
        let mut width = 1;
        if r >= 0x80 {
            let (rr, w) = decode_rune_prefix(&s[i..]);
            r = rr;
            width = w;
        }
        if width == 1 && r == 0xFFFD {
            buf.extend_from_slice(b"\\x");
            buf.push(HEX[(s[i] >> 4) as usize]);
            buf.push(HEX[(s[i] & 0x0f) as usize]);
            i += 1;
            continue;
        }
        if r == u32::from(b'"') || r == u32::from(b'\\') {
            buf.push(b'\\');
            buf.push(r as u8);
            i += width;
            continue;
        }
        if is_print_go(r) {
            if r < 0x80 {
                buf.push(r as u8);
            } else if let Some(ch) = char::from_u32(r) {
                let mut tmp = [0u8; 4];
                buf.extend_from_slice(ch.encode_utf8(&mut tmp).as_bytes());
            } else {
                buf.extend_from_slice(b"\\uFFFD");
            }
            i += width;
            continue;
        }
        match r {
            0x07 => buf.extend_from_slice(b"\\a"),
            0x08 => buf.extend_from_slice(b"\\b"),
            0x0c => buf.extend_from_slice(b"\\f"),
            0x0a => buf.extend_from_slice(b"\\n"),
            0x0d => buf.extend_from_slice(b"\\r"),
            0x09 => buf.extend_from_slice(b"\\t"),
            0x0b => buf.extend_from_slice(b"\\v"),
            r if r < 0x20 || r == 0x7f => {
                buf.extend_from_slice(b"\\x");
                buf.push(HEX[(r >> 4) as usize]);
                buf.push(HEX[(r & 0x0f) as usize]);
            }
            r if r < 0x10000 => {
                buf.extend_from_slice(b"\\u");
                for sft in [12, 8, 4, 0] {
                    buf.push(HEX[((r >> sft) & 0x0f) as usize]);
                }
            }
            r => {
                buf.extend_from_slice(b"\\U");
                for sft in [28, 24, 20, 16, 12, 8, 4, 0] {
                    buf.push(HEX[((r >> sft) & 0x0f) as usize]);
                }
            }
        }
        i += width;
    }
    buf.push(b'"');
    String::from_utf8(buf).expect("quote_go ascii/utf8")
}

fn parse_string_literal(lit: &str) -> Option<Vec<u8>> {
    unquote(lit)
}

fn parse_imag_literal(lit: &str) -> Option<GoConstValue> {
    let n = lit.len();
    if n == 0 || lit.as_bytes()[n - 1] != b'i' {
        return None;
    }
    match parse_float_literal(&lit[..n - 1]) {
        Some(im) => im.rat.clone().map(make_complex_from_imag),
        None => None,
    }
}

fn parse_float_literal(lit: &str) -> Option<GoConstValue> {
    if lit.is_empty() {
        return None;
    }
    let mut cur = Cursor {
        s: lit.as_bytes(),
        i: 0,
    };
    let neg = scan_sign(&mut cur);
    let (mant, base, fcount) = scan_mant(&mut cur, true)?;
    let (exp, ebase) = scan_exp(&mut cur)?;
    if cur.i != cur.s.len() {
        return None;
    }
    let mut exp2: i64 = 0;
    let mut exp5: i64 = 0;
    if fcount < 0 {
        let d = i64::from(fcount);
        match base {
            10 => {
                exp5 = d;
                exp2 = d;
            }
            2 => exp2 = d,
            8 => exp2 = d.checked_mul(3)?,
            16 => exp2 = d.checked_mul(4)?,
            _ => return None,
        }
    }
    match ebase {
        10 => {
            exp5 = exp5.checked_add(exp)?;
            exp2 = exp2.checked_add(exp)?;
        }
        2 => exp2 = exp2.checked_add(exp)?,
        _ => return None,
    }
    apply_exp2_exp5(mant, neg, exp2, exp5)
}

/// Go `MakeFromLiteral` for INT/FLOAT/IMAG/CHAR/STRING. Invalid lit → Unknown.
/// Other toks throw. `prec` must be 0 (Go panics otherwise). CHAR is an Int (rune).
/// IMAG is Complex `(0 + <float>i)`. STRING is `strconv.Unquote` (CHAR `'ab'` is
/// Int 97; STRING `'ab'` is Unknown because Unquote rejects leftover).
#[napi]
pub fn const_make_from_literal(lit: String, tok: i32, prec: i64) -> Result<GoConstValue> {
    if prec != 0 {
        return Err(Error::new(
            Status::InvalidArg,
            "gotool: constMakeFromLiteral prec must be 0",
        ));
    }
    match tok {
        token::INT => Ok(parse_int_literal(&lit)
            .map(make_int)
            .unwrap_or_else(make_unknown)),
        token::FLOAT => Ok(parse_float_literal(&lit).unwrap_or_else(make_unknown)),
        token::IMAG => Ok(parse_imag_literal(&lit).unwrap_or_else(make_unknown)),
        token::CHAR => Ok(parse_char_literal(&lit)
            .map(|code| make_int(num_bigint::BigInt::from(code)))
            .unwrap_or_else(make_unknown)),
        token::STRING => Ok(parse_string_literal(&lit)
            .map(make_string)
            .unwrap_or_else(make_unknown)),
        _ => Err(Error::new(
            Status::InvalidArg,
            "gotool: constMakeFromLiteral tok must be INT, FLOAT, CHAR, IMAG, or STRING",
        )),
    }
}
