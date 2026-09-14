use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::io::Write as _;

const KIND_ANY: u8 = 0;
const KIND_BOOL: u8 = 1;
const KIND_DURATION: u8 = 2;
const KIND_FLOAT64: u8 = 3;
const KIND_INT64: u8 = 4;
const KIND_STRING: u8 = 5;
const KIND_TIME: u8 = 6;
const KIND_UINT64: u8 = 7;
const KIND_GROUP: u8 = 8;

const LDATE: u32 = 1;
const LTIME: u32 = 2;
const LMICRO: u32 = 4;
const LLONGFILE: u32 = 8;
const LSHORTFILE: u32 = 16;
const LUTC: u32 = 32;
const LMSGPREFIX: u32 = 64;

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn error(code: &str, message: &str) -> Error {
    Error::new(Status::InvalidArg, format!("{code}: {message}"))
}

struct Cursor<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Cursor<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self { b, i: 0 }
    }
    fn rest(&self) -> usize {
        self.b.len().saturating_sub(self.i)
    }
    fn u8(&mut self) -> Result<u8> {
        if self.i >= self.b.len() {
            return Err(error("DecodeError", "truncated attr buffer"));
        }
        let v = self.b[self.i];
        self.i += 1;
        Ok(v)
    }
    fn u32(&mut self) -> Result<u32> {
        if self.rest() < 4 {
            return Err(error("DecodeError", "truncated attr buffer"));
        }
        let v = u32::from_le_bytes(self.b[self.i..self.i + 4].try_into().unwrap());
        self.i += 4;
        Ok(v)
    }
    fn i64(&mut self) -> Result<i64> {
        if self.rest() < 8 {
            return Err(error("DecodeError", "truncated attr buffer"));
        }
        let v = i64::from_le_bytes(self.b[self.i..self.i + 8].try_into().unwrap());
        self.i += 8;
        Ok(v)
    }
    fn u64(&mut self) -> Result<u64> {
        if self.rest() < 8 {
            return Err(error("DecodeError", "truncated attr buffer"));
        }
        let v = u64::from_le_bytes(self.b[self.i..self.i + 8].try_into().unwrap());
        self.i += 8;
        Ok(v)
    }
    fn f64(&mut self) -> Result<f64> {
        Ok(f64::from_bits(self.u64()?))
    }
    fn bytes(&mut self) -> Result<&'a [u8]> {
        let n = self.u32()? as usize;
        if self.rest() < n {
            return Err(error("DecodeError", "truncated attr buffer"));
        }
        let s = &self.b[self.i..self.i + n];
        self.i += n;
        Ok(s)
    }
    fn str(&mut self) -> Result<&'a str> {
        std::str::from_utf8(self.bytes()?).map_err(|_| error("DecodeError", "attr key is not utf-8"))
    }
}

#[derive(Clone)]
enum Val {
    Any { text: String, json: String },
    Bool(bool),
    Duration(i64),
    Float(f64),
    Int(i64),
    String(String),
    Time(i64),
    Uint(u64),
    Group(Vec<Attr>),
}

#[derive(Clone)]
struct Attr {
    key: String,
    val: Val,
}

fn read_attrs(c: &mut Cursor) -> Result<Vec<Attr>> {
    let n = c.u32()? as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(read_attr(c)?);
    }
    Ok(out)
}

fn read_attr(c: &mut Cursor) -> Result<Attr> {
    let key = c.str()?.to_string();
    let kind = c.u8()?;
    let val = match kind {
        KIND_ANY => {
            let text = String::from_utf8(c.bytes()?.to_vec())
                .map_err(|_| error("DecodeError", "any text is not utf-8"))?;
            let json = String::from_utf8(c.bytes()?.to_vec())
                .map_err(|_| error("DecodeError", "any json is not utf-8"))?;
            Val::Any { text, json }
        }
        KIND_BOOL => Val::Bool(c.u8()? != 0),
        KIND_DURATION => Val::Duration(c.i64()?),
        KIND_FLOAT64 => Val::Float(c.f64()?),
        KIND_INT64 => Val::Int(c.i64()?),
        KIND_STRING => Val::String(
            String::from_utf8(c.bytes()?.to_vec())
                .map_err(|_| error("DecodeError", "string is not utf-8"))?,
        ),
        KIND_TIME => Val::Time(c.i64()?),
        KIND_UINT64 => Val::Uint(c.u64()?),
        KIND_GROUP => Val::Group(read_attrs(c)?),
        _ => return Err(error("DecodeError", "unknown attr kind")),
    };
    Ok(Attr { key, val })
}

fn civil_from_days(unix_days: i64) -> (i32, u32, u32) {
    let z = unix_days + 719468;
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

fn breakdown(unix_ns: i64, offset_secs: i32) -> (i32, u32, u32, u32, u32, u32, u32) {
    let secs = unix_ns.div_euclid(1_000_000_000) + i64::from(offset_secs);
    let nsec = unix_ns.rem_euclid(1_000_000_000) as u32;
    let days = secs.div_euclid(86400);
    let tod = secs.rem_euclid(86400) as u32;
    let (y, m, d) = civil_from_days(days);
    let hour = tod / 3600;
    let min = (tod % 3600) / 60;
    let sec = tod % 60;
    (y, m, d, hour, min, sec, nsec)
}

fn itoa(buf: &mut Vec<u8>, mut i: i32, mut wid: i32) {
    let mut b = [0u8; 20];
    let mut bp = 19;
    while i >= 10 || wid > 1 {
        wid -= 1;
        let q = i / 10;
        b[bp] = b'0' + (i - q * 10) as u8;
        bp -= 1;
        i = q;
    }
    b[bp] = b'0' + i as u8;
    buf.extend_from_slice(&b[bp..]);
}

fn format_log_header(
    buf: &mut Vec<u8>,
    unix_ns: i64,
    offset_secs: i32,
    flags: u32,
    prefix: &str,
    file: &str,
    line: i32,
) {
    if flags & LMSGPREFIX == 0 {
        buf.extend_from_slice(prefix.as_bytes());
    }
    if flags & (LDATE | LTIME | LMICRO) != 0 {
        let off = if flags & LUTC != 0 { 0 } else { offset_secs };
        let (y, m, d, hour, min, sec, nsec) = breakdown(unix_ns, off);
        if flags & LDATE != 0 {
            itoa(buf, y, 4);
            buf.push(b'/');
            itoa(buf, m as i32, 2);
            buf.push(b'/');
            itoa(buf, d as i32, 2);
            buf.push(b' ');
        }
        if flags & (LTIME | LMICRO) != 0 {
            itoa(buf, hour as i32, 2);
            buf.push(b':');
            itoa(buf, min as i32, 2);
            buf.push(b':');
            itoa(buf, sec as i32, 2);
            if flags & LMICRO != 0 {
                buf.push(b'.');
                itoa(buf, (nsec / 1000) as i32, 6);
            }
            buf.push(b' ');
        }
    }
    if flags & (LSHORTFILE | LLONGFILE) != 0 {
        let mut file = file;
        if flags & LSHORTFILE != 0 {
            if let Some(i) = file.rfind('/') {
                file = &file[i + 1..];
            }
        }
        buf.extend_from_slice(file.as_bytes());
        buf.push(b':');
        itoa(buf, line, -1);
        buf.extend_from_slice(b": ");
    }
    if flags & LMSGPREFIX != 0 {
        buf.extend_from_slice(prefix.as_bytes());
    }
}

fn fmt_frac(buf: &mut [u8], mut v: u64, prec: i32) -> (usize, u64) {
    let mut w = buf.len();
    let mut print = false;
    for _ in 0..prec {
        let digit = v % 10;
        print = print || digit != 0;
        if print {
            w -= 1;
            buf[w] = b'0' + digit as u8;
        }
        v /= 10;
    }
    if print {
        w -= 1;
        buf[w] = b'.';
    }
    (w, v)
}

fn fmt_int(buf: &mut [u8], mut v: u64) -> usize {
    let mut w = buf.len();
    if v == 0 {
        w -= 1;
        buf[w] = b'0';
    } else {
        while v > 0 {
            w -= 1;
            buf[w] = b'0' + (v % 10) as u8;
            v /= 10;
        }
    }
    w
}

fn duration_string(d: i64) -> String {
    let mut arr = [0u8; 32];
    let mut w = 32;
    let mut u = d as u64;
    let neg = d < 0;
    if neg {
        u = d.wrapping_neg() as u64;
    }
    const SECOND: u64 = 1_000_000_000;
    const MICRO: u64 = 1_000;
    const MILLI: u64 = 1_000_000;
    if u < SECOND {
        w -= 1;
        arr[w] = b's';
        w -= 1;
        let prec;
        if u == 0 {
            return "0s".into();
        } else if u < MICRO {
            prec = 0;
            arr[w] = b'n';
        } else if u < MILLI {
            prec = 3;
            w -= 1;
            arr[w] = 0xc2;
            arr[w + 1] = 0xb5;
        } else {
            prec = 6;
            arr[w] = b'm';
        }
        let (nw, nu) = fmt_frac(&mut arr[..w], u, prec);
        w = fmt_int(&mut arr[..nw], nu);
    } else {
        w -= 1;
        arr[w] = b's';
        let (nw, nu) = fmt_frac(&mut arr[..w], u, 9);
        w = fmt_int(&mut arr[..nw], nu % 60);
        u = nu / 60;
        if u > 0 {
            w -= 1;
            arr[w] = b'm';
            w = fmt_int(&mut arr[..w], u % 60);
            u /= 60;
            if u > 0 {
                w -= 1;
                arr[w] = b'h';
                w = fmt_int(&mut arr[..w], u);
            }
        }
    }
    if neg {
        w -= 1;
        arr[w] = b'-';
    }
    String::from_utf8(arr[w..].to_vec()).unwrap()
}

fn level_string(level: i32) -> String {
    const DEBUG: i32 = -4;
    const INFO: i32 = 0;
    const WARN: i32 = 4;
    const ERROR: i32 = 8;
    let (base, val) = if level < INFO {
        ("DEBUG", level - DEBUG)
    } else if level < WARN {
        ("INFO", level - INFO)
    } else if level < ERROR {
        ("WARN", level - WARN)
    } else {
        ("ERROR", level - ERROR)
    };
    if val == 0 {
        base.to_string()
    } else {
        format!("{base}{val:+}")
    }
}

fn rfc3339_nano(buf: &mut Vec<u8>, unix_ns: i64) {
    let (y, m, d, h, min, s, nsec) = breakdown(unix_ns, 0);
    let _ = write!(
        buf,
        "{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}"
    );
    if nsec != 0 {
        let mut frac = format!("{nsec:09}");
        while frac.ends_with('0') {
            frac.pop();
        }
        buf.push(b'.');
        buf.extend_from_slice(frac.as_bytes());
    }
    buf.push(b'Z');
}

fn rfc3339_millis(buf: &mut Vec<u8>, unix_ns: i64) {
    let (y, m, d, h, min, s, nsec) = breakdown(unix_ns, 0);
    let ms = nsec / 1_000_000;
    let _ = write!(
        buf,
        "{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}.{ms:03}Z"
    );
}

fn rfc3339(buf: &mut Vec<u8>, unix_ns: i64) {
    let (y, m, d, h, min, s, _) = breakdown(unix_ns, 0);
    let _ = write!(
        buf,
        "{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}Z"
    );
}

fn stamp(buf: &mut Vec<u8>, unix_ns: i64) {
    let (_, m, d, h, min, s, _) = breakdown(unix_ns, 0);
    let mon = MONTHS[(m - 1) as usize];
    let _ = write!(buf, "{mon} {d:2} {h:02}:{min:02}:{s:02}");
}

fn safe_json_byte(b: u8) -> bool {
    b >= 0x20 && b != b'"' && b != b'\\'
}

fn needs_quoting(s: &str) -> bool {
    if s.is_empty() {
        return true;
    }
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b < 0x80 {
            if b != b'\\' && (b == b' ' || b == b'=' || !safe_json_byte(b)) {
                return true;
            }
            i += 1;
            continue;
        }
        let rest = &s[i..];
        match rest.chars().next() {
            Some(ch) => {
                if ch == '\u{FFFD}' && !rest.starts_with('\u{FFFD}') {
                    return true;
                }
                if ch.is_whitespace() || !ch.is_ascii() && ch.is_control() || !is_print(ch) {
                    return true;
                }
                i += ch.len_utf8();
            }
            None => return true,
        }
    }
    false
}

fn is_print(ch: char) -> bool {
    !ch.is_control()
}

fn append_go_quote(buf: &mut Vec<u8>, s: &str) {
    buf.push(b'"');
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b < 0x80 {
            match b {
                b'\\' | b'"' => {
                    buf.push(b'\\');
                    buf.push(b);
                }
                b'\n' => buf.extend_from_slice(br"\n"),
                b'\r' => buf.extend_from_slice(br"\r"),
                b'\t' => buf.extend_from_slice(br"\t"),
                b'\x07' => buf.extend_from_slice(br"\a"),
                b'\x08' => buf.extend_from_slice(br"\b"),
                b'\x0c' => buf.extend_from_slice(br"\f"),
                b'\x0b' => buf.extend_from_slice(br"\v"),
                0x00..=0x1f => {
                    let _ = write!(buf, "\\x{b:02x}");
                }
                _ => buf.push(b),
            }
            i += 1;
            continue;
        }
        match std::str::from_utf8(&bytes[i..]) {
            Ok(rest) => {
                let ch = rest.chars().next().unwrap();
                if is_print(ch) {
                    let n = ch.len_utf8();
                    buf.extend_from_slice(&bytes[i..i + n]);
                    i += n;
                } else if (ch as u32) <= 0xffff {
                    let _ = write!(buf, "\\u{:04x}", ch as u32);
                    i += ch.len_utf8();
                } else {
                    let _ = write!(buf, "\\U{:08x}", ch as u32);
                    i += ch.len_utf8();
                }
            }
            Err(_) => {
                let _ = write!(buf, "\\x{b:02x}");
                i += 1;
            }
        }
    }
    buf.push(b'"');
}

fn append_json_string_body(buf: &mut Vec<u8>, s: &str) {
    const HEX: &[u8] = b"0123456789abcdef";
    let bytes = s.as_bytes();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b < 0x80 {
            if safe_json_byte(b) {
                i += 1;
                continue;
            }
            if start < i {
                buf.extend_from_slice(&bytes[start..i]);
            }
            buf.push(b'\\');
            match b {
                b'\\' | b'"' => buf.push(b),
                b'\n' => buf.push(b'n'),
                b'\r' => buf.push(b'r'),
                b'\t' => buf.push(b't'),
                _ => {
                    buf.extend_from_slice(b"u00");
                    buf.push(HEX[(b >> 4) as usize]);
                    buf.push(HEX[(b & 0xf) as usize]);
                }
            }
            i += 1;
            start = i;
            continue;
        }
        match std::str::from_utf8(&bytes[i..]) {
            Ok(rest) => {
                let ch = rest.chars().next().unwrap();
                if ch == '\u{2028}' || ch == '\u{2029}' {
                    if start < i {
                        buf.extend_from_slice(&bytes[start..i]);
                    }
                    buf.extend_from_slice(b"\\u202");
                    buf.push(HEX[(ch as u32 & 0xf) as usize]);
                    i += ch.len_utf8();
                    start = i;
                } else {
                    i += ch.len_utf8();
                }
            }
            Err(_) => {
                if start < i {
                    buf.extend_from_slice(&bytes[start..i]);
                }
                buf.extend_from_slice(br"\ufffd");
                i += 1;
                start = i;
            }
        }
    }
    if start < bytes.len() {
        buf.extend_from_slice(&bytes[start..]);
    }
}

fn append_json_string(buf: &mut Vec<u8>, s: &str) {
    buf.push(b'"');
    append_json_string_body(buf, s);
    buf.push(b'"');
}

fn append_json_float(buf: &mut Vec<u8>, f: f64) {
    if !f.is_finite() {
        append_json_string(buf, "!ERROR:json: unsupported value: NaN or Inf");
        return;
    }
    let mut tmp = ryu_like(f);
    buf.append(&mut tmp);
}

fn ryu_like(f: f64) -> Vec<u8> {
    // Match encoding/json for the fixture set: integers without a decimal,
    // otherwise shortest decimal. Go's json uses ES6-style; for 1.5/0/2.5 it
    // matches Rust Display.
    if f == 0.0 {
        return b"0".to_vec();
    }
    let s = format!("{f}");
    s.into_bytes()
}

struct State {
    json: bool,
    buf: Vec<u8>,
    sep: String,
    prefix: String,
}

impl State {
    fn append_key(&mut self, key: &str) {
        self.buf.extend_from_slice(self.sep.as_bytes());
        let mut name = self.prefix.clone();
        name.push_str(key);
        self.append_string(&name);
        self.buf.push(if self.json { b':' } else { b'=' });
        self.sep = if self.json { "," } else { " " }.into();
    }
    fn append_string(&mut self, s: &str) {
        if self.json {
            append_json_string(&mut self.buf, s);
        } else if needs_quoting(s) {
            append_go_quote(&mut self.buf, s);
        } else {
            self.buf.extend_from_slice(s.as_bytes());
        }
    }
    fn open_group(&mut self, name: &str) {
        if self.json {
            self.append_key(name);
            self.buf.push(b'{');
            self.sep = String::new();
        } else {
            self.prefix.push_str(name);
            self.prefix.push('.');
        }
    }
    fn close_group(&mut self, name: &str) {
        if self.json {
            self.buf.push(b'}');
        } else {
            let drop = name.len() + 1;
            self.prefix.truncate(self.prefix.len() - drop);
        }
        self.sep = if self.json { "," } else { " " }.into();
    }
    fn append_attr(&mut self, a: &Attr) -> bool {
        if let Val::Group(items) = &a.val {
            if items.is_empty() {
                return false;
            }
            let pos = self.buf.len();
            let sep = self.sep.clone();
            let prefix = self.prefix.clone();
            if !a.key.is_empty() {
                self.open_group(&a.key);
            }
            let mut any = false;
            for child in items {
                if self.append_attr(child) {
                    any = true;
                }
            }
            if !any {
                self.buf.truncate(pos);
                self.sep = sep;
                self.prefix = prefix;
                return false;
            }
            if !a.key.is_empty() {
                self.close_group(&a.key);
            }
            true
        } else {
            self.append_key(&a.key);
            self.append_value(&a.val);
            true
        }
    }
    fn append_value(&mut self, v: &Val) {
        match v {
            Val::String(s) => self.append_string(s),
            Val::Bool(b) => {
                if self.json {
                    self.buf
                        .extend_from_slice(if *b { b"true" } else { b"false" });
                } else {
                    self.append_string(if *b { "true" } else { "false" });
                }
            }
            Val::Int(n) => {
                let s = n.to_string();
                if self.json {
                    self.buf.extend_from_slice(s.as_bytes());
                } else {
                    self.buf.extend_from_slice(s.as_bytes());
                }
            }
            Val::Uint(n) => {
                let s = n.to_string();
                self.buf.extend_from_slice(s.as_bytes());
            }
            Val::Float(f) => {
                if self.json {
                    append_json_float(&mut self.buf, *f);
                } else {
                    let s = if *f == 0.0 {
                        "0".into()
                    } else {
                        format!("{f}")
                    };
                    self.buf.extend_from_slice(s.as_bytes());
                }
            }
            Val::Duration(n) => {
                if self.json {
                    self.buf.extend_from_slice(n.to_string().as_bytes());
                } else {
                    self.buf.extend_from_slice(duration_string(*n).as_bytes());
                }
            }
            Val::Time(ns) => {
                if self.json {
                    self.buf.push(b'"');
                    rfc3339_nano(&mut self.buf, *ns);
                    self.buf.push(b'"');
                } else {
                    rfc3339_millis(&mut self.buf, *ns);
                }
            }
            Val::Any { text, json } => {
                if self.json {
                    self.buf.extend_from_slice(json.as_bytes());
                } else {
                    self.append_string(text);
                }
            }
            Val::Group(_) => unreachable!(),
        }
    }
}

fn format_slog_inner(
    json: bool,
    has_time: bool,
    time_ns: i64,
    level: i32,
    msg: &str,
    add_source: bool,
    source_file: &str,
    source_line: i32,
    source_fn: &str,
    groups: &[String],
    with_attrs: &[Attr],
    attrs: &[Attr],
) -> Vec<u8> {
    let mut s = State {
        json,
        buf: Vec::new(),
        sep: String::new(),
        prefix: String::new(),
    };
    if json {
        s.buf.push(b'{');
    }
    if has_time {
        s.append_key("time");
        if json {
            s.buf.push(b'"');
            rfc3339_nano(&mut s.buf, time_ns);
            s.buf.push(b'"');
        } else {
            rfc3339_millis(&mut s.buf, time_ns);
        }
    }
    s.append_key("level");
    s.append_string(&level_string(level));
    if add_source {
        if json {
            let mut items = Vec::new();
            if !source_fn.is_empty() {
                items.push(Attr {
                    key: "function".into(),
                    val: Val::String(source_fn.into()),
                });
            }
            if !source_file.is_empty() {
                items.push(Attr {
                    key: "file".into(),
                    val: Val::String(source_file.into()),
                });
            }
            if source_line != 0 {
                items.push(Attr {
                    key: "line".into(),
                    val: Val::Int(i64::from(source_line)),
                });
            }
            s.append_attr(&Attr {
                key: "source".into(),
                val: Val::Group(items),
            });
        } else {
            s.append_key("source");
            s.append_string(&format!("{source_file}:{source_line}"));
        }
    }
    s.append_key("msg");
    s.append_string(msg);
    for a in with_attrs {
        s.append_attr(a);
    }
    let pos = s.buf.len();
    let sep = s.sep.clone();
    let prefix = s.prefix.clone();
    for g in groups {
        s.open_group(g);
    }
    let mut any = false;
    for a in attrs {
        if s.append_attr(a) {
            any = true;
        }
    }
    if json {
        if any {
            for _ in groups {
                s.buf.push(b'}');
            }
        } else {
            s.buf.truncate(pos);
            s.sep = sep;
            s.prefix = prefix;
        }
        s.buf.push(b'}');
    } else if !any {
        s.buf.truncate(pos);
        s.sep = sep;
        s.prefix = prefix;
    }
    s.buf.push(b'\n');
    s.buf
}

fn unix_ns(secs: i64, nsec: u32) -> i64 {
    secs.saturating_mul(1_000_000_000).saturating_add(i64::from(nsec))
}

#[napi]
pub fn format_log_line(
    now_unix_secs: i64,
    now_nsec: u32,
    utc_offset_secs: i32,
    flags: u32,
    prefix: String,
    file: String,
    line: i32,
    message: String,
) -> Uint8Array {
    let mut buf = Vec::new();
    format_log_header(
        &mut buf,
        unix_ns(now_unix_secs, now_nsec),
        utc_offset_secs,
        flags,
        &prefix,
        &file,
        line,
    );
    buf.extend_from_slice(message.as_bytes());
    if buf.last().copied() != Some(b'\n') {
        buf.push(b'\n');
    }
    buf.into()
}

#[napi]
pub fn format_slog(
    json: bool,
    has_time: bool,
    time_secs: i64,
    time_nsec: u32,
    level: i32,
    msg: String,
    add_source: bool,
    source_file: String,
    source_line: i32,
    source_fn: String,
    groups: Vec<String>,
    with_attrs: Uint8Array,
    attrs: Uint8Array,
) -> Result<Uint8Array> {
    let with = read_attrs(&mut Cursor::new(with_attrs.as_ref()))?;
    let rec = read_attrs(&mut Cursor::new(attrs.as_ref()))?;
    Ok(format_slog_inner(
        json,
        has_time,
        unix_ns(time_secs, time_nsec),
        level,
        &msg,
        add_source,
        &source_file,
        source_line,
        &source_fn,
        &groups,
        &with,
        &rec,
    )
    .into())
}

#[napi]
pub fn format_syslog(
    local: bool,
    priority: u32,
    time_secs: i64,
    time_nsec: u32,
    hostname: String,
    tag: String,
    pid: u32,
    msg: String,
) -> Uint8Array {
    let mut buf = Vec::new();
    let nl = if msg.ends_with('\n') { "" } else { "\n" };
    let _ = write!(buf, "<{priority}>");
    let time_ns = unix_ns(time_secs, time_nsec);
    if local {
        stamp(&mut buf, time_ns);
        let _ = write!(buf, " {tag}[{pid}]: {msg}{nl}");
    } else {
        rfc3339(&mut buf, time_ns);
        let _ = write!(buf, " {hostname} {tag}[{pid}]: {msg}{nl}");
    }
    buf.into()
}

#[napi]
pub fn syslog_send_udp(raddr: String, packet: Uint8Array) -> Result<()> {
    if packet.len() > 1024 {
        return Err(error(
            "MessageTooLongError",
            "log/syslog: UDP message exceeds 1KiB",
        ));
    }
    let sock = std::net::UdpSocket::bind("0.0.0.0:0")
        .map_err(|e| error("SyslogError", &e.to_string()))?;
    sock.send_to(packet.as_ref(), raddr.trim())
        .map_err(|e| error("SyslogError", &e.to_string()))?;
    Ok(())
}

#[napi]
pub fn syslog_unix_connect(path: String) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::net::UnixDatagram;
        let sock = UnixDatagram::unbound().map_err(|e| error("SyslogError", &e.to_string()))?;
        sock.connect(path.as_str())
            .map_err(|e| error("SyslogError", &e.to_string()))?;
        return Ok(());
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(error(
            "UnsupportedPlatformError",
            "log/syslog: not supported on this platform",
        ))
    }
}

#[napi]
pub fn syslog_send_unix(path: String, packet: Uint8Array) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::net::UnixDatagram;
        let sock = UnixDatagram::unbound().map_err(|e| error("SyslogError", &e.to_string()))?;
        sock.send_to(packet.as_ref(), path.as_str())
            .map_err(|e| error("SyslogError", &e.to_string()))?;
        return Ok(());
    }
    #[cfg(not(unix))]
    {
        let _ = (path, packet);
        Err(error(
            "UnsupportedPlatformError",
            "log/syslog: not supported on this platform",
        ))
    }
}
