use crate::token;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use num_bigint::Sign;
use num_rational::BigRational;
use std::ops::{BitAnd, BitOr, BitXor, Not, Shl, Shr};

/// Opaque `go/constant.Value` (issue #28). Int is arbitrary-precision.
/// QUO of Ints is a Float (`big.Rat`); QUO/REM by zero is Unknown.
#[napi]
pub struct GoConstValue {
    kind: String,
    int: Option<num_bigint::BigInt>,
    rat: Option<BigRational>,
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
    }
}

fn make_float(r: BigRational) -> GoConstValue {
    GoConstValue {
        kind: "Float".into(),
        int: None,
        rat: Some(r),
    }
}

fn make_unknown() -> GoConstValue {
    GoConstValue {
        kind: "Unknown".into(),
        int: None,
        rat: None,
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

/// Go `StringVal`: `["", true]` for Unknown; Int/Float would panic → `["", false]`.
#[napi]
pub fn const_to_string(v: &GoConstValue) -> ConstToStringResult {
    match v.kind.as_str() {
        "Unknown" => ConstToStringResult {
            value: String::new(),
            ok: true,
        },
        "String" => ConstToStringResult {
            value: String::new(),
            ok: false,
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
    match (v.kind.as_str(), v.int.as_ref(), v.rat.as_ref()) {
        ("Int", Some(n), _) => sign_i32(n.sign()),
        ("Float", _, Some(r)) => sign_i32(r.numer().sign()),
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

/// Int: decimal. Float: `ExactString` (`n` or `n/d`). Unknown: `"unknown"`.
#[napi]
pub fn const_string(v: &GoConstValue) -> String {
    match (v.kind.as_str(), v.int.as_ref(), v.rat.as_ref()) {
        ("Int", Some(n), _) => n.to_string(),
        ("Float", _, Some(r)) => {
            if r.denom() == &num_bigint::BigInt::from(1) {
                r.numer().to_string()
            } else {
                format!("{}/{}", r.numer(), r.denom())
            }
        }
        _ => "unknown".into(),
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
