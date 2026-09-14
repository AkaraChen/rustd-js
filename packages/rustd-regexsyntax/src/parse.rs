use crate::fold::simple_fold;
use crate::perl_groups::{perl_group, posix_group, CharGroup};
use crate::regexp::*;
use crate::unicode_tables::{unicode_table, RangeTable};
use std::collections::HashMap;

pub const ERR_INTERNAL: &str = "regexp/syntax: internal error";
pub const ERR_INVALID_CHAR_CLASS: &str = "invalid character class";
pub const ERR_INVALID_CHAR_RANGE: &str = "invalid character class range";
pub const ERR_INVALID_ESCAPE: &str = "invalid escape sequence";
pub const ERR_INVALID_NAMED_CAPTURE: &str = "invalid named capture";
pub const ERR_INVALID_PERL_OP: &str = "invalid or unsupported Perl syntax";
pub const ERR_INVALID_REPEAT_OP: &str = "invalid nested repetition operator";
pub const ERR_INVALID_REPEAT_SIZE: &str = "invalid repeat count";
pub const ERR_INVALID_UTF8: &str = "invalid UTF-8";
pub const ERR_MISSING_BRACKET: &str = "missing closing ]";
pub const ERR_MISSING_PAREN: &str = "missing closing )";
pub const ERR_MISSING_REPEAT_ARGUMENT: &str = "missing argument to repetition operator";
pub const ERR_TRAILING_BACKSLASH: &str = "trailing backslash at end of expression";
pub const ERR_UNEXPECTED_PAREN: &str = "unexpected )";
pub const ERR_NESTING_DEPTH: &str = "expression nests too deeply";
pub const ERR_LARGE: &str = "expression too large";

#[derive(Debug)]
pub struct SyntaxError {
    pub code: String,
    pub expr: String,
}

impl SyntaxError {
    fn new(code: &str, expr: impl Into<String>) -> Self {
        Self { code: code.to_string(), expr: expr.into() }
    }
    pub fn message(&self) -> String {
        format!("error parsing regexp: {}: `{}`", self.code, self.expr)
    }
}

const MAX_HEIGHT: i32 = 1000;
const INST_SIZE: i64 = 5 * 8;
const MAX_SIZE: i64 = (128 << 20) / INST_SIZE;
const RUNE_SIZE: i32 = 4;
const MAX_RUNES: i32 = (128 << 20) / RUNE_SIZE;

struct Parser {
    flags: u16,
    stack: Vec<u32>,
    free: Vec<u32>,
    nodes: Vec<Regexp>,
    num_cap: i32,
    whole: String,
    tmp_class: Vec<i32>,
    num_regexp: i32,
    num_runes: i32,
    repeats: i64,
    height: Option<HashMap<u32, i32>>,
    size: Option<HashMap<u32, i64>>,
}

impl Parser {
    fn new_regexp(&mut self, op: u8) -> u32 {
        if let Some(id) = self.free.pop() {
            self.nodes[id as usize] = Regexp::new(op);
            id
        } else {
            let id = self.nodes.len() as u32;
            self.nodes.push(Regexp::new(op));
            self.num_regexp += 1;
            id
        }
    }

    fn reuse(&mut self, id: u32) {
        if let Some(h) = self.height.as_mut() {
            h.remove(&id);
        }
        self.free.push(id);
    }

    fn check_limits(&mut self, id: u32) -> Result<(), SyntaxError> {
        if self.num_runes > MAX_RUNES {
            return Err(SyntaxError::new(ERR_LARGE, self.whole.clone()));
        }
        self.check_size(id)?;
        self.check_height(id)
    }

    fn check_size(&mut self, id: u32) -> Result<(), SyntaxError> {
        if self.size.is_none() {
            if self.repeats == 0 {
                self.repeats = 1;
            }
            if self.nodes[id as usize].op == OP_REPEAT {
                let mut n = self.nodes[id as usize].max;
                if n == -1 {
                    n = self.nodes[id as usize].min;
                }
                if n <= 0 {
                    n = 1;
                }
                if (n as i64) > MAX_SIZE / self.repeats {
                    self.repeats = MAX_SIZE;
                } else {
                    self.repeats *= n as i64;
                }
            }
            if (self.num_regexp as i64) < MAX_SIZE / self.repeats {
                return Ok(());
            }
            self.size = Some(HashMap::new());
            let stack = self.stack.clone();
            for sid in stack {
                self.check_size(sid)?;
            }
        }
        if self.calc_size(id, true) > MAX_SIZE {
            return Err(SyntaxError::new(ERR_LARGE, self.whole.clone()));
        }
        Ok(())
    }

    fn calc_size(&mut self, id: u32, force: bool) -> i64 {
        if !force {
            if let Some(map) = self.size.as_ref() {
                if let Some(&sz) = map.get(&id) {
                    return sz;
                }
            }
        }
        let op = self.nodes[id as usize].op;
        let sub = self.nodes[id as usize].sub.clone();
        let rune_len = self.nodes[id as usize].rune.len() as i64;
        let min = self.nodes[id as usize].min;
        let max = self.nodes[id as usize].max;
        let mut size = match op {
            OP_LITERAL => rune_len,
            OP_CAPTURE | OP_STAR => 2 + self.calc_size(sub[0], false),
            OP_PLUS | OP_QUEST => 1 + self.calc_size(sub[0], false),
            OP_CONCAT => sub.iter().map(|&s| self.calc_size(s, false)).sum(),
            OP_ALTERNATE => {
                let mut size: i64 = sub.iter().map(|&s| self.calc_size(s, false)).sum();
                if sub.len() > 1 {
                    size += sub.len() as i64 - 1;
                }
                size
            }
            OP_REPEAT => {
                let subsz = self.calc_size(sub[0], false);
                if max == -1 {
                    if min == 0 {
                        2 + subsz
                    } else {
                        1 + (min as i64) * subsz
                    }
                } else {
                    (max as i64) * subsz + (max as i64 - min as i64)
                }
            }
            _ => 1,
        };
        size = size.max(1);
        if let Some(map) = self.size.as_mut() {
            map.insert(id, size);
        }
        size
    }

    fn check_height(&mut self, id: u32) -> Result<(), SyntaxError> {
        if self.num_regexp < MAX_HEIGHT {
            return Ok(());
        }
        if self.height.is_none() {
            self.height = Some(HashMap::new());
            let stack = self.stack.clone();
            for sid in stack {
                self.check_height(sid)?;
            }
        }
        if self.calc_height(id, true) > MAX_HEIGHT {
            return Err(SyntaxError::new(ERR_NESTING_DEPTH, self.whole.clone()));
        }
        Ok(())
    }

    fn calc_height(&mut self, id: u32, force: bool) -> i32 {
        if !force {
            if let Some(map) = self.height.as_ref() {
                if let Some(&h) = map.get(&id) {
                    return h;
                }
            }
        }
        let sub = self.nodes[id as usize].sub.clone();
        let mut h = 1;
        for s in sub {
            let hs = self.calc_height(s, false);
            if h < 1 + hs {
                h = 1 + hs;
            }
        }
        if let Some(map) = self.height.as_mut() {
            map.insert(id, h);
        }
        h
    }

    fn push(&mut self, id: u32) -> Result<Option<u32>, SyntaxError> {
        self.num_runes += self.nodes[id as usize].rune.len() as i32;
        let op = self.nodes[id as usize].op;
        let rune = self.nodes[id as usize].rune.clone();
        let fold0 = if rune.len() >= 1 { simple_fold(rune[0]) } else { 0 };
        let fold2 = if rune.len() >= 3 { simple_fold(rune[2]) } else { 0 };
        if op == OP_CHAR_CLASS && rune.len() == 2 && rune[0] == rune[1] {
            if self.maybe_concat(rune[0], self.flags & !FOLD_CASE)? {
                return Ok(None);
            }
            self.nodes[id as usize].op = OP_LITERAL;
            self.nodes[id as usize].rune = vec![rune[0]];
            self.nodes[id as usize].flags = self.flags & !FOLD_CASE;
        } else if (op == OP_CHAR_CLASS
            && rune.len() == 4
            && rune[0] == rune[1]
            && rune[2] == rune[3]
            && fold0 == rune[2]
            && fold2 == rune[0])
            || (op == OP_CHAR_CLASS
                && rune.len() == 2
                && rune[0] + 1 == rune[1]
                && simple_fold(rune[0]) == rune[1]
                && simple_fold(rune[1]) == rune[0])
        {
            if self.maybe_concat(rune[0], self.flags | FOLD_CASE)? {
                return Ok(None);
            }
            self.nodes[id as usize].op = OP_LITERAL;
            self.nodes[id as usize].rune = vec![rune[0]];
            self.nodes[id as usize].flags = self.flags | FOLD_CASE;
        } else {
            self.maybe_concat(-1, 0)?;
        }
        self.stack.push(id);
        self.check_limits(id)?;
        Ok(Some(id))
    }

    fn maybe_concat(&mut self, r: i32, flags: u16) -> Result<bool, SyntaxError> {
        let n = self.stack.len();
        if n < 2 {
            return Ok(false);
        }
        let re1 = self.stack[n - 1];
        let re2 = self.stack[n - 2];
        if self.nodes[re1 as usize].op != OP_LITERAL
            || self.nodes[re2 as usize].op != OP_LITERAL
            || self.nodes[re1 as usize].flags & FOLD_CASE != self.nodes[re2 as usize].flags & FOLD_CASE
        {
            return Ok(false);
        }
        let extra = self.nodes[re1 as usize].rune.clone();
        self.nodes[re2 as usize].rune.extend(extra);
        if r >= 0 {
            self.nodes[re1 as usize].rune = vec![r];
            self.nodes[re1 as usize].flags = flags;
            return Ok(true);
        }
        self.stack.pop();
        self.reuse(re1);
        Ok(false)
    }

    fn literal(&mut self, mut r: i32) -> Result<(), SyntaxError> {
        let id = self.new_regexp(OP_LITERAL);
        self.nodes[id as usize].flags = self.flags;
        if self.flags & FOLD_CASE != 0 {
            r = min_fold_rune(r);
        }
        self.nodes[id as usize].rune = vec![r];
        self.push(id)?;
        Ok(())
    }

    fn op(&mut self, op: u8) -> Result<u32, SyntaxError> {
        let id = self.new_regexp(op);
        self.nodes[id as usize].flags = self.flags;
        Ok(self.push(id)?.unwrap())
    }

    fn repeat(
        &mut self,
        op: u8,
        min: i32,
        max: i32,
        before: &str,
        mut after: String,
        last_repeat: &str,
    ) -> Result<String, SyntaxError> {
        let mut flags = self.flags;
        if self.flags & PERL_X != 0 {
            if after.starts_with('?') {
                after = after[1..].to_string();
                flags ^= NON_GREEDY;
            }
            if !last_repeat.is_empty() {
                let expr = last_repeat[..last_repeat.len() - after.len()].to_string();
                return Err(SyntaxError::new(ERR_INVALID_REPEAT_OP, expr));
            }
        }
        let n = self.stack.len();
        if n == 0 {
            let expr = before[..before.len() - after.len()].to_string();
            return Err(SyntaxError::new(ERR_MISSING_REPEAT_ARGUMENT, expr));
        }
        let sub = self.stack[n - 1];
        if self.nodes[sub as usize].op >= OP_PSEUDO {
            let expr = before[..before.len() - after.len()].to_string();
            return Err(SyntaxError::new(ERR_MISSING_REPEAT_ARGUMENT, expr));
        }
        let id = self.new_regexp(op);
        self.nodes[id as usize].min = min;
        self.nodes[id as usize].max = max;
        self.nodes[id as usize].flags = flags;
        self.nodes[id as usize].sub = vec![sub];
        self.stack[n - 1] = id;
        self.check_limits(id)?;
        if op == OP_REPEAT && (min >= 2 || max >= 2) && !repeat_is_valid(&self.nodes, id, 1000) {
            let expr = before[..before.len() - after.len()].to_string();
            return Err(SyntaxError::new(ERR_INVALID_REPEAT_SIZE, expr));
        }
        Ok(after)
    }

    fn concat(&mut self) -> Result<u32, SyntaxError> {
        self.maybe_concat(-1, 0)?;
        let mut i = self.stack.len();
        while i > 0 && self.nodes[self.stack[i - 1] as usize].op < OP_PSEUDO {
            i -= 1;
        }
        let subs: Vec<u32> = self.stack.split_off(i);
        if subs.is_empty() {
            let id = self.new_regexp(OP_EMPTY_MATCH);
            return Ok(self.push(id)?.unwrap());
        }
        let collapsed = self.collapse(subs, OP_CONCAT)?;
        Ok(self.push(collapsed)?.unwrap())
    }

    fn alternate(&mut self) -> Result<u32, SyntaxError> {
        let mut i = self.stack.len();
        while i > 0 && self.nodes[self.stack[i - 1] as usize].op < OP_PSEUDO {
            i -= 1;
        }
        let mut subs: Vec<u32> = self.stack.split_off(i);
        if !subs.is_empty() {
            clean_alt(&mut self.nodes, *subs.last().unwrap());
        }
        if subs.is_empty() {
            let id = self.new_regexp(OP_NO_MATCH);
            return Ok(self.push(id)?.unwrap());
        }
        let collapsed = self.collapse(subs, OP_ALTERNATE)?;
        Ok(self.push(collapsed)?.unwrap())
    }

    fn collapse(&mut self, mut subs: Vec<u32>, op: u8) -> Result<u32, SyntaxError> {
        if subs.len() == 1 {
            return Ok(subs[0]);
        }
        let id = self.new_regexp(op);
        let mut out = Vec::new();
        for sub in subs.drain(..) {
            if self.nodes[sub as usize].op == op {
                out.extend(self.nodes[sub as usize].sub.clone());
                self.reuse(sub);
            } else {
                out.push(sub);
            }
        }
        if op == OP_ALTERNATE {
            out = self.factor(out)?;
            if out.len() == 1 {
                let old = id;
                let keep = out[0];
                self.reuse(old);
                return Ok(keep);
            }
        }
        self.nodes[id as usize].sub = out;
        Ok(id)
    }

    fn factor(&mut self, mut sub: Vec<u32>) -> Result<Vec<u32>, SyntaxError> {
        if sub.len() < 2 {
            return Ok(sub);
        }
        let mut strv: Vec<i32> = Vec::new();
        let mut strflags = 0u16;
        let mut start = 0usize;
        let mut out = Vec::new();
        for i in 0..=sub.len() {
            let mut istr = Vec::new();
            let mut iflags = 0u16;
            if i < sub.len() {
                let (s, f) = self.leading_string(sub[i]);
                istr = s;
                iflags = f;
                if iflags == strflags {
                    let mut same = 0;
                    while same < strv.len() && same < istr.len() && strv[same] == istr[same] {
                        same += 1;
                    }
                    if same > 0 {
                        strv.truncate(same);
                        continue;
                    }
                }
            }
            if i == start {
            } else if i == start + 1 {
                out.push(sub[start]);
            } else {
                let prefix = self.new_regexp(OP_LITERAL);
                self.nodes[prefix as usize].flags = strflags;
                self.nodes[prefix as usize].rune = strv.clone();
                for j in start..i {
                    sub[j] = self.remove_leading_string(sub[j], strv.len());
                    self.check_limits(sub[j])?;
                }
                let suffix = self.collapse(sub[start..i].to_vec(), OP_ALTERNATE)?;
                let re = self.new_regexp(OP_CONCAT);
                self.nodes[re as usize].sub = vec![prefix, suffix];
                out.push(re);
            }
            start = i;
            strv = istr;
            strflags = iflags;
        }
        sub = out;

        start = 0;
        out = Vec::new();
        let mut first: Option<u32> = None;
        for i in 0..=sub.len() {
            let mut ifirst = None;
            if i < sub.len() {
                ifirst = self.leading_regexp(sub[i]);
                if let (Some(f), Some(ifr)) = (first, ifirst) {
                    if equal(&self.nodes, f, ifr)
                        && (is_char_class(&self.nodes[f as usize])
                            || (self.nodes[f as usize].op == OP_REPEAT
                                && self.nodes[f as usize].min == self.nodes[f as usize].max
                                && is_char_class(&self.nodes[self.nodes[f as usize].sub[0] as usize])))
                    {
                        continue;
                    }
                }
            }
            if i == start {
            } else if i == start + 1 {
                out.push(sub[start]);
            } else {
                let prefix = first.unwrap();
                for j in start..i {
                    let reuse = j != start;
                    sub[j] = self.remove_leading_regexp(sub[j], reuse);
                    self.check_limits(sub[j])?;
                }
                let suffix = self.collapse(sub[start..i].to_vec(), OP_ALTERNATE)?;
                let re = self.new_regexp(OP_CONCAT);
                self.nodes[re as usize].sub = vec![prefix, suffix];
                out.push(re);
            }
            start = i;
            first = ifirst;
        }
        sub = out;

        start = 0;
        out = Vec::new();
        for i in 0..=sub.len() {
            if i < sub.len() && is_char_class(&self.nodes[sub[i] as usize]) {
                continue;
            }
            if i == start {
            } else if i == start + 1 {
                out.push(sub[start]);
            } else {
                let mut max = start;
                for j in start + 1..i {
                    let a = &self.nodes[sub[max] as usize];
                    let b = &self.nodes[sub[j] as usize];
                    if a.op < b.op || (a.op == b.op && a.rune.len() < b.rune.len()) {
                        max = j;
                    }
                }
                sub.swap(start, max);
                for j in start + 1..i {
                    merge_char_class(&mut self.nodes, sub[start], sub[j]);
                    self.reuse(sub[j]);
                }
                clean_alt(&mut self.nodes, sub[start]);
                out.push(sub[start]);
            }
            if i < sub.len() {
                out.push(sub[i]);
            }
            start = i + 1;
        }
        sub = out;

        out = Vec::new();
        let mut i = 0;
        while i < sub.len() {
            if i + 1 < sub.len()
                && self.nodes[sub[i] as usize].op == OP_EMPTY_MATCH
                && self.nodes[sub[i + 1] as usize].op == OP_EMPTY_MATCH
            {
                i += 1;
                continue;
            }
            out.push(sub[i]);
            i += 1;
        }
        Ok(out)
    }

    fn leading_string(&self, id: u32) -> (Vec<i32>, u16) {
        let mut re = &self.nodes[id as usize];
        if re.op == OP_CONCAT && !re.sub.is_empty() {
            re = &self.nodes[re.sub[0] as usize];
        }
        if re.op != OP_LITERAL {
            return (Vec::new(), 0);
        }
        (re.rune.clone(), re.flags & FOLD_CASE)
    }

    fn remove_leading_string(&mut self, id: u32, n: usize) -> u32 {
        if self.nodes[id as usize].op == OP_CONCAT && !self.nodes[id as usize].sub.is_empty() {
            let sub0 = self.nodes[id as usize].sub[0];
            let sub = self.remove_leading_string(sub0, n);
            self.nodes[id as usize].sub[0] = sub;
            if self.nodes[sub as usize].op == OP_EMPTY_MATCH {
                self.reuse(sub);
                let len = self.nodes[id as usize].sub.len();
                match len {
                    0 | 1 => {
                        self.nodes[id as usize].op = OP_EMPTY_MATCH;
                        self.nodes[id as usize].sub.clear();
                    }
                    2 => {
                        let keep = self.nodes[id as usize].sub[1];
                        self.reuse(id);
                        return keep;
                    }
                    _ => {
                        self.nodes[id as usize].sub.remove(0);
                    }
                }
            }
            return id;
        }
        if self.nodes[id as usize].op == OP_LITERAL {
            let nlen = self.nodes[id as usize].rune.len();
            self.nodes[id as usize].rune.drain(..n.min(nlen));
            if self.nodes[id as usize].rune.is_empty() {
                self.nodes[id as usize].op = OP_EMPTY_MATCH;
            }
        }
        id
    }

    fn leading_regexp(&self, id: u32) -> Option<u32> {
        let re = &self.nodes[id as usize];
        if re.op == OP_EMPTY_MATCH {
            return None;
        }
        if re.op == OP_CONCAT && !re.sub.is_empty() {
            let sub = re.sub[0];
            if self.nodes[sub as usize].op == OP_EMPTY_MATCH {
                return None;
            }
            return Some(sub);
        }
        Some(id)
    }

    fn remove_leading_regexp(&mut self, id: u32, reuse: bool) -> u32 {
        if self.nodes[id as usize].op == OP_CONCAT && !self.nodes[id as usize].sub.is_empty() {
            if reuse {
                let first = self.nodes[id as usize].sub[0];
                self.reuse(first);
            }
            self.nodes[id as usize].sub.remove(0);
            match self.nodes[id as usize].sub.len() {
                0 => {
                    self.nodes[id as usize].op = OP_EMPTY_MATCH;
                    self.nodes[id as usize].sub.clear();
                    id
                }
                1 => {
                    let keep = self.nodes[id as usize].sub[0];
                    self.reuse(id);
                    keep
                }
                _ => id,
            }
        } else {
            if reuse {
                self.reuse(id);
            }
            self.new_regexp(OP_EMPTY_MATCH)
        }
    }

    fn parse_vertical_bar(&mut self) -> Result<(), SyntaxError> {
        self.concat()?;
        if !self.swap_vertical_bar() {
            self.op(OP_VERTICAL_BAR)?;
        }
        Ok(())
    }

    fn swap_vertical_bar(&mut self) -> bool {
        let n = self.stack.len();
        if n >= 3
            && self.nodes[self.stack[n - 2] as usize].op == OP_VERTICAL_BAR
            && is_char_class(&self.nodes[self.stack[n - 1] as usize])
            && is_char_class(&self.nodes[self.stack[n - 3] as usize])
        {
            let mut re1 = self.stack[n - 1];
            let mut re3 = self.stack[n - 3];
            if self.nodes[re1 as usize].op > self.nodes[re3 as usize].op {
                std::mem::swap(&mut re1, &mut re3);
                self.stack[n - 3] = re3;
            }
            merge_char_class(&mut self.nodes, re3, re1);
            self.reuse(re1);
            self.stack.pop();
            return true;
        }
        if n >= 2 {
            let re1 = self.stack[n - 1];
            let re2 = self.stack[n - 2];
            if self.nodes[re2 as usize].op == OP_VERTICAL_BAR {
                if n >= 3 {
                    let re3 = self.stack[n - 3];
                    clean_alt(&mut self.nodes, re3);
                }
                self.stack[n - 2] = re1;
                self.stack[n - 1] = re2;
                return true;
            }
        }
        false
    }

    fn parse_right_paren(&mut self) -> Result<(), SyntaxError> {
        self.concat()?;
        if self.swap_vertical_bar() {
            self.stack.pop();
        }
        self.alternate()?;
        let n = self.stack.len();
        if n < 2 {
            return Err(SyntaxError::new(ERR_UNEXPECTED_PAREN, self.whole.clone()));
        }
        let re1 = self.stack.pop().unwrap();
        let re2 = self.stack.pop().unwrap();
        if self.nodes[re2 as usize].op != OP_LEFT_PAREN {
            return Err(SyntaxError::new(ERR_UNEXPECTED_PAREN, self.whole.clone()));
        }
        self.flags = self.nodes[re2 as usize].flags;
        if self.nodes[re2 as usize].cap == 0 {
            self.push(re1)?;
        } else {
            self.nodes[re2 as usize].op = OP_CAPTURE;
            self.nodes[re2 as usize].sub = vec![re1];
            self.push(re2)?;
        }
        Ok(())
    }
}

fn min_fold_rune(r: i32) -> i32 {
    if r < MIN_FOLD || r > MAX_FOLD {
        return r;
    }
    let mut m = r;
    let r0 = r;
    let mut cur = simple_fold(r);
    while cur != r0 {
        m = m.min(cur);
        cur = simple_fold(cur);
    }
    m
}

fn repeat_is_valid(nodes: &[Regexp], id: u32, mut n: i32) -> bool {
    let re = &nodes[id as usize];
    if re.op == OP_REPEAT {
        let mut m = re.max;
        if m == 0 {
            return true;
        }
        if m < 0 {
            m = re.min;
        }
        if m > n {
            return false;
        }
        if m > 0 {
            n /= m;
        }
    }
    for &sub in &re.sub {
        if !repeat_is_valid(nodes, sub, n) {
            return false;
        }
    }
    true
}

fn is_char_class(re: &Regexp) -> bool {
    (re.op == OP_LITERAL && re.rune.len() == 1)
        || re.op == OP_CHAR_CLASS
        || re.op == OP_ANY_CHAR_NOT_NL
        || re.op == OP_ANY_CHAR
}

fn match_rune(re: &Regexp, r: i32) -> bool {
    match re.op {
        OP_LITERAL => re.rune.len() == 1 && re.rune[0] == r,
        OP_CHAR_CLASS => {
            let mut i = 0;
            while i + 1 < re.rune.len() {
                if re.rune[i] <= r && r <= re.rune[i + 1] {
                    return true;
                }
                i += 2;
            }
            false
        }
        OP_ANY_CHAR_NOT_NL => r != '\n' as i32,
        OP_ANY_CHAR => true,
        _ => false,
    }
}

fn clean_alt(nodes: &mut [Regexp], id: u32) {
    if nodes[id as usize].op != OP_CHAR_CLASS {
        return;
    }
    nodes[id as usize].rune = clean_class(&nodes[id as usize].rune);
    let r = &nodes[id as usize].rune;
    if r.len() == 2 && r[0] == 0 && r[1] == MAX_RUNE {
        nodes[id as usize].rune.clear();
        nodes[id as usize].op = OP_ANY_CHAR;
        return;
    }
    if r.len() == 4 && r[0] == 0 && r[1] == ('\n' as i32) - 1 && r[2] == ('\n' as i32) + 1 && r[3] == MAX_RUNE {
        nodes[id as usize].rune.clear();
        nodes[id as usize].op = OP_ANY_CHAR_NOT_NL;
    }
}

fn merge_char_class(nodes: &mut [Regexp], dst: u32, src: u32) {
    let src_op = nodes[src as usize].op;
    let src_rune = nodes[src as usize].rune.clone();
    let src_flags = nodes[src as usize].flags;
    match nodes[dst as usize].op {
        OP_ANY_CHAR => {}
        OP_ANY_CHAR_NOT_NL => {
            if match_rune(&nodes[src as usize], '\n' as i32) {
                nodes[dst as usize].op = OP_ANY_CHAR;
            }
        }
        OP_CHAR_CLASS => {
            if src_op == OP_LITERAL {
                nodes[dst as usize].rune = append_literal(std::mem::take(&mut nodes[dst as usize].rune), src_rune[0], src_flags);
            } else {
                nodes[dst as usize].rune = append_class(std::mem::take(&mut nodes[dst as usize].rune), &src_rune);
            }
        }
        OP_LITERAL => {
            if src_rune[0] == nodes[dst as usize].rune[0] && src_flags == nodes[dst as usize].flags {
            } else {
                let dst_r = nodes[dst as usize].rune[0];
                let dst_f = nodes[dst as usize].flags;
                nodes[dst as usize].op = OP_CHAR_CLASS;
                let mut class = Vec::new();
                class = append_literal(class, dst_r, dst_f);
                class = append_literal(class, src_rune[0], src_flags);
                nodes[dst as usize].rune = class;
            }
        }
        _ => {}
    }
}

fn literal_regexp(s: &str, flags: u16) -> (Vec<Regexp>, u32) {
    let mut re = Regexp::new(OP_LITERAL);
    re.flags = flags;
    re.rune = s.chars().map(|c| c as i32).collect();
    (vec![re], 0)
}

pub fn parse(s: &str, flags: u16) -> Result<(Vec<Regexp>, u32), SyntaxError> {
    if flags & LITERAL != 0 {
        check_utf8(s)?;
        return Ok(literal_regexp(s, flags));
    }
    let mut p = Parser {
        flags,
        stack: Vec::new(),
        free: Vec::new(),
        nodes: Vec::new(),
        num_cap: 0,
        whole: s.to_string(),
        tmp_class: Vec::new(),
        num_regexp: 0,
        num_runes: 0,
        repeats: 0,
        height: None,
        size: None,
    };
    let mut t = s;
    let mut last_repeat = String::new();
    while !t.is_empty() {
        let mut repeat = String::new();
        let b0 = t.as_bytes()[0];
        match b0 {
            b'(' => {
                if p.flags & PERL_X != 0 && t.len() >= 2 && t.as_bytes()[1] == b'?' {
                    t = p.parse_perl_flags(t)?;
                } else {
                    p.num_cap += 1;
                    let id = p.op(OP_LEFT_PAREN)?;
                    p.nodes[id as usize].cap = p.num_cap;
                    t = &t[1..];
                }
            }
            b'|' => {
                p.parse_vertical_bar()?;
                t = &t[1..];
            }
            b')' => {
                p.parse_right_paren()?;
                t = &t[1..];
            }
            b'^' => {
                if p.flags & ONE_LINE != 0 {
                    p.op(OP_BEGIN_TEXT)?;
                } else {
                    p.op(OP_BEGIN_LINE)?;
                }
                t = &t[1..];
            }
            b'$' => {
                if p.flags & ONE_LINE != 0 {
                    let id = p.op(OP_END_TEXT)?;
                    p.nodes[id as usize].flags |= WAS_DOLLAR;
                } else {
                    p.op(OP_END_LINE)?;
                }
                t = &t[1..];
            }
            b'.' => {
                if p.flags & DOT_NL != 0 {
                    p.op(OP_ANY_CHAR)?;
                } else {
                    p.op(OP_ANY_CHAR_NOT_NL)?;
                }
                t = &t[1..];
            }
            b'[' => {
                t = p.parse_class(t)?;
            }
            b'*' | b'+' | b'?' => {
                let before = t;
                let op = match b0 {
                    b'*' => OP_STAR,
                    b'+' => OP_PLUS,
                    _ => OP_QUEST,
                };
                let after = t[1..].to_string();
                let after = p.repeat(op, 0, 0, before, after, &last_repeat)?;
                repeat = before.to_string();
                t = s_suffix(s, &after);
            }
            b'{' => {
                let before = t;
                if let Some((min, max, after_s)) = parse_repeat(t) {
                    if min < 0 || min > 1000 || max > 1000 || (max >= 0 && min > max) {
                        let expr = before[..before.len() - after_s.len()].to_string();
                        return Err(SyntaxError::new(ERR_INVALID_REPEAT_SIZE, expr));
                    }
                    let after = p.repeat(OP_REPEAT, min, max, before, after_s.to_string(), &last_repeat)?;
                    repeat = before.to_string();
                    t = s_suffix(s, &after);
                } else {
                    p.literal('{' as i32)?;
                    t = &t[1..];
                }
            }
            b'\\' => {
                t = p.parse_backslash(t)?;
            }
            _ => {
                let (c, rest) = next_rune(t)?;
                p.literal(c)?;
                t = rest;
            }
        }
        last_repeat = repeat;
    }
    p.concat()?;
    if p.swap_vertical_bar() {
        p.stack.pop();
    }
    p.alternate()?;
    if p.stack.len() != 1 {
        return Err(SyntaxError::new(ERR_MISSING_PAREN, s));
    }
    Ok((p.nodes, p.stack[0]))
}

fn s_suffix<'a>(s: &'a str, after: &str) -> &'a str {
    &s[s.len() - after.len()..]
}

impl Parser {
    fn parse_backslash<'a>(&mut self, t: &'a str) -> Result<&'a str, SyntaxError> {
        if self.flags & PERL_X != 0 && t.len() >= 2 {
            match t.as_bytes()[1] {
                b'A' => {
                    self.op(OP_BEGIN_TEXT)?;
                    return Ok(&t[2..]);
                }
                b'b' => {
                    self.op(OP_WORD_BOUNDARY)?;
                    return Ok(&t[2..]);
                }
                b'B' => {
                    self.op(OP_NO_WORD_BOUNDARY)?;
                    return Ok(&t[2..]);
                }
                b'C' => return Err(SyntaxError::new(ERR_INVALID_ESCAPE, t[..2].to_string())),
                b'Q' => {
                    let rest = &t[2..];
                    let (lit, after) = match rest.find(r"\E") {
                        Some(i) => (&rest[..i], &rest[i + 2..]),
                        None => (rest, ""),
                    };
                    let mut lit_s = lit;
                    while !lit_s.is_empty() {
                        let (c, rest) = next_rune(lit_s)?;
                        self.literal(c)?;
                        lit_s = rest;
                    }
                    return Ok(after);
                }
                b'z' => {
                    self.op(OP_END_TEXT)?;
                    return Ok(&t[2..]);
                }
                _ => {}
            }
        }
        let id = self.new_regexp(OP_CHAR_CLASS);
        self.nodes[id as usize].flags = self.flags;
        if t.len() >= 2 && (t.as_bytes()[1] == b'p' || t.as_bytes()[1] == b'P') {
            if let Some((r, rest)) = self.parse_unicode_class(t)? {
                self.nodes[id as usize].rune = r;
                self.push(id)?;
                return Ok(rest);
            }
        }
        if let Some((r, rest)) = self.parse_perl_class_escape(t) {
            self.nodes[id as usize].rune = r;
            self.push(id)?;
            return Ok(rest);
        }
        self.reuse(id);
        let (c, rest) = self.parse_escape(t)?;
        self.literal(c)?;
        Ok(rest)
    }

    fn parse_perl_flags<'a>(&mut self, s: &'a str) -> Result<&'a str, SyntaxError> {
        let t = s;
        let starts_with_p = t.len() > 4 && t.as_bytes()[2] == b'P' && t.as_bytes()[3] == b'<';
        let starts_with_name = t.len() > 3 && t.as_bytes()[2] == b'<';
        if starts_with_p || starts_with_name {
            let expr_start = if starts_with_name && !starts_with_p { 3 } else { 4 };
            let end = match t.find('>') {
                Some(e) => e,
                None => {
                    check_utf8(t)?;
                    return Err(SyntaxError::new(ERR_INVALID_NAMED_CAPTURE, s));
                }
            };
            let capture = &t[..end + 1];
            let name = &t[expr_start..end];
            check_utf8(name)?;
            if !is_valid_capture_name(name) {
                return Err(SyntaxError::new(ERR_INVALID_NAMED_CAPTURE, capture));
            }
            self.num_cap += 1;
            let id = self.op(OP_LEFT_PAREN)?;
            self.nodes[id as usize].cap = self.num_cap;
            self.nodes[id as usize].name = name.to_string();
            return Ok(&t[end + 1..]);
        }
        let mut t = &t[2..];
        let mut flags = self.flags;
        let mut sign = 1i32;
        let mut saw_flag = false;
        while !t.is_empty() {
            let (c, rest) = next_rune(t)?;
            t = rest;
            let ch = char::from_u32(c as u32).unwrap_or('\0');
            match ch {
                'i' => {
                    flags |= FOLD_CASE;
                    saw_flag = true;
                }
                'm' => {
                    flags &= !ONE_LINE;
                    saw_flag = true;
                }
                's' => {
                    flags |= DOT_NL;
                    saw_flag = true;
                }
                'U' => {
                    flags |= NON_GREEDY;
                    saw_flag = true;
                }
                '-' => {
                    if sign < 0 {
                        return Err(SyntaxError::new(ERR_INVALID_PERL_OP, s[..s.len() - t.len()].to_string()));
                    }
                    sign = -1;
                    flags = !flags;
                    saw_flag = false;
                }
                ':' | ')' => {
                    if sign < 0 {
                        if !saw_flag {
                            return Err(SyntaxError::new(ERR_INVALID_PERL_OP, s[..s.len() - t.len()].to_string()));
                        }
                        flags = !flags;
                    }
                    if ch == ':' {
                        self.op(OP_LEFT_PAREN)?;
                    }
                    self.flags = flags;
                    return Ok(t);
                }
                _ => {
                    return Err(SyntaxError::new(ERR_INVALID_PERL_OP, s[..s.len() - t.len()].to_string()));
                }
            }
        }
        Err(SyntaxError::new(ERR_INVALID_PERL_OP, s[..s.len() - t.len()].to_string()))
    }

    fn parse_escape<'a>(&self, s: &'a str) -> Result<(i32, &'a str), SyntaxError> {
        if s.len() < 2 {
            return Err(SyntaxError::new(ERR_TRAILING_BACKSLASH, ""));
        }
        let (c, mut t) = next_rune(&s[1..])?;
        let ch = char::from_u32(c as u32).unwrap_or('\0');
        match ch {
            _ if c < 0x80 && !isalnum(c) => Ok((c, t)),
            '1' | '2' | '3' | '4' | '5' | '6' | '7' => {
                if t.is_empty() || t.as_bytes()[0] < b'0' || t.as_bytes()[0] > b'7' {
                    return Err(SyntaxError::new(ERR_INVALID_ESCAPE, s[..s.len() - t.len()].to_string()));
                }
                let mut r = c - '0' as i32;
                for _ in 1..3 {
                    if t.is_empty() || t.as_bytes()[0] < b'0' || t.as_bytes()[0] > b'7' {
                        break;
                    }
                    r = r * 8 + (t.as_bytes()[0] as i32 - '0' as i32);
                    t = &t[1..];
                }
                Ok((r, t))
            }
            '0' => {
                let mut r = c - '0' as i32;
                for _ in 1..3 {
                    if t.is_empty() || t.as_bytes()[0] < b'0' || t.as_bytes()[0] > b'7' {
                        break;
                    }
                    r = r * 8 + (t.as_bytes()[0] as i32 - '0' as i32);
                    t = &t[1..];
                }
                Ok((r, t))
            }
            'x' => {
                if t.is_empty() {
                    return Err(SyntaxError::new(ERR_INVALID_ESCAPE, s[..s.len() - t.len()].to_string()));
                }
                let (c, rest) = next_rune(t)?;
                t = rest;
                if c == '{' as i32 {
                    let mut nhex = 0;
                    let mut r = 0i32;
                    loop {
                        if t.is_empty() {
                            return Err(SyntaxError::new(ERR_INVALID_ESCAPE, s[..s.len() - t.len()].to_string()));
                        }
                        let (c, rest) = next_rune(t)?;
                        t = rest;
                        if c == '}' as i32 {
                            break;
                        }
                        let v = unhex(c);
                        if v < 0 {
                            return Err(SyntaxError::new(ERR_INVALID_ESCAPE, s[..s.len() - t.len()].to_string()));
                        }
                        r = r * 16 + v;
                        if r > MAX_RUNE {
                            return Err(SyntaxError::new(ERR_INVALID_ESCAPE, s[..s.len() - t.len()].to_string()));
                        }
                        nhex += 1;
                    }
                    if nhex == 0 {
                        return Err(SyntaxError::new(ERR_INVALID_ESCAPE, s[..s.len() - t.len()].to_string()));
                    }
                    return Ok((r, t));
                }
                let x = unhex(c);
                let (c2, rest) = next_rune(t)?;
                t = rest;
                let y = unhex(c2);
                if x < 0 || y < 0 {
                    return Err(SyntaxError::new(ERR_INVALID_ESCAPE, s[..s.len() - t.len()].to_string()));
                }
                Ok((x * 16 + y, t))
            }
            'a' => Ok((0x07, t)),
            'f' => Ok((0x0c, t)),
            'n' => Ok(('\n' as i32, t)),
            'r' => Ok(('\r' as i32, t)),
            't' => Ok(('\t' as i32, t)),
            'v' => Ok((0x0b, t)),
            _ => Err(SyntaxError::new(ERR_INVALID_ESCAPE, s[..s.len() - t.len()].to_string())),
        }
    }

    fn parse_class_char<'a>(&self, s: &'a str, whole: &str) -> Result<(i32, &'a str), SyntaxError> {
        if s.is_empty() {
            return Err(SyntaxError::new(ERR_MISSING_BRACKET, whole));
        }
        if s.as_bytes()[0] == b'\\' {
            return self.parse_escape(s);
        }
        next_rune(s)
    }

    fn parse_perl_class_escape<'a>(&mut self, s: &'a str) -> Option<(Vec<i32>, &'a str)> {
        if self.flags & PERL_X == 0 || s.len() < 2 || s.as_bytes()[0] != b'\\' || !s.is_char_boundary(2) {
            return None;
        }
        let g = perl_group(&s[..2])?;
        Some((self.append_group(Vec::new(), g), &s[2..]))
    }

    fn parse_named_class<'a>(&mut self, s: &'a str, r: Vec<i32>) -> Result<Option<(Vec<i32>, &'a str)>, SyntaxError> {
        if s.len() < 2 || s.as_bytes()[0] != b'[' || s.as_bytes()[1] != b':' {
            return Ok(None);
        }
        let rest = &s[2..];
        let i = match rest.find(":]") {
            Some(i) => i,
            None => return Ok(None),
        };
        let end = 2 + i + 2;
        let name = &s[..end];
        let srest = &s[end..];
        let g = posix_group(name).ok_or_else(|| SyntaxError::new(ERR_INVALID_CHAR_RANGE, name))?;
        Ok(Some((self.append_group(r, g), srest)))
    }

    fn append_group(&mut self, mut r: Vec<i32>, g: CharGroup) -> Vec<i32> {
        if self.flags & FOLD_CASE == 0 {
            if g.sign < 0 {
                append_negated_class(r, g.class)
            } else {
                append_class(r, g.class)
            }
        } else {
            self.tmp_class.clear();
            self.tmp_class = append_folded_class(std::mem::take(&mut self.tmp_class), g.class);
            self.tmp_class = clean_class(&self.tmp_class);
            let tmp = self.tmp_class.clone();
            if g.sign < 0 {
                append_negated_class(r, &tmp)
            } else {
                append_class(r, &tmp)
            }
        }
    }

    fn parse_unicode_class<'a>(&mut self, s: &'a str) -> Result<Option<(Vec<i32>, &'a str)>, SyntaxError> {
        if self.flags & UNICODE_GROUPS == 0 || s.len() < 2 || s.as_bytes()[0] != b'\\' || (s.as_bytes()[1] != b'p' && s.as_bytes()[1] != b'P')
        {
            return Ok(None);
        }
        let mut sign = 1i32;
        if s.as_bytes()[1] == b'P' {
            sign = -1;
        }
        let mut t = &s[2..];
        let (c, rest) = next_rune(t)?;
        t = rest;
        let seq;
        let mut name;
        if c != '{' as i32 {
            seq = &s[..s.len() - t.len()];
            name = &seq[2..];
        } else {
            let end = match s.find('}') {
                Some(e) => e,
                None => {
                    check_utf8(s)?;
                    return Err(SyntaxError::new(ERR_INVALID_CHAR_RANGE, s));
                }
            };
            seq = &s[..end + 1];
            t = &s[end + 1..];
            name = &s[3..end];
            check_utf8(name)?;
        }
        if !name.is_empty() && name.as_bytes()[0] == b'^' {
            sign = -sign;
            name = &name[1..];
        }
        let Some((tab, fold)) = unicode_table(name) else {
            return Err(SyntaxError::new(ERR_INVALID_CHAR_RANGE, seq));
        };
        let r = if self.flags & FOLD_CASE == 0 || fold.is_none() {
            if sign > 0 {
                append_table(Vec::new(), tab)
            } else {
                append_negated_table(Vec::new(), tab)
            }
        } else {
            self.tmp_class.clear();
            self.tmp_class = append_table(std::mem::take(&mut self.tmp_class), tab);
            if let Some(fold_tab) = fold {
                self.tmp_class = append_table(std::mem::take(&mut self.tmp_class), fold_tab);
            }
            self.tmp_class = clean_class(&self.tmp_class);
            let tmp = self.tmp_class.clone();
            if sign > 0 {
                append_class(Vec::new(), &tmp)
            } else {
                append_negated_class(Vec::new(), &tmp)
            }
        };
        Ok(Some((r, t)))
    }

    fn parse_class<'a>(&mut self, s: &'a str) -> Result<&'a str, SyntaxError> {
        let mut t = &s[1..];
        let id = self.new_regexp(OP_CHAR_CLASS);
        self.nodes[id as usize].flags = self.flags;
        let mut sign = 1i32;
        if !t.is_empty() && t.as_bytes()[0] == b'^' {
            sign = -1;
            t = &t[1..];
            if self.flags & CLASS_NL == 0 {
                self.nodes[id as usize].rune.extend_from_slice(&['\n' as i32, '\n' as i32]);
            }
        }
        let mut class = std::mem::take(&mut self.nodes[id as usize].rune);
        let mut first = true;
        while t.is_empty() || t.as_bytes()[0] != b']' || first {
            if !t.is_empty() && t.as_bytes()[0] == b'-' && self.flags & PERL_X == 0 && !first && (t.len() == 1 || t.as_bytes()[1] != b']')
            {
                let size = t[1..].chars().next().map(|c| c.len_utf8()).unwrap_or(0);
                return Err(SyntaxError::new(ERR_INVALID_CHAR_RANGE, t[..1 + size].to_string()));
            }
            first = false;
            if t.len() > 2 && t.as_bytes()[0] == b'[' && t.as_bytes()[1] == b':' {
                if let Some((nclass, nt)) = self.parse_named_class(t, class.clone())? {
                    class = nclass;
                    t = nt;
                    continue;
                }
            }
            match self.parse_unicode_class(t) {
                Ok(Some((nclass, nt))) => {
                    class = append_class(class, &nclass);
                    t = nt;
                    continue;
                }
                Ok(None) => {}
                Err(e) => {
                    if t.len() >= 2 && (t.as_bytes().starts_with(br"\p") || t.as_bytes().starts_with(br"\P")) {
                        return Err(e);
                    }
                }
            }
            if t.len() >= 2 && t.is_char_boundary(2) && perl_group(&t[..2]).is_some() {
                if let Some((_, nt)) = self.parse_perl_class_escape(t) {
                    let g = perl_group(&t[..2]).unwrap();
                    class = self.append_group(class, g);
                    t = nt;
                    continue;
                }
            }
            let rng = t;
            let (lo, rest) = self.parse_class_char(t, s)?;
            t = rest;
            let mut hi = lo;
            if t.len() >= 2 && t.as_bytes()[0] == b'-' && t.as_bytes()[1] != b']' {
                t = &t[1..];
                let (h, rest) = self.parse_class_char(t, s)?;
                hi = h;
                t = rest;
                if hi < lo {
                    let expr = &rng[..rng.len() - t.len()];
                    return Err(SyntaxError::new(ERR_INVALID_CHAR_RANGE, expr));
                }
            }
            if self.flags & FOLD_CASE == 0 {
                class = append_range(class, lo, hi);
            } else {
                class = append_folded_range(class, lo, hi);
            }
        }
        t = &t[1..];
        class = clean_class(&class);
        if sign < 0 {
            class = negate_class(class);
        }
        self.nodes[id as usize].rune = class;
        self.push(id)?;
        Ok(t)
    }
}

fn parse_repeat(s: &str) -> Option<(i32, i32, &str)> {
    if s.is_empty() || s.as_bytes()[0] != b'{' {
        return None;
    }
    let mut s = &s[1..];
    let (mut min, rest) = parse_int(s)?;
    s = rest;
    if s.is_empty() {
        return None;
    }
    let max;
    if s.as_bytes()[0] != b',' {
        max = min;
    } else {
        s = &s[1..];
        if s.is_empty() {
            return None;
        }
        if s.as_bytes()[0] == b'}' {
            max = -1;
        } else {
            let (m, rest) = parse_int(s)?;
            s = rest;
            if m < 0 {
                min = -1;
            }
            max = m;
        }
    }
    if s.is_empty() || s.as_bytes()[0] != b'}' {
        return None;
    }
    Some((min, max, &s[1..]))
}

fn parse_int(s: &str) -> Option<(i32, &str)> {
    if s.is_empty() || s.as_bytes()[0] < b'0' || s.as_bytes()[0] > b'9' {
        return None;
    }
    if s.len() >= 2 && s.as_bytes()[0] == b'0' && s.as_bytes()[1] >= b'0' && s.as_bytes()[1] <= b'9' {
        return None;
    }
    let mut i = 0;
    while i < s.len() && s.as_bytes()[i] >= b'0' && s.as_bytes()[i] <= b'9' {
        i += 1;
    }
    let digits = &s[..i];
    let rest = &s[i..];
    let mut n: i32 = 0;
    for b in digits.bytes() {
        if n >= 100_000_000 {
            return Some((-1, rest));
        }
        n = n * 10 + (b - b'0') as i32;
    }
    Some((n, rest))
}

fn is_valid_capture_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    name.chars().all(|c| c == '_' || isalnum(c as i32))
}

fn check_utf8(s: &str) -> Result<(), SyntaxError> {
    if s.is_char_boundary(s.len()) && s.chars().all(|_| true) {
        // Rust strings are valid UTF-8. Go still rejects invalid UTF-8 bytes;
        // those cannot appear in a Rust &str.
        return Ok(());
    }
    Err(SyntaxError::new(ERR_INVALID_UTF8, s))
}

fn next_rune(s: &str) -> Result<(i32, &str), SyntaxError> {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => Ok((c as i32, chars.as_str())),
        None => Err(SyntaxError::new(ERR_INVALID_UTF8, s)),
    }
}

fn isalnum(c: i32) -> bool {
    (c >= '0' as i32 && c <= '9' as i32) || (c >= 'A' as i32 && c <= 'Z' as i32) || (c >= 'a' as i32 && c <= 'z' as i32)
}

fn unhex(c: i32) -> i32 {
    if c >= '0' as i32 && c <= '9' as i32 {
        c - '0' as i32
    } else if c >= 'a' as i32 && c <= 'f' as i32 {
        c - 'a' as i32 + 10
    } else if c >= 'A' as i32 && c <= 'F' as i32 {
        c - 'A' as i32 + 10
    } else {
        -1
    }
}

fn clean_class(r: &[i32]) -> Vec<i32> {
    if r.len() < 2 {
        return r.to_vec();
    }
    let mut pairs: Vec<(i32, i32)> = r.chunks(2).filter(|c| c.len() == 2).map(|c| (c[0], c[1])).collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    let mut out = vec![pairs[0].0, pairs[0].1];
    for &(lo, hi) in &pairs[1..] {
        let last = *out.last().unwrap();
        if lo <= last + 1 {
            if hi > last {
                *out.last_mut().unwrap() = hi;
            }
        } else {
            out.push(lo);
            out.push(hi);
        }
    }
    out
}

fn append_literal(r: Vec<i32>, x: i32, flags: u16) -> Vec<i32> {
    if flags & FOLD_CASE != 0 {
        append_folded_range(r, x, x)
    } else {
        append_range(r, x, x)
    }
}

fn append_range(mut r: Vec<i32>, lo: i32, hi: i32) -> Vec<i32> {
    let n = r.len();
    let mut i = 2;
    while i <= 4 {
        if n >= i {
            let rlo = r[n - i];
            let rhi = r[n - i + 1];
            if lo <= rhi + 1 && rlo <= hi + 1 {
                if lo < rlo {
                    r[n - i] = lo;
                }
                if hi > rhi {
                    r[n - i + 1] = hi;
                }
                return r;
            }
        }
        i += 2;
    }
    r.push(lo);
    r.push(hi);
    r
}

fn append_folded_range(mut r: Vec<i32>, mut lo: i32, mut hi: i32) -> Vec<i32> {
    if lo <= MIN_FOLD && hi >= MAX_FOLD {
        return append_range(r, lo, hi);
    }
    if hi < MIN_FOLD || lo > MAX_FOLD {
        return append_range(r, lo, hi);
    }
    if lo < MIN_FOLD {
        r = append_range(r, lo, MIN_FOLD - 1);
        lo = MIN_FOLD;
    }
    if hi > MAX_FOLD {
        r = append_range(r, MAX_FOLD + 1, hi);
        hi = MAX_FOLD;
    }
    let mut c = lo;
    while c <= hi {
        r = append_range(r, c, c);
        let mut f = simple_fold(c);
        while f != c {
            r = append_range(r, f, f);
            f = simple_fold(f);
        }
        c += 1;
    }
    r
}

fn append_table(mut r: Vec<i32>, x: &RangeTable) -> Vec<i32> {
    for xr in x.r16 {
        let lo = xr.lo as i32;
        let hi = xr.hi as i32;
        let stride = xr.stride as i32;
        if stride == 1 {
            r = append_range(r, lo, hi);
        } else {
            let mut c = lo;
            while c <= hi {
                r = append_range(r, c, c);
                c += stride;
            }
        }
    }
    for xr in x.r32 {
        let lo = xr.lo as i32;
        let hi = xr.hi as i32;
        let stride = xr.stride as i32;
        if stride == 1 {
            r = append_range(r, lo, hi);
        } else {
            let mut c = lo;
            while c <= hi {
                r = append_range(r, c, c);
                c += stride;
            }
        }
    }
    r
}

fn append_negated_table(mut r: Vec<i32>, x: &RangeTable) -> Vec<i32> {
    let mut next_lo = 0i32;
    for xr in x.r16 {
        let lo = xr.lo as i32;
        let hi = xr.hi as i32;
        let stride = xr.stride as i32;
        if stride == 1 {
            if next_lo <= lo - 1 {
                r = append_range(r, next_lo, lo - 1);
            }
            next_lo = hi + 1;
        } else {
            let mut c = lo;
            while c <= hi {
                if next_lo <= c - 1 {
                    r = append_range(r, next_lo, c - 1);
                }
                next_lo = c + 1;
                c += stride;
            }
        }
    }
    for xr in x.r32 {
        let lo = xr.lo as i32;
        let hi = xr.hi as i32;
        let stride = xr.stride as i32;
        if stride == 1 {
            if next_lo <= lo - 1 {
                r = append_range(r, next_lo, lo - 1);
            }
            next_lo = hi + 1;
        } else {
            let mut c = lo;
            while c <= hi {
                if next_lo <= c - 1 {
                    r = append_range(r, next_lo, c - 1);
                }
                next_lo = c + 1;
                c += stride;
            }
        }
    }
    if next_lo <= MAX_RUNE {
        r = append_range(r, next_lo, MAX_RUNE);
    }
    r
}

fn append_class(mut r: Vec<i32>, x: &[i32]) -> Vec<i32> {
    let mut i = 0;
    while i + 1 < x.len() {
        r = append_range(r, x[i], x[i + 1]);
        i += 2;
    }
    r
}

fn append_folded_class(mut r: Vec<i32>, x: &[i32]) -> Vec<i32> {
    let mut i = 0;
    while i + 1 < x.len() {
        r = append_folded_range(r, x[i], x[i + 1]);
        i += 2;
    }
    r
}

fn append_negated_class(mut r: Vec<i32>, x: &[i32]) -> Vec<i32> {
    let mut next_lo = 0i32;
    let mut i = 0;
    while i + 1 < x.len() {
        let lo = x[i];
        let hi = x[i + 1];
        if next_lo <= lo - 1 {
            r = append_range(r, next_lo, lo - 1);
        }
        next_lo = hi + 1;
        i += 2;
    }
    if next_lo <= MAX_RUNE {
        r = append_range(r, next_lo, MAX_RUNE);
    }
    r
}

fn negate_class(r: Vec<i32>) -> Vec<i32> {
    let mut next_lo = 0i32;
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < r.len() {
        let lo = r[i];
        let hi = r[i + 1];
        if next_lo <= lo - 1 {
            out.push(next_lo);
            out.push(lo - 1);
        }
        next_lo = hi + 1;
        i += 2;
    }
    if next_lo <= MAX_RUNE {
        out.push(next_lo);
        out.push(MAX_RUNE);
    }
    out
}
