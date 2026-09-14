use crate::generated::{CaseRange, CASE_RANGES, SIMPLE_FOLD, TURKISH_CASE, UPPER_LOWER};

const MAX_ASCII: i32 = 0x7F;
const MAX_RUNE: i32 = 0x10FFFF;
const REPLACEMENT: i32 = 0xFFFD;

fn lookup_case_range(r: i32, case_range: &[CaseRange]) -> Option<&CaseRange> {
    let mut lo = 0;
    let mut hi = case_range.len();
    while lo < hi {
        let m = (lo + hi) >> 1;
        let cr = &case_range[m];
        if cr.lo as i32 <= r && r <= cr.hi as i32 {
            return Some(cr);
        }
        if r < cr.lo as i32 {
            hi = m;
        } else {
            lo = m + 1;
        }
    }
    None
}

fn convert_case(case: usize, r: i32, cr: &CaseRange) -> i32 {
    let delta = cr.delta[case];
    if delta > MAX_RUNE {
        return cr.lo as i32 + (((r - cr.lo as i32) & !1) | (case as i32 & 1));
    }
    r + delta
}

fn to(case: i32, r: i32, case_range: &[CaseRange]) -> (i32, bool) {
    if case < 0 || case >= 3 {
        return (REPLACEMENT, false);
    }
    if let Some(cr) = lookup_case_range(r, case_range) {
        return (convert_case(case as usize, r, cr), true);
    }
    (r, false)
}

pub fn to_case(case: i32, r: i32) -> i32 {
    to(case, r, CASE_RANGES).0
}

pub fn to_upper(r: i32) -> i32 {
    if r <= MAX_ASCII {
        if (b'a' as i32..=b'z' as i32).contains(&r) {
            return r - (b'a' as i32 - b'A' as i32);
        }
        return r;
    }
    to_case(0, r)
}

pub fn to_lower(r: i32) -> i32 {
    if r <= MAX_ASCII {
        if (b'A' as i32..=b'Z' as i32).contains(&r) {
            return r + (b'a' as i32 - b'A' as i32);
        }
        return r;
    }
    to_case(1, r)
}

pub fn to_title(r: i32) -> i32 {
    if r <= MAX_ASCII {
        if (b'a' as i32..=b'z' as i32).contains(&r) {
            return r - (b'a' as i32 - b'A' as i32);
        }
        return r;
    }
    to_case(2, r)
}

fn special_to(ranges: &[CaseRange], case: i32, r: i32, fallback: fn(i32) -> i32) -> i32 {
    let (mapped, had) = to(case, r, ranges);
    if mapped == r && !had {
        fallback(r)
    } else {
        mapped
    }
}

pub fn to_special_case(name: &str, case: i32, r: i32) -> Result<i32, String> {
    let fallback = match case {
        0 => to_upper,
        1 => to_lower,
        2 => to_title,
        _ => return Ok(REPLACEMENT),
    };
    match name {
        "turkish" | "azeri" => Ok(special_to(TURKISH_CASE, case, r, fallback)),
        "dutch" | "lithuanian" => Ok(fallback(r)),
        _ => Err(format!("UnknownSpecialCaseError:{name}")),
    }
}

pub fn simple_fold(r: i32) -> i32 {
    if r < 0 || r > MAX_RUNE {
        return r;
    }
    let key = r as u32;
    match SIMPLE_FOLD.binary_search_by_key(&key, |&(from, _)| from) {
        Ok(i) => SIMPLE_FOLD[i].1 as i32,
        Err(_) => r,
    }
}

pub fn case_kind(kind: &str) -> Result<i32, String> {
    match kind {
        "upper" => Ok(0),
        "lower" => Ok(1),
        "title" => Ok(2),
        _ => Err(format!("UnknownCaseKindError:{kind}")),
    }
}

const _: () = {
    let _ = UPPER_LOWER;
};
