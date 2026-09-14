use crate::generated::{Range16, Range32, RangeTable, TABLE_INDEX, TABLES};

const LINEAR_MAX: usize = 18;
const MAX_LATIN1: u32 = 0xFF;

fn is16(ranges: &[Range16], r: u16) -> bool {
    if ranges.len() <= LINEAR_MAX || r as u32 <= MAX_LATIN1 {
        for range_ in ranges {
            if r < range_.lo {
                return false;
            }
            if r <= range_.hi {
                return range_.stride == 1 || (r - range_.lo) % range_.stride == 0;
            }
        }
        return false;
    }
    let mut lo = 0;
    let mut hi = ranges.len();
    while lo < hi {
        let m = (lo + hi) >> 1;
        let range_ = &ranges[m];
        if range_.lo <= r && r <= range_.hi {
            return range_.stride == 1 || (r - range_.lo) % range_.stride == 0;
        }
        if r < range_.lo {
            hi = m;
        } else {
            lo = m + 1;
        }
    }
    false
}

fn is32(ranges: &[Range32], r: u32) -> bool {
    if ranges.len() <= LINEAR_MAX {
        for range_ in ranges {
            if r < range_.lo {
                return false;
            }
            if r <= range_.hi {
                return range_.stride == 1 || (r - range_.lo) % range_.stride == 0;
            }
        }
        return false;
    }
    let mut lo = 0;
    let mut hi = ranges.len();
    while lo < hi {
        let m = (lo + hi) >> 1;
        let range_ = &ranges[m];
        if range_.lo <= r && r <= range_.hi {
            return range_.stride == 1 || (r - range_.lo) % range_.stride == 0;
        }
        if r < range_.lo {
            hi = m;
        } else {
            lo = m + 1;
        }
    }
    false
}

pub fn is_in(table: &RangeTable, r: i32) -> bool {
    let r16 = table.r16;
    if !r16.is_empty() && (r as u32) <= r16[r16.len() - 1].hi as u32 {
        return is16(r16, r as u16);
    }
    let r32 = table.r32;
    if !r32.is_empty() && r >= r32[0].lo as i32 {
        return is32(r32, r as u32);
    }
    false
}

pub fn is_excluding_latin(table: &RangeTable, r: i32) -> bool {
    let r16 = table.r16;
    let off = table.latin_offset as usize;
    if r16.len() > off && (r as u32) <= r16[r16.len() - 1].hi as u32 {
        return is16(&r16[off..], r as u16);
    }
    let r32 = table.r32;
    if !r32.is_empty() && r >= r32[0].lo as i32 {
        return is32(r32, r as u32);
    }
    false
}

pub fn lookup_table(name: &str) -> Option<&'static RangeTable> {
    match TABLE_INDEX.binary_search_by_key(&name, |&(n, _)| n) {
        Ok(i) => Some(&TABLES[TABLE_INDEX[i].1 as usize]),
        Err(_) => None,
    }
}

pub fn table_names() -> Vec<String> {
    TABLE_INDEX.iter().map(|&(n, _)| n.to_string()).collect()
}

pub fn tables_of(r: i32) -> Vec<String> {
    TABLE_INDEX
        .iter()
        .filter(|&&(_, idx)| is_in(&TABLES[idx as usize], r))
        .map(|&(n, _)| n.to_string())
        .collect()
}

pub fn require_table(name: &str) -> Result<&'static RangeTable, String> {
    lookup_table(name).ok_or_else(|| format!("UnknownTableError:{name}"))
}
