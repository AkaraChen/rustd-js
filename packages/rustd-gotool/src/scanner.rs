use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::fileset::{path_clean, path_is_abs, path_join, path_split, GoFile};
use crate::token;
use crate::unicode_go::{decode_rune, is_digit as uni_digit, is_letter as uni_letter, BOM, RUNE_SELF};

pub const SCAN_COMMENTS: u32 = 1;
const DONT_INSERT_SEMIS: u32 = 2;
const EOF: i32 = -1;
const MAX_LINE_COL: u32 = 1 << 30;

#[napi(object)]
#[derive(Clone, Default)]
pub struct NativeScanError {
    pub filename: String,
    pub offset: i64,
    pub line: i64,
    pub column: i64,
    pub msg: String,
}

#[napi(object)]
#[derive(Clone, Default)]
pub struct NativeScanStep {
    pub pos: i64,
    pub tok: i32,
    pub lit: String,
    pub errors: Vec<NativeScanError>,
}

pub struct ScannerState {
    file: GoFile,
    dir: String,
    src: Vec<u8>,
    mode: u32,
    ch: i32,
    offset: usize,
    rd_offset: usize,
    line_offset: usize,
    insert_semi: bool,
    nl_pos: i32,
    error_count: i32,
    pending: Vec<NativeScanError>,
}

#[napi]
pub struct Scanner {
    state: ScannerState,
}

#[napi]
impl Scanner {
    #[napi(constructor)]
    pub fn new(file: &GoFile, src: Uint8Array, mode: u32) -> Result<Self> {
        let mut s = Self {
            state: ScannerState {
                file: file.clone_handle(),
                dir: String::new(),
                src: Vec::new(),
                mode: 0,
                ch: b' ' as i32,
                offset: 0,
                rd_offset: 0,
                line_offset: 0,
                insert_semi: false,
                nl_pos: 0,
                error_count: 0,
                pending: Vec::new(),
            },
        };
        s.state.init(file, src.as_ref(), mode)?;
        Ok(s)
    }

    #[napi]
    pub fn init(&mut self, file: &GoFile, src: Uint8Array, mode: u32) -> Result<()> {
        self.state.init(file, src.as_ref(), mode)
    }

    #[napi(getter)]
    pub fn error_count(&self) -> i32 {
        self.state.error_count
    }

    #[napi]
    pub fn error(&mut self, pos: i64, msg: String) -> Result<()> {
        let offs = self.state.file.offset_of(pos.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32)?;
        self.state.report(offs.max(0) as usize, &msg)?;
        Ok(())
    }

    #[napi]
    pub fn scan(&mut self) -> Result<NativeScanStep> {
        self.state.scan()
    }
}

impl ScannerState {
    pub(crate) fn new(file: &GoFile, src: &[u8], mode: u32) -> Result<Self> {
        let mut s = Self {
            file: file.clone_handle(),
            dir: String::new(),
            src: Vec::new(),
            mode: 0,
            ch: b' ' as i32,
            offset: 0,
            rd_offset: 0,
            line_offset: 0,
            insert_semi: false,
            nl_pos: 0,
            error_count: 0,
            pending: Vec::new(),
        };
        s.init(file, src, mode)?;
        Ok(s)
    }

    pub(crate) fn init(&mut self, file: &GoFile, src: &[u8], mode: u32) -> Result<()> {
        let size = file.inner_size()?;
        if size as usize != src.len() {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "gotool: file size ({size}) does not match src len ({})",
                    src.len()
                ),
            ));
        }
        let name = file.inner_name()?;
        let (dir, _) = path_split(&name);
        self.file = file.clone_handle();
        self.dir = dir;
        self.src = src.to_vec();
        self.mode = mode;
        self.ch = b' ' as i32;
        self.offset = 0;
        self.rd_offset = 0;
        self.line_offset = 0;
        self.insert_semi = false;
        self.nl_pos = 0;
        self.error_count = 0;
        self.pending.clear();
        let mut errs = Vec::new();
        self.next(&mut errs)?;
        if self.ch == BOM {
            self.next(&mut errs)?;
        }
        self.pending = errs;
        Ok(())
    }

    fn next(&mut self, errs: &mut Vec<NativeScanError>) -> Result<()> {
        if self.rd_offset < self.src.len() {
            self.offset = self.rd_offset;
            if self.ch == i32::from(b'\n') {
                self.line_offset = self.offset;
                self.file.add_line_offset(self.offset as i32)?;
            }
            let mut r = i32::from(self.src[self.rd_offset]);
            let mut w = 1usize;
            if r == 0 {
                self.report_into(errs, self.offset, "illegal character NUL")?;
            } else if r >= RUNE_SELF {
                let (rr, ww) = decode_rune(&self.src[self.rd_offset..]);
                r = rr;
                w = ww;
                if r == crate::unicode_go::RUNE_ERROR && w == 1 {
                    self.report_into(errs, self.offset, "illegal UTF-8 encoding")?;
                } else if r == BOM && self.offset > 0 {
                    self.report_into(errs, self.offset, "illegal byte order mark")?;
                }
            }
            self.rd_offset += w;
            self.ch = r;
        } else {
            self.offset = self.src.len();
            if self.ch == i32::from(b'\n') {
                self.line_offset = self.offset;
                self.file.add_line_offset(self.offset as i32)?;
            }
            self.ch = EOF;
        }
        Ok(())
    }

    fn peek(&self) -> u8 {
        if self.rd_offset < self.src.len() {
            self.src[self.rd_offset]
        } else {
            0
        }
    }

    fn report(&mut self, offs: usize, msg: &str) -> Result<()> {
        let mut errs = Vec::new();
        self.report_into(&mut errs, offs, msg)?;
        let _ = errs;
        Ok(())
    }

    fn report_into(
        &mut self,
        errs: &mut Vec<NativeScanError>,
        offs: usize,
        msg: &str,
    ) -> Result<()> {
        let pos = self.file.pos_of(offs as i32)?;
        let p = self.file.position_of(pos, true)?;
        errs.push(NativeScanError {
            filename: p.filename,
            offset: p.offset,
            line: p.line,
            column: p.column,
            msg: msg.to_string(),
        });
        self.error_count += 1;
        Ok(())
    }

    pub(crate) fn scan(&mut self) -> Result<NativeScanStep> {
        let mut errs = std::mem::take(&mut self.pending);
        loop {
            if self.nl_pos != 0 {
                let pos = self.nl_pos;
                self.nl_pos = 0;
                return Ok(NativeScanStep {
                    pos: i64::from(pos),
                    tok: token::SEMICOLON,
                    lit: "\n".into(),
                    errors: errs,
                });
            }
            self.skip_whitespace(&mut errs)?;
            let pos = self.file.pos_of(self.offset as i32)?;
            let mut insert_semi = false;
            let ch = self.ch;
            let (tok, lit) = if is_letter(ch) {
                let lit = self.scan_identifier(&mut errs)?;
                let tok = if lit.len() > 1 {
                    let tok = token::lookup(&lit);
                    match tok {
                        token::IDENT | token::BREAK | token::CONTINUE | token::FALLTHROUGH
                        | token::RETURN => {
                            insert_semi = true;
                        }
                        _ => {}
                    }
                    tok
                } else {
                    insert_semi = true;
                    token::IDENT
                };
                (tok, lit)
            } else if is_decimal(ch) || (ch == i32::from(b'.') && is_decimal(i32::from(self.peek())))
            {
                insert_semi = true;
                self.scan_number(&mut errs)?
            } else {
                self.next(&mut errs)?;
                match ch {
                    EOF => {
                        if self.insert_semi {
                            self.insert_semi = false;
                            return Ok(NativeScanStep {
                                pos: i64::from(pos),
                                tok: token::SEMICOLON,
                                lit: "\n".into(),
                                errors: errs,
                            });
                        }
                        (token::EOF, String::new())
                    }
                    0x0A => {
                        self.insert_semi = false;
                        return Ok(NativeScanStep {
                            pos: i64::from(pos),
                            tok: token::SEMICOLON,
                            lit: "\n".into(),
                            errors: errs,
                        });
                    }
                    0x22 => {
                        insert_semi = true;
                        (token::STRING, self.scan_string(&mut errs)?)
                    }
                    0x27 => {
                        insert_semi = true;
                        (token::CHAR, self.scan_rune(&mut errs)?)
                    }
                    0x60 => {
                        insert_semi = true;
                        (token::STRING, self.scan_raw_string(&mut errs)?)
                    }
                    0x3A => (self.switch2(&mut errs, token::COLON, token::DEFINE)?, String::new()),
                    0x2E => {
                        let mut tok = token::PERIOD;
                        if self.ch == i32::from(b'.') && self.peek() == b'.' {
                            self.next(&mut errs)?;
                            self.next(&mut errs)?;
                            tok = token::ELLIPSIS;
                        }
                        (tok, String::new())
                    }
                    0x2C => (token::COMMA, String::new()),
                    0x3B => (token::SEMICOLON, ";".into()),
                    0x28 => (token::LPAREN, String::new()),
                    0x29 => {
                        insert_semi = true;
                        (token::RPAREN, String::new())
                    }
                    0x5B => (token::LBRACK, String::new()),
                    0x5D => {
                        insert_semi = true;
                        (token::RBRACK, String::new())
                    }
                    0x7B => (token::LBRACE, String::new()),
                    0x7D => {
                        insert_semi = true;
                        (token::RBRACE, String::new())
                    }
                    0x2B => {
                        let tok = self.switch3(&mut errs, token::ADD, token::ADD_ASSIGN, '+' as i32, token::INC)?;
                        if tok == token::INC {
                            insert_semi = true;
                        }
                        (tok, String::new())
                    }
                    0x2D => {
                        let tok = self.switch3(&mut errs, token::SUB, token::SUB_ASSIGN, '-' as i32, token::DEC)?;
                        if tok == token::DEC {
                            insert_semi = true;
                        }
                        (tok, String::new())
                    }
                    0x2A => (self.switch2(&mut errs, token::MUL, token::MUL_ASSIGN)?, String::new()),
                    0x2F => {
                        if self.ch == i32::from(b'/') || self.ch == i32::from(b'*') {
                            let (comment, nl_offset) = self.scan_comment(&mut errs)?;
                            if self.insert_semi && nl_offset != 0 {
                                self.nl_pos = self.file.pos_of(nl_offset as i32)?;
                                self.insert_semi = false;
                            } else {
                                insert_semi = self.insert_semi;
                            }
                            if self.mode & SCAN_COMMENTS == 0 {
                                if self.mode & DONT_INSERT_SEMIS == 0 {
                                    self.insert_semi = insert_semi;
                                }
                                continue;
                            }
                            (token::COMMENT, comment)
                        } else {
                            (self.switch2(&mut errs, token::QUO, token::QUO_ASSIGN)?, String::new())
                        }
                    }
                    0x25 => (self.switch2(&mut errs, token::REM, token::REM_ASSIGN)?, String::new()),
                    0x5E => (self.switch2(&mut errs, token::XOR, token::XOR_ASSIGN)?, String::new()),
                    0x3C => {
                        if self.ch == i32::from(b'-') {
                            self.next(&mut errs)?;
                            (token::ARROW, String::new())
                        } else {
                            (
                                self.switch4(
                                    &mut errs,
                                    token::LSS,
                                    token::LEQ,
                                    '<' as i32,
                                    token::SHL,
                                    token::SHL_ASSIGN,
                                )?,
                                String::new(),
                            )
                        }
                    }
                    0x3E => (
                        self.switch4(
                            &mut errs,
                            token::GTR,
                            token::GEQ,
                            '>' as i32,
                            token::SHR,
                            token::SHR_ASSIGN,
                        )?,
                        String::new(),
                    ),
                    0x3D => (self.switch2(&mut errs, token::ASSIGN, token::EQL)?, String::new()),
                    0x21 => (self.switch2(&mut errs, token::NOT, token::NEQ)?, String::new()),
                    0x26 => {
                        if self.ch == i32::from(b'^') {
                            self.next(&mut errs)?;
                            (
                                self.switch2(&mut errs, token::AND_NOT, token::AND_NOT_ASSIGN)?,
                                String::new(),
                            )
                        } else {
                            (
                                self.switch3(
                                    &mut errs,
                                    token::AND,
                                    token::AND_ASSIGN,
                                    '&' as i32,
                                    token::LAND,
                                )?,
                                String::new(),
                            )
                        }
                    }
                    0x7C => (
                        self.switch3(&mut errs, token::OR, token::OR_ASSIGN, '|' as i32, token::LOR)?,
                        String::new(),
                    ),
                    0x7E => (token::TILDE, String::new()),
                    _ => {
                        if ch != BOM {
                            let offs = self.file.offset_of(pos)? as usize;
                            if ch == 0x201C || ch == 0x201D {
                                self.report_into(
                                    &mut errs,
                                    offs,
                                    &format!(
                                        "curly quotation mark {} (use neutral {})",
                                        go_quote_rune(ch),
                                        go_quote_rune('"' as i32)
                                    ),
                                )?;
                            } else {
                                self.report_into(
                                    &mut errs,
                                    offs,
                                    &format!("illegal character {}", go_hash_u(ch)),
                                )?;
                            }
                        }
                        insert_semi = self.insert_semi;
                        (token::ILLEGAL, rune_lit(ch))
                    }
                }
            };
            if self.mode & DONT_INSERT_SEMIS == 0 {
                self.insert_semi = insert_semi;
            }
            return Ok(NativeScanStep {
                pos: i64::from(pos),
                tok,
                lit,
                errors: errs,
            });
        }
    }

    fn skip_whitespace(&mut self, errs: &mut Vec<NativeScanError>) -> Result<()> {
        while self.ch == i32::from(b' ')
            || self.ch == i32::from(b'\t')
            || (self.ch == i32::from(b'\n') && !self.insert_semi)
            || self.ch == i32::from(b'\r')
        {
            self.next(errs)?;
        }
        Ok(())
    }

    fn switch2(
        &mut self,
        errs: &mut Vec<NativeScanError>,
        tok0: i32,
        tok1: i32,
    ) -> Result<i32> {
        if self.ch == i32::from(b'=') {
            self.next(errs)?;
            Ok(tok1)
        } else {
            Ok(tok0)
        }
    }

    fn switch3(
        &mut self,
        errs: &mut Vec<NativeScanError>,
        tok0: i32,
        tok1: i32,
        ch2: i32,
        tok2: i32,
    ) -> Result<i32> {
        if self.ch == i32::from(b'=') {
            self.next(errs)?;
            Ok(tok1)
        } else if self.ch == ch2 {
            self.next(errs)?;
            Ok(tok2)
        } else {
            Ok(tok0)
        }
    }

    fn switch4(
        &mut self,
        errs: &mut Vec<NativeScanError>,
        tok0: i32,
        tok1: i32,
        ch2: i32,
        tok2: i32,
        tok3: i32,
    ) -> Result<i32> {
        if self.ch == i32::from(b'=') {
            self.next(errs)?;
            Ok(tok1)
        } else if self.ch == ch2 {
            self.next(errs)?;
            if self.ch == i32::from(b'=') {
                self.next(errs)?;
                Ok(tok3)
            } else {
                Ok(tok2)
            }
        } else {
            Ok(tok0)
        }
    }

    fn scan_identifier(&mut self, errs: &mut Vec<NativeScanError>) -> Result<String> {
        let offs = self.offset;
        let rest = &self.src[self.rd_offset..];
        for (rd_offset, b) in rest.iter().copied().enumerate() {
            if b.is_ascii_alphanumeric() || b == b'_' {
                continue;
            }
            self.rd_offset += rd_offset;
            if b > 0 && (b as i32) < RUNE_SELF {
                self.ch = i32::from(b);
                self.offset = self.rd_offset;
                self.rd_offset += 1;
                return Ok(slice_to_string(&self.src[offs..self.offset]));
            }
            self.next(errs)?;
            while is_letter(self.ch) || is_digit(self.ch) {
                self.next(errs)?;
            }
            return Ok(slice_to_string(&self.src[offs..self.offset]));
        }
        self.offset = self.src.len();
        self.rd_offset = self.src.len();
        self.ch = EOF;
        Ok(slice_to_string(&self.src[offs..self.offset]))
    }

    fn digits(
        &mut self,
        errs: &mut Vec<NativeScanError>,
        base: i32,
        mut invalid: Option<&mut i32>,
    ) -> Result<i32> {
        let mut digsep = 0i32;
        if base <= 10 {
            let max = i32::from(b'0') + base;
            while is_decimal(self.ch) || self.ch == i32::from(b'_') {
                let mut ds = 1;
                if self.ch == i32::from(b'_') {
                    ds = 2;
                } else if self.ch >= max {
                    if let Some(slot) = invalid.as_deref_mut() {
                        if *slot < 0 {
                            *slot = self.offset as i32;
                        }
                    }
                }
                digsep |= ds;
                self.next(errs)?;
            }
        } else {
            while is_hex(self.ch) || self.ch == i32::from(b'_') {
                let ds = if self.ch == i32::from(b'_') { 2 } else { 1 };
                digsep |= ds;
                self.next(errs)?;
            }
        }
        Ok(digsep)
    }

    fn scan_number(&mut self, errs: &mut Vec<NativeScanError>) -> Result<(i32, String)> {
        let offs = self.offset;
        let mut tok = token::ILLEGAL;
        let mut base = 10i32;
        let mut prefix = 0i32;
        let mut digsep = 0i32;
        let mut invalid = -1i32;

        if self.ch != i32::from(b'.') {
            tok = token::INT;
            if self.ch == i32::from(b'0') {
                self.next(errs)?;
                match lower(self.ch) {
                    0x78 => {
                        self.next(errs)?;
                        base = 16;
                        prefix = 'x' as i32;
                    }
                    0x6F => {
                        self.next(errs)?;
                        base = 8;
                        prefix = 'o' as i32;
                    }
                    0x62 => {
                        self.next(errs)?;
                        base = 2;
                        prefix = 'b' as i32;
                    }
                    _ => {
                        base = 8;
                        prefix = '0' as i32;
                        digsep = 1;
                    }
                }
            }
            digsep |= self.digits(errs, base, Some(&mut invalid))?;
        }

        if self.ch == i32::from(b'.') {
            tok = token::FLOAT;
            if prefix == 'o' as i32 || prefix == 'b' as i32 {
                self.report_into(
                    errs,
                    self.offset,
                    &format!("invalid radix point in {}", litname(prefix)),
                )?;
            }
            self.next(errs)?;
            digsep |= self.digits(errs, base, Some(&mut invalid))?;
        }

        if digsep & 1 == 0 {
            self.report_into(
                errs,
                self.offset,
                &format!("{} has no digits", litname(prefix)),
            )?;
        }

        let e = lower(self.ch);
        if e == 'e' as i32 || e == 'p' as i32 {
            if e == 'e' as i32 && prefix != 0 && prefix != '0' as i32 {
                self.report_into(
                    errs,
                    self.offset,
                    &format!("{:?} exponent requires decimal mantissa", rune_lit(self.ch)),
                )?;
            } else if e == 'p' as i32 && prefix != 'x' as i32 {
                self.report_into(
                    errs,
                    self.offset,
                    &format!("{:?} exponent requires hexadecimal mantissa", rune_lit(self.ch)),
                )?;
            }
            self.next(errs)?;
            tok = token::FLOAT;
            if self.ch == i32::from(b'+') || self.ch == i32::from(b'-') {
                self.next(errs)?;
            }
            let ds = self.digits(errs, 10, None)?;
            digsep |= ds;
            if ds & 1 == 0 {
                self.report_into(errs, self.offset, "exponent has no digits")?;
            }
        } else if prefix == 'x' as i32 && tok == token::FLOAT {
            self.report_into(
                errs,
                self.offset,
                "hexadecimal mantissa requires a 'p' exponent",
            )?;
        }

        if self.ch == i32::from(b'i') {
            tok = token::IMAG;
            self.next(errs)?;
        }

        let lit = slice_to_string(&self.src[offs..self.offset]);
        if tok == token::INT && invalid >= 0 {
            let idx = (invalid as usize).saturating_sub(offs);
            let d = lit.as_bytes().get(idx).copied().unwrap_or(b'?') as char;
            self.report_into(
                errs,
                invalid as usize,
                &format!("invalid digit {:?} in {}", d, litname(prefix)),
            )?;
        }
        if digsep & 2 != 0 {
            if let Some(i) = invalid_sep(lit.as_bytes()) {
                self.report_into(errs, offs + i, "'_' must separate successive digits")?;
            }
        }
        Ok((tok, lit))
    }

    fn scan_escape(&mut self, errs: &mut Vec<NativeScanError>, quote: i32) -> Result<bool> {
        let offs = self.offset;
        let (n, base, max) = match self.ch {
            0x61 | 0x62 | 0x66 | 0x6E | 0x72 | 0x74 | 0x76 | 0x5C => {
                self.next(errs)?;
                return Ok(true);
            }
            q if q == quote => {
                self.next(errs)?;
                return Ok(true);
            }
            0x30..=0x37 => (3u32, 8u32, 255u32),
            0x78 => {
                self.next(errs)?;
                (2, 16, 255)
            }
            0x75 => {
                self.next(errs)?;
                (4, 16, crate::unicode_go::MAX_RUNE)
            }
            0x55 => {
                self.next(errs)?;
                (8, 16, crate::unicode_go::MAX_RUNE)
            }
            _ => {
                let msg = if self.ch < 0 {
                    "escape sequence not terminated"
                } else {
                    "unknown escape sequence"
                };
                self.report_into(errs, offs, msg)?;
                return Ok(false);
            }
        };
        let mut x = 0u32;
        let mut left = n;
        while left > 0 {
            let d = digit_val(self.ch) as u32;
            if d >= base {
                let msg = if self.ch < 0 {
                    "escape sequence not terminated".into()
                } else {
                    format!("illegal character {} in escape sequence", go_hash_u(self.ch))
                };
                self.report_into(errs, self.offset, &msg)?;
                return Ok(false);
            }
            x = x * base + d;
            self.next(errs)?;
            left -= 1;
        }
        if x > max || (0xD800..0xE000).contains(&x) {
            self.report_into(errs, offs, "escape sequence is invalid Unicode code point")?;
            return Ok(false);
        }
        Ok(true)
    }

    fn scan_rune(&mut self, errs: &mut Vec<NativeScanError>) -> Result<String> {
        let offs = self.offset - 1;
        let mut valid = true;
        let mut n = 0i32;
        loop {
            let ch = self.ch;
            if ch == i32::from(b'\n') || ch < 0 {
                if valid {
                    self.report_into(errs, offs, "rune literal not terminated")?;
                    valid = false;
                }
                break;
            }
            self.next(errs)?;
            if ch == i32::from(b'\'') {
                break;
            }
            n += 1;
            if ch == i32::from(b'\\') && !self.scan_escape(errs, '\'' as i32)? {
                valid = false;
            }
        }
        if valid && n != 1 {
            self.report_into(errs, offs, "illegal rune literal")?;
        }
        Ok(slice_to_string(&self.src[offs..self.offset]))
    }

    fn scan_string(&mut self, errs: &mut Vec<NativeScanError>) -> Result<String> {
        let offs = self.offset - 1;
        loop {
            let ch = self.ch;
            if ch == i32::from(b'\n') || ch < 0 {
                self.report_into(errs, offs, "string literal not terminated")?;
                break;
            }
            self.next(errs)?;
            if ch == i32::from(b'"') {
                break;
            }
            if ch == i32::from(b'\\') {
                let _ = self.scan_escape(errs, '"' as i32)?;
            }
        }
        Ok(slice_to_string(&self.src[offs..self.offset]))
    }

    fn scan_raw_string(&mut self, errs: &mut Vec<NativeScanError>) -> Result<String> {
        let offs = self.offset - 1;
        let mut has_cr = false;
        loop {
            let ch = self.ch;
            if ch < 0 {
                self.report_into(errs, offs, "raw string literal not terminated")?;
                break;
            }
            self.next(errs)?;
            if ch == i32::from(b'`') {
                break;
            }
            if ch == i32::from(b'\r') {
                has_cr = true;
            }
        }
        let mut lit = self.src[offs..self.offset].to_vec();
        if has_cr {
            lit = strip_cr(&lit, false);
        }
        Ok(slice_to_string(&lit))
    }

    fn scan_comment(&mut self, errs: &mut Vec<NativeScanError>) -> Result<(String, usize)> {
        let offs = self.offset - 1;
        let mut next: i32 = -1;
        let mut num_cr = 0i32;
        let mut nl_offset = 0usize;
        if self.ch == i32::from(b'/') {
            self.next(errs)?;
            while self.ch != i32::from(b'\n') && self.ch >= 0 {
                if self.ch == i32::from(b'\r') {
                    num_cr += 1;
                }
                self.next(errs)?;
            }
            next = self.offset as i32;
            if self.ch == i32::from(b'\n') {
                next += 1;
            }
        } else {
            self.next(errs)?;
            while self.ch >= 0 {
                let ch = self.ch;
                if ch == i32::from(b'\r') {
                    num_cr += 1;
                } else if ch == i32::from(b'\n') && nl_offset == 0 {
                    nl_offset = self.offset;
                }
                self.next(errs)?;
                if ch == i32::from(b'*') && self.ch == i32::from(b'/') {
                    self.next(errs)?;
                    next = self.offset as i32;
                    break;
                }
            }
            if next < 0 {
                self.report_into(errs, offs, "comment not terminated")?;
            }
        }

        let mut lit = self.src[offs..self.offset].to_vec();
        if num_cr > 0 && lit.len() >= 2 && lit[1] == b'/' && *lit.last().unwrap_or(&0) == b'\r' {
            lit.pop();
            num_cr -= 1;
        }
        if next >= 0 && (lit.get(1) == Some(&b'*') || offs == self.line_offset) && has_line_prefix(&lit) {
            self.update_line_info(next as usize, offs, &lit, errs)?;
        }
        if num_cr > 0 {
            lit = strip_cr(&lit, lit.get(1) == Some(&b'*'));
        }
        Ok((slice_to_string(&lit), nl_offset))
    }

    fn update_line_info(
        &mut self,
        next: usize,
        mut offs: usize,
        text: &[u8],
        errs: &mut Vec<NativeScanError>,
    ) -> Result<()> {
        let mut text = text.to_vec();
        if text.get(1) == Some(&b'*') {
            if text.len() >= 2 {
                text.truncate(text.len() - 2);
            }
        }
        if text.len() < 7 {
            return Ok(());
        }
        text = text[7..].to_vec();
        offs += 7;
        let Some((i, n, ok)) = trailing_digits(&text) else {
            return Ok(());
        };
        if i == 0 {
            return Ok(());
        }
        if !ok {
            self.report_into(
                errs,
                offs + i,
                &format!("invalid line number: {}", slice_to_string(&text[i..])),
            )?;
            return Ok(());
        }
        let (mut i, mut line, mut col, mut ok2) = (i, n, 0u64, false);
        let mut i2 = 0usize;
        if i > 0 {
            if let Some((j, n2, ok_col)) = trailing_digits(&text[..i - 1]) {
                if ok_col {
                    i2 = i;
                    i = j;
                    line = n2;
                    col = n;
                    ok2 = true;
                    if col == 0 || col > u64::from(MAX_LINE_COL) {
                        self.report_into(
                            errs,
                            offs + i2,
                            &format!("invalid column number: {}", slice_to_string(&text[i2..])),
                        )?;
                        return Ok(());
                    }
                    if i2 > 0 {
                        text.truncate(i2 - 1);
                    }
                }
            }
        }
        if !ok2 {
            line = n;
        }
        if line == 0 || line > u64::from(MAX_LINE_COL) {
            self.report_into(
                errs,
                offs + i,
                &format!("invalid line number: {}", slice_to_string(&text[i..])),
            )?;
            return Ok(());
        }
        let mut filename = if i == 0 {
            String::new()
        } else {
            slice_to_string(&text[..i.saturating_sub(1)])
        };
        if filename.is_empty() && ok2 {
            let pos = self.file.pos_of(offs as i32)?;
            filename = self.file.position_of(pos, true)?.filename;
        } else if !filename.is_empty() {
            filename = path_clean(&filename);
            if !path_is_abs(&filename) {
                filename = path_join(&self.dir, &filename);
            }
        }
        self.file.add_line_column_info(
            next as i32,
            filename,
            line as i32,
            if ok2 { col as i32 } else { 0 },
        )?;
        Ok(())
    }
}

fn has_line_prefix(lit: &[u8]) -> bool {
    lit.len() >= 7 && lit[2..].starts_with(b"line ")
}

fn trailing_digits(text: &[u8]) -> Option<(usize, u64, bool)> {
    let i = match text.iter().rposition(|&b| b == b':') {
        Some(i) => i,
        None => return Some((0, 0, false)),
    };
    let digits = &text[i + 1..];
    match std::str::from_utf8(digits)
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
    {
        Some(n) => Some((i + 1, n, true)),
        None => Some((i + 1, 0, false)),
    }
}

fn strip_cr(b: &[u8], comment: bool) -> Vec<u8> {
    let mut c = Vec::with_capacity(b.len());
    for (j, &ch) in b.iter().enumerate() {
        if ch != b'\r'
            || (comment
                && c.len() > 2
                && c.last() == Some(&b'*')
                && j + 1 < b.len()
                && b[j + 1] == b'/')
        {
            c.push(ch);
        }
    }
    c
}

fn invalid_sep(x: &[u8]) -> Option<usize> {
    let mut x1 = b' ';
    let mut d = b'.';
    let mut i = 0usize;
    if x.len() >= 2 && x[0] == b'0' {
        x1 = lower(i32::from(x[1])) as u8;
        if x1 == b'x' || x1 == b'o' || x1 == b'b' {
            d = b'0';
            i = 2;
        }
    }
    while i < x.len() {
        let p = d;
        d = x[i];
        if d == b'_' {
            if p != b'0' {
                return Some(i);
            }
        } else if is_decimal(i32::from(d)) || (x1 == b'x' && is_hex(i32::from(d))) {
            d = b'0';
        } else {
            if p == b'_' {
                return Some(i - 1);
            }
            d = b'.';
        }
        i += 1;
    }
    if d == b'_' {
        return Some(x.len() - 1);
    }
    None
}

fn litname(prefix: i32) -> &'static str {
    match prefix {
        0x78 => "hexadecimal literal",
        0x6F | 0x30 => "octal literal",
        0x62 => "binary literal",
        _ => "decimal literal",
    }
}

fn digit_val(ch: i32) -> i32 {
    if (b'0' as i32) <= ch && ch <= (b'9' as i32) {
        ch - i32::from(b'0')
    } else {
        let l = lower(ch);
        if (b'a' as i32) <= l && l <= (b'f' as i32) {
            l - i32::from(b'a') + 10
        } else {
            16
        }
    }
}

fn lower(ch: i32) -> i32 {
    (b'a' as i32 - b'A' as i32) | ch
}

fn is_decimal(ch: i32) -> bool {
    (b'0' as i32) <= ch && ch <= (b'9' as i32)
}

fn is_hex(ch: i32) -> bool {
    is_decimal(ch) || {
        let l = lower(ch);
        (b'a' as i32) <= l && l <= (b'f' as i32)
    }
}

fn is_letter(ch: i32) -> bool {
    if ch < 0 {
        return false;
    }
    let l = lower(ch);
    ('a' as i32) <= l && l <= ('z' as i32) || ch == '_' as i32 || ch >= RUNE_SELF && uni_letter(ch as u32)
}

fn is_digit(ch: i32) -> bool {
    if ch < 0 {
        return false;
    }
    is_decimal(ch) || ch >= RUNE_SELF && uni_digit(ch as u32)
}

fn slice_to_string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn rune_lit(ch: i32) -> String {
    if ch < 0 {
        String::new()
    } else {
        crate::unicode_go::rune_to_string(ch)
    }
}

fn go_hash_u(ch: i32) -> String {
    if ch < 0 {
        return "U+FFFFFFFF".into();
    }
    let u = ch as u32;
    if is_go_print(u) {
        format!("U+{u:04X} '{}'", char::from_u32(u).unwrap_or('\u{FFFD}'))
    } else {
        format!("U+{u:04X}")
    }
}

fn go_quote_rune(ch: i32) -> String {
    if ch < 0 {
        return r"'\uFFFD'".into();
    }
    let c = char::from_u32(ch as u32).unwrap_or('\u{FFFD}');
    format!("{:?}", c)
}

fn is_go_print(u: u32) -> bool {
    char::from_u32(u).map(|c| !c.is_control()).unwrap_or(false)
}
