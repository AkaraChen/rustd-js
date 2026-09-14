//! Port of Go 1.24.13 `regexp/syntax/compile.go` + `Prog.String()` dump.

use crate::fold::simple_fold;
use crate::regexp::*;

pub const INST_ALT: u8 = 0;
pub const INST_ALT_MATCH: u8 = 1;
pub const INST_CAPTURE: u8 = 2;
pub const INST_EMPTY_WIDTH: u8 = 3;
pub const INST_MATCH: u8 = 4;
pub const INST_FAIL: u8 = 5;
pub const INST_NOP: u8 = 6;
pub const INST_RUNE: u8 = 7;
pub const INST_RUNE1: u8 = 8;
pub const INST_RUNE_ANY: u8 = 9;
pub const INST_RUNE_ANY_NOT_NL: u8 = 10;

pub const EMPTY_BEGIN_LINE: u32 = 1 << 0;
pub const EMPTY_END_LINE: u32 = 1 << 1;
pub const EMPTY_BEGIN_TEXT: u32 = 1 << 2;
pub const EMPTY_END_TEXT: u32 = 1 << 3;
pub const EMPTY_WORD_BOUNDARY: u32 = 1 << 4;
pub const EMPTY_NO_WORD_BOUNDARY: u32 = 1 << 5;

/// Go `syntax.IsWordChar`: ASCII `[A-Za-z0-9_]` only.
pub fn is_word_char(r: i32) -> bool {
    (b'a' as i32 <= r && r <= b'z' as i32)
        || (b'A' as i32 <= r && r <= b'Z' as i32)
        || (b'0' as i32 <= r && r <= b'9' as i32)
        || r == b'_' as i32
}

/// Go `syntax.EmptyOpContext(r1, r2)`.
/// `r1 < 0` is beginning of text; `r2 < 0` is end of text.
pub fn empty_op_context(r1: i32, r2: i32) -> u32 {
    let mut op = EMPTY_NO_WORD_BOUNDARY;
    let mut boundary: u8 = 0;
    if is_word_char(r1) {
        boundary = 1;
    } else if r1 == b'\n' as i32 {
        op |= EMPTY_BEGIN_LINE;
    } else if r1 < 0 {
        op |= EMPTY_BEGIN_TEXT | EMPTY_BEGIN_LINE;
    }
    if is_word_char(r2) {
        boundary ^= 1;
    } else if r2 == b'\n' as i32 {
        op |= EMPTY_END_LINE;
    } else if r2 < 0 {
        op |= EMPTY_END_TEXT | EMPTY_END_LINE;
    }
    if boundary != 0 {
        op ^= EMPTY_WORD_BOUNDARY | EMPTY_NO_WORD_BOUNDARY;
    }
    op
}

#[derive(Clone, Debug)]
pub struct Inst {
    pub op: u8,
    pub out: u32,
    pub arg: u32,
    pub rune: Vec<i32>,
}

#[derive(Clone, Debug)]
pub struct Prog {
    pub inst: Vec<Inst>,
    pub start: i32,
    pub num_cap: i32,
}

#[derive(Clone, Copy)]
struct PatchList {
    head: u32,
    tail: u32,
}

impl PatchList {
    fn make(n: u32) -> Self {
        Self { head: n, tail: n }
    }

    fn empty() -> Self {
        Self { head: 0, tail: 0 }
    }

    fn patch(self, p: &mut Prog, val: u32) {
        let mut head = self.head;
        while head != 0 {
            let i = &mut p.inst[(head >> 1) as usize];
            if head & 1 == 0 {
                head = i.out;
                i.out = val;
            } else {
                head = i.arg;
                i.arg = val;
            }
        }
    }

    fn append(self, p: &mut Prog, l2: PatchList) -> PatchList {
        if self.head == 0 {
            return l2;
        }
        if l2.head == 0 {
            return self;
        }
        let i = &mut p.inst[(self.tail >> 1) as usize];
        if self.tail & 1 == 0 {
            i.out = l2.head;
        } else {
            i.arg = l2.head;
        }
        PatchList { head: self.head, tail: l2.tail }
    }
}

#[derive(Clone, Copy)]
struct Frag {
    i: u32,
    out: PatchList,
    nullable: bool,
}

impl Frag {
    fn fail() -> Self {
        Self { i: 0, out: PatchList::empty(), nullable: false }
    }
}

struct Compiler {
    p: Prog,
}

pub fn compile(nodes: &[Regexp], id: u32) -> Result<Prog, String> {
    let mut c = Compiler {
        p: Prog { inst: Vec::new(), start: 0, num_cap: 2 },
    };
    c.inst(INST_FAIL);
    let f = c.compile(nodes, id)?;
    let match_i = c.inst(INST_MATCH).i;
    f.out.patch(&mut c.p, match_i);
    c.p.start = f.i as i32;
    Ok(c.p)
}

impl Compiler {
    fn compile(&mut self, nodes: &[Regexp], id: u32) -> Result<Frag, String> {
        let re = &nodes[id as usize];
        match re.op {
            OP_NO_MATCH => Ok(Frag::fail()),
            OP_EMPTY_MATCH => Ok(self.nop()),
            OP_LITERAL => {
                if re.rune.is_empty() {
                    return Ok(self.nop());
                }
                let flags = re.flags;
                let mut f = Frag::fail();
                for j in 0..re.rune.len() {
                    let f1 = self.rune(&[re.rune[j]], flags);
                    f = if j == 0 { f1 } else { self.cat(f, f1) };
                }
                Ok(f)
            }
            OP_CHAR_CLASS => {
                let runes = re.rune.clone();
                Ok(self.rune(&runes, re.flags))
            }
            OP_ANY_CHAR_NOT_NL => Ok(self.rune(&[0, '\n' as i32 - 1, '\n' as i32 + 1, MAX_RUNE], 0)),
            OP_ANY_CHAR => Ok(self.rune(&[0, MAX_RUNE], 0)),
            OP_BEGIN_LINE => Ok(self.empty(EMPTY_BEGIN_LINE)),
            OP_END_LINE => Ok(self.empty(EMPTY_END_LINE)),
            OP_BEGIN_TEXT => Ok(self.empty(EMPTY_BEGIN_TEXT)),
            OP_END_TEXT => Ok(self.empty(EMPTY_END_TEXT)),
            OP_WORD_BOUNDARY => Ok(self.empty(EMPTY_WORD_BOUNDARY)),
            OP_NO_WORD_BOUNDARY => Ok(self.empty(EMPTY_NO_WORD_BOUNDARY)),
            OP_CAPTURE => {
                let cap = re.cap as u32;
                let sub = re.sub[0];
                let bra = self.cap(cap << 1);
                let subf = self.compile(nodes, sub)?;
                let ket = self.cap(cap << 1 | 1);
                let mid = self.cat(bra, subf);
                Ok(self.cat(mid, ket))
            }
            OP_STAR => {
                let nongreedy = re.flags & NON_GREEDY != 0;
                let sub = self.compile(nodes, re.sub[0])?;
                Ok(self.star(sub, nongreedy))
            }
            OP_PLUS => {
                let nongreedy = re.flags & NON_GREEDY != 0;
                let sub = self.compile(nodes, re.sub[0])?;
                Ok(self.plus(sub, nongreedy))
            }
            OP_QUEST => {
                let nongreedy = re.flags & NON_GREEDY != 0;
                let sub = self.compile(nodes, re.sub[0])?;
                Ok(self.quest(sub, nongreedy))
            }
            OP_CONCAT => {
                if re.sub.is_empty() {
                    return Ok(self.nop());
                }
                let mut f = Frag::fail();
                for (i, &sub) in re.sub.iter().enumerate() {
                    let next = self.compile(nodes, sub)?;
                    f = if i == 0 { next } else { self.cat(f, next) };
                }
                Ok(f)
            }
            OP_ALTERNATE => {
                let mut f = Frag::fail();
                let subs = re.sub.clone();
                for sub in subs {
                    let next = self.compile(nodes, sub)?;
                    f = self.alt(f, next);
                }
                Ok(f)
            }
            other => Err(format!("regexp: unhandled case in compile (op {other})")),
        }
    }

    fn inst(&mut self, op: u8) -> Frag {
        let f = Frag {
            i: self.p.inst.len() as u32,
            out: PatchList::empty(),
            nullable: true,
        };
        self.p.inst.push(Inst { op, out: 0, arg: 0, rune: Vec::new() });
        f
    }

    fn nop(&mut self) -> Frag {
        let mut f = self.inst(INST_NOP);
        f.out = PatchList::make(f.i << 1);
        f
    }

    fn cap(&mut self, arg: u32) -> Frag {
        let mut f = self.inst(INST_CAPTURE);
        f.out = PatchList::make(f.i << 1);
        self.p.inst[f.i as usize].arg = arg;
        if self.p.num_cap < arg as i32 + 1 {
            self.p.num_cap = arg as i32 + 1;
        }
        f
    }

    fn cat(&mut self, f1: Frag, f2: Frag) -> Frag {
        if f1.i == 0 || f2.i == 0 {
            return Frag::fail();
        }
        f1.out.patch(&mut self.p, f2.i);
        Frag { i: f1.i, out: f2.out, nullable: f1.nullable && f2.nullable }
    }

    fn alt(&mut self, f1: Frag, f2: Frag) -> Frag {
        if f1.i == 0 {
            return f2;
        }
        if f2.i == 0 {
            return f1;
        }
        let mut f = self.inst(INST_ALT);
        {
            let i = &mut self.p.inst[f.i as usize];
            i.out = f1.i;
            i.arg = f2.i;
        }
        f.out = f1.out.append(&mut self.p, f2.out);
        f.nullable = f1.nullable || f2.nullable;
        f
    }

    fn quest(&mut self, f1: Frag, nongreedy: bool) -> Frag {
        let mut f = self.inst(INST_ALT);
        {
            let i = &mut self.p.inst[f.i as usize];
            if nongreedy {
                i.arg = f1.i;
                f.out = PatchList::make(f.i << 1);
            } else {
                i.out = f1.i;
                f.out = PatchList::make(f.i << 1 | 1);
            }
        }
        f.out = f.out.append(&mut self.p, f1.out);
        f
    }

    fn loop_(&mut self, f1: Frag, nongreedy: bool) -> Frag {
        let mut f = self.inst(INST_ALT);
        {
            let i = &mut self.p.inst[f.i as usize];
            if nongreedy {
                i.arg = f1.i;
                f.out = PatchList::make(f.i << 1);
            } else {
                i.out = f1.i;
                f.out = PatchList::make(f.i << 1 | 1);
            }
        }
        f1.out.patch(&mut self.p, f.i);
        f
    }

    fn star(&mut self, f1: Frag, nongreedy: bool) -> Frag {
        if f1.nullable {
            let plus = self.plus(f1, nongreedy);
            return self.quest(plus, nongreedy);
        }
        self.loop_(f1, nongreedy)
    }

    fn plus(&mut self, f1: Frag, nongreedy: bool) -> Frag {
        let loopf = self.loop_(f1, nongreedy);
        Frag { i: f1.i, out: loopf.out, nullable: f1.nullable }
    }

    fn empty(&mut self, op: u32) -> Frag {
        let mut f = self.inst(INST_EMPTY_WIDTH);
        self.p.inst[f.i as usize].arg = op;
        f.out = PatchList::make(f.i << 1);
        f
    }

    fn rune(&mut self, r: &[i32], mut flags: u16) -> Frag {
        let mut f = self.inst(INST_RUNE);
        f.nullable = false;
        flags &= FOLD_CASE;
        if r.len() != 1 || simple_fold(r[0]) == r[0] {
            flags &= !FOLD_CASE;
        }
        {
            let i = &mut self.p.inst[f.i as usize];
            i.rune = r.to_vec();
            i.arg = flags as u32;
            if flags & FOLD_CASE == 0 && (r.len() == 1 || r.len() == 2 && r[0] == r[1]) {
                i.op = INST_RUNE1;
            } else if r.len() == 2 && r[0] == 0 && r[1] == MAX_RUNE {
                i.op = INST_RUNE_ANY;
            } else if r.len() == 4
                && r[0] == 0
                && r[1] == '\n' as i32 - 1
                && r[2] == '\n' as i32 + 1
                && r[3] == MAX_RUNE
            {
                i.op = INST_RUNE_ANY_NOT_NL;
            }
        }
        f.out = PatchList::make(f.i << 1);
        f
    }
}

pub fn dump_prog(p: &Prog) -> String {
    let mut b = String::new();
    for (j, inst) in p.inst.iter().enumerate() {
        let mut pc = j.to_string();
        if pc.len() < 3 {
            b.push_str(&"   "[pc.len()..]);
        }
        if j == p.start as usize {
            pc.push('*');
        }
        b.push_str(&pc);
        b.push('\t');
        dump_inst(&mut b, inst);
        b.push('\n');
    }
    b
}

fn dump_inst(b: &mut String, i: &Inst) {
    match i.op {
        INST_ALT => {
            b.push_str("alt -> ");
            b.push_str(&i.out.to_string());
            b.push_str(", ");
            b.push_str(&i.arg.to_string());
        }
        INST_ALT_MATCH => {
            b.push_str("altmatch -> ");
            b.push_str(&i.out.to_string());
            b.push_str(", ");
            b.push_str(&i.arg.to_string());
        }
        INST_CAPTURE => {
            b.push_str("cap ");
            b.push_str(&i.arg.to_string());
            b.push_str(" -> ");
            b.push_str(&i.out.to_string());
        }
        INST_EMPTY_WIDTH => {
            b.push_str("empty ");
            b.push_str(&i.arg.to_string());
            b.push_str(" -> ");
            b.push_str(&i.out.to_string());
        }
        INST_MATCH => b.push_str("match"),
        INST_FAIL => b.push_str("fail"),
        INST_NOP => {
            b.push_str("nop -> ");
            b.push_str(&i.out.to_string());
        }
        INST_RUNE => {
            b.push_str("rune ");
            b.push_str(&quote_to_ascii(&runes_to_string(&i.rune)));
            if i.arg as u16 & FOLD_CASE != 0 {
                b.push_str("/i");
            }
            b.push_str(" -> ");
            b.push_str(&i.out.to_string());
        }
        INST_RUNE1 => {
            b.push_str("rune1 ");
            b.push_str(&quote_to_ascii(&runes_to_string(&i.rune)));
            b.push_str(" -> ");
            b.push_str(&i.out.to_string());
        }
        INST_RUNE_ANY => {
            b.push_str("any -> ");
            b.push_str(&i.out.to_string());
        }
        INST_RUNE_ANY_NOT_NL => {
            b.push_str("anynotnl -> ");
            b.push_str(&i.out.to_string());
        }
        other => {
            b.push_str("op");
            b.push_str(&other.to_string());
        }
    }
}

fn runes_to_string(runes: &[i32]) -> String {
    runes
        .iter()
        .filter_map(|&r| char::from_u32(r as u32))
        .collect()
}

fn quote_to_ascii(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\x07' => out.push_str("\\a"),
            '\u{08}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{0b}' => out.push_str("\\v"),
            '\u{0c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if c.is_ascii_graphic() || c == ' ' => out.push(c),
            c => {
                let n = c as u32;
                if n < 0x100 {
                    out.push_str(&format!("\\x{:02x}", n));
                } else if n < 0x10000 {
                    out.push_str(&format!("\\u{:04x}", n));
                } else {
                    out.push_str(&format!("\\U{:08x}", n));
                }
            }
        }
    }
    out.push('"');
    out
}
