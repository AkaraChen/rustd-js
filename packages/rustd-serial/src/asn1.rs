//! Go 1.24 `encoding/asn1` Marshal/Unmarshal (DER-only), schema-driven.
//! TLV and primitive codecs follow the Go stdlib; `der` is not used because
//! Go accepts arbitrary OID arcs and splits SyntaxError vs StructuralError.

use napi::bindgen_prelude::*;
use serde::Deserialize;
use serde_json::{json, Value};

const TAG_BOOLEAN: i64 = 1;
const TAG_INTEGER: i64 = 2;
const TAG_BIT_STRING: i64 = 3;
const TAG_OCTET_STRING: i64 = 4;
const TAG_NULL: i64 = 5;
const TAG_OID: i64 = 6;
const TAG_ENUM: i64 = 10;
const TAG_UTF8: i64 = 12;
const TAG_SEQUENCE: i64 = 16;
const TAG_SET: i64 = 17;
const TAG_NUMERIC: i64 = 18;
const TAG_PRINTABLE: i64 = 19;
const TAG_IA5: i64 = 22;
const TAG_UTCTIME: i64 = 23;
const TAG_GENERALIZED: i64 = 24;
const TAG_BMP: i64 = 30;

const CLASS_UNIVERSAL: i64 = 0;
const CLASS_APPLICATION: i64 = 1;
const CLASS_CONTEXT: i64 = 2;
const CLASS_PRIVATE: i64 = 3;

const MAX_DEPTH: u32 = 256;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind")]
enum Schema {
    #[serde(rename = "bool")]
    Bool,
    #[serde(rename = "int")]
    Int,
    #[serde(rename = "bigint")]
    BigInt,
    #[serde(rename = "bitstring")]
    BitString,
    #[serde(rename = "octetstring")]
    OctetString,
    #[serde(rename = "oid")]
    Oid,
    #[serde(rename = "null")]
    Null,
    #[serde(rename = "enumerated")]
    Enumerated,
    #[serde(rename = "utf8")]
    Utf8,
    #[serde(rename = "ia5")]
    Ia5,
    #[serde(rename = "printable")]
    Printable,
    #[serde(rename = "numeric")]
    Numeric,
    #[serde(rename = "bmp")]
    Bmp,
    #[serde(rename = "utctime")]
    UtcTime,
    #[serde(rename = "generalizedtime")]
    GeneralizedTime,
    #[serde(rename = "raw")]
    Raw,
    #[serde(rename = "optional")]
    Optional { inner: Box<Schema> },
    #[serde(rename = "explicit")]
    Explicit {
        tag: i64,
        inner: Box<Schema>,
        class: Option<i64>,
    },
    #[serde(rename = "implicit")]
    Implicit {
        tag: i64,
        inner: Box<Schema>,
        class: Option<i64>,
    },
    #[serde(rename = "sequence")]
    Sequence { fields: Vec<SeqField> },
    #[serde(rename = "set")]
    Set { fields: Vec<SeqField> },
    #[serde(rename = "sequenceof")]
    SequenceOf { inner: Box<Schema> },
    #[serde(rename = "setof")]
    SetOf { inner: Box<Schema> },
}

#[derive(Debug, Clone, Deserialize)]
struct SeqField {
    name: Option<String>,
    schema: Schema,
    optional: Option<bool>,
}

#[derive(Debug, Default, Clone)]
struct Params {
    optional: bool,
    explicit: bool,
    application: bool,
    private: bool,
    tag: Option<i64>,
    string_type: Option<i64>,
    time_type: Option<i64>,
    set: bool,
    omit_empty: bool,
}

fn syntax(msg: impl Into<String>) -> Error {
    Error::from_reason(format!("Asn1SyntaxError:{}", msg.into()))
}

fn structural(msg: impl Into<String>) -> Error {
    Error::from_reason(format!("Asn1StructuralError:{}", msg.into()))
}

fn parse_params(str: &str) -> Params {
    let mut ret = Params::default();
    if str.is_empty() {
        return ret;
    }
    for part in str.split(',') {
        match part {
            "optional" => ret.optional = true,
            "explicit" => {
                ret.explicit = true;
                if ret.tag.is_none() {
                    ret.tag = Some(0);
                }
            }
            "generalized" => ret.time_type = Some(TAG_GENERALIZED),
            "utc" => ret.time_type = Some(TAG_UTCTIME),
            "ia5" => ret.string_type = Some(TAG_IA5),
            "printable" => ret.string_type = Some(TAG_PRINTABLE),
            "numeric" => ret.string_type = Some(TAG_NUMERIC),
            "utf8" => ret.string_type = Some(TAG_UTF8),
            "set" => ret.set = true,
            "application" => {
                ret.application = true;
                if ret.tag.is_none() {
                    ret.tag = Some(0);
                }
            }
            "private" => {
                ret.private = true;
                if ret.tag.is_none() {
                    ret.tag = Some(0);
                }
            }
            "omitempty" => ret.omit_empty = true,
            _ if part.starts_with("tag:") => {
                if let Ok(i) = part[4..].parse::<i64>() {
                    ret.tag = Some(i);
                }
            }
            _ => {}
        }
    }
    ret
}

fn overlay(schema: Schema, p: &Params) -> Schema {
    let mut s = schema;
    if let Some(st) = p.string_type {
        s = match s {
            Schema::Utf8 | Schema::Ia5 | Schema::Printable | Schema::Numeric | Schema::Bmp => {
                string_kind(st)
            }
            other => other,
        };
    }
    if let Some(tt) = p.time_type {
        s = match s {
            Schema::UtcTime | Schema::GeneralizedTime => {
                if tt == TAG_GENERALIZED {
                    Schema::GeneralizedTime
                } else {
                    Schema::UtcTime
                }
            }
            other => other,
        };
    }
    if p.set {
        s = match s {
            Schema::Sequence { fields } => Schema::Set { fields },
            Schema::SequenceOf { inner } => Schema::SetOf { inner },
            other => other,
        };
    }
    if let Some(tag) = p.tag {
        s = strip_tag(s);
        let class = if p.application {
            Some(CLASS_APPLICATION)
        } else if p.private {
            Some(CLASS_PRIVATE)
        } else {
            Some(CLASS_CONTEXT)
        };
        s = if p.explicit {
            Schema::Explicit {
                tag,
                inner: Box::new(s),
                class,
            }
        } else {
            Schema::Implicit {
                tag,
                inner: Box::new(s),
                class,
            }
        };
    }
    if p.optional {
        s = Schema::Optional { inner: Box::new(s) };
    }
    s
}

fn strip_tag(s: Schema) -> Schema {
    match s {
        Schema::Explicit { inner, .. } | Schema::Implicit { inner, .. } => *inner,
        other => other,
    }
}

fn string_kind(tag: i64) -> Schema {
    match tag {
        TAG_IA5 => Schema::Ia5,
        TAG_PRINTABLE => Schema::Printable,
        TAG_NUMERIC => Schema::Numeric,
        TAG_BMP => Schema::Bmp,
        _ => Schema::Utf8,
    }
}

struct Tlv {
    class: i64,
    tag: i64,
    is_compound: bool,
    length: usize,
}

fn parse_base128(bytes: &[u8], mut offset: usize) -> Result<(i64, usize)> {
    let mut ret64: i64 = 0;
    for shifted in 0.. {
        if shifted == 5 {
            return Err(structural("base 128 integer too large"));
        }
        if offset >= bytes.len() {
            return Err(syntax("truncated base 128 integer"));
        }
        let b = bytes[offset];
        if shifted == 0 && b == 0x80 {
            return Err(syntax("integer is not minimally encoded"));
        }
        ret64 = (ret64 << 7) | i64::from(b & 0x7f);
        offset += 1;
        if b & 0x80 == 0 {
            if ret64 > i64::from(i32::MAX) {
                return Err(structural("base 128 integer too large"));
            }
            return Ok((ret64, offset));
        }
    }
    Err(syntax("truncated base 128 integer"))
}

fn parse_tlv(bytes: &[u8], offset: usize) -> Result<(Tlv, usize)> {
    if offset >= bytes.len() {
        return Err(syntax("truncated tag or length"));
    }
    let mut i = offset;
    let b = bytes[i];
    i += 1;
    let class = i64::from(b >> 6);
    let is_compound = b & 0x20 == 0x20;
    let mut tag = i64::from(b & 0x1f);
    if tag == 0x1f {
        let (t, ni) = parse_base128(bytes, i)?;
        tag = t;
        i = ni;
        if tag < 0x1f {
            return Err(syntax("non-minimal tag"));
        }
    }
    if i >= bytes.len() {
        return Err(syntax("truncated tag or length"));
    }
    let b = bytes[i];
    i += 1;
    let length = if b & 0x80 == 0 {
        usize::from(b & 0x7f)
    } else {
        let num_bytes = usize::from(b & 0x7f);
        if num_bytes == 0 {
            return Err(syntax("indefinite length found (not DER)"));
        }
        let mut len: usize = 0;
        for _ in 0..num_bytes {
            if i >= bytes.len() {
                return Err(syntax("truncated tag or length"));
            }
            let b = bytes[i];
            i += 1;
            if len >= 1 << 23 {
                return Err(structural("length too large"));
            }
            len = (len << 8) | usize::from(b);
            if len == 0 {
                return Err(structural("superfluous leading zeros in length"));
            }
        }
        if len < 0x80 {
            return Err(structural("non-minimal length"));
        }
        len
    };
    if i.checked_add(length).is_none_or(|end| end > bytes.len()) {
        return Err(syntax("data truncated"));
    }
    Ok((
        Tlv {
            class,
            tag,
            is_compound,
            length,
        },
        i,
    ))
}

fn append_base128(dst: &mut Vec<u8>, n: i64) {
    if n == 0 {
        dst.push(0);
        return;
    }
    let mut l = 0;
    let mut i = n;
    while i > 0 {
        l += 1;
        i >>= 7;
    }
    for k in (0..l).rev() {
        let mut o = (n >> (k * 7)) as u8;
        o &= 0x7f;
        if k != 0 {
            o |= 0x80;
        }
        dst.push(o);
    }
}

fn append_length(dst: &mut Vec<u8>, len: usize) {
    if len < 128 {
        dst.push(len as u8);
        return;
    }
    let mut n = 1;
    let mut i = len;
    while i > 255 {
        n += 1;
        i >>= 8;
    }
    dst.push(0x80 | n as u8);
    for k in (0..n).rev() {
        dst.push((len >> (k * 8)) as u8);
    }
}

fn encode_tlv(class: i64, tag: i64, is_compound: bool, body: &[u8]) -> Vec<u8> {
    let mut dst = Vec::with_capacity(body.len() + 8);
    let mut b = (class as u8) << 6;
    if is_compound {
        b |= 0x20;
    }
    if tag >= 31 {
        b |= 0x1f;
        dst.push(b);
        append_base128(&mut dst, tag);
    } else {
        dst.push(b | tag as u8);
    }
    append_length(&mut dst, body.len());
    dst.extend_from_slice(body);
    dst
}

fn check_integer(bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() {
        return Err(structural("empty integer"));
    }
    if bytes.len() > 1
        && ((bytes[0] == 0 && bytes[1] & 0x80 == 0)
            || (bytes[0] == 0xff && bytes[1] & 0x80 == 0x80))
    {
        return Err(structural("integer not minimally-encoded"));
    }
    Ok(())
}

fn encode_integer_bytes(bytes: &[u8], negative: bool) -> Vec<u8> {
    if bytes.is_empty() || bytes.iter().all(|&b| b == 0) {
        return vec![0];
    }
    let mut v = bytes.to_vec();
    while v.len() > 1 && v[0] == 0 {
        v.remove(0);
    }
    if negative {
        for b in &mut v {
            *b ^= 0xff;
        }
        let mut i = v.len();
        while i > 0 {
            i -= 1;
            let (n, c) = v[i].overflowing_add(1);
            v[i] = n;
            if !c {
                break;
            }
        }
        if v[0] & 0x80 == 0 {
            v.insert(0, 0xff);
        }
        v
    } else if v[0] & 0x80 != 0 {
        v.insert(0, 0);
        v
    } else {
        v
    }
}

fn decimal_to_int_bytes(s: &str) -> Result<Vec<u8>> {
    let (neg, digits) = if let Some(rest) = s.strip_prefix('-') {
        (true, rest)
    } else {
        (false, s)
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(structural("invalid integer"));
    }
    let mut mag = vec![0u8];
    for d in digits.bytes() {
        let mut carry = u16::from(d - b'0');
        for b in mag.iter_mut().rev() {
            let v = u16::from(*b) * 10 + carry;
            *b = (v & 0xff) as u8;
            carry = v >> 8;
        }
        while carry > 0 {
            mag.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    Ok(encode_integer_bytes(&mag, neg && mag.iter().any(|&b| b != 0)))
}

fn i64_to_int_bytes(n: i64) -> Vec<u8> {
    if n == 0 {
        return vec![0];
    }
    let mut tmp = n.to_be_bytes().to_vec();
    while tmp.len() > 1 && ((tmp[0] == 0 && tmp[1] & 0x80 == 0) || (tmp[0] == 0xff && tmp[1] & 0x80 != 0))
    {
        tmp.remove(0);
    }
    tmp
}

fn int_bytes_to_json(bytes: &[u8], force_bigint: bool) -> Result<Value> {
    check_integer(bytes)?;
    let mut mag = bytes.to_vec();
    let neg = !mag.is_empty() && mag[0] & 0x80 != 0;
    if neg {
        for b in &mut mag {
            *b ^= 0xff;
        }
        let mut i = mag.len();
        while i > 0 {
            i -= 1;
            let (n, c) = mag[i].overflowing_add(1);
            mag[i] = n;
            if !c {
                break;
            }
        }
    }
    while mag.len() > 1 && mag[0] == 0 {
        mag.remove(0);
    }
    if mag.len() <= 8 {
        let mut v: u64 = 0;
        for b in &mag {
            v = (v << 8) | u64::from(*b);
        }
        if !neg && v <= 9_007_199_254_740_991 && !force_bigint {
            return Ok(json!(v));
        }
        if neg && v <= 9_007_199_254_740_991 && !force_bigint {
            return Ok(json!(-(v as i64)));
        }
    }
    let mut dec = vec![0u8];
    for &b in &mag {
        let mut carry = u32::from(b);
        for d in dec.iter_mut().rev() {
            let v = u32::from(*d) * 256 + carry;
            *d = (v % 10) as u8;
            carry = v / 10;
        }
        while carry > 0 {
            dec.insert(0, (carry % 10) as u8);
            carry /= 10;
        }
    }
    let mut s = String::new();
    if neg {
        s.push('-');
    }
    if dec.iter().all(|&d| d == 0) {
        s.push('0');
    } else {
        let mut started = false;
        for d in dec {
            if d != 0 {
                started = true;
            }
            if started {
                s.push(char::from(b'0' + d));
            }
        }
    }
    Ok(json!({ "$i": s }))
}

fn parse_bool(bytes: &[u8]) -> Result<bool> {
    if bytes.len() != 1 {
        return Err(syntax("invalid boolean"));
    }
    match bytes[0] {
        0 => Ok(false),
        0xff => Ok(true),
        _ => Err(syntax("invalid boolean")),
    }
}

fn parse_bit_string(bytes: &[u8]) -> Result<(Vec<u8>, i64)> {
    if bytes.is_empty() {
        return Err(syntax("zero length BIT STRING"));
    }
    let padding = bytes[0];
    if padding > 7 || (bytes.len() == 1 && padding > 0) || bytes[bytes.len() - 1] & ((1 << padding) - 1) != 0
    {
        return Err(syntax("invalid padding bits in BIT STRING"));
    }
    let bit_length = (bytes.len() as i64 - 1) * 8 - i64::from(padding);
    Ok((bytes[1..].to_vec(), bit_length))
}

fn parse_oid(bytes: &[u8]) -> Result<Vec<i64>> {
    if bytes.is_empty() {
        return Err(syntax("zero length OBJECT IDENTIFIER"));
    }
    let (v, mut offset) = parse_base128(bytes, 0)?;
    let mut s = Vec::new();
    if v < 80 {
        s.push(v / 40);
        s.push(v % 40);
    } else {
        s.push(2);
        s.push(v - 80);
    }
    while offset < bytes.len() {
        let (n, ni) = parse_base128(bytes, offset)?;
        s.push(n);
        offset = ni;
    }
    Ok(s)
}

fn is_numeric(b: u8) -> bool {
    b.is_ascii_digit() || b == b' '
}

fn is_printable(b: u8, asterisk: bool, ampersand: bool) -> bool {
    (b'a'..=b'z').contains(&b)
        || (b'A'..=b'Z').contains(&b)
        || b.is_ascii_digit()
        || (b'\''..=b')').contains(&b)
        || (b'+'..=b'/').contains(&b)
        || b == b' '
        || b == b':'
        || b == b'='
        || b == b'?'
        || (asterisk && b == b'*')
        || (ampersand && b == b'&')
}

fn parse_numeric(bytes: &[u8]) -> Result<String> {
    if bytes.iter().all(|&b| is_numeric(b)) {
        Ok(String::from_utf8_lossy(bytes).into_owned())
    } else {
        Err(syntax("NumericString contains invalid character"))
    }
}

fn parse_printable(bytes: &[u8]) -> Result<String> {
    if bytes.iter().all(|&b| is_printable(b, true, true)) {
        Ok(String::from_utf8_lossy(bytes).into_owned())
    } else {
        Err(syntax("PrintableString contains invalid character"))
    }
}

fn parse_ia5(bytes: &[u8]) -> Result<String> {
    if bytes.iter().all(|&b| b < 0x80) {
        Ok(String::from_utf8_lossy(bytes).into_owned())
    } else {
        Err(syntax("IA5String contains invalid character"))
    }
}

fn parse_utf8(bytes: &[u8]) -> Result<String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| syntax("invalid UTF-8 string"))
}

fn parse_bmp(bytes: &[u8]) -> Result<String> {
    if bytes.len() % 2 != 0 {
        return Err(syntax("odd-length BMP string"));
    }
    let mut data = bytes;
    if data.len() >= 2 && data[data.len() - 1] == 0 && data[data.len() - 2] == 0 {
        data = &data[..data.len() - 2];
    }
    let units: Vec<u16> = data
        .chunks_exact(2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();
    Ok(String::from_utf16_lossy(&units))
}

fn two_digits(n: i32) -> [u8; 2] {
    [b'0' + ((n / 10) % 10) as u8, b'0' + (n % 10) as u8]
}

fn four_digits(n: i32) -> [u8; 4] {
    [
        b'0' + ((n / 1000) % 10) as u8,
        b'0' + ((n / 100) % 10) as u8,
        b'0' + ((n / 10) % 10) as u8,
        b'0' + (n % 10) as u8,
    ]
}

fn civil_from_unix_ms(ms: i64) -> (i32, i32, i32, i32, i32, i32) {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86400);
    let tod = secs.rem_euclid(86400) as i32;
    let hour = tod / 3600;
    let min = (tod % 3600) / 60;
    let sec = tod % 60;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i32) + (era as i32) * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as i32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as i32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, hour, min, sec)
}

fn unix_ms_from_civil(y: i32, m: i32, d: i32, hh: i32, mm: i32, ss: i32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400) as i64;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = (era as i64) * 146_097 + doe - 719_468;
    (days * 86400 + i64::from(hh) * 3600 + i64::from(mm) * 60 + i64::from(ss)) * 1000
}

fn encode_utc_time(ms: i64) -> Result<Vec<u8>> {
    let (y, m, d, hh, mm, ss) = civil_from_unix_ms(ms);
    if !(1950..2050).contains(&y) {
        return Err(structural("cannot represent time as UTCTime"));
    }
    let yy = if y >= 2000 { y - 2000 } else { y - 1900 };
    let mut dst = Vec::with_capacity(13);
    dst.extend_from_slice(&two_digits(yy));
    dst.extend_from_slice(&two_digits(m));
    dst.extend_from_slice(&two_digits(d));
    dst.extend_from_slice(&two_digits(hh));
    dst.extend_from_slice(&two_digits(mm));
    dst.extend_from_slice(&two_digits(ss));
    dst.push(b'Z');
    Ok(dst)
}

fn encode_gen_time(ms: i64) -> Result<Vec<u8>> {
    let (y, m, d, hh, mm, ss) = civil_from_unix_ms(ms);
    if !(0..=9999).contains(&y) {
        return Err(structural("cannot represent time as GeneralizedTime"));
    }
    let mut dst = Vec::with_capacity(15);
    dst.extend_from_slice(&four_digits(y));
    dst.extend_from_slice(&two_digits(m));
    dst.extend_from_slice(&two_digits(d));
    dst.extend_from_slice(&two_digits(hh));
    dst.extend_from_slice(&two_digits(mm));
    dst.extend_from_slice(&two_digits(ss));
    dst.push(b'Z');
    Ok(dst)
}

fn parse_digits(s: &[u8], n: usize) -> Result<i32> {
    if s.len() < n || !s[..n].iter().all(|b| b.is_ascii_digit()) {
        return Err(syntax("invalid time"));
    }
    let mut v = 0i32;
    for &b in &s[..n] {
        v = v * 10 + i32::from(b - b'0');
    }
    Ok(v)
}

fn parse_time_common(s: &[u8], y: i32) -> Result<i64> {
    if s.len() < 10 {
        return Err(syntax("invalid time"));
    }
    let m = parse_digits(s, 2)?;
    let d = parse_digits(&s[2..], 2)?;
    let hh = parse_digits(&s[4..], 2)?;
    let mm = parse_digits(&s[6..], 2)?;
    let ss = parse_digits(&s[8..], 2)?;
    let rest = &s[10..];
    let offset_min = if rest == b"Z" {
        0
    } else if (rest.first() == Some(&b'+') || rest.first() == Some(&b'-')) && rest.len() == 5 {
        let sign = if rest[0] == b'+' { 1 } else { -1 };
        let oh = parse_digits(&rest[1..], 2)?;
        let om = parse_digits(&rest[3..], 2)?;
        sign * (oh * 60 + om)
    } else {
        return Err(syntax("invalid time"));
    };
    Ok(unix_ms_from_civil(y, m, d, hh, mm, ss) - i64::from(offset_min) * 60_000)
}

fn parse_utc_time(bytes: &[u8]) -> Result<i64> {
    if bytes.len() < 11 {
        return Err(syntax("invalid time"));
    }
    let yy = parse_digits(bytes, 2)?;
    let y = if yy >= 50 { 1900 + yy } else { 2000 + yy };
    let rest = &bytes[2..];
    let ms = if rest.len() >= 11 {
        parse_time_common(rest, y)?
    } else if rest.len() >= 9 {
        let m = parse_digits(rest, 2)?;
        let d = parse_digits(&rest[2..], 2)?;
        let hh = parse_digits(&rest[4..], 2)?;
        let mm = parse_digits(&rest[6..], 2)?;
        let tz = &rest[8..];
        let offset_min = if tz == b"Z" {
            0
        } else if tz.len() == 5 {
            let sign = if tz[0] == b'+' { 1 } else { -1 };
            sign * (parse_digits(&tz[1..], 2)? * 60 + parse_digits(&tz[3..], 2)?)
        } else {
            return Err(syntax("invalid time"));
        };
        unix_ms_from_civil(y, m, d, hh, mm, 0) - i64::from(offset_min) * 60_000
    } else {
        return Err(syntax("invalid time"));
    };
    let (cy, m, d, hh, mm, ss) = civil_from_unix_ms(ms);
    let adj = if cy >= 2050 {
        unix_ms_from_civil(cy - 100, m, d, hh, mm, ss)
    } else {
        ms
    };
    Ok(adj)
}

fn parse_gen_time(bytes: &[u8]) -> Result<i64> {
    if bytes.len() < 15 {
        return Err(syntax("invalid time"));
    }
    let y = parse_digits(bytes, 4)?;
    parse_time_common(&bytes[4..], y)
}

fn hex_encode(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for &x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 0xf) as usize] as char);
    }
    s
}

fn hex_decode(s: &str) -> Result<Vec<u8>> {
    if s.len() % 2 != 0 {
        return Err(structural("invalid hex"));
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    for i in (0..bytes.len()).step_by(2) {
        let hi = hex_nibble(bytes[i])?;
        let lo = hex_nibble(bytes[i + 1])?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_nibble(b: u8) -> Result<u8> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err(structural("invalid hex")),
    }
}

fn bytes_ir(b: &[u8]) -> Value {
    json!({ "$b": hex_encode(b) })
}

fn is_empty_value(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(false) => true,
        Value::Number(n) => n.as_i64() == Some(0) || n.as_u64() == Some(0),
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => {
            if let Some(h) = o.get("$b").and_then(|x| x.as_str()) {
                h.is_empty()
            } else if let Some(h) = o.get("$bits").and_then(|x| x.as_str()) {
                h.is_empty()
            } else {
                o.is_empty()
            }
        }
        _ => false,
    }
}

fn value_bytes(v: &Value) -> Result<Vec<u8>> {
    if let Some(h) = v.get("$b").and_then(|x| x.as_str()) {
        return hex_decode(h);
    }
    if let Some(s) = v.as_str() {
        return Ok(s.as_bytes().to_vec());
    }
    Err(structural("expected bytes"))
}

fn value_int_bytes(v: &Value) -> Result<Vec<u8>> {
    if let Some(s) = v.get("$i").and_then(|x| x.as_str()) {
        return decimal_to_int_bytes(s);
    }
    if let Some(n) = v.as_i64() {
        return Ok(i64_to_int_bytes(n));
    }
    if let Some(n) = v.as_u64() {
        return Ok(encode_integer_bytes(&n.to_be_bytes(), false));
    }
    Err(structural("expected integer"))
}

fn value_time_ms(v: &Value) -> Result<i64> {
    if let Some(n) = v.get("$t").and_then(|x| x.as_i64()) {
        return Ok(n);
    }
    if let Some(n) = v.as_i64() {
        return Ok(n);
    }
    Err(structural("expected time"))
}

fn oid_from_value(v: &Value) -> Result<Vec<i64>> {
    let arr = v.as_array().ok_or_else(|| structural("expected oid array"))?;
    arr.iter()
        .map(|x| {
            x.as_i64()
                .ok_or_else(|| structural("oid arc must be integer"))
        })
        .collect()
}

fn encode_oid(oid: &[i64]) -> Result<Vec<u8>> {
    if oid.len() < 2 || oid[0] > 2 || (oid[0] < 2 && oid[1] >= 40) {
        return Err(structural("invalid object identifier"));
    }
    let mut dst = Vec::new();
    append_base128(&mut dst, oid[0] * 40 + oid[1]);
    for &n in &oid[2..] {
        if n < 0 {
            return Err(structural("invalid object identifier"));
        }
        append_base128(&mut dst, n);
    }
    Ok(dst)
}

fn encode_string(kind: &Schema, s: &str) -> Result<Vec<u8>> {
    let b = s.as_bytes();
    match kind {
        Schema::Numeric => {
            if !b.iter().all(|&c| is_numeric(c)) {
                return Err(structural("NumericString contains invalid character"));
            }
        }
        Schema::Printable => {
            if !b.iter().all(|&c| is_printable(c, true, false)) {
                return Err(structural("PrintableString contains invalid character"));
            }
        }
        Schema::Ia5 => {
            if !b.iter().all(|&c| c < 0x80) {
                return Err(structural("IA5String contains invalid character"));
            }
        }
        Schema::Utf8 => {
            if !s.is_ascii() && std::str::from_utf8(b).is_err() {
                return Err(syntax("invalid UTF-8 string"));
            }
        }
        Schema::Bmp => {
            let mut out = Vec::new();
            for u in s.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
            return Ok(out);
        }
        _ => {}
    }
    Ok(b.to_vec())
}

fn universal(schema: &Schema) -> Result<(i64, bool)> {
    Ok(match schema {
        Schema::Bool => (TAG_BOOLEAN, false),
        Schema::Int | Schema::BigInt => (TAG_INTEGER, false),
        Schema::BitString => (TAG_BIT_STRING, false),
        Schema::OctetString => (TAG_OCTET_STRING, false),
        Schema::Oid => (TAG_OID, false),
        Schema::Null => (TAG_NULL, false),
        Schema::Enumerated => (TAG_ENUM, false),
        Schema::Utf8 => (TAG_UTF8, false),
        Schema::Ia5 => (TAG_IA5, false),
        Schema::Printable => (TAG_PRINTABLE, false),
        Schema::Numeric => (TAG_NUMERIC, false),
        Schema::Bmp => (TAG_BMP, false),
        Schema::UtcTime => (TAG_UTCTIME, false),
        Schema::GeneralizedTime => (TAG_GENERALIZED, false),
        Schema::Raw => (-1, false),
        Schema::Sequence { .. } | Schema::SequenceOf { .. } => (TAG_SEQUENCE, true),
        Schema::Set { .. } | Schema::SetOf { .. } => (TAG_SET, true),
        Schema::Optional { inner } => universal(inner)?,
        Schema::Explicit { inner, .. } | Schema::Implicit { inner, .. } => universal(inner)?,
    })
}

fn marshal_body(schema: &Schema, value: &Value, depth: u32) -> Result<Vec<u8>> {
    if depth > MAX_DEPTH {
        return Err(syntax("nesting too deep"));
    }
    match schema {
        Schema::Bool => {
            let b = value
                .as_bool()
                .ok_or_else(|| structural("expected boolean"))?;
            Ok(vec![if b { 0xff } else { 0x00 }])
        }
        Schema::Int | Schema::BigInt | Schema::Enumerated => value_int_bytes(value),
        Schema::BitString => {
            let bits = value
                .get("$bits")
                .and_then(|x| x.as_str())
                .ok_or_else(|| structural("expected bitstring"))?;
            let bytes = hex_decode(bits)?;
            let bit_length = value
                .get("bitLength")
                .and_then(|x| x.as_i64())
                .ok_or_else(|| structural("expected bitLength"))?;
            let pad = ((8 - bit_length % 8) % 8) as u8;
            let mut out = vec![pad];
            out.extend_from_slice(&bytes);
            Ok(out)
        }
        Schema::OctetString => value_bytes(value),
        Schema::Oid => encode_oid(&oid_from_value(value)?),
        Schema::Null => Ok(vec![]),
        Schema::Utf8 | Schema::Ia5 | Schema::Printable | Schema::Numeric | Schema::Bmp => {
            let s = value
                .as_str()
                .ok_or_else(|| structural("expected string"))?;
            encode_string(schema, s)
        }
        Schema::UtcTime => encode_utc_time(value_time_ms(value)?),
        Schema::GeneralizedTime => encode_gen_time(value_time_ms(value)?),
        Schema::Raw => {
            if let Some(full) = value.pointer("/$raw/fullBytes").and_then(|x| x.as_str()) {
                if !full.is_empty() {
                    return Ok(hex_decode(full)?);
                }
            }
            let class = value
                .pointer("/$raw/class")
                .and_then(|x| x.as_i64())
                .unwrap_or(0);
            let tag = value
                .pointer("/$raw/tag")
                .and_then(|x| x.as_i64())
                .ok_or_else(|| structural("raw tag required"))?;
            let is_compound = value
                .pointer("/$raw/isCompound")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            let body = hex_decode(
                value
                    .pointer("/$raw/bytes")
                    .and_then(|x| x.as_str())
                    .unwrap_or(""),
            )?;
            Ok(encode_tlv(class, tag, is_compound, &body))
        }
        Schema::Sequence { fields } | Schema::Set { fields } => {
            marshal_fields(fields, value, depth + 1)
        }
        Schema::SequenceOf { inner } => marshal_of(inner, value, false, depth + 1),
        Schema::SetOf { inner } => marshal_of(inner, value, true, depth + 1),
        Schema::Optional { inner } => {
            if value.is_null() || is_empty_value(value) {
                Ok(vec![])
            } else {
                marshal_value(inner, value, depth + 1)
            }
        }
        Schema::Explicit { inner, .. } | Schema::Implicit { inner, .. } => {
            marshal_body(inner, value, depth + 1)
        }
    }
}

fn marshal_fields(fields: &[SeqField], value: &Value, depth: u32) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    let named = fields.iter().any(|f| f.name.is_some());
    for (i, f) in fields.iter().enumerate() {
        let child = if named {
            f.name
                .as_ref()
                .and_then(|n| value.get(n))
                .unwrap_or(&Value::Null)
        } else {
            value.get(i).unwrap_or(&Value::Null)
        };
        let optional = f.optional.unwrap_or(false) || matches!(f.schema, Schema::Optional { .. });
        if optional && (child.is_null() || is_empty_value(child)) {
            continue;
        }
        if child.is_null() && !optional {
            return Err(structural("missing required sequence field"));
        }
        body.extend_from_slice(&marshal_value(&f.schema, child, depth)?);
    }
    Ok(body)
}

fn marshal_of(inner: &Schema, value: &Value, set: bool, depth: u32) -> Result<Vec<u8>> {
    let arr = value
        .as_array()
        .ok_or_else(|| structural("expected array"))?;
    let mut parts = Vec::new();
    for v in arr {
        parts.push(marshal_value(inner, v, depth)?);
    }
    if set {
        parts.sort();
    }
    Ok(parts.concat())
}

fn marshal_value(schema: &Schema, value: &Value, depth: u32) -> Result<Vec<u8>> {
    if depth > MAX_DEPTH {
        return Err(syntax("nesting too deep"));
    }
    if let Schema::Optional { inner } = schema {
        if value.is_null() {
            return Ok(vec![]);
        }
        return marshal_value(inner, value, depth + 1);
    }
    if let Schema::Raw = schema {
        return marshal_body(schema, value, depth);
    }
    if let Schema::Explicit {
        tag,
        inner,
        class,
    } = schema
    {
        let inner_der = marshal_value(inner, value, depth + 1)?;
        let class = class.unwrap_or(CLASS_CONTEXT);
        return Ok(encode_tlv(class, *tag, true, &inner_der));
    }
    if let Schema::Implicit {
        tag,
        inner,
        class,
    } = schema
    {
        let inner_body = marshal_body(inner, value, depth + 1)?;
        let (_, compound) = universal(inner)?;
        let class = class.unwrap_or(CLASS_CONTEXT);
        return Ok(encode_tlv(class, *tag, compound, &inner_body));
    }
    let body = marshal_body(schema, value, depth)?;
    let (tag, compound) = universal(schema)?;
    Ok(encode_tlv(CLASS_UNIVERSAL, tag, compound, &body))
}

fn expect_tag(
    tlv: &Tlv,
    class: i64,
    tag: i64,
    compound: bool,
    match_compound: bool,
) -> Result<()> {
    if tlv.class != class || tlv.tag != tag || (match_compound && tlv.is_compound != compound) {
        return Err(structural(format!(
            "tags don't match ({} vs class={} tag={} compound={})",
            tag, tlv.class, tlv.tag, tlv.is_compound
        )));
    }
    Ok(())
}

fn unmarshal_value<'a>(
    schema: &Schema,
    bytes: &'a [u8],
    offset: usize,
    depth: u32,
) -> Result<(Value, usize)> {
    if depth > MAX_DEPTH {
        return Err(syntax("nesting too deep"));
    }
    if let Schema::Optional { inner } = schema {
        if offset == bytes.len() {
            return Ok((Value::Null, offset));
        }
        match unmarshal_value(inner, bytes, offset, depth + 1) {
            Ok(v) => return Ok(v),
            Err(_) => return Ok((Value::Null, offset)),
        }
    }
    if offset == bytes.len() {
        return Err(syntax("sequence truncated"));
    }
    let start = offset;
    let (tlv, content_off) = parse_tlv(bytes, offset)?;
    let content = &bytes[content_off..content_off + tlv.length];
    let next = content_off + tlv.length;

    if let Schema::Raw = schema {
        return Ok((
            json!({
                "$raw": {
                    "class": tlv.class,
                    "tag": tlv.tag,
                    "isCompound": tlv.is_compound,
                    "bytes": hex_encode(content),
                    "fullBytes": hex_encode(&bytes[start..next]),
                }
            }),
            next,
        ));
    }

    if let Schema::Explicit {
        tag,
        inner,
        class,
    } = schema
    {
        let class = class.unwrap_or(CLASS_CONTEXT);
        if tlv.class != class || tlv.tag != *tag || !(tlv.length == 0 || tlv.is_compound) {
            return Err(structural("explicitly tagged member didn't match"));
        }
        let (v, inner_next) = unmarshal_value(inner, content, 0, depth + 1)?;
        if inner_next > content.len() {
            return Err(syntax("data truncated"));
        }
        return Ok((v, next));
    }

    if let Schema::Implicit {
        tag,
        inner,
        class,
    } = schema
    {
        let class = class.unwrap_or(CLASS_CONTEXT);
        let (_, compound) = universal(inner)?;
        expect_tag(&tlv, class, *tag, compound, true)?;
        let v = unmarshal_body(inner, content, depth + 1)?;
        return Ok((v, next));
    }

    let (tag, compound) = universal(schema)?;
    expect_tag(&tlv, CLASS_UNIVERSAL, tag, compound, true)?;
    Ok((unmarshal_body(schema, content, depth + 1)?, next))
}

fn unmarshal_body(schema: &Schema, content: &[u8], depth: u32) -> Result<Value> {
    if depth > MAX_DEPTH {
        return Err(syntax("nesting too deep"));
    }
    match schema {
        Schema::Bool => Ok(json!(parse_bool(content)?)),
        Schema::Int => int_bytes_to_json(content, false),
        Schema::BigInt => int_bytes_to_json(content, true),
        Schema::Enumerated => int_bytes_to_json(content, false),
        Schema::BitString => {
            let (b, n) = parse_bit_string(content)?;
            Ok(json!({ "$bits": hex_encode(&b), "bitLength": n }))
        }
        Schema::OctetString => Ok(bytes_ir(content)),
        Schema::Oid => {
            let oid = parse_oid(content)?;
            Ok(json!(oid))
        }
        Schema::Null => {
            if !content.is_empty() {
                return Err(syntax("invalid boolean"));
            }
            Ok(Value::Null)
        }
        Schema::Utf8 => Ok(json!(parse_utf8(content)?)),
        Schema::Ia5 => Ok(json!(parse_ia5(content)?)),
        Schema::Printable => Ok(json!(parse_printable(content)?)),
        Schema::Numeric => Ok(json!(parse_numeric(content)?)),
        Schema::Bmp => Ok(json!(parse_bmp(content)?)),
        Schema::UtcTime => Ok(json!({ "$t": parse_utc_time(content)? })),
        Schema::GeneralizedTime => Ok(json!({ "$t": parse_gen_time(content)? })),
        Schema::Sequence { fields } | Schema::Set { fields } => {
            unmarshal_fields(fields, content, depth + 1)
        }
        Schema::SequenceOf { inner } | Schema::SetOf { inner } => {
            let mut out = Vec::new();
            let mut off = 0;
            while off < content.len() {
                let (v, n) = unmarshal_value(inner, content, off, depth + 1)?;
                out.push(v);
                off = n;
            }
            Ok(Value::Array(out))
        }
        Schema::Optional { inner } => unmarshal_body(inner, content, depth + 1),
        Schema::Explicit { inner, .. } | Schema::Implicit { inner, .. } => {
            unmarshal_body(inner, content, depth + 1)
        }
        Schema::Raw => Ok(bytes_ir(content)),
    }
}

fn unmarshal_fields(fields: &[SeqField], content: &[u8], depth: u32) -> Result<Value> {
    let named = fields.iter().any(|f| f.name.is_some());
    let mut off = 0;
    if named {
        let mut map = serde_json::Map::new();
        for f in fields {
            let name = f.name.clone().unwrap();
            let optional = f.optional.unwrap_or(false) || matches!(f.schema, Schema::Optional { .. });
            if off == content.len() {
                if optional {
                    map.insert(name, Value::Null);
                    continue;
                }
                return Err(syntax("sequence truncated"));
            }
            match unmarshal_value(&f.schema, content, off, depth) {
                Ok((v, n)) => {
                    map.insert(name, v);
                    off = n;
                }
                Err(_) if optional => {
                    map.insert(name, Value::Null);
                }
                Err(e) => return Err(e),
            }
        }
        Ok(Value::Object(map))
    } else {
        let mut arr = Vec::new();
        for f in fields {
            let optional = f.optional.unwrap_or(false);
            if off == content.len() {
                if optional {
                    arr.push(Value::Null);
                    continue;
                }
                return Err(syntax("sequence truncated"));
            }
            match unmarshal_value(&f.schema, content, off, depth) {
                Ok((v, n)) => {
                    arr.push(v);
                    off = n;
                }
                Err(_) if optional => arr.push(Value::Null),
                Err(e) => return Err(e),
            }
        }
        Ok(Value::Array(arr))
    }
}

pub fn marshal(schema_json: &str, value_json: &str, params: Option<&str>) -> Result<Vec<u8>> {
    let schema: Schema =
        serde_json::from_str(schema_json).map_err(|e| structural(format!("invalid schema: {e}")))?;
    let value: Value =
        serde_json::from_str(value_json).map_err(|e| structural(format!("invalid value: {e}")))?;
    let schema = overlay(schema, &parse_params(params.unwrap_or("")));
    marshal_value(&schema, &value, 0)
}

pub fn unmarshal(
    data: &[u8],
    schema_json: &str,
    params: Option<&str>,
) -> Result<(Value, Vec<u8>)> {
    let schema: Schema =
        serde_json::from_str(schema_json).map_err(|e| structural(format!("invalid schema: {e}")))?;
    let schema = overlay(schema, &parse_params(params.unwrap_or("")));
    let (value, next) = unmarshal_value(&schema, data, 0, 0)?;
    Ok((value, data[next..].to_vec()))
}
