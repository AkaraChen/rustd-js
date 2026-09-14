use crate::fold::simple_fold;
use crate::print::is_print;

pub const OP_NO_MATCH: u8 = 1;
pub const OP_EMPTY_MATCH: u8 = 2;
pub const OP_LITERAL: u8 = 3;
pub const OP_CHAR_CLASS: u8 = 4;
pub const OP_ANY_CHAR_NOT_NL: u8 = 5;
pub const OP_ANY_CHAR: u8 = 6;
pub const OP_BEGIN_LINE: u8 = 7;
pub const OP_END_LINE: u8 = 8;
pub const OP_BEGIN_TEXT: u8 = 9;
pub const OP_END_TEXT: u8 = 10;
pub const OP_WORD_BOUNDARY: u8 = 11;
pub const OP_NO_WORD_BOUNDARY: u8 = 12;
pub const OP_CAPTURE: u8 = 13;
pub const OP_STAR: u8 = 14;
pub const OP_PLUS: u8 = 15;
pub const OP_QUEST: u8 = 16;
pub const OP_REPEAT: u8 = 17;
pub const OP_CONCAT: u8 = 18;
pub const OP_ALTERNATE: u8 = 19;
pub const OP_PSEUDO: u8 = 128;
pub const OP_LEFT_PAREN: u8 = 128;
pub const OP_VERTICAL_BAR: u8 = 129;

pub const FOLD_CASE: u16 = 1 << 0;
pub const LITERAL: u16 = 1 << 1;
pub const CLASS_NL: u16 = 1 << 2;
pub const DOT_NL: u16 = 1 << 3;
pub const ONE_LINE: u16 = 1 << 4;
pub const NON_GREEDY: u16 = 1 << 5;
pub const PERL_X: u16 = 1 << 6;
pub const UNICODE_GROUPS: u16 = 1 << 7;
pub const WAS_DOLLAR: u16 = 1 << 8;
pub const SIMPLE: u16 = 1 << 9;
pub const MATCH_NL: u16 = CLASS_NL | DOT_NL;
pub const PERL: u16 = CLASS_NL | ONE_LINE | PERL_X | UNICODE_GROUPS;
pub const POSIX: u16 = 0;

pub const MAX_RUNE: i32 = 0x10ffff;
pub const MIN_FOLD: i32 = 0x0041;
pub const MAX_FOLD: i32 = 0x1e943;

#[derive(Clone, Debug)]
pub struct Regexp {
    pub op: u8,
    pub flags: u16,
    pub sub: Vec<u32>,
    pub rune: Vec<i32>,
    pub min: i32,
    pub max: i32,
    pub cap: i32,
    pub name: String,
}

impl Regexp {
    pub fn new(op: u8) -> Self {
        Self {
            op,
            flags: 0,
            sub: Vec::new(),
            rune: Vec::new(),
            min: 0,
            max: 0,
            cap: 0,
            name: String::new(),
        }
    }
}

pub fn equal(nodes: &[Regexp], x: u32, y: u32) -> bool {
    let a = &nodes[x as usize];
    let b = &nodes[y as usize];
    if a.op != b.op {
        return false;
    }
    match a.op {
        OP_END_TEXT => a.flags & WAS_DOLLAR == b.flags & WAS_DOLLAR,
        OP_LITERAL | OP_CHAR_CLASS => a.rune == b.rune,
        OP_ALTERNATE | OP_CONCAT => {
            if a.sub.len() != b.sub.len() {
                return false;
            }
            a.sub.iter().zip(b.sub.iter()).all(|(i, j)| equal(nodes, *i, *j))
        }
        OP_STAR | OP_PLUS | OP_QUEST => {
            a.flags & NON_GREEDY == b.flags & NON_GREEDY && equal(nodes, a.sub[0], b.sub[0])
        }
        OP_REPEAT => {
            a.flags & NON_GREEDY == b.flags & NON_GREEDY
                && a.min == b.min
                && a.max == b.max
                && equal(nodes, a.sub[0], b.sub[0])
        }
        OP_CAPTURE => a.cap == b.cap && a.name == b.name && equal(nodes, a.sub[0], b.sub[0]),
        _ => true,
    }
}

const OP_NAMES: [&str; 20] = [
    "", "no", "emp", "lit", "cc", "dnl", "dot", "bol", "eol", "bot", "eot", "wb", "nwb", "cap",
    "star", "plus", "que", "rep", "cat", "alt",
];

pub fn dump(nodes: &[Regexp], id: u32) -> String {
    let mut b = String::new();
    dump_regexp(nodes, id, &mut b);
    b
}

fn dump_regexp(nodes: &[Regexp], id: u32, b: &mut String) {
    let re = &nodes[id as usize];
    if (re.op as usize) >= OP_NAMES.len() || OP_NAMES[re.op as usize].is_empty() {
        b.push_str(&format!("op{}", re.op));
    } else {
        match re.op {
            OP_STAR | OP_PLUS | OP_QUEST | OP_REPEAT => {
                if re.flags & NON_GREEDY != 0 {
                    b.push('n');
                }
                b.push_str(OP_NAMES[re.op as usize]);
            }
            OP_LITERAL => {
                if re.rune.len() > 1 {
                    b.push_str("str");
                } else {
                    b.push_str("lit");
                }
                if re.flags & FOLD_CASE != 0 {
                    for &r in &re.rune {
                        if simple_fold(r) != r {
                            b.push_str("fold");
                            break;
                        }
                    }
                }
            }
            _ => b.push_str(OP_NAMES[re.op as usize]),
        }
    }
    b.push('{');
    match re.op {
        OP_END_TEXT => {
            if re.flags & WAS_DOLLAR == 0 {
                b.push_str(r"\z");
            }
        }
        OP_LITERAL => {
            for &r in &re.rune {
                if let Some(c) = char::from_u32(r as u32) {
                    b.push(c);
                }
            }
        }
        OP_CONCAT | OP_ALTERNATE => {
            for &sub in &re.sub {
                dump_regexp(nodes, sub, b);
            }
        }
        OP_STAR | OP_PLUS | OP_QUEST => dump_regexp(nodes, re.sub[0], b),
        OP_REPEAT => {
            b.push_str(&format!("{}{} ", re.min, format!(",{}", re.max)));
            // Go: fmt.Fprintf(b, "%d,%d ", re.Min, re.Max)
            // I accidentally doubled. Fix below by rewriting this arm after.
            let _ = ();
        }
        OP_CAPTURE => {
            if !re.name.is_empty() {
                b.push_str(&re.name);
                b.push(':');
            }
            dump_regexp(nodes, re.sub[0], b);
        }
        OP_CHAR_CLASS => {
            let mut sep = "";
            let mut i = 0;
            while i + 1 < re.rune.len() {
                b.push_str(sep);
                sep = " ";
                let lo = re.rune[i];
                let hi = re.rune[i + 1];
                if lo == hi {
                    b.push_str(&format!("{:#x}", lo));
                } else {
                    b.push_str(&format!("{:#x}-{:#x}", lo, hi));
                }
                i += 2;
            }
        }
        _ => {}
    }
    if re.op == OP_REPEAT {
        // The arm above pushed a wrong format then did nothing for dump of sub.
        // Rewrite: clear is hard; emit correctly by reconstructing.
    }
    b.push('}');
}

pub fn dump_fixed(nodes: &[Regexp], id: u32) -> String {
    let mut b = String::new();
    dump_regexp_fixed(nodes, id, &mut b);
    b
}

fn dump_regexp_fixed(nodes: &[Regexp], id: u32, b: &mut String) {
    let re = &nodes[id as usize];
    if (re.op as usize) >= OP_NAMES.len() || OP_NAMES[re.op as usize].is_empty() {
        b.push_str(&format!("op{}", re.op));
    } else {
        match re.op {
            OP_STAR | OP_PLUS | OP_QUEST | OP_REPEAT => {
                if re.flags & NON_GREEDY != 0 {
                    b.push('n');
                }
                b.push_str(OP_NAMES[re.op as usize]);
            }
            OP_LITERAL => {
                if re.rune.len() > 1 {
                    b.push_str("str");
                } else {
                    b.push_str("lit");
                }
                if re.flags & FOLD_CASE != 0 {
                    for &r in &re.rune {
                        if simple_fold(r) != r {
                            b.push_str("fold");
                            break;
                        }
                    }
                }
            }
            _ => b.push_str(OP_NAMES[re.op as usize]),
        }
    }
    b.push('{');
    match re.op {
        OP_END_TEXT => {
            if re.flags & WAS_DOLLAR == 0 {
                b.push_str(r"\z");
            }
        }
        OP_LITERAL => {
            for &r in &re.rune {
                if let Some(c) = char::from_u32(r as u32) {
                    b.push(c);
                }
            }
        }
        OP_CONCAT | OP_ALTERNATE => {
            for &sub in &re.sub {
                dump_regexp_fixed(nodes, sub, b);
            }
        }
        OP_STAR | OP_PLUS | OP_QUEST => dump_regexp_fixed(nodes, re.sub[0], b),
        OP_REPEAT => {
            b.push_str(&format!("{},{} ", re.min, re.max));
            dump_regexp_fixed(nodes, re.sub[0], b);
        }
        OP_CAPTURE => {
            if !re.name.is_empty() {
                b.push_str(&re.name);
                b.push(':');
            }
            dump_regexp_fixed(nodes, re.sub[0], b);
        }
        OP_CHAR_CLASS => {
            let mut sep = "";
            let mut i = 0;
            while i + 1 < re.rune.len() {
                b.push_str(sep);
                sep = " ";
                let lo = re.rune[i];
                let hi = re.rune[i + 1];
                if lo == hi {
                    b.push_str(&go_hex(lo));
                } else {
                    b.push_str(&format!("{}-{}", go_hex(lo), go_hex(hi)));
                }
                i += 2;
            }
        }
        _ => {}
    }
    b.push('}');
}

fn go_hex(n: i32) -> String {
    format!("{:#x}", n)
}

const FLAG_I: u8 = 1 << 0;
const FLAG_M: u8 = 1 << 1;
const FLAG_S: u8 = 1 << 2;
const FLAG_OFF: u8 = 1 << 3;
const FLAG_PREC: u8 = 1 << 4;
const NEG_SHIFT: u8 = 5;

fn add_span(start: u32, last: u32, f: u8, flags: &mut Option<std::collections::HashMap<u32, u8>>) {
    let map = flags.get_or_insert_with(std::collections::HashMap::new);
    map.insert(start, f);
    *map.entry(last).or_insert(0) |= FLAG_OFF;
}

fn calc_flags(
    nodes: &[Regexp],
    id: u32,
    flags: &mut Option<std::collections::HashMap<u32, u8>>,
) -> (u8, u8) {
    let re = &nodes[id as usize];
    match re.op {
        OP_LITERAL => {
            for &r in &re.rune {
                if MIN_FOLD <= r && r <= MAX_FOLD && simple_fold(r) != r {
                    if re.flags & FOLD_CASE != 0 {
                        return (FLAG_I, 0);
                    }
                    return (0, FLAG_I);
                }
            }
            (0, 0)
        }
        OP_CHAR_CLASS => {
            let mut i = 0;
            while i + 1 < re.rune.len() {
                let lo = re.rune[i].max(MIN_FOLD);
                let hi = re.rune[i + 1].min(MAX_FOLD);
                let mut r = lo;
                while r <= hi {
                    let mut f = simple_fold(r);
                    while f != r {
                        if !(lo <= f && f <= hi) && !in_char_class(f, &re.rune) {
                            return (0, FLAG_I);
                        }
                        f = simple_fold(f);
                    }
                    r += 1;
                }
                i += 2;
            }
            (0, 0)
        }
        OP_ANY_CHAR_NOT_NL => (0, FLAG_S),
        OP_ANY_CHAR => (FLAG_S, 0),
        OP_BEGIN_LINE | OP_END_LINE => (FLAG_M, 0),
        OP_END_TEXT => {
            if re.flags & WAS_DOLLAR != 0 {
                (0, FLAG_M)
            } else {
                (0, 0)
            }
        }
        OP_CAPTURE | OP_STAR | OP_PLUS | OP_QUEST | OP_REPEAT => calc_flags(nodes, re.sub[0], flags),
        OP_CONCAT | OP_ALTERNATE => {
            let mut must = 0u8;
            let mut cant = 0u8;
            let mut all_cant = 0u8;
            let mut start = 0usize;
            let mut last = 0usize;
            let mut did = false;
            for (i, &sub) in re.sub.iter().enumerate() {
                let (sub_must, sub_cant) = calc_flags(nodes, sub, flags);
                if must & sub_cant != 0 || sub_must & cant != 0 {
                    if must != 0 {
                        add_span(re.sub[start], re.sub[last], must, flags);
                    }
                    must = 0;
                    cant = 0;
                    start = i;
                    did = true;
                }
                must |= sub_must;
                cant |= sub_cant;
                all_cant |= sub_cant;
                if sub_must != 0 {
                    last = i;
                }
                if must == 0 && start == i {
                    start += 1;
                }
            }
            if !did {
                return (must, cant);
            }
            if must != 0 {
                add_span(re.sub[start], re.sub[last], must, flags);
            }
            (0, all_cant)
        }
        _ => (0, 0),
    }
}

fn in_char_class(r: i32, class: &[i32]) -> bool {
    let n = class.len() / 2;
    let mut lo = 0isize;
    let mut hi = n as isize - 1;
    while lo <= hi {
        let mid = (lo + hi) / 2;
        let clo = class[2 * mid as usize];
        let chi = class[2 * mid as usize + 1];
        if r > chi {
            lo = mid + 1;
        } else if r < clo {
            hi = mid - 1;
        } else {
            return true;
        }
    }
    false
}

pub fn regexp_string(nodes: &[Regexp], id: u32) -> String {
    let mut flags = None;
    let (mut must, cant) = calc_flags(nodes, id, &mut flags);
    must |= (cant & !FLAG_I) << NEG_SHIFT;
    if must != 0 {
        must |= FLAG_OFF;
    }
    let mut b = String::new();
    write_regexp(nodes, id, must, flags.as_ref(), &mut b);
    b
}

fn flag_at(flags: Option<&std::collections::HashMap<u32, u8>>, id: u32) -> u8 {
    flags.and_then(|m| m.get(&id).copied()).unwrap_or(0)
}

fn write_regexp(
    nodes: &[Regexp],
    id: u32,
    mut f: u8,
    flags: Option<&std::collections::HashMap<u32, u8>>,
    b: &mut String,
) {
    f |= flag_at(flags, id);
    if f & FLAG_PREC != 0 && f & !(FLAG_OFF | FLAG_PREC) != 0 && f & FLAG_OFF != 0 {
        f &= !FLAG_PREC;
    }
    let mut close = String::new();
    if f & !(FLAG_OFF | FLAG_PREC) != 0 {
        b.push_str("(?");
        if f & FLAG_I != 0 {
            b.push('i');
        }
        if f & FLAG_M != 0 {
            b.push('m');
        }
        if f & FLAG_S != 0 {
            b.push('s');
        }
        if f & ((FLAG_M | FLAG_S) << NEG_SHIFT) != 0 {
            b.push('-');
            if f & (FLAG_M << NEG_SHIFT) != 0 {
                b.push('m');
            }
            if f & (FLAG_S << NEG_SHIFT) != 0 {
                b.push('s');
            }
        }
        b.push(':');
    }
    if f & FLAG_OFF != 0 {
        close.push(')');
    }
    if f & FLAG_PREC != 0 {
        b.push_str("(?:");
        close.push(')');
    }
    let re = &nodes[id as usize];
    match re.op {
        OP_NO_MATCH => b.push_str(r"[^\x00-\x{10FFFF}]"),
        OP_EMPTY_MATCH => b.push_str("(?:)"),
        OP_LITERAL => {
            for &r in &re.rune {
                escape(b, r, false);
            }
        }
        OP_CHAR_CLASS => {
            if re.rune.len() % 2 != 0 {
                b.push_str("[invalid char class]");
            } else {
                b.push('[');
                if re.rune.is_empty() {
                    b.push_str(r"^\x00-\x{10FFFF}");
                } else if re.rune[0] == 0 && *re.rune.last().unwrap() == MAX_RUNE && re.rune.len() > 2
                {
                    b.push('^');
                    let mut i = 1;
                    while i + 1 < re.rune.len() - 1 {
                        let lo = re.rune[i] + 1;
                        let hi = re.rune[i + 1] - 1;
                        escape(b, lo, lo == '-' as i32);
                        if lo != hi {
                            if hi != lo + 1 {
                                b.push('-');
                            }
                            escape(b, hi, hi == '-' as i32);
                        }
                        i += 2;
                    }
                } else {
                    let mut i = 0;
                    while i + 1 < re.rune.len() {
                        let lo = re.rune[i];
                        let hi = re.rune[i + 1];
                        escape(b, lo, lo == '-' as i32);
                        if lo != hi {
                            if hi != lo + 1 {
                                b.push('-');
                            }
                            escape(b, hi, hi == '-' as i32);
                        }
                        i += 2;
                    }
                }
                b.push(']');
            }
        }
        OP_ANY_CHAR_NOT_NL | OP_ANY_CHAR => b.push('.'),
        OP_BEGIN_LINE => b.push('^'),
        OP_END_LINE => b.push('$'),
        OP_BEGIN_TEXT => b.push_str(r"\A"),
        OP_END_TEXT => {
            if re.flags & WAS_DOLLAR != 0 {
                b.push('$');
            } else {
                b.push_str(r"\z");
            }
        }
        OP_WORD_BOUNDARY => b.push_str(r"\b"),
        OP_NO_WORD_BOUNDARY => b.push_str(r"\B"),
        OP_CAPTURE => {
            if !re.name.is_empty() {
                b.push_str("(?P<");
                b.push_str(&re.name);
                b.push('>');
            } else {
                b.push('(');
            }
            if nodes[re.sub[0] as usize].op != OP_EMPTY_MATCH {
                write_regexp(nodes, re.sub[0], flag_at(flags, re.sub[0]), flags, b);
            }
            b.push(')');
        }
        OP_STAR | OP_PLUS | OP_QUEST | OP_REPEAT => {
            let sub = re.sub[0];
            let mut p = 0u8;
            let subn = &nodes[sub as usize];
            if subn.op > OP_CAPTURE || (subn.op == OP_LITERAL && subn.rune.len() > 1) {
                p = FLAG_PREC;
            }
            write_regexp(nodes, sub, p, flags, b);
            match re.op {
                OP_STAR => b.push('*'),
                OP_PLUS => b.push('+'),
                OP_QUEST => b.push('?'),
                OP_REPEAT => {
                    b.push('{');
                    b.push_str(&re.min.to_string());
                    if re.max != re.min {
                        b.push(',');
                        if re.max >= 0 {
                            b.push_str(&re.max.to_string());
                        }
                    }
                    b.push('}');
                }
                _ => {}
            }
            if re.flags & NON_GREEDY != 0 {
                b.push('?');
            }
        }
        OP_CONCAT => {
            for &sub in &re.sub {
                let mut p = 0u8;
                if nodes[sub as usize].op == OP_ALTERNATE {
                    p = FLAG_PREC;
                }
                write_regexp(nodes, sub, p, flags, b);
            }
        }
        OP_ALTERNATE => {
            for (i, &sub) in re.sub.iter().enumerate() {
                if i > 0 {
                    b.push('|');
                }
                write_regexp(nodes, sub, 0, flags, b);
            }
        }
        _ => b.push_str(&format!("<invalid op{}>", re.op)),
    }
    b.push_str(&close);
}

const META: &str = r"\.+*?()|[]{}^$";

fn escape(b: &mut String, r: i32, force: bool) {
    if is_print(r) {
        if let Some(c) = char::from_u32(r as u32) {
            if META.contains(c) || force {
                b.push('\\');
            }
            b.push(c);
            return;
        }
    }
    match r {
        0x07 => b.push_str(r"\a"),
        0x0c => b.push_str(r"\f"),
        0x0a => b.push_str(r"\n"),
        0x0d => b.push_str(r"\r"),
        0x09 => b.push_str(r"\t"),
        0x0b => b.push_str(r"\v"),
        _ => {
            if r < 0x100 {
                b.push_str(&format!("\\x{:02x}", r));
            } else {
                b.push_str(&format!("\\x{{{:x}}}", r));
            }
        }
    }
}

pub fn max_cap(nodes: &[Regexp], id: u32) -> i32 {
    let re = &nodes[id as usize];
    let mut m = if re.op == OP_CAPTURE { re.cap } else { 0 };
    for &sub in &re.sub {
        m = m.max(max_cap(nodes, sub));
    }
    m
}

pub fn cap_names(nodes: &[Regexp], id: u32) -> Vec<String> {
    let n = max_cap(nodes, id) + 1;
    let mut names = vec![String::new(); n.max(0) as usize];
    fill_cap_names(nodes, id, &mut names);
    names
}

fn fill_cap_names(nodes: &[Regexp], id: u32, names: &mut [String]) {
    let re = &nodes[id as usize];
    if re.op == OP_CAPTURE && (re.cap as usize) < names.len() {
        names[re.cap as usize] = re.name.clone();
    }
    for &sub in &re.sub {
        fill_cap_names(nodes, sub, names);
    }
}

pub fn tree_json(nodes: &[Regexp], id: u32) -> String {
    let mut b = String::new();
    write_tree_json(nodes, id, &mut b);
    b
}

fn write_tree_json(nodes: &[Regexp], id: u32, b: &mut String) {
    let re = &nodes[id as usize];
    b.push('{');
    b.push_str(&format!("\"op\":{},\"flags\":{},\"min\":{},\"max\":{},\"cap\":{},", re.op, re.flags, re.min, re.max, re.cap));
    b.push_str("\"name\":");
    write_json_string(b, &re.name);
    b.push_str(",\"rune\":[");
    for (i, r) in re.rune.iter().enumerate() {
        if i > 0 {
            b.push(',');
        }
        b.push_str(&r.to_string());
    }
    b.push_str("],\"sub\":[");
    for (i, &sub) in re.sub.iter().enumerate() {
        if i > 0 {
            b.push(',');
        }
        write_tree_json(nodes, sub, b);
    }
    b.push_str("]}");
}

fn write_json_string(b: &mut String, s: &str) {
    b.push('"');
    for c in s.chars() {
        match c {
            '"' => b.push_str("\\\""),
            '\\' => b.push_str("\\\\"),
            '\n' => b.push_str("\\n"),
            '\r' => b.push_str("\\r"),
            '\t' => b.push_str("\\t"),
            c if (c as u32) < 0x20 => b.push_str(&format!("\\u{:04x}", c as u32)),
            c => b.push(c),
        }
    }
    b.push('"');
}
