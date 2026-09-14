const RUNE_ERROR: i32 = 0xFFFD;
const RUNE_SELF: u32 = 0x80;
const MAX_RUNE: u32 = 0x10FFFF;
const UTF_MAX: usize = 4;
const SURROGATE_MIN: u32 = 0xD800;
const SURROGATE_MAX: u32 = 0xDFFF;

const T2: u8 = 0b1100_0000;
const T3: u8 = 0b1110_0000;
const T4: u8 = 0b1111_0000;
const TX: u8 = 0b1000_0000;
const MASKX: u8 = 0b0011_1111;
const MASK2: u8 = 0b0001_1111;
const MASK3: u8 = 0b0000_1111;
const MASK4: u8 = 0b0000_0111;
const RUNE1_MAX: u32 = (1 << 7) - 1;
const RUNE2_MAX: u32 = (1 << 11) - 1;
const RUNE3_MAX: u32 = (1 << 16) - 1;
const LOCB: u8 = 0b1000_0000;
const HICB: u8 = 0b1011_1111;
const XX: u8 = 0xF1;
const AS: u8 = 0xF0;
const S1: u8 = 0x02;
const S2: u8 = 0x13;
const S3: u8 = 0x03;
const S4: u8 = 0x23;
const S5: u8 = 0x34;
const S6: u8 = 0x04;
const S7: u8 = 0x44;

const RUNE_ERROR_BYTES: [u8; 3] = [0xEF, 0xBF, 0xBD];

const fn first_table() -> [u8; 256] {
    let mut t = [XX; 256];
    let mut i = 0;
    while i < 0x80 {
        t[i] = AS;
        i += 1;
    }
    i = 0xC2;
    while i <= 0xDF {
        t[i] = S1;
        i += 1;
    }
    t[0xE0] = S2;
    i = 0xE1;
    while i <= 0xEC {
        t[i] = S3;
        i += 1;
    }
    t[0xED] = S4;
    t[0xEE] = S3;
    t[0xEF] = S3;
    t[0xF0] = S5;
    t[0xF1] = S6;
    t[0xF2] = S6;
    t[0xF3] = S6;
    t[0xF4] = S7;
    t
}

const FIRST: [u8; 256] = first_table();

struct AcceptRange {
    lo: u8,
    hi: u8,
}

const ACCEPT: [AcceptRange; 16] = [
    AcceptRange { lo: LOCB, hi: HICB },
    AcceptRange { lo: 0xA0, hi: HICB },
    AcceptRange { lo: LOCB, hi: 0x9F },
    AcceptRange { lo: 0x90, hi: HICB },
    AcceptRange { lo: LOCB, hi: 0x8F },
    AcceptRange { lo: 0, hi: 0 },
    AcceptRange { lo: 0, hi: 0 },
    AcceptRange { lo: 0, hi: 0 },
    AcceptRange { lo: 0, hi: 0 },
    AcceptRange { lo: 0, hi: 0 },
    AcceptRange { lo: 0, hi: 0 },
    AcceptRange { lo: 0, hi: 0 },
    AcceptRange { lo: 0, hi: 0 },
    AcceptRange { lo: 0, hi: 0 },
    AcceptRange { lo: 0, hi: 0 },
    AcceptRange { lo: 0, hi: 0 },
];

pub fn full_rune(p: &[u8]) -> bool {
    let n = p.len();
    if n == 0 {
        return false;
    }
    let x = FIRST[p[0] as usize];
    if n >= (x & 7) as usize {
        return true;
    }
    let accept = &ACCEPT[(x >> 4) as usize];
    if n > 1 && (p[1] < accept.lo || accept.hi < p[1]) {
        return true;
    }
    if n > 2 && (p[2] < LOCB || HICB < p[2]) {
        return true;
    }
    false
}

pub fn decode_rune(p: &[u8]) -> (i32, usize) {
    let n = p.len();
    if n < 1 {
        return (RUNE_ERROR, 0);
    }
    let p0 = p[0];
    let x = FIRST[p0 as usize];
    if x >= AS {
        let mask = ((x as i32) << 31) >> 31;
        return ((p0 as i32) & !mask | RUNE_ERROR & mask, 1);
    }
    let sz = (x & 7) as usize;
    let accept = &ACCEPT[(x >> 4) as usize];
    if n < sz {
        return (RUNE_ERROR, 1);
    }
    let b1 = p[1];
    if b1 < accept.lo || accept.hi < b1 {
        return (RUNE_ERROR, 1);
    }
    if sz <= 2 {
        return ((((p0 & MASK2) as i32) << 6) | ((b1 & MASKX) as i32), 2);
    }
    let b2 = p[2];
    if b2 < LOCB || HICB < b2 {
        return (RUNE_ERROR, 1);
    }
    if sz <= 3 {
        return (
            (((p0 & MASK3) as i32) << 12) | (((b1 & MASKX) as i32) << 6) | ((b2 & MASKX) as i32),
            3,
        );
    }
    let b3 = p[3];
    if b3 < LOCB || HICB < b3 {
        return (RUNE_ERROR, 1);
    }
    (
        (((p0 & MASK4) as i32) << 18)
            | (((b1 & MASKX) as i32) << 12)
            | (((b2 & MASKX) as i32) << 6)
            | ((b3 & MASKX) as i32),
        4,
    )
}

pub fn decode_last_rune(p: &[u8]) -> (i32, usize) {
    let end = p.len();
    if end == 0 {
        return (RUNE_ERROR, 0);
    }
    let start = end - 1;
    if (p[start] as u32) < RUNE_SELF {
        return (p[start] as i32, 1);
    }
    let lim = end.saturating_sub(UTF_MAX) as i32;
    let mut i = start as i32 - 1;
    while i >= lim {
        if rune_start(p[i as usize]) {
            break;
        }
        i -= 1;
    }
    let start = if i < 0 { 0 } else { i as usize };
    let (r, size) = decode_rune(&p[start..end]);
    if start + size != end {
        return (RUNE_ERROR, 1);
    }
    (r, size)
}

pub fn rune_len(r: i32) -> i32 {
    match r {
        n if n < 0 => -1,
        n if n as u32 <= RUNE1_MAX => 1,
        n if n as u32 <= RUNE2_MAX => 2,
        n if (n as u32) >= SURROGATE_MIN && (n as u32) <= SURROGATE_MAX => -1,
        n if n as u32 <= RUNE3_MAX => 3,
        n if n as u32 <= MAX_RUNE => 4,
        _ => -1,
    }
}

pub fn encode_rune(r: i32) -> Vec<u8> {
    let mut p = vec![0u8; 4];
    let n = encode_rune_into(&mut p, r);
    p.truncate(n);
    p
}

pub fn encode_rune_into(p: &mut [u8], r: i32) -> usize {
    let i = r as u32;
    if i <= RUNE1_MAX {
        p[0] = r as u8;
        return 1;
    }
    if i <= RUNE2_MAX {
        p[0] = T2 | (r >> 6) as u8;
        p[1] = TX | (r as u8) & MASKX;
        return 2;
    }
    if i < SURROGATE_MIN || (SURROGATE_MAX < i && i <= RUNE3_MAX) {
        p[0] = T3 | (r >> 12) as u8;
        p[1] = TX | ((r >> 6) as u8) & MASKX;
        p[2] = TX | (r as u8) & MASKX;
        return 3;
    }
    if i > RUNE3_MAX && i <= MAX_RUNE {
        p[0] = T4 | (r >> 18) as u8;
        p[1] = TX | ((r >> 12) as u8) & MASKX;
        p[2] = TX | ((r >> 6) as u8) & MASKX;
        p[3] = TX | (r as u8) & MASKX;
        return 4;
    }
    p[..3].copy_from_slice(&RUNE_ERROR_BYTES);
    3
}

pub fn append_rune(out: &[u8], r: i32) -> Vec<u8> {
    let extra = encode_rune(r);
    let mut v = out.to_vec();
    v.extend_from_slice(&extra);
    v
}

pub fn rune_count(p: &[u8]) -> i32 {
    let mut n = 0;
    let mut i = 0;
    while i < p.len() {
        let ( _, size) = decode_rune(&p[i..]);
        let size = if size == 0 { 1 } else { size };
        i += size;
        n += 1;
    }
    n
}

pub fn rune_start(b: u8) -> bool {
    b & 0xC0 != 0x80
}

pub fn valid(p: &[u8]) -> bool {
    let mut i = 0;
    let n = p.len();
    while i < n {
        let pi = p[i];
        if (pi as u32) < RUNE_SELF {
            i += 1;
            continue;
        }
        let x = FIRST[pi as usize];
        if x == XX {
            return false;
        }
        let size = (x & 7) as usize;
        if i + size > n {
            return false;
        }
        let accept = &ACCEPT[(x >> 4) as usize];
        let c = p[i + 1];
        if c < accept.lo || accept.hi < c {
            return false;
        } else if size == 2 {
        } else if p[i + 2] < LOCB || HICB < p[i + 2] {
            return false;
        } else if size == 3 {
        } else if p[i + 3] < LOCB || HICB < p[i + 3] {
            return false;
        }
        i += size;
    }
    true
}

pub fn valid_rune(r: i32) -> bool {
    (r >= 0 && (r as u32) < SURROGATE_MIN) || ((r as u32) > SURROGATE_MAX && (r as u32) <= MAX_RUNE)
}

pub fn encode_rune_strict(r: i32) -> Result<Vec<u8>, String> {
    if !valid_rune(r) {
        return Err(format!("InvalidRuneError:{r}"));
    }
    Ok(encode_rune(r))
}
