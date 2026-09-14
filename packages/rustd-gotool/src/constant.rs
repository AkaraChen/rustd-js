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

#[napi]
pub fn const_compare(x: &GoConstValue, y: &GoConstValue) -> Result<i32> {
    let xi = as_int(x, "x")?;
    let yi = as_int(y, "y")?;
    Ok(match xi.cmp(yi) {
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

#[napi]
pub fn const_binary_op(op: i32, x: &GoConstValue, y: &GoConstValue) -> Result<GoConstValue> {
    if x.kind == "Unknown" || y.kind == "Unknown" {
        return Ok(make_unknown());
    }
    let xi = as_int(x, "x")?;
    let yi = as_int(y, "y")?;
    if (op == token::QUO || op == token::REM) && yi.sign() == Sign::NoSign {
        // Issue #28: JS maps Go's QUO/REM-by-zero panic to Unknown.
        return Ok(make_unknown());
    }
    match op {
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

/// Int ADD/SUB/XOR. `prec` is Go's XOR width in bits; 0 means unlimited (two's complement).
#[napi]
pub fn const_unary_op(op: i32, y: &GoConstValue, prec: i64) -> Result<GoConstValue> {
    let prec = as_prec(prec)?;
    if y.kind == "Unknown" {
        return match op {
            token::ADD | token::SUB | token::XOR => Ok(make_unknown()),
            _ => Err(Error::new(
                Status::InvalidArg,
                "gotool: constUnaryOp op must be ADD, SUB, or XOR",
            )),
        };
    }
    let yi = as_int(y, "y")?;
    match op {
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
        _ => Err(Error::new(
            Status::InvalidArg,
            "gotool: constUnaryOp op must be ADD, SUB, or XOR",
        )),
    }
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
