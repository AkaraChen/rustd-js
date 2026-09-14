use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Opaque `go/constant.Value` for the Int/MakeInt64 slice (issue #28).
#[napi]
pub struct GoConstValue {
    kind: String,
    int: i64,
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

fn i64_from_bigint(value: &BigInt) -> Result<i64> {
    let (n, lossless) = value.get_i64();
    if !lossless {
        return Err(Error::new(
            Status::InvalidArg,
            "gotool: constMakeInt64 value must fit in int64",
        ));
    }
    Ok(n)
}

#[napi]
pub fn const_make_int64(v: BigInt) -> Result<GoConstValue> {
    Ok(GoConstValue {
        kind: "Int".into(),
        int: i64_from_bigint(&v)?,
    })
}

#[napi]
pub fn const_to_int(v: &GoConstValue) -> ConstToIntResult {
    ConstToIntResult {
        value: BigInt::from(v.int),
        ok: v.kind == "Int",
    }
}

#[napi]
pub fn const_compare(x: &GoConstValue, y: &GoConstValue) -> i32 {
    match x.int.cmp(&y.int) {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => 1,
    }
}

#[napi]
pub fn const_sign(v: &GoConstValue) -> i32 {
    match v.int.cmp(&0) {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => 1,
    }
}

#[napi]
pub fn const_bit_len(v: &GoConstValue) -> i32 {
    // go/constant.BitLen → math/big.Int.BitLen of the absolute value.
    let abs = v.int.unsigned_abs();
    i32::try_from(u64::BITS - abs.leading_zeros()).unwrap_or(0)
}
