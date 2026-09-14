use napi::bindgen_prelude::*;
use napi_derive::napi;

fn range(message: &str) -> Error {
    Error::new(Status::GenericFailure, format!("RangeError: {message}"))
}

fn u64_arg(value: BigInt) -> Result<u64> {
    let (negative, magnitude, lossless) = value.get_u64();
    if negative || !lossless {
        return Err(range("math/bits: value out of range"));
    }
    Ok(magnitude)
}

fn u64_out(value: u64) -> BigInt {
    BigInt::from(value)
}

fn rotate_shift(k: i64, width: u32) -> u32 {
    (k as u64 & (u64::from(width) - 1)) as u32
}

fn add32_inner(x: u32, y: u32, carry: u32) -> Result<(u32, u32)> {
    if carry > 1 {
        return Err(range("math/bits: carry must be 0 or 1"));
    }
    let sum = u64::from(x) + u64::from(y) + u64::from(carry);
    Ok((sum as u32, (sum >> 32) as u32))
}

fn add64_inner(x: u64, y: u64, carry: u64) -> Result<(u64, u64)> {
    if carry > 1 {
        return Err(range("math/bits: carry must be 0 or 1"));
    }
    let (sum, carry_out) = wrapping_add64(x, y, carry);
    Ok((sum, carry_out))
}

fn wrapping_add64(x: u64, y: u64, carry: u64) -> (u64, u64) {
    let sum = x.wrapping_add(y).wrapping_add(carry);
    let carry_out = ((x & y) | ((x | y) & !sum)) >> 63;
    (sum, carry_out)
}

fn sub32_inner(x: u32, y: u32, borrow: u32) -> Result<(u32, u32)> {
    if borrow > 1 {
        return Err(range("math/bits: borrow must be 0 or 1"));
    }
    let diff = x.wrapping_sub(y).wrapping_sub(borrow);
    let borrow_out = ((!x & y) | (!(x ^ y) & diff)) >> 31;
    Ok((diff, borrow_out))
}

fn sub64_inner(x: u64, y: u64, borrow: u64) -> Result<(u64, u64)> {
    if borrow > 1 {
        return Err(range("math/bits: borrow must be 0 or 1"));
    }
    let diff = x.wrapping_sub(y).wrapping_sub(borrow);
    let borrow_out = ((!x & y) | (!(x ^ y) & diff)) >> 63;
    Ok((diff, borrow_out))
}

fn div32_inner(hi: u32, lo: u32, y: u32) -> Result<(u32, u32)> {
    if y == 0 {
        return Err(range("integer divide by zero"));
    }
    if y <= hi {
        return Err(range("integer overflow"));
    }
    let z = (u64::from(hi) << 32) | u64::from(lo);
    Ok(((z / u64::from(y)) as u32, (z % u64::from(y)) as u32))
}

fn div64_inner(hi: u64, lo: u64, y: u64) -> Result<(u64, u64)> {
    if y == 0 {
        return Err(range("integer divide by zero"));
    }
    if y <= hi {
        return Err(range("integer overflow"));
    }
    let z = ((hi as u128) << 64) | u128::from(lo);
    let y = u128::from(y);
    Ok(((z / y) as u64, (z % y) as u64))
}

#[napi(object)]
pub struct Add32Result {
    pub sum: u32,
    pub carry_out: u32,
}

#[napi(object)]
pub struct Sub32Result {
    pub diff: u32,
    pub borrow_out: u32,
}

#[napi(object)]
pub struct Mul32Result {
    pub hi: u32,
    pub lo: u32,
}

#[napi(object)]
pub struct Div32Result {
    pub quo: u32,
    pub rem: u32,
}

#[napi(object)]
pub struct Add64Result {
    pub sum: BigInt,
    pub carry_out: BigInt,
}

#[napi(object)]
pub struct Sub64Result {
    pub diff: BigInt,
    pub borrow_out: BigInt,
}

#[napi(object)]
pub struct Mul64Result {
    pub hi: BigInt,
    pub lo: BigInt,
}

#[napi(object)]
pub struct Div64Result {
    pub quo: BigInt,
    pub rem: BigInt,
}

#[napi]
pub fn leading_zeros8(x: u8) -> u32 {
    x.leading_zeros()
}
#[napi]
pub fn leading_zeros16(x: u16) -> u32 {
    x.leading_zeros()
}
#[napi]
pub fn leading_zeros32(x: u32) -> u32 {
    x.leading_zeros()
}
#[napi]
pub fn leading_zeros64(x: BigInt) -> Result<u32> {
    Ok(u64_arg(x)?.leading_zeros())
}

#[napi]
pub fn trailing_zeros8(x: u8) -> u32 {
    x.trailing_zeros()
}
#[napi]
pub fn trailing_zeros16(x: u16) -> u32 {
    x.trailing_zeros()
}
#[napi]
pub fn trailing_zeros32(x: u32) -> u32 {
    x.trailing_zeros()
}
#[napi]
pub fn trailing_zeros64(x: BigInt) -> Result<u32> {
    Ok(u64_arg(x)?.trailing_zeros())
}

#[napi]
pub fn ones_count8(x: u8) -> u32 {
    x.count_ones()
}
#[napi]
pub fn ones_count16(x: u16) -> u32 {
    x.count_ones()
}
#[napi]
pub fn ones_count32(x: u32) -> u32 {
    x.count_ones()
}
#[napi]
pub fn ones_count64(x: BigInt) -> Result<u32> {
    Ok(u64_arg(x)?.count_ones())
}

#[napi]
pub fn len8(x: u8) -> u32 {
    8 - x.leading_zeros()
}
#[napi]
pub fn len16(x: u16) -> u32 {
    16 - x.leading_zeros()
}
#[napi]
pub fn len32(x: u32) -> u32 {
    32 - x.leading_zeros()
}
#[napi]
pub fn len64(x: BigInt) -> Result<u32> {
    Ok(64 - u64_arg(x)?.leading_zeros())
}

#[napi]
pub fn rotate_left8(x: u8, k: i64) -> u8 {
    x.rotate_left(rotate_shift(k, 8))
}
#[napi]
pub fn rotate_left16(x: u16, k: i64) -> u16 {
    x.rotate_left(rotate_shift(k, 16))
}
#[napi]
pub fn rotate_left32(x: u32, k: i64) -> u32 {
    x.rotate_left(rotate_shift(k, 32))
}
#[napi]
pub fn rotate_left64(x: BigInt, k: i64) -> Result<BigInt> {
    Ok(u64_out(u64_arg(x)?.rotate_left(rotate_shift(k, 64))))
}

#[napi]
pub fn reverse8(x: u8) -> u8 {
    x.reverse_bits()
}
#[napi]
pub fn reverse16(x: u16) -> u16 {
    x.reverse_bits()
}
#[napi]
pub fn reverse32(x: u32) -> u32 {
    x.reverse_bits()
}
#[napi]
pub fn reverse64(x: BigInt) -> Result<BigInt> {
    Ok(u64_out(u64_arg(x)?.reverse_bits()))
}

#[napi]
pub fn reverse_bytes16(x: u16) -> u16 {
    x.swap_bytes()
}
#[napi]
pub fn reverse_bytes32(x: u32) -> u32 {
    x.swap_bytes()
}
#[napi]
pub fn reverse_bytes64(x: BigInt) -> Result<BigInt> {
    Ok(u64_out(u64_arg(x)?.swap_bytes()))
}

#[napi]
pub fn add32(x: u32, y: u32, carry: u32) -> Result<Add32Result> {
    let (sum, carry_out) = add32_inner(x, y, carry)?;
    Ok(Add32Result { sum, carry_out })
}
#[napi]
pub fn add64(x: BigInt, y: BigInt, carry: BigInt) -> Result<Add64Result> {
    let (sum, carry_out) = add64_inner(u64_arg(x)?, u64_arg(y)?, u64_arg(carry)?)?;
    Ok(Add64Result {
        sum: u64_out(sum),
        carry_out: u64_out(carry_out),
    })
}

#[napi]
pub fn sub32(x: u32, y: u32, borrow: u32) -> Result<Sub32Result> {
    let (diff, borrow_out) = sub32_inner(x, y, borrow)?;
    Ok(Sub32Result { diff, borrow_out })
}
#[napi]
pub fn sub64(x: BigInt, y: BigInt, borrow: BigInt) -> Result<Sub64Result> {
    let (diff, borrow_out) = sub64_inner(u64_arg(x)?, u64_arg(y)?, u64_arg(borrow)?)?;
    Ok(Sub64Result {
        diff: u64_out(diff),
        borrow_out: u64_out(borrow_out),
    })
}

#[napi]
pub fn mul32(x: u32, y: u32) -> Mul32Result {
    let product = u64::from(x) * u64::from(y);
    Mul32Result {
        hi: (product >> 32) as u32,
        lo: product as u32,
    }
}
#[napi]
pub fn mul64(x: BigInt, y: BigInt) -> Result<Mul64Result> {
    let product = u128::from(u64_arg(x)?) * u128::from(u64_arg(y)?);
    Ok(Mul64Result {
        hi: u64_out((product >> 64) as u64),
        lo: u64_out(product as u64),
    })
}

#[napi]
pub fn div32(hi: u32, lo: u32, y: u32) -> Result<Div32Result> {
    let (quo, rem) = div32_inner(hi, lo, y)?;
    Ok(Div32Result { quo, rem })
}
#[napi]
pub fn div64(hi: BigInt, lo: BigInt, y: BigInt) -> Result<Div64Result> {
    let (quo, rem) = div64_inner(u64_arg(hi)?, u64_arg(lo)?, u64_arg(y)?)?;
    Ok(Div64Result {
        quo: u64_out(quo),
        rem: u64_out(rem),
    })
}

#[napi]
pub fn rem32(hi: u32, lo: u32, y: u32) -> Result<u32> {
    Ok(div32_inner(hi, lo, y)?.1)
}
#[napi]
pub fn rem64(hi: BigInt, lo: BigInt, y: BigInt) -> Result<BigInt> {
    Ok(u64_out(div64_inner(u64_arg(hi)?, u64_arg(lo)?, u64_arg(y)?)?.1))
}
