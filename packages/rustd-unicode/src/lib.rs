mod case;
mod generated;
mod predicates;
mod tables;
mod utf16;
mod utf8;



use napi::bindgen_prelude::*;
use napi_derive::napi;

fn err(msg: String) -> Error {
    Error::from_reason(msg)
}

fn slice_at(data: &[u8], offset: Option<u32>) -> Result<&[u8]> {
    let off = offset.unwrap_or(0) as usize;
    if off > data.len() {
        return Err(err("RangeError:offset out of range".into()));
    }
    Ok(&data[off..])
}

#[napi]
pub fn unicode_version() -> String {
    generated::UNICODE_VERSION.to_string()
}

#[napi]
pub const MAX_RUNE: i32 = 0x10FFFF;
#[napi]
pub const REPLACEMENT_CHAR: i32 = 0xFFFD;
#[napi]
pub const MAX_ASCII: i32 = 0x7F;
#[napi]
pub const MAX_LATIN1: i32 = 0xFF;
#[napi]
pub const UTF8_RUNE_ERROR: i32 = 0xFFFD;
#[napi]
pub const UTF8_RUNE_SELF: i32 = 0x80;
#[napi]
pub const UTF8_MAX_RUNE: i32 = 0x10FFFF;
#[napi]
pub const UTF8_UTF_MAX: i32 = 4;

#[napi]
pub fn is_control(r: i32) -> bool {
    predicates::is_control(r)
}
#[napi]
pub fn is_digit(r: i32) -> bool {
    predicates::is_digit(r)
}
#[napi]
pub fn is_graphic(r: i32) -> bool {
    predicates::is_graphic(r)
}
#[napi]
pub fn is_letter(r: i32) -> bool {
    predicates::is_letter(r)
}
#[napi]
pub fn is_lower(r: i32) -> bool {
    predicates::is_lower(r)
}
#[napi]
pub fn is_mark(r: i32) -> bool {
    predicates::is_mark(r)
}
#[napi]
pub fn is_number(r: i32) -> bool {
    predicates::is_number(r)
}
#[napi]
pub fn is_print(r: i32) -> bool {
    predicates::is_print(r)
}
#[napi]
pub fn is_punct(r: i32) -> bool {
    predicates::is_punct(r)
}
#[napi]
pub fn is_space(r: i32) -> bool {
    predicates::is_space(r)
}
#[napi]
pub fn is_symbol(r: i32) -> bool {
    predicates::is_symbol(r)
}
#[napi]
pub fn is_title(r: i32) -> bool {
    predicates::is_title(r)
}
#[napi]
pub fn is_upper(r: i32) -> bool {
    predicates::is_upper(r)
}

#[napi]
pub fn is_table(name: String, r: i32) -> Result<bool> {
    Ok(tables::is_in(tables::require_table(&name).map_err(err)?, r))
}

#[napi]
pub fn is_one_of_tables(names: Vec<String>, r: i32) -> Result<bool> {
    let mut any = false;
    for name in names {
        if tables::is_in(tables::require_table(&name).map_err(err)?, r) {
            any = true;
        }
    }
    Ok(any)
}

#[napi]
pub fn tables_of(r: i32) -> Vec<String> {
    tables::tables_of(r)
}

#[napi]
pub fn range_table_names() -> Vec<String> {
    tables::table_names()
}

#[napi]
pub fn to_case(kind: String, r: i32) -> Result<i32> {
    Ok(case::to_case(case::case_kind(&kind).map_err(err)?, r))
}

#[napi]
pub fn to_upper(r: i32) -> i32 {
    case::to_upper(r)
}
#[napi]
pub fn to_lower(r: i32) -> i32 {
    case::to_lower(r)
}
#[napi]
pub fn to_title(r: i32) -> i32 {
    case::to_title(r)
}
#[napi]
pub fn simple_fold(r: i32) -> i32 {
    case::simple_fold(r)
}

#[napi]
pub fn to_special_case(name: String, kind: String, r: i32) -> Result<i32> {
    case::to_special_case(&name, case::case_kind(&kind).map_err(err)?, r).map_err(err)
}

#[napi(object)]
pub struct RuneSize {
    pub r: i32,
    pub size: i32,
}

#[napi(object)]
pub struct Utf16Pair {
    pub r1: i32,
    pub r2: i32,
}

#[napi]
pub fn utf8_valid(bytes: Uint8Array) -> bool {
    utf8::valid(bytes.as_ref())
}

#[napi]
pub fn utf8_valid_rune(r: i32) -> bool {
    utf8::valid_rune(r)
}

#[napi]
pub fn utf8_rune_len(r: i32) -> i32 {
    utf8::rune_len(r)
}

#[napi]
pub fn utf8_rune_count(bytes: Uint8Array) -> i32 {
    utf8::rune_count(bytes.as_ref())
}

#[napi]
pub fn utf8_rune_start(b: i32) -> Result<bool> {
    if !(0..=255).contains(&b) {
        return Err(err("TypeError:utf8RuneStart expects a byte 0..255".into()));
    }
    Ok(utf8::rune_start(b as u8))
}

#[napi]
pub fn utf8_full_rune(bytes: Uint8Array, offset: Option<u32>) -> Result<bool> {
    Ok(utf8::full_rune(slice_at(bytes.as_ref(), offset)?))
}

#[napi]
pub fn utf8_decode_rune(bytes: Uint8Array, offset: Option<u32>) -> Result<RuneSize> {
    let (r, size) = utf8::decode_rune(slice_at(bytes.as_ref(), offset)?);
    Ok(RuneSize { r, size: size as i32 })
}

#[napi]
pub fn utf8_decode_last_rune(bytes: Uint8Array) -> RuneSize {
    let (r, size) = utf8::decode_last_rune(bytes.as_ref());
    RuneSize { r, size: size as i32 }
}

#[napi]
pub fn utf8_encode_rune(r: i32) -> Uint8Array {
    utf8::encode_rune(r).into()
}

#[napi]
pub fn utf8_encode_rune_strict(r: i32) -> Result<Uint8Array> {
    Ok(utf8::encode_rune_strict(r).map_err(err)?.into())
}

#[napi]
pub fn utf8_append_rune(out: Uint8Array, r: i32) -> Uint8Array {
    utf8::append_rune(out.as_ref(), r).into()
}

#[napi]
pub fn utf16_encode(codepoints: Uint32Array) -> Uint16Array {
    let runes: Vec<i32> = codepoints.as_ref().iter().map(|&x| x as i32).collect();
    utf16::encode(&runes).into()
}

#[napi]
pub fn utf16_encode_rune(r: i32) -> Utf16Pair {
    let (r1, r2) = utf16::encode_rune(r);
    Utf16Pair { r1, r2 }
}

#[napi]
pub fn utf16_decode(units: Uint16Array) -> Uint32Array {
    utf16::decode(units.as_ref()).into()
}

#[napi]
pub fn utf16_decode_rune(r1: i32, r2: i32) -> i32 {
    utf16::decode_rune(r1, r2)
}

#[napi]
pub fn utf16_is_surrogate(r: i32) -> bool {
    utf16::is_surrogate(r)
}

#[napi]
pub fn utf16_rune_len(r: i32) -> i32 {
    utf16::rune_len(r)
}

#[napi]
pub fn utf16_append_rune(out: Uint16Array, r: i32) -> Uint16Array {
    utf16::append_rune(out.as_ref(), r).into()
}

/// Test helper: first code point in `0..=0x10FFFF` where `isTable(name)` disagrees
/// with Go `unicode.Is` compact runs. `-1` means the full sweep matched.
#[napi]
pub fn first_is_table_mismatch(name: String, lo: Uint32Array, hi: Uint32Array) -> Result<i32> {
    let lo = lo.as_ref();
    let hi = hi.as_ref();
    if lo.len() != hi.len() {
        return Err(err("TypeError:lo/hi length mismatch".into()));
    }
    let table = tables::require_table(&name).map_err(err)?;
    let mut i = 0;
    let n = lo.len();
    for r in 0..=0x10FFFFu32 {
        while i < n && hi[i] < r {
            i += 1;
        }
        let want = i < n && lo[i] <= r && r <= hi[i];
        if tables::is_in(table, r as i32) != want {
            return Ok(r as i32);
        }
    }
    Ok(-1)
}
