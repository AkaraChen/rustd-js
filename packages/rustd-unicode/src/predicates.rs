use crate::generated::LATIN1_PRED;
use crate::tables::{is_excluding_latin, is_in, lookup_table};

const MAX_LATIN1: u32 = 0xFF;

fn latin(r: i32, bit: u16) -> bool {
    (r as u32) <= MAX_LATIN1 && LATIN1_PRED[r as usize] & bit != 0
}

fn named(name: &str) -> &'static crate::generated::RangeTable {
    lookup_table(name).expect("generated table missing")
}

pub fn is_control(r: i32) -> bool {
    latin(r, 1 << 0)
}

pub fn is_digit(r: i32) -> bool {
    if (r as u32) <= MAX_LATIN1 {
        return latin(r, 1 << 1);
    }
    is_excluding_latin(named("Digit"), r)
}

pub fn is_graphic(r: i32) -> bool {
    if (r as u32) <= MAX_LATIN1 {
        return latin(r, 1 << 2);
    }
    is_in(named("L"), r)
        || is_in(named("M"), r)
        || is_in(named("N"), r)
        || is_in(named("P"), r)
        || is_in(named("S"), r)
        || is_in(named("Zs"), r)
}

pub fn is_letter(r: i32) -> bool {
    if (r as u32) <= MAX_LATIN1 {
        return latin(r, 1 << 3);
    }
    is_excluding_latin(named("Letter"), r)
}

pub fn is_lower(r: i32) -> bool {
    if (r as u32) <= MAX_LATIN1 {
        return latin(r, 1 << 4);
    }
    is_excluding_latin(named("Lower"), r)
}

pub fn is_mark(r: i32) -> bool {
    if (r as u32) <= MAX_LATIN1 {
        return latin(r, 1 << 5);
    }
    is_excluding_latin(named("Mark"), r)
}

pub fn is_number(r: i32) -> bool {
    if (r as u32) <= MAX_LATIN1 {
        return latin(r, 1 << 6);
    }
    is_excluding_latin(named("Number"), r)
}

pub fn is_print(r: i32) -> bool {
    if (r as u32) <= MAX_LATIN1 {
        return latin(r, 1 << 7);
    }
    is_in(named("L"), r)
        || is_in(named("M"), r)
        || is_in(named("N"), r)
        || is_in(named("P"), r)
        || is_in(named("S"), r)
}

pub fn is_punct(r: i32) -> bool {
    if (r as u32) <= MAX_LATIN1 {
        return latin(r, 1 << 8);
    }
    is_in(named("Punct"), r)
}

pub fn is_space(r: i32) -> bool {
    if (r as u32) <= MAX_LATIN1 {
        return latin(r, 1 << 9);
    }
    is_excluding_latin(named("White_Space"), r)
}

pub fn is_symbol(r: i32) -> bool {
    if (r as u32) <= MAX_LATIN1 {
        return latin(r, 1 << 10);
    }
    is_excluding_latin(named("Symbol"), r)
}

pub fn is_title(r: i32) -> bool {
    if (r as u32) <= MAX_LATIN1 {
        return latin(r, 1 << 11);
    }
    is_excluding_latin(named("Title"), r)
}

pub fn is_upper(r: i32) -> bool {
    if (r as u32) <= MAX_LATIN1 {
        return latin(r, 1 << 12);
    }
    is_excluding_latin(named("Upper"), r)
}
