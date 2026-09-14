//! Go 1.24 `encoding/xml` tokenizer, EscapeText, EncodeToken, and schema mapping.

use std::collections::HashMap;

use napi::bindgen_prelude::{Result as JsResult, Uint8Array};
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::xml_entities::{html_entity_map, HTML_AUTO_CLOSE, HTML_ENTITY_PAIRS};
use crate::xml_names::{is_name_char, is_name_start};

const XML_URL: &str = "http://www.w3.org/XML/1998/namespace";
const XMLNS_PREFIX: &str = "xmlns";
const XML_PREFIX: &str = "xml";
const MAX_NESTING: usize = 10_000;
const XML_HEADER: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";

const ESC_QUOT: &[u8] = b"&#34;";
const ESC_APOS: &[u8] = b"&#39;";
const ESC_AMP: &[u8] = b"&amp;";
const ESC_LT: &[u8] = b"&lt;";
const ESC_GT: &[u8] = b"&gt;";
const ESC_TAB: &[u8] = b"&#x9;";
const ESC_NL: &[u8] = b"&#xA;";
const ESC_CR: &[u8] = b"&#xD;";
const ESC_FFFD: &[u8] = "\u{FFFD}".as_bytes();

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Name {
    pub space: String,
    pub local: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attr {
    pub name: Name,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Token {
    Start { name: Name, attr: Vec<Attr> },
    End { name: Name },
    CharData(Vec<u8>),
    Comment(Vec<u8>),
    ProcInst { target: String, inst: Vec<u8> },
    Directive(Vec<u8>),
}

#[derive(Clone, Debug)]
pub struct XmlError {
    pub kind: &'static str,
    pub line: i32,
    pub msg: String,
}

impl XmlError {
    fn syntax(line: i32, msg: impl Into<String>) -> Self {
        Self {
            kind: "syntax",
            line,
            msg: msg.into(),
        }
    }
    fn unsupported(type_name: impl Into<String>) -> Self {
        Self {
            kind: "unsupported",
            line: 0,
            msg: type_name.into(),
        }
    }
    fn other(msg: impl Into<String>) -> Self {
        Self {
            kind: "other",
            line: 0,
            msg: msg.into(),
        }
    }
    fn to_napi(self) -> napi::Error {
        match self.kind {
            "syntax" => napi::Error::from_reason(format!("XmlSyntaxError:{}:{}", self.line, self.msg)),
            "unsupported" => napi::Error::from_reason(format!("XmlUnsupportedTypeError:{}", self.msg)),
            _ => napi::Error::from_reason(format!("XmlError:{}", self.msg)),
        }
    }
}

enum Stk {
    Start(Name),
    Ns { local: String, url: String, ok: bool },
}

pub struct Decoder {
    input: Vec<u8>,
    pos: usize,
    next_byte: i32,
    line: i32,
    linestart: i64,
    offset: i64,
    buf: Vec<u8>,
    stk: Vec<Stk>,
    need_close: bool,
    to_close: Name,
    next_token: Option<Token>,
    ns: HashMap<String, String>,
    err: Option<XmlError>,
    strict: bool,
    auto_close: Vec<String>,
    entity: HashMap<String, String>,
    default_space: String,
    unmarshal_depth: i32,
    assume_utf8: bool,
}

impl Decoder {
    pub fn new(input: Vec<u8>) -> Self {
        Self {
            input,
            pos: 0,
            next_byte: -1,
            line: 1,
            linestart: 0,
            offset: 0,
            buf: Vec::new(),
            stk: Vec::new(),
            need_close: false,
            to_close: Name {
                space: String::new(),
                local: String::new(),
            },
            next_token: None,
            ns: HashMap::new(),
            err: None,
            strict: true,
            auto_close: Vec::new(),
            entity: HashMap::new(),
            default_space: String::new(),
            unmarshal_depth: 0,
            assume_utf8: true,
        }
    }

    pub fn set_options(
        &mut self,
        strict: bool,
        auto_close: Vec<String>,
        entity: HashMap<String, String>,
        default_space: String,
        assume_utf8: bool,
    ) {
        self.strict = strict;
        self.auto_close = auto_close;
        self.entity = entity;
        self.default_space = default_space;
        self.assume_utf8 = assume_utf8;
    }

    fn syntax(&self, msg: impl Into<String>) -> XmlError {
        XmlError::syntax(self.line, msg)
    }

    fn fail(&mut self, err: XmlError) {
        self.err = Some(err);
    }

    pub fn input_offset(&self) -> i64 {
        self.offset
    }

    pub fn input_pos(&self) -> (i32, i32) {
        (self.line, (self.offset - self.linestart) as i32 + 1)
    }

    fn start_depth(&self) -> usize {
        self.stk.iter().filter(|s| matches!(s, Stk::Start(_))).count()
    }

    pub fn token(&mut self) -> Result<Option<Token>, XmlError> {
        let mut t = if let Some(tok) = self.next_token.take() {
            tok
        } else {
            match self.raw_token_inner()? {
                None => {
                    if !self.stk.is_empty() {
                        return Err(self.syntax("unexpected EOF"));
                    }
                    return Ok(None);
                }
                Some(tok) => tok,
            }
        };
        if !self.strict {
            if let Some(end) = self.auto_close_token(&t) {
                self.next_token = Some(t);
                t = end;
            }
        }
        match t {
            Token::Start { mut name, mut attr } => {
                if self.start_depth() >= MAX_NESTING {
                    return Err(self.syntax("element nesting too deep"));
                }
                for a in &attr {
                    if a.name.space == XMLNS_PREFIX {
                        let old = self.ns.get(&a.name.local).cloned();
                        self.stk.push(Stk::Ns {
                            local: a.name.local.clone(),
                            url: old.clone().unwrap_or_default(),
                            ok: old.is_some(),
                        });
                        self.ns.insert(a.name.local.clone(), a.value.clone());
                    }
                    if a.name.space.is_empty() && a.name.local == XMLNS_PREFIX {
                        let old = self.ns.get("").cloned();
                        self.stk.push(Stk::Ns {
                            local: String::new(),
                            url: old.clone().unwrap_or_default(),
                            ok: old.is_some(),
                        });
                        self.ns.insert(String::new(), a.value.clone());
                    }
                }
                self.stk.push(Stk::Start(name.clone()));
                self.translate(&mut name, true);
                for a in &mut attr {
                    self.translate(&mut a.name, false);
                }
                Ok(Some(Token::Start { name, attr }))
            }
            Token::End { mut name } => {
                self.pop_element(&mut name)?;
                Ok(Some(Token::End { name }))
            }
            other => Ok(Some(other)),
        }
    }

    fn translate(&self, n: &mut Name, is_element: bool) {
        if n.space == XMLNS_PREFIX {
            return;
        }
        if n.space.is_empty() && !is_element {
            return;
        }
        if n.space == XML_PREFIX {
            n.space = XML_URL.to_string();
            return;
        }
        if n.space.is_empty() && n.local == XMLNS_PREFIX {
            return;
        }
        if let Some(v) = self.ns.get(&n.space) {
            n.space = v.clone();
        } else if n.space.is_empty() {
            n.space = self.default_space.clone();
        }
    }

    fn auto_close_token(&self, t: &Token) -> Option<Token> {
        let Stk::Start(name) = self.stk.last()? else {
            return None;
        };
        for s in &self.auto_close {
            if s.eq_ignore_ascii_case(&name.local) {
                match t {
                    Token::End { name: end } if end.local.eq_ignore_ascii_case(&name.local) => {
                        return None;
                    }
                    _ => {
                        return Some(Token::End { name: name.clone() });
                    }
                }
            }
        }
        None
    }

    fn pop_element(&mut self, t: &mut Name) -> Result<(), XmlError> {
        let Some(Stk::Start(start)) = self.stk.pop() else {
            return Err(self.syntax(format!("unexpected end element </{}>", t.local)));
        };
        if start.local != t.local {
            if !self.strict {
                self.need_close = true;
                self.to_close = t.clone();
                *t = start;
                return Ok(());
            }
            return Err(self.syntax(format!(
                "element <{}> closed by </{}>",
                start.local, t.local
            )));
        }
        if start.space != t.space {
            let ns = if t.space.is_empty() {
                "\"\"".to_string()
            } else {
                t.space.clone()
            };
            return Err(self.syntax(format!(
                "element <{}> in space {} closed by </{}> in space {}",
                start.local, start.space, t.local, ns
            )));
        }
        self.translate(t, true);
        while matches!(self.stk.last(), Some(Stk::Ns { .. })) {
            if let Some(Stk::Ns { local, url, ok }) = self.stk.pop() {
                if ok {
                    self.ns.insert(local, url);
                } else {
                    self.ns.remove(&local);
                }
            }
        }
        Ok(())
    }

    pub fn raw_token(&mut self) -> Result<Option<Token>, XmlError> {
        if self.unmarshal_depth > 0 {
            return Err(XmlError::other("xml: cannot use RawToken from UnmarshalXML method"));
        }
        self.raw_token_inner()
    }

    fn raw_token_inner(&mut self) -> Result<Option<Token>, XmlError> {
        if let Some(err) = self.err.clone() {
            return Err(err);
        }
        if self.need_close {
            self.need_close = false;
            return Ok(Some(Token::End {
                name: self.to_close.clone(),
            }));
        }
        let Some(b) = self.getc()? else {
            return Ok(None);
        };
        if b != b'<' {
            self.ungetc(b);
            let data = self.text(-1, false)?;
            return Ok(Some(Token::CharData(data)));
        }
        let b = self.mustgetc()?;
        match b {
            b'/' => {
                let name = match self.nsname()? {
                    Some(n) => n,
                    None => {
                        if self.err.is_none() {
                            self.fail(self.syntax("expected element name after </"));
                        }
                        return Err(self.err.clone().unwrap());
                    }
                };
                self.space();
                let c = self.mustgetc()?;
                if c != b'>' {
                    return Err(self.syntax(format!(
                        "invalid characters between </{} and >",
                        name.local
                    )));
                }
                Ok(Some(Token::End { name }))
            }
            b'?' => {
                let target = match self.name()? {
                    Some(n) => n,
                    None => {
                        if self.err.is_none() {
                            self.fail(self.syntax("expected target name after <?"));
                        }
                        return Err(self.err.clone().unwrap());
                    }
                };
                self.space();
                self.buf.clear();
                let mut b0 = 0u8;
                loop {
                    let c = self.mustgetc()?;
                    self.buf.push(c);
                    if b0 == b'?' && c == b'>' {
                        break;
                    }
                    b0 = c;
                }
                let mut data = self.buf.clone();
                data.truncate(data.len() - 2);
                if target == "xml" {
                    let content = String::from_utf8_lossy(&data).into_owned();
                    let ver = proc_inst("version", &content);
                    if !ver.is_empty() && ver != "1.0" {
                        return Err(XmlError::other(format!(
                            "xml: unsupported version {ver:?}; only version 1.0 is supported"
                        )));
                    }
                    let enc = proc_inst("encoding", &content);
                    if !enc.is_empty()
                        && !enc.eq_ignore_ascii_case("utf-8")
                        && !self.assume_utf8
                    {
                        return Err(XmlError::other(format!(
                            "xml: encoding {enc:?} declared but Decoder.CharsetReader is nil"
                        )));
                    }
                }
                Ok(Some(Token::ProcInst { target, inst: data }))
            }
            b'!' => self.read_bang(),
            _ => {
                self.ungetc(b);
                let name = match self.nsname()? {
                    Some(n) => n,
                    None => {
                        if self.err.is_none() {
                            self.fail(self.syntax("expected element name after <"));
                        }
                        return Err(self.err.clone().unwrap());
                    }
                };
                let mut empty = false;
                let mut attr = Vec::new();
                loop {
                    self.space();
                    let c = self.mustgetc()?;
                    if c == b'/' {
                        empty = true;
                        let n = self.mustgetc()?;
                        if n != b'>' {
                            return Err(self.syntax("expected /> in element"));
                        }
                        break;
                    }
                    if c == b'>' {
                        break;
                    }
                    self.ungetc(c);
                    let aname = match self.nsname()? {
                        Some(n) => n,
                        None => {
                            if self.err.is_none() {
                                self.fail(self.syntax("expected attribute name in element"));
                            }
                            return Err(self.err.clone().unwrap());
                        }
                    };
                    self.space();
                    let eq = self.mustgetc()?;
                    let value = if eq != b'=' {
                        if self.strict {
                            return Err(self.syntax("attribute name without = in element"));
                        }
                        self.ungetc(eq);
                        aname.local.clone()
                    } else {
                        self.space();
                        String::from_utf8_lossy(&self.attrval()?).into_owned()
                    };
                    attr.push(Attr { name: aname, value });
                }
                if empty {
                    self.need_close = true;
                    self.to_close = name.clone();
                }
                Ok(Some(Token::Start { name, attr }))
            }
        }
    }

    fn read_bang(&mut self) -> Result<Option<Token>, XmlError> {
        let b = self.mustgetc()?;
        match b {
            b'-' => {
                let c = self.mustgetc()?;
                if c != b'-' {
                    return Err(self.syntax("invalid sequence <!- not part of <!--"));
                }
                self.buf.clear();
                let mut b0 = 0u8;
                let mut b1 = 0u8;
                loop {
                    let c = self.mustgetc()?;
                    self.buf.push(c);
                    if b0 == b'-' && b1 == b'-' {
                        if c != b'>' {
                            return Err(self.syntax("invalid sequence \"--\" not allowed in comments"));
                        }
                        break;
                    }
                    b0 = b1;
                    b1 = c;
                }
                let mut data = self.buf.clone();
                data.truncate(data.len().saturating_sub(3));
                Ok(Some(Token::Comment(data)))
            }
            b'[' => {
                for &ch in b"CDATA[" {
                    let c = self.mustgetc()?;
                    if c != ch {
                        return Err(self.syntax("invalid <![ sequence"));
                    }
                }
                let data = self.text(-1, true)?;
                Ok(Some(Token::CharData(data)))
            }
            _ => {
                self.buf.clear();
                self.buf.push(b);
                let mut inquote = 0u8;
                let mut depth = 0i32;
                loop {
                    let c = self.mustgetc()?;
                    if inquote == 0 && c == b'>' && depth == 0 {
                        break;
                    }
                    self.handle_directive_byte(c, &mut inquote, &mut depth)?;
                }
                Ok(Some(Token::Directive(self.buf.clone())))
            }
        }
    }

    fn handle_directive_byte(
        &mut self,
        mut b: u8,
        inquote: &mut u8,
        depth: &mut i32,
    ) -> Result<(), XmlError> {
        loop {
            self.buf.push(b);
            if b == *inquote {
                *inquote = 0;
                return Ok(());
            }
            if *inquote != 0 {
                return Ok(());
            }
            if b == b'\'' || b == b'"' {
                *inquote = b;
                return Ok(());
            }
            if b == b'>' && *inquote == 0 {
                *depth -= 1;
                return Ok(());
            }
            if b == b'<' && *inquote == 0 {
                let s = b"!--";
                let mut i = 0;
                while i < s.len() {
                    let c = self.mustgetc()?;
                    if c != s[i] {
                        self.buf.extend_from_slice(&s[..i]);
                        *depth += 1;
                        b = c;
                        break;
                    }
                    i += 1;
                }
                if i == s.len() {
                    self.buf.pop();
                    let mut b0 = 0u8;
                    let mut b1 = 0u8;
                    loop {
                        let c = self.mustgetc()?;
                        if b0 == b'-' && b1 == b'-' && c == b'>' {
                            break;
                        }
                        b0 = b1;
                        b1 = c;
                    }
                    self.buf.push(b' ');
                    return Ok(());
                }
                continue;
            }
            return Ok(());
        }
    }

    fn attrval(&mut self) -> Result<Vec<u8>, XmlError> {
        let b = self.mustgetc()?;
        if b == b'"' || b == b'\'' {
            return self.text(b as i32, false);
        }
        if self.strict {
            return Err(self.syntax("unquoted or missing attribute value in element"));
        }
        self.ungetc(b);
        self.buf.clear();
        loop {
            let c = self.mustgetc()?;
            if (b'a'..=b'z').contains(&c)
                || (b'A'..=b'Z').contains(&c)
                || (b'0'..=b'9').contains(&c)
                || c == b'_'
                || c == b':'
                || c == b'-'
            {
                self.buf.push(c);
            } else {
                self.ungetc(c);
                break;
            }
        }
        Ok(self.buf.clone())
    }

    fn space(&mut self) {
        while let Ok(Some(b)) = self.getc() {
            match b {
                b' ' | b'\r' | b'\n' | b'\t' => {}
                _ => {
                    self.ungetc(b);
                    return;
                }
            }
        }
    }

    fn getc(&mut self) -> Result<Option<u8>, XmlError> {
        if let Some(err) = self.err.clone() {
            return Err(err);
        }
        let b = if self.next_byte >= 0 {
            let b = self.next_byte as u8;
            self.next_byte = -1;
            b
        } else if self.pos >= self.input.len() {
            return Ok(None);
        } else {
            let b = self.input[self.pos];
            self.pos += 1;
            b
        };
        if b == b'\n' {
            self.line += 1;
            self.linestart = self.offset + 1;
        }
        self.offset += 1;
        Ok(Some(b))
    }

    fn mustgetc(&mut self) -> Result<u8, XmlError> {
        match self.getc()? {
            Some(b) => Ok(b),
            None => {
                let err = self.syntax("unexpected EOF");
                self.fail(err.clone());
                Err(err)
            }
        }
    }

    fn ungetc(&mut self, b: u8) {
        if b == b'\n' {
            self.line -= 1;
        }
        self.next_byte = b as i32;
        self.offset -= 1;
    }

    fn text(&mut self, quote: i32, cdata: bool) -> Result<Vec<u8>, XmlError> {
        let mut b0 = 0u8;
        let mut b1 = 0u8;
        let mut trunc = 0usize;
        self.buf.clear();
        loop {
            let Some(b) = self.getc()? else {
                if cdata {
                    return Err(self.syntax("unexpected EOF in CDATA section"));
                }
                break;
            };
            if quote < 0 && b0 == b']' && b1 == b']' && b == b'>' {
                if cdata {
                    trunc = 2;
                    break;
                }
                return Err(self.syntax("unescaped ]]> not in CDATA section"));
            }
            if b == b'<' && !cdata {
                if quote >= 0 {
                    return Err(self.syntax("unescaped < inside quoted string"));
                }
                self.ungetc(b'<');
                break;
            }
            if quote >= 0 && b == quote as u8 {
                break;
            }
            if b == b'&' && !cdata {
                let before = self.buf.len();
                self.buf.push(b'&');
                let c = self.mustgetc()?;
                let mut have_text = false;
                let mut text = String::new();
                if c == b'#' {
                    self.buf.push(c);
                    let mut nxt = self.mustgetc()?;
                    let mut base = 10u32;
                    if nxt == b'x' {
                        base = 16;
                        self.buf.push(nxt);
                        nxt = self.mustgetc()?;
                    }
                    let start = self.buf.len();
                    while (b'0'..=b'9').contains(&nxt)
                        || (base == 16 && (b'a'..=b'f').contains(&nxt))
                        || (base == 16 && (b'A'..=b'F').contains(&nxt))
                    {
                        self.buf.push(nxt);
                        nxt = self.mustgetc()?;
                    }
                    if nxt != b';' {
                        self.ungetc(nxt);
                    } else {
                        let s = String::from_utf8_lossy(&self.buf[start..]).into_owned();
                        self.buf.push(b';');
                        if let Ok(n) = u32::from_str_radix(&s, base) {
                            if let Some(ch) = char::from_u32(n) {
                                text = ch.to_string();
                                have_text = true;
                            }
                        }
                    }
                } else {
                    self.ungetc(c);
                    if !self.read_name()? && self.err.is_some() {
                        return Err(self.err.clone().unwrap());
                    }
                    let semi = self.mustgetc()?;
                    if semi != b';' {
                        self.ungetc(semi);
                    } else {
                        let name = self.buf[before + 1..].to_vec();
                        self.buf.push(b';');
                        if is_name(&name) {
                            let s = String::from_utf8_lossy(&name).into_owned();
                            if let Some(r) = std_entity(&s) {
                                text = r.to_string();
                                have_text = true;
                            } else if let Some(v) = self.entity.get(&s) {
                                text = v.clone();
                                have_text = true;
                            }
                        }
                    }
                }
                if have_text {
                    self.buf.truncate(before);
                    self.buf.extend_from_slice(text.as_bytes());
                    b0 = 0;
                    b1 = 0;
                    continue;
                }
                if !self.strict {
                    b0 = 0;
                    b1 = 0;
                    continue;
                }
                let mut ent = String::from_utf8_lossy(&self.buf[before..]).into_owned();
                if !ent.ends_with(';') {
                    ent.push_str(" (no semicolon)");
                }
                return Err(self.syntax(format!("invalid character entity {ent}")));
            }
            if b == b'\r' {
                self.buf.push(b'\n');
            } else if b1 == b'\r' && b == b'\n' {
                // skip, already wrote \n
            } else {
                self.buf.push(b);
            }
            b0 = b1;
            b1 = b;
        }
        let mut data = self.buf.clone();
        if trunc > 0 {
            data.truncate(data.len() - trunc);
        }
        let mut rest = data.as_slice();
        while !rest.is_empty() {
            let (r, size) = decode_rune(rest);
            if r == '\u{FFFD}' && size == 1 {
                return Err(self.syntax("invalid UTF-8"));
            }
            rest = &rest[size..];
            if !is_in_character_range(r) {
                return Err(self.syntax(format!("illegal character code U+{:04X}", r as u32)));
            }
        }
        Ok(data)
    }

    fn nsname(&mut self) -> Result<Option<Name>, XmlError> {
        let Some(s) = self.name()? else {
            return Ok(None);
        };
        if s.bytes().filter(|&b| b == b':').count() > 1 {
            return Ok(None);
        }
        if let Some((space, local)) = s.split_once(':') {
            if space.is_empty() || local.is_empty() {
                return Ok(Some(Name {
                    space: String::new(),
                    local: s,
                }));
            }
            return Ok(Some(Name {
                space: space.to_string(),
                local: local.to_string(),
            }));
        }
        Ok(Some(Name {
            space: String::new(),
            local: s,
        }))
    }

    fn name(&mut self) -> Result<Option<String>, XmlError> {
        self.buf.clear();
        if !self.read_name()? {
            return Ok(None);
        }
        if !is_name(&self.buf) {
            return Err(self.syntax(format!(
                "invalid XML name: {}",
                String::from_utf8_lossy(&self.buf)
            )));
        }
        Ok(Some(String::from_utf8_lossy(&self.buf).into_owned()))
    }

    fn read_name(&mut self) -> Result<bool, XmlError> {
        let b = match self.mustgetc() {
            Ok(b) => b,
            Err(e) => {
                self.fail(e.clone());
                return Err(e);
            }
        };
        if b < 0x80 && !is_name_byte(b) {
            self.ungetc(b);
            return Ok(false);
        }
        self.buf.push(b);
        loop {
            let c = match self.mustgetc() {
                Ok(c) => c,
                Err(e) => return Err(e),
            };
            if c < 0x80 && !is_name_byte(c) {
                self.ungetc(c);
                break;
            }
            self.buf.push(c);
        }
        Ok(true)
    }

    pub fn skip(&mut self) -> Result<(), XmlError> {
        loop {
            match self.token()? {
                None => return Err(self.syntax("unexpected EOF")),
                Some(Token::Start { .. }) => self.skip()?,
                Some(Token::End { .. }) => return Ok(()),
                Some(_) => {}
            }
        }
    }

    pub fn decode(&mut self, schema: &Schema, start: Option<Token>) -> Result<Value, XmlError> {
        self.unmarshal_depth += 1;
        let result = self.decode_inner(schema, start);
        self.unmarshal_depth -= 1;
        result
    }

    fn decode_inner(&mut self, schema: &Schema, start: Option<Token>) -> Result<Value, XmlError> {
        let start = match start {
            Some(Token::Start { name, attr }) => Token::Start { name, attr },
            Some(_) => return Err(XmlError::other("xml: DecodeElement start must be a start token")),
            None => loop {
                match self.token()? {
                    None => return Err(self.syntax("unexpected EOF")),
                    Some(Token::Start { name, attr }) => break Token::Start { name, attr },
                    Some(Token::CharData(_)) | Some(Token::Comment(_)) | Some(Token::ProcInst { .. }) | Some(Token::Directive(_)) => {}
                    Some(Token::End { name }) => {
                        return Err(self.syntax(format!("unexpected end element </{}>", name.local)));
                    }
                }
            },
        };
        unmarshal_element(self, schema, start)
    }
}

fn std_entity(name: &str) -> Option<char> {
    match name {
        "lt" => Some('<'),
        "gt" => Some('>'),
        "amp" => Some('&'),
        "apos" => Some('\''),
        "quot" => Some('"'),
        _ => None,
    }
}

fn is_name_byte(c: u8) -> bool {
    (b'A'..=b'Z').contains(&c)
        || (b'a'..=b'z').contains(&c)
        || (b'0'..=b'9').contains(&c)
        || c == b'_'
        || c == b':'
        || c == b'.'
        || c == b'-'
}

fn is_name(s: &[u8]) -> bool {
    if s.is_empty() {
        return false;
    }
    let (c, n) = decode_rune(s);
    if c == '\u{FFFD}' && n == 1 {
        return false;
    }
    if !is_name_start(c) {
        return false;
    }
    let mut rest = &s[n..];
    while !rest.is_empty() {
        let (ch, n) = decode_rune(rest);
        if ch == '\u{FFFD}' && n == 1 {
            return false;
        }
        if !is_name_char(ch) {
            return false;
        }
        rest = &rest[n..];
    }
    true
}

fn is_name_string(s: &str) -> bool {
    is_name(s.as_bytes())
}

fn is_in_character_range(r: char) -> bool {
    let u = r as u32;
    r == '\u{09}'
        || r == '\u{0A}'
        || r == '\u{0D}'
        || (0x20..=0xD7FF).contains(&u)
        || (0xE000..=0xFFFD).contains(&u)
        || (0x10000..=0x10FFFF).contains(&u)
}

fn decode_rune(b: &[u8]) -> (char, usize) {
    if b.is_empty() {
        return ('\u{FFFD}', 0);
    }
    match std::str::from_utf8(b) {
        Ok(s) => {
            let ch = s.chars().next().unwrap_or('\u{FFFD}');
            (ch, ch.len_utf8())
        }
        Err(err) => {
            let valid = err.valid_up_to();
            if valid > 0 {
                let ch = std::str::from_utf8(&b[..valid]).unwrap().chars().next().unwrap();
                (ch, ch.len_utf8())
            } else if err.error_len() == Some(0) {
                ('\u{FFFD}', 1)
            } else {
                ('\u{FFFD}', 1)
            }
        }
    }
}

fn proc_inst(param: &str, s: &str) -> String {
    let needle = format!("{param}=");
    let mut i = 0usize;
    let mut sep = 0u8;
    while i < s.len() {
        let sub = &s[i..];
        let Some(k) = sub.find(&needle) else {
            return String::new();
        };
        if needle.len() + k >= sub.len() {
            return String::new();
        }
        let c = sub.as_bytes()[needle.len() + k];
        i += needle.len() + k + 1;
        if c == b'\'' || c == b'"' {
            sep = c;
            break;
        }
    }
    if sep == 0 {
        return String::new();
    }
    let rest = &s[i..];
    let Some(j) = rest.as_bytes().iter().position(|&b| b == sep) else {
        return String::new();
    };
    rest[..j].to_string()
}

pub fn escape_text(s: &[u8], escape_newline: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let (r, width) = decode_rune(&s[i..]);
        i += width;
        let esc: Option<&[u8]> = match r {
            '"' => Some(ESC_QUOT),
            '\'' => Some(ESC_APOS),
            '&' => Some(ESC_AMP),
            '<' => Some(ESC_LT),
            '>' => Some(ESC_GT),
            '\t' => Some(ESC_TAB),
            '\n' if escape_newline => Some(ESC_NL),
            '\n' => None,
            '\r' => Some(ESC_CR),
            _ if !is_in_character_range(r) || (r == '\u{FFFD}' && width == 1) => Some(ESC_FFFD),
            _ => None,
        };
        if let Some(esc) = esc {
            out.extend_from_slice(esc);
        } else {
            out.extend_from_slice(&s[i - width..i]);
        }
    }
    out
}

struct Encoder {
    buf: Vec<u8>,
    indent: String,
    prefix: String,
    depth: i32,
    indented_in: bool,
    put_newline: bool,
    tags: Vec<Name>,
    attr_ns: HashMap<String, String>,
    attr_prefix: HashMap<String, String>,
    prefixes: Vec<String>,
    seq: i32,
}

impl Encoder {
    fn new(prefix: String, indent: String) -> Self {
        Self {
            buf: Vec::new(),
            indent,
            prefix,
            depth: 0,
            indented_in: false,
            put_newline: false,
            tags: Vec::new(),
            attr_ns: HashMap::new(),
            attr_prefix: HashMap::new(),
            prefixes: Vec::new(),
            seq: 0,
        }
    }

    fn encode_token(&mut self, t: &Token) -> Result<(), XmlError> {
        match t {
            Token::Start { name, attr } => self.write_start(name, attr),
            Token::End { name } => self.write_end(name),
            Token::CharData(b) => {
                self.buf.extend_from_slice(&escape_text(b, false));
                Ok(())
            }
            Token::Comment(b) => {
                if b.windows(3).any(|w| w == b"-->") {
                    return Err(XmlError::other("xml: EncodeToken of Comment containing --> marker"));
                }
                self.buf.extend_from_slice(b"<!--");
                self.buf.extend_from_slice(b);
                self.buf.extend_from_slice(b"-->");
                Ok(())
            }
            Token::ProcInst { target, inst } => {
                if target == "xml" && !self.buf.is_empty() {
                    return Err(XmlError::other(
                        "xml: EncodeToken of ProcInst xml target only valid for xml declaration, first token encoded",
                    ));
                }
                if !is_name_string(target) {
                    return Err(XmlError::other("xml: EncodeToken of ProcInst with invalid Target"));
                }
                if inst.windows(2).any(|w| w == b"?>") {
                    return Err(XmlError::other("xml: EncodeToken of ProcInst containing ?> marker"));
                }
                self.buf.extend_from_slice(b"<?");
                self.buf.extend_from_slice(target.as_bytes());
                if !inst.is_empty() {
                    self.buf.push(b' ');
                    self.buf.extend_from_slice(inst);
                }
                self.buf.extend_from_slice(b"?>");
                Ok(())
            }
            Token::Directive(b) => {
                if !is_valid_directive(b) {
                    return Err(XmlError::other(
                        "xml: EncodeToken of Directive containing wrong < or > markers",
                    ));
                }
                self.buf.extend_from_slice(b"<!");
                self.buf.extend_from_slice(b);
                self.buf.push(b'>');
                Ok(())
            }
        }
    }

    fn write_indent(&mut self, depth_delta: i32) {
        if self.prefix.is_empty() && self.indent.is_empty() {
            return;
        }
        if depth_delta < 0 {
            self.depth -= 1;
            if self.indented_in {
                self.indented_in = false;
                return;
            }
            self.indented_in = false;
        }
        if self.put_newline {
            self.buf.push(b'\n');
        } else {
            self.put_newline = true;
        }
        self.buf.extend_from_slice(self.prefix.as_bytes());
        if !self.indent.is_empty() {
            for _ in 0..self.depth {
                self.buf.extend_from_slice(self.indent.as_bytes());
            }
        }
        if depth_delta > 0 {
            self.depth += 1;
            self.indented_in = true;
        }
    }

    fn create_attr_prefix(&mut self, url: &str) -> Result<String, XmlError> {
        if let Some(p) = self.attr_prefix.get(url) {
            return Ok(p.clone());
        }
        if url == XML_URL {
            return Ok(XML_PREFIX.to_string());
        }
        let mut prefix = url.trim_end_matches('/').to_string();
        if let Some(i) = prefix.rfind('/') {
            prefix = prefix[i + 1..].to_string();
        }
        if prefix.is_empty() || !is_name(prefix.as_bytes()) || prefix.contains(':') {
            prefix = "_".to_string();
        }
        if prefix.len() >= 3 && prefix[..3].eq_ignore_ascii_case("xml") {
            prefix = format!("_{prefix}");
        }
        if self.attr_ns.contains_key(&prefix) {
            loop {
                self.seq += 1;
                let id = format!("{prefix}_{}", self.seq);
                if !self.attr_ns.contains_key(&id) {
                    prefix = id;
                    break;
                }
            }
        }
        self.buf.extend_from_slice(b"xmlns:");
        self.buf.extend_from_slice(prefix.as_bytes());
        self.buf.extend_from_slice(b"=\"");
        self.buf.extend_from_slice(&escape_text(url.as_bytes(), true));
        self.buf.extend_from_slice(b"\" ");
        self.attr_prefix.insert(url.to_string(), prefix.clone());
        self.attr_ns.insert(prefix.clone(), url.to_string());
        self.prefixes.push(prefix.clone());
        Ok(prefix)
    }

    fn mark_prefix(&mut self) {
        self.prefixes.push(String::new());
    }

    fn pop_prefix(&mut self) {
        while let Some(prefix) = self.prefixes.pop() {
            if prefix.is_empty() {
                break;
            }
            if let Some(url) = self.attr_ns.remove(&prefix) {
                self.attr_prefix.remove(&url);
            }
        }
    }

    fn write_start(&mut self, name: &Name, attr: &[Attr]) -> Result<(), XmlError> {
        if name.local.is_empty() {
            return Err(XmlError::other("xml: start tag with no name"));
        }
        self.tags.push(name.clone());
        self.mark_prefix();
        self.write_indent(1);
        self.buf.push(b'<');
        self.buf.extend_from_slice(name.local.as_bytes());
        if !name.space.is_empty() {
            self.buf.extend_from_slice(b" xmlns=\"");
            self.buf.extend_from_slice(&escape_text(name.space.as_bytes(), true));
            self.buf.push(b'"');
        }
        for a in attr {
            if a.name.local.is_empty() {
                continue;
            }
            self.buf.push(b' ');
            if !a.name.space.is_empty() {
                let p = self.create_attr_prefix(&a.name.space)?;
                self.buf.extend_from_slice(p.as_bytes());
                self.buf.push(b':');
            }
            self.buf.extend_from_slice(a.name.local.as_bytes());
            self.buf.extend_from_slice(b"=\"");
            self.buf.extend_from_slice(&escape_text(a.value.as_bytes(), true));
            self.buf.push(b'"');
        }
        self.buf.push(b'>');
        Ok(())
    }

    fn write_end(&mut self, name: &Name) -> Result<(), XmlError> {
        if name.local.is_empty() {
            return Err(XmlError::other("xml: end tag with no name"));
        }
        if self.tags.is_empty() || self.tags.last().unwrap().local.is_empty() {
            return Err(XmlError::other(format!(
                "xml: end tag </{}> without start tag",
                name.local
            )));
        }
        let top = self.tags.last().unwrap();
        if top != name {
            if top.local != name.local {
                return Err(XmlError::other(format!(
                    "xml: end tag </{}> does not match start tag <{}>",
                    name.local, top.local
                )));
            }
            return Err(XmlError::other(format!(
                "xml: end tag </{}> in namespace {} does not match start tag <{}> in namespace {}",
                name.local, name.space, top.local, top.space
            )));
        }
        self.tags.pop();
        self.write_indent(-1);
        self.buf.push(b'<');
        self.buf.push(b'/');
        self.buf.extend_from_slice(name.local.as_bytes());
        self.buf.push(b'>');
        self.pop_prefix();
        Ok(())
    }

    fn close(&mut self) -> Result<(), XmlError> {
        if !self.tags.is_empty() {
            return Err(XmlError::other(format!(
                "xml: unclosed elements: {}",
                self.tags.last().unwrap().local
            )));
        }
        Ok(())
    }
}

fn is_valid_directive(dir: &[u8]) -> bool {
    let mut depth = 0i32;
    let mut inquote = 0u8;
    let mut incomment = false;
    for (i, &c) in dir.iter().enumerate() {
        if incomment {
            if c == b'>' {
                let n = 1 + i as i32 - 3;
                if n >= 0 && dir[n as usize..=i] == *b"-->" {
                    incomment = false;
                }
            }
            continue;
        }
        if inquote != 0 {
            if c == inquote {
                inquote = 0;
            }
            continue;
        }
        if c == b'\'' || c == b'"' {
            inquote = c;
        } else if c == b'<' {
            if i + 4 <= dir.len() && &dir[i..i + 4] == b"<!--" {
                incomment = true;
            } else {
                depth += 1;
            }
        } else if c == b'>' {
            if depth == 0 {
                return false;
            }
            depth -= 1;
        }
    }
    depth == 0 && inquote == 0 && !incomment
}

#[derive(Debug, Clone, Deserialize)]
pub struct Schema {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    pub kind: String,
    #[serde(default)]
    #[serde(rename = "type")]
    pub typ: Option<String>,
    #[serde(default)]
    pub children: Option<Vec<Schema>>,
    #[serde(default)]
    pub marshaler: Option<bool>,
    #[serde(default)]
    pub omitempty: Option<bool>,
}

fn parse_tag(schema: &Schema) -> (String, String, Vec<String>, &'static str, bool) {
    let mut kind = match schema.kind.as_str() {
        "attr" => "attr",
        "chardata" => "chardata",
        "comment" => "comment",
        "any" => "any",
        _ => "element",
    };
    let mut omitempty = schema.omitempty.unwrap_or(false);
    let mut name = schema.name.clone();
    let mut xmlns = String::new();
    let mut parents = Vec::new();
    if let Some(path) = &schema.path {
        let parts: Vec<&str> = path.split('>').collect();
        if parts.len() > 1 {
            parents = parts[..parts.len() - 1].iter().map(|s| s.to_string()).collect();
            name = parts[parts.len() - 1].to_string();
        } else if name.is_empty() {
            name = path.clone();
        }
    }
    if let Some(tag) = &schema.tag {
        let mut tag = tag.as_str();
        if let Some((ns, rest)) = tag.split_once(' ') {
            xmlns = ns.to_string();
            tag = rest;
        }
        let mut toks = tag.split(',').collect::<Vec<_>>();
        let name_part = toks.remove(0);
        for flag in toks {
            match flag {
                "attr" => kind = "attr",
                "chardata" | "cdata" => kind = "chardata",
                "comment" => kind = "comment",
                "innerxml" | "any" => kind = "any",
                "omitempty" => omitempty = true,
                _ => {}
            }
        }
        if !name_part.is_empty() {
            let parts: Vec<&str> = name_part.split('>').collect();
            if parts.len() > 1 {
                parents = parts[..parts.len() - 1].iter().map(|s| s.to_string()).collect();
                name = parts[parts.len() - 1].to_string();
            } else {
                name = name_part.to_string();
            }
        }
    }
    (name, xmlns, parents, kind, omitempty)
}

fn is_empty_json(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(false) => true,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        _ => false,
    }
}

fn scalar_text(schema: &Schema, value: &Value) -> Result<Vec<u8>, XmlError> {
    if schema.marshaler.unwrap_or(false) {
        return match value {
            Value::String(s) => Ok(s.as_bytes().to_vec()),
            Value::Object(o) if o.get("$b").is_some() => {
                let hex = o.get("$b").and_then(|v| v.as_str()).unwrap_or("");
                Ok(hex::decode(hex).unwrap_or_default())
            }
            _ => Err(XmlError::unsupported("marshaler")),
        };
    }
    match schema.typ.as_deref().unwrap_or("string") {
        "int" | "uint" => match value {
            Value::Number(n) => Ok(n.to_string().into_bytes()),
            Value::String(s) => Ok(s.clone().into_bytes()),
            Value::Object(o) if o.get("$i").is_some() => {
                Ok(o["$i"].as_str().unwrap_or("0").as_bytes().to_vec())
            }
            _ => Err(XmlError::unsupported("int")),
        },
        "float" => match value {
            Value::Number(n) => Ok(n.to_string().into_bytes()),
            _ => Err(XmlError::unsupported("float")),
        },
        "bool" => match value {
            Value::Bool(b) => Ok(if *b { b"true".to_vec() } else { b"false".to_vec() }),
            _ => Err(XmlError::unsupported("bool")),
        },
        "bytes" => match value {
            Value::Object(o) if o.get("$b").is_some() => {
                let hex = o["$b"].as_str().unwrap_or("");
                Ok(hex::decode(hex).unwrap_or_default())
            }
            Value::String(s) => Ok(s.as_bytes().to_vec()),
            _ => Err(XmlError::unsupported("bytes")),
        },
        "time" => match value {
            Value::Object(o) if o.get("$t").is_some() => {
                let ms = o["$t"].as_i64().unwrap_or(0);
                Ok(rfc3339(ms).into_bytes())
            }
            Value::Number(n) => Ok(rfc3339(n.as_i64().unwrap_or(0)).into_bytes()),
            Value::String(s) => Ok(s.clone().into_bytes()),
            _ => Err(XmlError::unsupported("time")),
        },
        _ => match value {
            Value::String(s) => Ok(s.as_bytes().to_vec()),
            Value::Number(n) => Ok(n.to_string().into_bytes()),
            Value::Bool(b) => Ok(if *b { b"true".to_vec() } else { b"false".to_vec() }),
            Value::Null => Ok(Vec::new()),
            _ => Err(XmlError::unsupported("string")),
        },
    }
}

fn rfc3339(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let nsec = (ms.rem_euclid(1000) * 1_000_000) as u32;
    let t = time_parts(secs);
    if nsec == 0 {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            t.0, t.1, t.2, t.3, t.4, t.5
        )
    } else {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            t.0, t.1, t.2, t.3, t.4, t.5, nsec / 1_000_000
        )
    }
}

fn time_parts(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400) as u32;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    let (y, m, d) = civil_from_days(days);
    (y, m, d, hour, min, sec)
}

fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

fn marshal_value(enc: &mut Encoder, schema: &Schema, value: &Value) -> Result<(), XmlError> {
    if value.is_null() {
        return Ok(());
    }
    if let Value::Array(items) = value {
        for item in items {
            marshal_value(enc, schema, item)?;
        }
        return Ok(());
    }
    let (name, xmlns, parents, kind, omitempty) = parse_tag(schema);
    if omitempty && is_empty_json(value) {
        return Ok(());
    }
    match kind {
        "attr" | "chardata" | "comment" => {
            return Err(XmlError::other(
                "xml: attr/chardata/comment schema must be a child of an element",
            ));
        }
        "any" => {
            let bytes = scalar_text(schema, value)?;
            enc.buf.extend_from_slice(&bytes);
            return Ok(());
        }
        _ => {}
    }
    for p in &parents {
        enc.write_start(
            &Name {
                space: String::new(),
                local: p.clone(),
            },
            &[],
        )?;
    }
    let mut attrs = Vec::new();
    if !xmlns.is_empty() {
        attrs.push(Attr {
            name: Name {
                space: String::new(),
                local: "xmlns".into(),
            },
            value: xmlns.clone(),
        });
    }
    let mut chardata = Vec::new();
    let mut comments = Vec::new();
    let mut child_work: Vec<(&Schema, &Value)> = Vec::new();
    if let Some(children) = &schema.children {
        let obj = value.as_object();
        for child in children {
            let key = if child.name.is_empty() {
                child.tag.clone().unwrap_or_default()
            } else {
                child.name.clone()
            };
            let cv = obj.and_then(|o| o.get(&key)).unwrap_or(&Value::Null);
            let (_, _, _, ck, omit) = parse_tag(child);
            if omit && is_empty_json(cv) {
                continue;
            }
            match ck {
                "attr" => {
                    if cv.is_null() {
                        continue;
                    }
                    let (aname, ax, _, _, _) = parse_tag(child);
                    attrs.push(Attr {
                        name: Name {
                            space: ax,
                            local: aname,
                        },
                        value: String::from_utf8_lossy(&scalar_text(child, cv)?).into_owned(),
                    });
                }
                "chardata" => {
                    if !cv.is_null() {
                        chardata = scalar_text(child, cv)?;
                    }
                }
                "comment" => {
                    if !cv.is_null() {
                        comments = scalar_text(child, cv)?;
                    }
                }
                _ => child_work.push((child, cv)),
            }
        }
    } else if schema.typ.is_some() || value.is_string() || value.is_number() || value.is_boolean() {
        chardata = scalar_text(schema, value)?;
    }
    let start_name = Name {
        space: xmlns,
        local: name,
    };
    enc.write_start(&start_name, &attrs)?;
    if !comments.is_empty() {
        enc.encode_token(&Token::Comment(comments))?;
    }
    if !chardata.is_empty() {
        enc.encode_token(&Token::CharData(chardata))?;
    }
    for (child, cv) in child_work {
        if cv.is_null() {
            continue;
        }
        marshal_value(enc, child, cv)?;
    }
    enc.write_end(&start_name)?;
    for p in parents.iter().rev() {
        enc.write_end(&Name {
            space: String::new(),
            local: p.clone(),
        })?;
    }
    Ok(())
}

fn parse_scalar(typ: Option<&str>, text: &[u8]) -> Result<Value, XmlError> {
    let s = String::from_utf8_lossy(text).into_owned();
    match typ.unwrap_or("string") {
        "int" => {
            let n: i64 = s.trim().parse().map_err(|_| XmlError::other("xml: invalid int"))?;
            Ok(json!(n))
        }
        "uint" => {
            let n: u64 = s.trim().parse().map_err(|_| XmlError::other("xml: invalid uint"))?;
            Ok(json!(n))
        }
        "float" => {
            let n: f64 = s.trim().parse().map_err(|_| XmlError::other("xml: invalid float"))?;
            Ok(json!(n))
        }
        "bool" => match s.trim() {
            "true" | "1" => Ok(json!(true)),
            "false" | "0" => Ok(json!(false)),
            _ => Err(XmlError::other("xml: invalid bool")),
        },
        "bytes" => Ok(json!({ "$b": hex::encode(text) })),
        "time" => Ok(json!({ "$t": parse_rfc3339(&s).unwrap_or(0) })),
        _ => Ok(Value::String(s)),
    }
}

fn parse_rfc3339(s: &str) -> Option<i64> {
    let t = s.trim();
    if t.len() < 20 {
        return None;
    }
    let y: i32 = t.get(0..4)?.parse().ok()?;
    let mo: u32 = t.get(5..7)?.parse().ok()?;
    let d: u32 = t.get(8..10)?.parse().ok()?;
    let h: u32 = t.get(11..13)?.parse().ok()?;
    let mi: u32 = t.get(14..16)?.parse().ok()?;
    let se: u32 = t.get(17..19)?.parse().ok()?;
    let days = days_from_civil(y, mo, d);
    Some(days * 86400 * 1000 + (((h * 3600 + mi * 60 + se) as i64) * 1000))
}

fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let mut y = y as i64;
    let m = m as i64;
    let d = d as i64;
    if m <= 2 {
        y -= 1;
    }
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy as u64;
    (era * 146097 + doe as i64 - 719468) as i64
}

fn merge_repeat(prev: Option<Value>, next: Value) -> Value {
    match prev {
        None => next,
        Some(Value::Array(mut a)) => {
            a.push(next);
            Value::Array(a)
        }
        Some(prev) => Value::Array(vec![prev, next]),
    }
}

fn insert_child(obj: &mut serde_json::Map<String, Value>, key: String, val: Value) {
    match obj.remove(&key) {
        None => {
            obj.insert(key, val);
        }
        Some(Value::Array(mut a)) => {
            a.push(val);
            obj.insert(key, Value::Array(a));
        }
        Some(prev) => {
            obj.insert(key, Value::Array(vec![prev, val]));
        }
    }
}

/// Walk Go `a>b>c` parents then unmarshal the leaf. `wrappers` is the remaining
/// path including the already-consumed start's local name.
fn unmarshal_path(
    dec: &mut Decoder,
    wrappers: &[String],
    leaf: &Schema,
    start: Token,
) -> Result<Value, XmlError> {
    let Token::Start { name: start_name, .. } = start.clone() else {
        return Err(XmlError::other("expected start"));
    };
    if wrappers.is_empty() {
        return unmarshal_element(dec, leaf, start);
    }
    let rest = &wrappers[1..];
    let want_next = if rest.is_empty() {
        parse_tag(leaf).0
    } else {
        rest[0].clone()
    };
    let mut found: Option<Value> = None;
    loop {
        match dec.token()? {
            None => return Err(dec.syntax("unexpected EOF")),
            Some(Token::End { name }) if name.local == start_name.local => break,
            Some(Token::Start { name, attr }) => {
                let tok = Token::Start {
                    name: name.clone(),
                    attr,
                };
                if name.local == want_next {
                    let val = if rest.is_empty() {
                        unmarshal_element(dec, leaf, tok)?
                    } else {
                        unmarshal_path(dec, rest, leaf, tok)?
                    };
                    found = Some(merge_repeat(found, val));
                } else {
                    dec.skip()?;
                }
            }
            Some(_) => {}
        }
    }
    Ok(found.unwrap_or(Value::Null))
}

fn unmarshal_element(dec: &mut Decoder, schema: &Schema, start: Token) -> Result<Value, XmlError> {
    let Token::Start { name: start_name, attr } = start else {
        return Err(XmlError::other("expected start"));
    };
    let children = schema.children.clone().unwrap_or_default();
    let mut obj = serde_json::Map::new();
    let mut chardata = Vec::new();
    let mut comment = Vec::new();
    let inner_start = dec.input_offset().max(0) as usize;
    for child in &children {
        let (cname, _, _, kind, _) = parse_tag(child);
        if kind == "attr" {
            if let Some(a) = attr.iter().find(|a| a.name.local == cname) {
                obj.insert(child.name.clone(), parse_scalar(child.typ.as_deref(), a.value.as_bytes())?);
            }
        }
    }
    let leaf = children.is_empty() && schema.typ.is_some();
    loop {
        let before = dec.input_offset().max(0) as usize;
        match dec.token()? {
            None => return Err(dec.syntax("unexpected EOF")),
            Some(Token::End { name }) => {
                if name.local != start_name.local {
                    return Err(dec.syntax(format!(
                        "element <{}> closed by </{}>",
                        start_name.local, name.local
                    )));
                }
                let inner_end = before.min(dec.input.len());
                let inner_raw = if inner_end >= inner_start {
                    dec.input[inner_start..inner_end].to_vec()
                } else {
                    Vec::new()
                };
                if leaf {
                    return parse_scalar(schema.typ.as_deref(), &chardata);
                }
                for child in &children {
                    let (_, _, _, kind, _) = parse_tag(child);
                    match kind {
                        "chardata" => {
                            obj.insert(child.name.clone(), parse_scalar(child.typ.as_deref(), &chardata)?);
                        }
                        "comment" => {
                            obj.insert(child.name.clone(), parse_scalar(child.typ.as_deref(), &comment)?);
                        }
                        "any" => {
                            obj.insert(
                                child.name.clone(),
                                parse_scalar(child.typ.as_deref().or(Some("string")), &inner_raw)?,
                            );
                        }
                        _ => {}
                    }
                }
                if obj.is_empty() && !chardata.is_empty() {
                    return parse_scalar(schema.typ.as_deref(), &chardata);
                }
                return Ok(Value::Object(obj));
            }
            Some(Token::CharData(b)) => {
                chardata.extend_from_slice(&b);
            }
            Some(Token::Comment(b)) => {
                comment = b.clone();
            }
            Some(Token::Start { name, attr }) => {
                let tok = Token::Start {
                    name: name.clone(),
                    attr: attr.clone(),
                };
                if let Some(child) = children.iter().find(|c| {
                    let (n, _, parents, k, _) = parse_tag(c);
                    k == "element" && parents.is_empty() && n == name.local
                }) {
                    let val = unmarshal_element(dec, child, tok)?;
                    let key = if child.name.is_empty() {
                        name.local.clone()
                    } else {
                        child.name.clone()
                    };
                    insert_child(&mut obj, key, val);
                } else if let Some(child) = children.iter().find(|c| {
                    let (_, _, parents, k, _) = parse_tag(c);
                    k == "element" && parents.first().is_some_and(|p| p == &name.local)
                }) {
                    let (_, _, parents, _, _) = parse_tag(child);
                    let val = unmarshal_path(dec, &parents, child, tok)?;
                    let key = if child.name.is_empty() {
                        parse_tag(child).0
                    } else {
                        child.name.clone()
                    };
                    if !val.is_null() {
                        insert_child(&mut obj, key, val);
                    }
                } else if children.iter().any(|c| parse_tag(c).3 == "any") {
                    dec.skip()?;
                } else {
                    dec.skip()?;
                }
            }
            Some(_) => {}
        }
    }
}

fn token_to_json(t: &Token) -> Value {
    match t {
        Token::Start { name, attr } => json!({
            "type": "start",
            "name": { "space": name.space, "local": name.local },
            "attr": attr.iter().map(|a| json!({
                "name": { "space": a.name.space, "local": a.name.local },
                "value": a.value
            })).collect::<Vec<_>>()
        }),
        Token::End { name } => json!({
            "type": "end",
            "name": { "space": name.space, "local": name.local }
        }),
        Token::CharData(b) => json!({ "type": "chardata", "text": String::from_utf8_lossy(b) }),
        Token::Comment(b) => json!({ "type": "comment", "text": String::from_utf8_lossy(b) }),
        Token::ProcInst { target, inst } => json!({
            "type": "procinst",
            "target": target,
            "instHex": hex::encode(inst)
        }),
        Token::Directive(b) => json!({ "type": "directive", "text": String::from_utf8_lossy(b) }),
    }
}

fn token_from_json(v: &Value) -> Result<Token, XmlError> {
    let typ = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let name = |v: &Value| Name {
        space: v.pointer("/name/space").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        local: v.pointer("/name/local").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    };
    match typ {
        "start" => {
            let attr = v
                .get("attr")
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|a| Attr {
                    name: Name {
                        space: a.pointer("/name/space").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        local: a.pointer("/name/local").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    },
                    value: a.get("value").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                })
                .collect();
            Ok(Token::Start { name: name(v), attr })
        }
        "end" => Ok(Token::End { name: name(v) }),
        "chardata" => Ok(Token::CharData(
            v.get("text").and_then(|x| x.as_str()).unwrap_or("").as_bytes().to_vec(),
        )),
        "comment" => Ok(Token::Comment(
            v.get("text").and_then(|x| x.as_str()).unwrap_or("").as_bytes().to_vec(),
        )),
        "procinst" => {
            let inst = if let Some(h) = v.get("instHex").and_then(|x| x.as_str()) {
                hex::decode(h).unwrap_or_default()
            } else {
                v.get("inst").and_then(|x| x.as_str()).unwrap_or("").as_bytes().to_vec()
            };
            Ok(Token::ProcInst {
                target: v.get("target").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                inst,
            })
        }
        "directive" => Ok(Token::Directive(
            v.get("text").and_then(|x| x.as_str()).unwrap_or("").as_bytes().to_vec(),
        )),
        _ => Err(XmlError::other("xml: EncodeToken of invalid token type")),
    }
}

fn schema_from_json(s: &str) -> Result<Schema, XmlError> {
    serde_json::from_str(s).map_err(|e| XmlError::other(format!("xml: invalid schema: {e}")))
}

mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut out = String::with_capacity(bytes.len() * 2);
        for &b in bytes {
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0f) as usize] as char);
        }
        out
    }
    pub fn decode(s: &str) -> Result<Vec<u8>, ()> {
        if s.len() % 2 != 0 {
            return Err(());
        }
        let mut out = Vec::with_capacity(s.len() / 2);
        let bytes = s.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let hi = from_hex(bytes[i])?;
            let lo = from_hex(bytes[i + 1])?;
            out.push((hi << 4) | lo);
            i += 2;
        }
        Ok(out)
    }
    fn from_hex(b: u8) -> Result<u8, ()> {
        match b {
            b'0'..=b'9' => Ok(b - b'0'),
            b'a'..=b'f' => Ok(b - b'a' + 10),
            b'A'..=b'F' => Ok(b - b'A' + 10),
            _ => Err(()),
        }
    }
}

pub fn marshal(schema_json: &str, value_json: &str, prefix: &str, indent: &str) -> Result<Vec<u8>, XmlError> {
    let schema = schema_from_json(schema_json)?;
    let value: Value =
        serde_json::from_str(value_json).map_err(|e| XmlError::other(format!("xml: invalid value: {e}")))?;
    let mut enc = Encoder::new(prefix.to_string(), indent.to_string());
    marshal_value(&mut enc, &schema, &value)?;
    enc.close()?;
    Ok(enc.buf)
}

pub fn unmarshal(input: &[u8], schema_json: &str) -> Result<Value, XmlError> {
    let schema = schema_from_json(schema_json)?;
    let mut dec = Decoder::new(input.to_vec());
    dec.decode(&schema, None)
}

pub fn html_entity_json() -> String {
    let mut obj = serde_json::Map::new();
    for (k, v) in HTML_ENTITY_PAIRS {
        obj.insert((*k).to_string(), Value::String((*v).to_string()));
    }
    Value::Object(obj).to_string()
}

pub fn html_auto_close_json() -> String {
    json!(HTML_AUTO_CLOSE).to_string()
}



#[napi(object)]
pub struct NativeXmlPos {
    pub line: i32,
    pub column: i32,
}

#[napi]
pub struct NativeXmlDecoder {
    inner: Decoder,
}

#[napi]
impl NativeXmlDecoder {
    #[napi(constructor)]
    pub fn new(
        data: Uint8Array,
        strict: bool,
        auto_close: Vec<String>,
        entity_json: String,
        default_space: String,
        assume_utf8: bool,
    ) -> Self {
        let entity: HashMap<String, String> = if entity_json.is_empty() {
            HashMap::new()
        } else {
            serde_json::from_str(&entity_json).unwrap_or_default()
        };
        let mut inner = Decoder::new(data.to_vec());
        inner.set_options(strict, auto_close, entity, default_space, assume_utf8);
        Self { inner }
    }

    #[napi]
    pub fn token(&mut self) -> JsResult<Option<String>> {
        match self.inner.token() {
            Ok(None) => Ok(None),
            Ok(Some(t)) => Ok(Some(token_to_json(&t).to_string())),
            Err(e) => Err(e.to_napi()),
        }
    }

    #[napi]
    pub fn raw_token(&mut self) -> JsResult<Option<String>> {
        match self.inner.raw_token() {
            Ok(None) => Ok(None),
            Ok(Some(t)) => Ok(Some(token_to_json(&t).to_string())),
            Err(e) => Err(e.to_napi()),
        }
    }

    #[napi]
    pub fn skip(&mut self) -> JsResult<()> {
        self.inner.skip().map_err(|e| e.to_napi())
    }

    #[napi]
    pub fn decode(&mut self, schema_json: String, start_json: Option<String>) -> JsResult<String> {
        let schema = schema_from_json(&schema_json).map_err(|e| e.to_napi())?;
        let start = match start_json {
            Some(s) if !s.is_empty() => {
                let v: Value = serde_json::from_str(&s)
                    .map_err(|e| napi::Error::from_reason(format!("XmlError:{e}")))?;
                Some(token_from_json(&v).map_err(|e| e.to_napi())?)
            }
            _ => None,
        };
        let value = self.inner.decode(&schema, start).map_err(|e| e.to_napi())?;
        Ok(value.to_string())
    }

    #[napi]
    pub fn input_offset(&self) -> i64 {
        self.inner.input_offset()
    }

    #[napi]
    pub fn input_pos(&self) -> NativeXmlPos {
        let (line, column) = self.inner.input_pos();
        NativeXmlPos { line, column }
    }
}

#[napi]
pub struct NativeXmlEncoder {
    inner: Encoder,
}

#[napi]
impl NativeXmlEncoder {
    #[napi(constructor)]
    pub fn new(prefix: String, indent: String) -> Self {
        Self {
            inner: Encoder::new(prefix, indent),
        }
    }

    #[napi]
    pub fn encode_token(&mut self, token_json: String) -> JsResult<()> {
        let v: Value =
            serde_json::from_str(&token_json).map_err(|e| napi::Error::from_reason(format!("XmlError:{e}")))?;
        let t = token_from_json(&v).map_err(|e| e.to_napi())?;
        self.inner.encode_token(&t).map_err(|e| e.to_napi())
    }

    #[napi]
    pub fn encode(&mut self, schema_json: String, value_json: String) -> JsResult<()> {
        let schema = schema_from_json(&schema_json).map_err(|e| e.to_napi())?;
        let value: Value = serde_json::from_str(&value_json)
            .map_err(|e| napi::Error::from_reason(format!("XmlError:{e}")))?;
        marshal_value(&mut self.inner, &schema, &value).map_err(|e| e.to_napi())
    }

    #[napi]
    pub fn flush(&self) {}

    #[napi]
    pub fn bytes(&self) -> Uint8Array {
        self.inner.buf.clone().into()
    }
}

#[napi]
pub fn xml_escape(data: Uint8Array) -> Uint8Array {
    escape_text(data.as_ref(), true).into()
}

#[napi]
pub fn xml_marshal(schema_json: String, value_json: String, prefix: String, indent: String) -> JsResult<Uint8Array> {
    marshal(&schema_json, &value_json, &prefix, &indent)
        .map(Uint8Array::from)
        .map_err(|e| e.to_napi())
}

#[napi]
pub fn xml_unmarshal(data: Uint8Array, schema_json: String) -> JsResult<String> {
    unmarshal(data.as_ref(), &schema_json)
        .map(|v| v.to_string())
        .map_err(|e| e.to_napi())
}

#[napi]
pub fn xml_html_entity() -> String {
    html_entity_json()
}

#[napi]
pub fn xml_html_auto_close() -> String {
    html_auto_close_json()
}

#[napi]
pub fn xml_header_text() -> String {
    XML_HEADER.to_string()
}

#[allow(dead_code)]
fn _use_html_map() {
    let _ = html_entity_map();
}
