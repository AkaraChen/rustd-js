const REPLACEMENT: i32 = 0xFFFD;
const MAX_RUNE: i32 = 0x10FFFF;
const SURR1: i32 = 0xD800;
const SURR2: i32 = 0xDC00;
const SURR3: i32 = 0xE000;
const SURR_SELF: i32 = 0x10000;

pub fn is_surrogate(r: i32) -> bool {
    SURR1 <= r && r < SURR3
}

pub fn decode_rune(r1: i32, r2: i32) -> i32 {
    if SURR1 <= r1 && r1 < SURR2 && SURR2 <= r2 && r2 < SURR3 {
        // Go `|` and `+` share precedence and associate left:
        // `((r1-surr1)<<10 | (r2-surr2)) + surrSelf`.
        (((r1 - SURR1) << 10) | (r2 - SURR2)) + SURR_SELF
    } else {
        REPLACEMENT
    }
}

pub fn encode_rune(r: i32) -> (i32, i32) {
    if r < SURR_SELF || r > MAX_RUNE {
        return (REPLACEMENT, REPLACEMENT);
    }
    let r = r - SURR_SELF;
    (SURR1 + ((r >> 10) & 0x3FF), SURR2 + (r & 0x3FF))
}

pub fn rune_len(r: i32) -> i32 {
    if (0..SURR1).contains(&r) || (SURR3..SURR_SELF).contains(&r) {
        1
    } else if (SURR_SELF..=MAX_RUNE).contains(&r) {
        2
    } else {
        -1
    }
}

pub fn encode(s: &[i32]) -> Vec<u16> {
    let mut n = s.len();
    for &v in s {
        if v >= SURR_SELF {
            n += 1;
        }
    }
    let mut a = vec![0u16; n];
    let mut n = 0;
    for &v in s {
        match rune_len(v) {
            1 => {
                a[n] = v as u16;
                n += 1;
            }
            2 => {
                let (r1, r2) = encode_rune(v);
                a[n] = r1 as u16;
                a[n + 1] = r2 as u16;
                n += 2;
            }
            _ => {
                a[n] = REPLACEMENT as u16;
                n += 1;
            }
        }
    }
    a.truncate(n);
    a
}

pub fn append_rune(out: &[u16], r: i32) -> Vec<u16> {
    let mut a = out.to_vec();
    match rune_len(r) {
        1 => a.push(r as u16),
        2 => {
            let (r1, r2) = encode_rune(r);
            a.push(r1 as u16);
            a.push(r2 as u16);
        }
        _ => a.push(REPLACEMENT as u16),
    }
    a
}

pub fn decode(s: &[u16]) -> Vec<u32> {
    let mut buf = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let r = s[i] as i32;
        let ar = if r < SURR1 || SURR3 <= r {
            r
        } else if SURR1 <= r
            && r < SURR2
            && i + 1 < s.len()
            && {
                let n = s[i + 1] as i32;
                SURR2 <= n && n < SURR3
            }
        {
            let n = s[i + 1] as i32;
            i += 1;
            decode_rune(r, n)
        } else {
            REPLACEMENT
        };
        buf.push(ar as u32);
        i += 1;
    }
    buf
}
