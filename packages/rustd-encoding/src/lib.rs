use base64_simd::AsOut;
use napi::bindgen_prelude::*;
use napi_derive::napi;

pub(crate) fn fail(code: &str, detail: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{code}:{detail}"))
}

pub(crate) fn named(code: &str) -> Error {
    Error::new(Status::GenericFailure, code.to_string())
}

mod gob;

struct Alphabet64 {
    encode: [u8; 64],
    decode: [u8; 256],
    pad: Option<u8>,
}

struct Alphabet32 {
    encode: [u8; 32],
    decode: [u8; 256],
    pad: Option<u8>,
}

fn decode_table() -> [u8; 256] {
    [0xff; 256]
}

fn parse_pad(pad: i32) -> Result<Option<u8>> {
    if pad == -1 {
        Ok(None)
    } else if (0..=255).contains(&pad) {
        let b = pad as u8;
        if b == b'\n' || b == b'\r' {
            return Err(fail("EncodingError", "invalid padding"));
        }
        Ok(Some(b))
    } else {
        Err(fail("EncodingError", "invalid padding"))
    }
}

fn alphabet64(alphabet: &str, pad: i32) -> Result<Alphabet64> {
    let bytes = alphabet.as_bytes();
    if bytes.len() != 64 {
        return Err(fail("EncodingError", "encoding alphabet is not 64-bytes long"));
    }
    let mut encode = [0u8; 64];
    encode.copy_from_slice(bytes);
    let mut decode = decode_table();
    for (i, &c) in bytes.iter().enumerate() {
        if c == b'\n' || c == b'\r' {
            return Err(fail("EncodingError", "encoding alphabet contains newline character"));
        }
        if decode[c as usize] != 0xff {
            return Err(fail("EncodingError", "encoding alphabet includes duplicate symbols"));
        }
        decode[c as usize] = i as u8;
    }
    let pad = parse_pad(pad)?;
    if let Some(p) = pad {
        if decode[p as usize] != 0xff {
            return Err(fail("EncodingError", "padding contained in alphabet"));
        }
    }
    Ok(Alphabet64 { encode, decode, pad })
}

fn alphabet32(alphabet: &str, pad: i32) -> Result<Alphabet32> {
    let bytes = alphabet.as_bytes();
    if bytes.len() != 32 {
        return Err(fail("EncodingError", "encoding alphabet is not 32-bytes long"));
    }
    let mut encode = [0u8; 32];
    encode.copy_from_slice(bytes);
    let mut decode = decode_table();
    for (i, &c) in bytes.iter().enumerate() {
        if c == b'\n' || c == b'\r' {
            return Err(fail("EncodingError", "encoding alphabet contains newline character"));
        }
        if decode[c as usize] != 0xff {
            return Err(fail("EncodingError", "encoding alphabet includes duplicate symbols"));
        }
        decode[c as usize] = i as u8;
    }
    let pad = parse_pad(pad)?;
    if let Some(p) = pad {
        if decode[p as usize] != 0xff {
            return Err(fail("EncodingError", "padding contained in alphabet"));
        }
    }
    Ok(Alphabet32 { encode, decode, pad })
}

fn b64_encoded_len(n: usize, pad: bool) -> usize {
    if pad {
        (n + 2) / 3 * 4
    } else {
        n / 3 * 4 + (n % 3 * 8 + 5) / 6
    }
}

fn b32_encoded_len(n: usize, pad: bool) -> usize {
    if pad {
        (n + 4) / 5 * 8
    } else {
        n / 5 * 8 + (n % 5 * 8 + 4) / 5
    }
}

const B64_STD: [u8; 64] = *b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL: [u8; 64] = *b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn simd_b64(enc: &Alphabet64) -> Option<base64_simd::Base64> {
    let std = enc.encode == B64_STD;
    let url = enc.encode == B64_URL;
    if !std && !url {
        return None;
    }
    match enc.pad {
        None => Some(if std {
            base64_simd::STANDARD_NO_PAD
        } else {
            base64_simd::URL_SAFE_NO_PAD
        }),
        Some(_) => Some(if std {
            base64_simd::STANDARD
        } else {
            base64_simd::URL_SAFE
        }),
    }
}

fn rewrite_pad(buf: &mut [u8], from: u8, to: u8) {
    if from == to {
        return;
    }
    for b in buf {
        if *b == from {
            *b = to;
        }
    }
}

fn encode_b64(enc: &Alphabet64, src: &[u8]) -> Vec<u8> {
    if let Some(variant) = simd_b64(enc) {
        let mut dst: Vec<u8> = variant.encode_type(src);
        if let Some(p) = enc.pad {
            rewrite_pad(&mut dst, b'=', p);
        }
        return dst;
    }
    if src.is_empty() {
        return Vec::new();
    }
    let mut dst = vec![0u8; b64_encoded_len(src.len(), enc.pad.is_some())];
    let mut di = 0;
    let n = src.len() / 3 * 3;
    let mut si = 0;
    while si < n {
        let val = (src[si] as u32) << 16 | (src[si + 1] as u32) << 8 | src[si + 2] as u32;
        dst[di] = enc.encode[((val >> 18) & 0x3f) as usize];
        dst[di + 1] = enc.encode[((val >> 12) & 0x3f) as usize];
        dst[di + 2] = enc.encode[((val >> 6) & 0x3f) as usize];
        dst[di + 3] = enc.encode[(val & 0x3f) as usize];
        si += 3;
        di += 4;
    }
    let remain = src.len() - si;
    if remain == 0 {
        return dst;
    }
    let mut val = (src[si] as u32) << 16;
    if remain == 2 {
        val |= (src[si + 1] as u32) << 8;
    }
    dst[di] = enc.encode[((val >> 18) & 0x3f) as usize];
    dst[di + 1] = enc.encode[((val >> 12) & 0x3f) as usize];
    match remain {
        2 => {
            dst[di + 2] = enc.encode[((val >> 6) & 0x3f) as usize];
            if let Some(p) = enc.pad {
                dst[di + 3] = p;
            }
        }
        1 => {
            if let Some(p) = enc.pad {
                dst[di + 2] = p;
                dst[di + 3] = p;
            }
        }
        _ => {}
    }
    dst
}

fn decode_quantum_b64(
    enc: &Alphabet64,
    strict: bool,
    dst: &mut [u8],
    src: &[u8],
    mut si: usize,
) -> std::result::Result<(usize, usize), usize> {
    let mut dbuf = [0u8; 4];
    let mut dlen = 4;
    let mut j = 0;
    while j < 4 {
        if si == src.len() {
            if j == 0 {
                return Ok((si, 0));
            }
            if j == 1 || enc.pad.is_some() {
                return Err(si - j);
            }
            dlen = j;
            break;
        }
        let inn = src[si];
        si += 1;
        let out = enc.decode[inn as usize];
        if out != 0xff {
            dbuf[j] = out;
            j += 1;
            continue;
        }
        if inn == b'\n' || inn == b'\r' {
            continue;
        }
        if Some(inn) != enc.pad {
            return Err(si - 1);
        }
        match j {
            0 | 1 => return Err(si - 1),
            2 => {
                while si < src.len() && (src[si] == b'\n' || src[si] == b'\r') {
                    si += 1;
                }
                if si == src.len() {
                    return Err(src.len());
                }
                if Some(src[si]) != enc.pad {
                    return Err(si - 1);
                }
                si += 1;
            }
            _ => {}
        }
        while si < src.len() && (src[si] == b'\n' || src[si] == b'\r') {
            si += 1;
        }
        if si < src.len() {
            return Err(si);
        }
        dlen = j;
        break;
    }
    let val = (dbuf[0] as u32) << 18 | (dbuf[1] as u32) << 12 | (dbuf[2] as u32) << 6 | dbuf[3] as u32;
    dbuf[2] = val as u8;
    dbuf[1] = (val >> 8) as u8;
    dbuf[0] = (val >> 16) as u8;
    match dlen {
        4 => {
            dst[2] = dbuf[2];
            dbuf[2] = 0;
            dst[1] = dbuf[1];
            if strict && dbuf[2] != 0 {
                return Err(si - 1);
            }
            dbuf[1] = 0;
            dst[0] = dbuf[0];
            if strict && (dbuf[1] != 0 || dbuf[2] != 0) {
                return Err(si - 2);
            }
            Ok((si, 3))
        }
        3 => {
            dst[1] = dbuf[1];
            if strict && dbuf[2] != 0 {
                return Err(si - 1);
            }
            dbuf[1] = 0;
            dst[0] = dbuf[0];
            if strict && (dbuf[1] != 0 || dbuf[2] != 0) {
                return Err(si - 2);
            }
            Ok((si, 2))
        }
        2 => {
            dst[0] = dbuf[0];
            if strict && (dbuf[1] != 0 || dbuf[2] != 0) {
                return Err(si - 2);
            }
            Ok((si, 1))
        }
        _ => Ok((si, 0)),
    }
}

fn decode_b64(enc: &Alphabet64, strict: bool, src: &[u8]) -> Result<Vec<u8>> {
    if !strict {
        if let Some(variant) = simd_b64(enc) {
            let rewritten;
            let data: &[u8] = match enc.pad {
                Some(p) if p != b'=' => {
                    let mut tmp = src.to_vec();
                    rewrite_pad(&mut tmp, p, b'=');
                    rewritten = tmp;
                    &rewritten
                }
                _ => src,
            };
            if let Ok(dst) = variant.decode_to_vec(data) {
                return Ok(dst);
            }
        }
    }
    if src.is_empty() {
        return Ok(Vec::new());
    }
    let mut dst = vec![0u8; src.len()];
    let mut n = 0usize;
    let mut si = 0usize;
    while si < src.len() {
        match decode_quantum_b64(enc, strict, &mut dst[n..], src, si) {
            Ok((nsi, ninc)) => {
                n += ninc;
                si = nsi;
            }
            Err(index) => return Err(fail("CorruptInputError", index)),
        }
    }
    dst.truncate(n);
    Ok(dst)
}

fn encode_b32(enc: &Alphabet32, src: &[u8]) -> Vec<u8> {
    if src.is_empty() {
        return Vec::new();
    }
    let mut dst = vec![0u8; b32_encoded_len(src.len(), enc.pad.is_some())];
    let mut di = 0;
    let mut si = 0;
    let n = src.len() / 5 * 5;
    while si < n {
        let hi = (src[si] as u32) << 24
            | (src[si + 1] as u32) << 16
            | (src[si + 2] as u32) << 8
            | src[si + 3] as u32;
        let lo = hi << 8 | src[si + 4] as u32;
        dst[di] = enc.encode[((hi >> 27) & 0x1f) as usize];
        dst[di + 1] = enc.encode[((hi >> 22) & 0x1f) as usize];
        dst[di + 2] = enc.encode[((hi >> 17) & 0x1f) as usize];
        dst[di + 3] = enc.encode[((hi >> 12) & 0x1f) as usize];
        dst[di + 4] = enc.encode[((hi >> 7) & 0x1f) as usize];
        dst[di + 5] = enc.encode[((hi >> 2) & 0x1f) as usize];
        dst[di + 6] = enc.encode[((lo >> 5) & 0x1f) as usize];
        dst[di + 7] = enc.encode[(lo & 0x1f) as usize];
        si += 5;
        di += 8;
    }
    let remain = src.len() - si;
    if remain == 0 {
        return dst;
    }
    let mut val = 0u32;
    match remain {
        4 => {
            val |= src[si + 3] as u32;
            dst[di + 6] = enc.encode[(val << 3 & 0x1f) as usize];
            dst[di + 5] = enc.encode[(val >> 2 & 0x1f) as usize];
            val |= (src[si + 2] as u32) << 8;
            dst[di + 4] = enc.encode[(val >> 7 & 0x1f) as usize];
            val |= (src[si + 1] as u32) << 16;
            dst[di + 3] = enc.encode[(val >> 12 & 0x1f) as usize];
            dst[di + 2] = enc.encode[(val >> 17 & 0x1f) as usize];
            val |= (src[si] as u32) << 24;
            dst[di + 1] = enc.encode[(val >> 22 & 0x1f) as usize];
            dst[di] = enc.encode[(val >> 27 & 0x1f) as usize];
        }
        3 => {
            val |= (src[si + 2] as u32) << 8;
            dst[di + 4] = enc.encode[(val >> 7 & 0x1f) as usize];
            val |= (src[si + 1] as u32) << 16;
            dst[di + 3] = enc.encode[(val >> 12 & 0x1f) as usize];
            dst[di + 2] = enc.encode[(val >> 17 & 0x1f) as usize];
            val |= (src[si] as u32) << 24;
            dst[di + 1] = enc.encode[(val >> 22 & 0x1f) as usize];
            dst[di] = enc.encode[(val >> 27 & 0x1f) as usize];
        }
        2 => {
            val |= (src[si + 1] as u32) << 16;
            dst[di + 3] = enc.encode[(val >> 12 & 0x1f) as usize];
            dst[di + 2] = enc.encode[(val >> 17 & 0x1f) as usize];
            val |= (src[si] as u32) << 24;
            dst[di + 1] = enc.encode[(val >> 22 & 0x1f) as usize];
            dst[di] = enc.encode[(val >> 27 & 0x1f) as usize];
        }
        1 => {
            val |= (src[si] as u32) << 24;
            dst[di + 1] = enc.encode[(val >> 22 & 0x1f) as usize];
            dst[di] = enc.encode[(val >> 27 & 0x1f) as usize];
        }
        _ => {}
    }
    if let Some(p) = enc.pad {
        let n_pad = remain * 8 / 5 + 1;
        for i in n_pad..8 {
            dst[di + i] = p;
        }
    }
    dst
}

fn strip_newlines(src: &[u8]) -> Vec<u8> {
    src.iter().copied().filter(|b| *b != b'\r' && *b != b'\n').collect()
}

fn decode_b32(enc: &Alphabet32, src_raw: &[u8]) -> Result<Vec<u8>> {
    let src = strip_newlines(src_raw);
    let mut dst = vec![0u8; src.len()];
    let mut n = 0usize;
    let mut src_rest = src.as_slice();
    let olen = src.len();
    while !src_rest.is_empty() {
        let mut dbuf = [0u8; 8];
        let mut dlen = 8;
        let mut j = 0;
        while j < 8 {
            if src_rest.is_empty() {
                if enc.pad.is_some() {
                    return Err(fail("CorruptInputError", olen - src_rest.len() - j));
                }
                dlen = j;
                break;
            }
            let inn = src_rest[0];
            src_rest = &src_rest[1..];
            if Some(inn) == enc.pad && j >= 2 && src_rest.len() < 8 {
                if src_rest.len() + j < 7 {
                    return Err(fail("CorruptInputError", olen));
                }
                for k in 0..(7 - j) {
                    if src_rest.len() > k && Some(src_rest[k]) != enc.pad {
                        return Err(fail("CorruptInputError", olen - src_rest.len() + k - 1));
                    }
                }
                dlen = j;
                if dlen == 1 || dlen == 3 || dlen == 6 {
                    return Err(fail("CorruptInputError", olen - src_rest.len() - 1));
                }
                src_rest = &[];
                break;
            }
            dbuf[j] = enc.decode[inn as usize];
            if dbuf[j] == 0xff {
                return Err(fail("CorruptInputError", olen - src_rest.len() - 1));
            }
            j += 1;
        }
        let dsti = n;
        match dlen {
            8 => {
                dst[dsti + 4] = dbuf[6] << 5 | dbuf[7];
                n += 1;
                dst[dsti + 3] = dbuf[4] << 7 | dbuf[5] << 2 | dbuf[6] >> 3;
                n += 1;
                dst[dsti + 2] = dbuf[3] << 4 | dbuf[4] >> 1;
                n += 1;
                dst[dsti + 1] = dbuf[1] << 6 | dbuf[2] << 1 | dbuf[3] >> 4;
                n += 1;
                dst[dsti] = dbuf[0] << 3 | dbuf[1] >> 2;
                n += 1;
            }
            7 => {
                dst[dsti + 3] = dbuf[4] << 7 | dbuf[5] << 2 | dbuf[6] >> 3;
                n += 1;
                dst[dsti + 2] = dbuf[3] << 4 | dbuf[4] >> 1;
                n += 1;
                dst[dsti + 1] = dbuf[1] << 6 | dbuf[2] << 1 | dbuf[3] >> 4;
                n += 1;
                dst[dsti] = dbuf[0] << 3 | dbuf[1] >> 2;
                n += 1;
            }
            5 => {
                dst[dsti + 2] = dbuf[3] << 4 | dbuf[4] >> 1;
                n += 1;
                dst[dsti + 1] = dbuf[1] << 6 | dbuf[2] << 1 | dbuf[3] >> 4;
                n += 1;
                dst[dsti] = dbuf[0] << 3 | dbuf[1] >> 2;
                n += 1;
            }
            4 => {
                dst[dsti + 1] = dbuf[1] << 6 | dbuf[2] << 1 | dbuf[3] >> 4;
                n += 1;
                dst[dsti] = dbuf[0] << 3 | dbuf[1] >> 2;
                n += 1;
            }
            2 => {
                dst[dsti] = dbuf[0] << 3 | dbuf[1] >> 2;
                n += 1;
            }
            0 => {}
            _ => return Err(fail("CorruptInputError", olen - src_rest.len())),
        }
        if dlen != 8 {
            break;
        }
    }
    dst.truncate(n);
    Ok(dst)
}

const HEX: &[u8; 16] = b"0123456789abcdef";
const HEX_REV: [u8; 256] = {
    let mut t = [0xffu8; 256];
    let mut i = 0u8;
    while i < 10 {
        t[(b'0' + i) as usize] = i;
        i += 1;
    }
    i = 0;
    while i < 6 {
        t[(b'a' + i) as usize] = 10 + i;
        t[(b'A' + i) as usize] = 10 + i;
        i += 1;
    }
    t
};

fn hex_encode(src: &[u8]) -> Vec<u8> {
    let mut dst = vec![0u8; src.len() * 2];
    for (i, &v) in src.iter().enumerate() {
        dst[i * 2] = HEX[(v >> 4) as usize];
        dst[i * 2 + 1] = HEX[(v & 0x0f) as usize];
    }
    dst
}

fn hex_decode(src: &[u8]) -> Result<Vec<u8>> {
    let mut dst = Vec::with_capacity(src.len() / 2);
    let mut j = 1;
    while j < src.len() {
        let p = src[j - 1];
        let q = src[j];
        let a = HEX_REV[p as usize];
        let b = HEX_REV[q as usize];
        if a > 0x0f {
            return Err(fail("InvalidByteError", p));
        }
        if b > 0x0f {
            return Err(fail("InvalidByteError", q));
        }
        dst.push((a << 4) | b);
        j += 2;
    }
    if src.len() % 2 == 1 {
        let last = src[j - 1];
        if HEX_REV[last as usize] > 0x0f {
            return Err(fail("InvalidByteError", last));
        }
        return Err(named("HexLengthError"));
    }
    Ok(dst)
}

fn ascii85_encode(src: &[u8]) -> Vec<u8> {
    if src.is_empty() {
        return Vec::new();
    }
    let mut dst = Vec::with_capacity((src.len() + 3) / 4 * 5);
    let mut src = src;
    while !src.is_empty() {
        let mut v = 0u32;
        match src.len() {
            n if n >= 4 => {
                v |= src[3] as u32;
                v |= (src[2] as u32) << 8;
                v |= (src[1] as u32) << 16;
                v |= (src[0] as u32) << 24;
            }
            3 => {
                v |= (src[2] as u32) << 8;
                v |= (src[1] as u32) << 16;
                v |= (src[0] as u32) << 24;
            }
            2 => {
                v |= (src[1] as u32) << 16;
                v |= (src[0] as u32) << 24;
            }
            1 => v |= (src[0] as u32) << 24,
            _ => {}
        }
        if v == 0 && src.len() >= 4 {
            dst.push(b'z');
            src = &src[4..];
            continue;
        }
        let mut buf = [0u8; 5];
        let mut x = v;
        for i in (0..5).rev() {
            buf[i] = b'!' + (x % 85) as u8;
            x /= 85;
        }
        let m = if src.len() < 4 {
            5 - (4 - src.len())
        } else {
            5
        };
        dst.extend_from_slice(&buf[..m]);
        if src.len() < 4 {
            break;
        }
        src = &src[4..];
    }
    dst
}

fn ascii85_decode(src: &[u8], flush: bool) -> Result<Vec<u8>> {
    let mut dst = Vec::with_capacity(src.len());
    let mut v = 0u32;
    let mut nb = 0usize;
    let mut ndst = 0usize;
    for (i, &b) in src.iter().enumerate() {
        if dst.len().saturating_sub(ndst) < 4 {
            dst.resize(ndst + 4, 0);
        }
        match b {
            b if b <= b' ' => continue,
            b'z' if nb == 0 => {
                nb = 5;
                v = 0;
            }
            b if (b'!'..=b'u').contains(&b) => {
                v = v.wrapping_mul(85).wrapping_add((b - b'!') as u32);
                nb += 1;
            }
            _ => return Err(fail("CorruptInputError", i)),
        }
        if nb == 5 {
            if dst.len() < ndst + 4 {
                dst.resize(ndst + 4, 0);
            }
            dst[ndst] = (v >> 24) as u8;
            dst[ndst + 1] = (v >> 16) as u8;
            dst[ndst + 2] = (v >> 8) as u8;
            dst[ndst + 3] = v as u8;
            ndst += 4;
            nb = 0;
            v = 0;
        }
    }
    if flush && nb > 0 {
        if nb == 1 {
            return Err(fail("CorruptInputError", src.len()));
        }
        if dst.len() < ndst + 4 {
            dst.resize(ndst + 4, 0);
        }
        for _ in nb..5 {
            v = v.wrapping_mul(85).wrapping_add(84);
        }
        for _ in 0..(nb - 1) {
            dst[ndst] = (v >> 24) as u8;
            v <<= 8;
            ndst += 1;
        }
    }
    dst.truncate(ndst);
    Ok(dst)
}

#[napi]
pub fn base64_encode(alphabet: String, pad: i32, src: Uint8Array) -> Result<Uint8Array> {
    Ok(encode_b64(&alphabet64(&alphabet, pad)?, src.as_ref()).into())
}

#[napi]
pub fn base64_encode_to_string(alphabet: String, pad: i32, src: Uint8Array) -> Result<Latin1String> {
    let dst = encode_b64(&alphabet64(&alphabet, pad)?, src.as_ref());
    Ok(unsafe { Latin1String::from(String::from_utf8_unchecked(dst)) })
}

fn fast_variant(kind: u32) -> Result<base64_simd::Base64> {
    Ok(match kind {
        0 => base64_simd::STANDARD,
        1 => base64_simd::URL_SAFE,
        2 => base64_simd::STANDARD_NO_PAD,
        3 => base64_simd::URL_SAFE_NO_PAD,
        _ => return Err(fail("EncodingError", "unknown base64 kind")),
    })
}

fn fast_table(kind: u32) -> Result<Alphabet64> {
    match kind {
        0 => alphabet64(std::str::from_utf8(&B64_STD).unwrap(), i32::from(b'=')),
        1 => alphabet64(std::str::from_utf8(&B64_URL).unwrap(), i32::from(b'=')),
        2 => alphabet64(std::str::from_utf8(&B64_STD).unwrap(), -1),
        3 => alphabet64(std::str::from_utf8(&B64_URL).unwrap(), -1),
        _ => Err(fail("EncodingError", "unknown base64 kind")),
    }
}

fn encode_fast_vec(kind: u32, src: &[u8]) -> Result<Vec<u8>> {
    let variant = fast_variant(kind)?;
    let mut dst = vec![0u8; variant.encoded_length(src.len())];
    if !src.is_empty() {
        let _ = variant.encode(src, dst.as_mut_slice().as_out());
    }
    Ok(dst)
}

fn decode_fast_vec(kind: u32, src: &[u8]) -> Result<Vec<u8>> {
    let variant = fast_variant(kind)?;
    match variant.decode_to_vec(src) {
        Ok(dst) => Ok(dst),
        Err(_) => decode_b64(&fast_table(kind)?, false, src),
    }
}

#[napi]
pub fn base64_encode_fast(kind: u32, src: Uint8ArraySlice) -> Result<Buffer> {
    Ok(encode_fast_vec(kind, src.as_ref())?.into())
}

#[napi]
pub fn base64_encode_fast_string(kind: u32, src: Uint8ArraySlice) -> Result<Latin1String> {
    let dst = encode_fast_vec(kind, src.as_ref())?;
    Ok(unsafe { Latin1String::from(String::from_utf8_unchecked(dst)) })
}

#[napi]
pub fn base64_decode_fast(kind: u32, src: Uint8ArraySlice) -> Result<Buffer> {
    Ok(decode_fast_vec(kind, src.as_ref())?.into())
}

#[napi]
pub fn base64_decode_fast_string(kind: u32, src: Latin1String) -> Result<Buffer> {
    Ok(decode_fast_vec(kind, src.as_ref())?.into())
}

#[napi]
pub fn base64_encode_into(kind: u32, src: Uint8ArraySlice, mut dst: BufferSlice) -> Result<u32> {
    let variant = fast_variant(kind)?;
    let src = src.as_ref();
    let needed = variant.encoded_length(src.len());
    if dst.len() < needed {
        return Err(fail("EncodingError", "destination too small"));
    }
    if src.is_empty() {
        return Ok(0);
    }
    let written = variant.encode(src, dst.as_mut().as_out()).len();
    Ok(written as u32)
}

#[napi]
pub fn base64_decode_into(kind: u32, src: Uint8ArraySlice, mut dst: BufferSlice) -> Result<u32> {
    let src = src.as_ref();
    let variant = fast_variant(kind)?;
    match variant.decode(src, dst.as_mut().as_out()) {
        Ok(out) => Ok(out.len() as u32),
        Err(_) => {
            let decoded = decode_b64(&fast_table(kind)?, false, src)?;
            if dst.len() < decoded.len() {
                return Err(fail("EncodingError", "destination too small"));
            }
            dst[..decoded.len()].copy_from_slice(&decoded);
            Ok(decoded.len() as u32)
        }
    }
}

#[napi]
pub fn base64_decode(alphabet: String, pad: i32, strict: bool, src: Uint8Array) -> Result<Uint8Array> {
    Ok(decode_b64(&alphabet64(&alphabet, pad)?, strict, src.as_ref())?.into())
}

#[napi]
pub fn base32_encode(alphabet: String, pad: i32, src: Uint8Array) -> Result<Uint8Array> {
    Ok(encode_b32(&alphabet32(&alphabet, pad)?, src.as_ref()).into())
}

#[napi]
pub fn base32_decode(alphabet: String, pad: i32, src: Uint8Array) -> Result<Uint8Array> {
    Ok(decode_b32(&alphabet32(&alphabet, pad)?, src.as_ref())?.into())
}

#[napi]
pub fn hex_encode_bytes(src: Uint8Array) -> Uint8Array {
    hex_encode(src.as_ref()).into()
}

#[napi]
pub fn hex_decode_bytes(src: Uint8Array) -> Result<Uint8Array> {
    Ok(hex_decode(src.as_ref())?.into())
}

#[napi]
pub fn ascii85_encode_bytes(src: Uint8Array) -> Uint8Array {
    ascii85_encode(src.as_ref()).into()
}

#[napi]
pub fn ascii85_decode_bytes(src: Uint8Array, flush: bool) -> Result<Uint8Array> {
    Ok(ascii85_decode(src.as_ref(), flush)?.into())
}

#[napi]
pub fn uvarint_encode(value: BigInt) -> Result<Uint8Array> {
    let x = bigint_u64(value)?;
    let mut buf = Vec::new();
    let mut n = x;
    while n >= 0x80 {
        buf.push((n as u8) | 0x80);
        n >>= 7;
    }
    buf.push(n as u8);
    Ok(buf.into())
}

#[napi]
pub fn varint_encode(value: BigInt) -> Result<Uint8Array> {
    let x = bigint_i64(value)?;
    let mut ux = (x as u64) << 1;
    if x < 0 {
        ux = !ux;
    }
    uvarint_encode(u64_bigint(ux))
}

#[napi(object)]
pub struct VarintRead {
    pub value: BigInt,
    pub n: u32,
}

#[napi]
pub fn uvarint_decode(src: Uint8Array, offset: u32) -> Result<VarintRead> {
    let buf = src.as_ref();
    let start = offset as usize;
    if start > buf.len() {
        return Err(named("BufferTooShortError"));
    }
    let slice = &buf[start..];
    let mut x = 0u64;
    let mut s = 0u32;
    for (i, &b) in slice.iter().enumerate() {
        if i == 10 {
            return Err(named("VarintOverflowError"));
        }
        if b < 0x80 {
            if i == 9 && b > 1 {
                return Err(named("VarintOverflowError"));
            }
            return Ok(VarintRead {
                value: u64_bigint(x | (b as u64) << s),
                n: (i + 1) as u32,
            });
        }
        x |= (b as u64 & 0x7f) << s;
        s += 7;
    }
    Err(named("BufferTooShortError"))
}

#[napi]
pub fn varint_decode(src: Uint8Array, offset: u32) -> Result<VarintRead> {
    let read = uvarint_decode(src, offset)?;
    let ux = bigint_u64(read.value)?;
    let mut x = (ux >> 1) as i64;
    if ux & 1 != 0 {
        x = !x;
    }
    Ok(VarintRead {
        value: i64_bigint(x),
        n: read.n,
    })
}

fn bigint_u64(value: BigInt) -> Result<u64> {
    if value.sign_bit {
        return Err(fail("EncodingError", "uvarint value is negative"));
    }
    if value.words.is_empty() {
        return Ok(0);
    }
    let (_, v, lossless) = value.get_u64();
    if !lossless {
        return Err(fail("EncodingError", "uvarint exceeds uint64"));
    }
    Ok(v)
}

fn bigint_i64(value: BigInt) -> Result<i64> {
    if value.words.is_empty() {
        return Ok(0);
    }
    let (signed, lossless) = value.get_i64();
    if !lossless {
        return Err(fail("EncodingError", "varint exceeds int64"));
    }
    Ok(signed)
}

fn u64_bigint(v: u64) -> BigInt {
    BigInt::from(v)
}

fn i64_bigint(v: i64) -> BigInt {
    BigInt::from(v)
}
