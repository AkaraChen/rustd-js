use crate::error::{FormatError, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const BLOCK: usize = 512;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Entry {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub size: u64,
    pub mode: u32,
    #[serde(default)]
    pub uid: u64,
    #[serde(default)]
    pub gid: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub linkname: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub uname: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub gname: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub pax: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typeflag: Option<String>,
    #[serde(skip)]
    pub data: Vec<u8>,
}

fn type_name(flag: u8) -> String {
    match flag {
        b'0' | 0 => "reg".into(),
        b'1' => "hardlink".into(),
        b'2' => "symlink".into(),
        b'3' => "char".into(),
        b'4' => "block".into(),
        b'5' => "dir".into(),
        b'6' => "fifo".into(),
        b'g' => "x-global-header".into(),
        b'x' => "x-header".into(),
        other => format!("{}", other as char),
    }
}

fn typeflag(name: &str, filename: &str) -> u8 {
    match name {
        "reg" | "" => {
            if filename.ends_with('/') {
                b'5'
            } else {
                b'0'
            }
        }
        "hardlink" => b'1',
        "symlink" => b'2',
        "char" => b'3',
        "block" => b'4',
        "dir" => b'5',
        "fifo" => b'6',
        "x-global-header" => b'g',
        other if other.len() == 1 => other.as_bytes()[0],
        _ => b'0',
    }
}

fn parse_string(b: &[u8]) -> String {
    match b.iter().position(|&c| c == 0) {
        Some(i) => String::from_utf8_lossy(&b[..i]).into_owned(),
        None => String::from_utf8_lossy(b).into_owned(),
    }
}

fn parse_octal(b: &[u8]) -> Result<u64> {
    if b.first().is_some_and(|c| c & 0x80 != 0) {
        return parse_base256(b);
    }
    let s = b.iter().copied().take_while(|&c| c != 0 && c != b' ').collect::<Vec<_>>();
    let t = std::str::from_utf8(&s).unwrap_or("").trim();
    if t.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(t, 8).map_err(|_| FormatError::tar(0, "archive/tar: invalid tar header"))
}

fn parse_base256(b: &[u8]) -> Result<u64> {
    let mut inv = 0u8;
    if b[0] & 0x40 != 0 {
        inv = 0xff;
    }
    let mut x: u64 = 0;
    for (i, &c) in b.iter().enumerate() {
        let mut c = c ^ inv;
        if i == 0 {
            c &= 0x7f;
        }
        if x > u64::MAX >> 8 {
            return Err(FormatError::tar(0, "archive/tar: invalid tar header"));
        }
        x = (x << 8) | u64::from(c);
    }
    if inv != 0 {
        return Err(FormatError::tar(0, "archive/tar: invalid tar header"));
    }
    Ok(x)
}

fn format_octal(dst: &mut [u8], value: u64) {
    let s = format!("{value:o}");
    dst.fill(0);
    if s.len() + 1 <= dst.len() {
        let start = dst.len() - s.len() - 1;
        dst[..start].fill(b'0');
        dst[start..start + s.len()].copy_from_slice(s.as_bytes());
        dst[dst.len() - 1] = b' ';
    } else {
        // GNU base-256: high bit set, rest big-endian.
        dst[0] = 0x80;
        let mut v = value;
        for i in (1..dst.len()).rev() {
            dst[i] = (v & 0xff) as u8;
            v >>= 8;
        }
    }
}

fn format_string(dst: &mut [u8], s: &str) {
    dst.fill(0);
    let bytes = s.as_bytes();
    let n = bytes.len().min(dst.len());
    dst[..n].copy_from_slice(&bytes[..n]);
}

fn checksum(block: &[u8; BLOCK]) -> u64 {
    let mut sum = 0u64;
    for (i, &b) in block.iter().enumerate() {
        let v = if (148..156).contains(&i) { b' ' } else { b };
        sum += u64::from(v);
    }
    sum
}

fn write_checksum(block: &mut [u8; BLOCK]) {
    let sum = checksum(block);
    let s = format!("{sum:06o}");
    block[148..154].copy_from_slice(s.as_bytes());
    block[154] = 0;
    block[155] = b' ';
}

fn pad_size(n: u64) -> usize {
    let rem = (n % BLOCK as u64) as usize;
    if rem == 0 {
        0
    } else {
        BLOCK - rem
    }
}

fn format_pax_record(k: &str, v: &str) -> String {
    let padding = 3;
    let mut size = k.len() + v.len() + padding;
    size += size.to_string().len();
    let mut record = format!("{size} {k}={v}\n");
    if record.len() != size {
        size = record.len();
        record = format!("{size} {k}={v}\n");
    }
    record
}

/// Parse a PAX timestamp (`%d.%d`) the same way Go `archive/tar.parsePAXTime` does.
/// Returns milliseconds since Unix epoch (sub-millisecond fraction kept in the f64).
fn parse_pax_time_ms(s: &str) -> Result<f64> {
    const MAX_NANO_DIGITS: usize = 9;
    let (ss, sn) = match s.split_once('.') {
        Some((a, b)) => (a, b),
        None => (s, ""),
    };
    let secs: i64 = ss
        .parse()
        .map_err(|_| FormatError::tar(0, "archive/tar: invalid tar header"))?;
    if sn.is_empty() {
        return Ok(secs as f64 * 1000.0);
    }
    if !sn.bytes().all(|c| c.is_ascii_digit()) {
        return Err(FormatError::tar(0, "archive/tar: invalid tar header"));
    }
    let mut nano = sn.to_string();
    if nano.len() < MAX_NANO_DIGITS {
        nano.extend(std::iter::repeat('0').take(MAX_NANO_DIGITS - nano.len()));
    } else {
        nano.truncate(MAX_NANO_DIGITS);
    }
    let nsecs: i64 = nano
        .parse()
        .map_err(|_| FormatError::tar(0, "archive/tar: invalid tar header"))?;
    let nsecs = if ss.starts_with('-') { -nsecs } else { nsecs };
    let (secs, nsecs) = normalize_unix(secs, nsecs);
    // Match Go `Time.UnixMilli`: integer milliseconds, sub-ms discarded.
    Ok(secs as f64 * 1000.0 + (nsecs / 1_000_000) as f64)
}

fn normalize_unix(mut secs: i64, mut nsecs: i64) -> (i64, i64) {
    const E9: i64 = 1_000_000_000;
    if nsecs < 0 || nsecs >= E9 {
        let n = nsecs / E9;
        secs += n;
        nsecs -= n * E9;
        if nsecs < 0 {
            nsecs += E9;
            secs -= 1;
        }
    }
    (secs, nsecs)
}

/// Format milliseconds as Go `archive/tar.formatPAXTime` (`time.UnixMilli`).
fn format_pax_time_ms(ms: f64) -> String {
    let msec = ms.trunc() as i64;
    let mut secs = msec / 1000;
    let mut nsecs = (msec % 1000) * 1_000_000;
    if nsecs < 0 {
        secs -= 1;
        nsecs += 1_000_000_000;
    }
    if nsecs == 0 {
        return format!("{secs}");
    }
    let (sign, secs_fmt, nsecs_fmt) = if secs < 0 {
        ("-", -(secs + 1), -(nsecs - 1_000_000_000))
    } else {
        ("", secs, nsecs)
    };
    format!("{sign}{secs_fmt}.{nsecs_fmt:09}")
        .trim_end_matches('0')
        .to_string()
}

fn mtime_needs_pax(mtime_ms: Option<f64>) -> bool {
    let Some(ms) = mtime_ms else {
        return false;
    };
    let msec = ms.trunc() as i64;
    let secs = msec / 1000;
    let nsecs = (msec % 1000) * 1_000_000;
    nsecs != 0 || secs < 0 || secs > 0o77777777777
}

fn parse_pax(body: &[u8]) -> Result<BTreeMap<String, String>> {
    let mut map = BTreeMap::new();
    let mut s = std::str::from_utf8(body).map_err(|_| FormatError::tar(0, "archive/tar: invalid tar header"))?;
    while !s.is_empty() {
        let Some((n_str, rest)) = s.split_once(' ') else {
            return Err(FormatError::tar(0, "archive/tar: invalid tar header"));
        };
        let n: usize = n_str.parse().map_err(|_| FormatError::tar(0, "archive/tar: invalid tar header"))?;
        if n < 5 || n > s.len() {
            return Err(FormatError::tar(0, "archive/tar: invalid tar header"));
        }
        let rec_len = n - (n_str.len() + 1);
        if rec_len == 0 || rec_len > rest.len() {
            return Err(FormatError::tar(0, "archive/tar: invalid tar header"));
        }
        let rec = &rest[..rec_len];
        if !rec.ends_with('\n') {
            return Err(FormatError::tar(0, "archive/tar: invalid tar header"));
        }
        let rec = &rec[..rec.len() - 1];
        let Some((k, v)) = rec.split_once('=') else {
            return Err(FormatError::tar(0, "archive/tar: invalid tar header"));
        };
        map.insert(k.to_string(), v.to_string());
        s = &rest[rec_len..];
    }
    Ok(map)
}

fn needs_pax(e: &Entry) -> bool {
    e.name.len() > 100
        || e.linkname.len() > 100
        || e.uname.len() > 31
        || e.gname.len() > 31
        || e.size > 0o77777777777
        || e.uid > 0o7777777
        || e.gid > 0o7777777
        || !e.name.is_ascii()
        || !e.linkname.is_ascii()
        || !e.pax.is_empty()
        || mtime_needs_pax(e.mtime_ms)
}

fn split_ustar(name: &str) -> Option<(String, String)> {
    if name.len() <= 100 {
        return None;
    }
    let bytes = name.as_bytes();
    if bytes.len() > 256 {
        return None;
    }
    for i in 1..=155 {
        if bytes.len() <= i {
            break;
        }
        if bytes[i] == b'/' && bytes.len() - i - 1 <= 100 {
            return Some((
                String::from_utf8_lossy(&bytes[..i]).into_owned(),
                String::from_utf8_lossy(&bytes[i + 1..]).into_owned(),
            ));
        }
    }
    None
}

fn write_header_block(e: &Entry, name: &str, linkname: &str, size: u64, flag: u8) -> [u8; BLOCK] {
    let mut b = [0u8; BLOCK];
    if let Some((prefix, rest)) = split_ustar(name) {
        format_string(&mut b[0..100], &rest);
        format_string(&mut b[345..500], &prefix);
    } else {
        format_string(&mut b[0..100], &name.chars().take(100).collect::<String>());
    }
    format_octal(&mut b[100..108], u64::from(e.mode));
    format_octal(&mut b[108..116], e.uid);
    format_octal(&mut b[116..124], e.gid);
    format_octal(&mut b[124..136], size);
    let mtime = e.mtime_ms.map(|ms| (ms / 1000.0).floor() as i64).unwrap_or(0).max(0) as u64;
    format_octal(&mut b[136..148], mtime);
    b[156] = flag;
    format_string(&mut b[157..257], &linkname.chars().take(100).collect::<String>());
    b[257..263].copy_from_slice(b"ustar\0");
    b[263] = b'0';
    b[264] = b'0';
    format_string(&mut b[265..297], &e.uname.chars().take(31).collect::<String>());
    format_string(&mut b[297..329], &e.gname.chars().take(31).collect::<String>());
    write_checksum(&mut b);
    b
}

fn write_pax_header(next_name: &str, records: &BTreeMap<String, String>) -> Vec<u8> {
    let mut body = String::new();
    for (k, v) in records {
        body.push_str(&format_pax_record(k, v));
    }
    let mut dummy = Entry { name: format!("./PaxHeaders.0/{next_name}"), type_name: "x-header".into(), mode: 0o644, ..Entry::default() };
    dummy.name = dummy.name.chars().take(100).collect();
    let hdr = write_header_block(&dummy, &dummy.name, "", body.len() as u64, b'x');
    let mut out = hdr.to_vec();
    out.extend_from_slice(body.as_bytes());
    out.extend(std::iter::repeat(0).take(pad_size(body.len() as u64)));
    out
}

pub fn create(entries: &[Entry]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    for e in entries {
        let flag = typeflag(&e.type_name, &e.name);
        let data = if matches!(flag, b'1' | b'2' | b'3' | b'4' | b'5' | b'6') {
            Vec::new()
        } else {
            e.data.clone()
        };
        let mut pax = e.pax.clone();
        if e.name.len() > 100 || !e.name.is_ascii() || split_ustar(&e.name).is_none() && e.name.len() > 100 {
            pax.insert("path".into(), e.name.clone());
        }
        if e.linkname.len() > 100 || (!e.linkname.is_empty() && !e.linkname.is_ascii()) {
            pax.insert("linkpath".into(), e.linkname.clone());
        }
        if e.size > 0o77777777777 {
            pax.insert("size".into(), e.size.to_string());
        }
        if e.uid > 0o7777777 {
            pax.insert("uid".into(), e.uid.to_string());
        }
        if e.gid > 0o7777777 {
            pax.insert("gid".into(), e.gid.to_string());
        }
        if e.uname.len() > 31 {
            pax.insert("uname".into(), e.uname.clone());
        }
        if e.gname.len() > 31 {
            pax.insert("gname".into(), e.gname.clone());
        }
        if mtime_needs_pax(e.mtime_ms) {
            if let Some(ms) = e.mtime_ms {
                pax.entry("mtime".into()).or_insert_with(|| format_pax_time_ms(ms));
            }
        }
        if !pax.is_empty() || needs_pax(e) {
            if e.name.len() > 100 {
                pax.entry("path".into()).or_insert_with(|| e.name.clone());
            }
            if !pax.is_empty() {
                out.extend(write_pax_header(&e.name, &pax));
            }
        }
        let hdr = write_header_block(e, &e.name, &e.linkname, data.len() as u64, flag);
        out.extend_from_slice(&hdr);
        out.extend_from_slice(&data);
        out.extend(std::iter::repeat(0).take(pad_size(data.len() as u64)));
    }
    out.extend_from_slice(&[0u8; BLOCK]);
    out.extend_from_slice(&[0u8; BLOCK]);
    Ok(out)
}

fn apply_pax(e: &mut Entry, pax: &BTreeMap<String, String>) -> Result<()> {
    for (k, v) in pax {
        match k.as_str() {
            "path" => e.name = v.clone(),
            "linkpath" => e.linkname = v.clone(),
            "uname" => e.uname = v.clone(),
            "gname" => e.gname = v.clone(),
            "size" => e.size = v.parse().map_err(|_| FormatError::tar(0, "archive/tar: invalid tar header"))?,
            "uid" => e.uid = v.parse().map_err(|_| FormatError::tar(0, "archive/tar: invalid tar header"))?,
            "gid" => e.gid = v.parse().map_err(|_| FormatError::tar(0, "archive/tar: invalid tar header"))?,
            "mtime" => {
                if !v.is_empty() {
                    e.mtime_ms = Some(parse_pax_time_ms(v)?);
                }
            }
            "atime" | "ctime" => {
                if !v.is_empty() {
                    parse_pax_time_ms(v)?;
                }
                e.pax.insert(k.clone(), v.clone());
            }
            _ => {
                e.pax.insert(k.clone(), v.clone());
            }
        }
    }
    Ok(())
}

fn is_zero(block: &[u8; BLOCK]) -> bool {
    block.iter().all(|&b| b == 0)
}

fn read_block(data: &[u8], offset: usize) -> Result<[u8; BLOCK]> {
    if offset + BLOCK > data.len() {
        return Err(FormatError::tar(offset as u64, "archive/tar: unexpected EOF"));
    }
    let mut b = [0u8; BLOCK];
    b.copy_from_slice(&data[offset..offset + BLOCK]);
    Ok(b)
}

fn parse_header(block: &[u8; BLOCK], offset: u64) -> Result<Entry> {
    let stored = parse_octal(&block[148..156]).map_err(|_| FormatError::tar(offset, "archive/tar: invalid tar header"))?;
    let sum = checksum(block);
    // Go accepts the unsigned checksum and the signed variant (bytes as signed).
    let signed: i64 = block.iter().enumerate().map(|(i, &b)| {
        let v = if (148..156).contains(&i) { b' ' as i8 as i64 } else { b as i8 as i64 };
        v
    }).sum();
    if stored != sum && stored != signed as u64 && stored != (signed as u32 as u64) {
        return Err(FormatError::tar(offset, "archive/tar: invalid tar header"));
    }
    let mut name = parse_string(&block[0..100]);
    let prefix = parse_string(&block[345..500]);
    if &block[257..263] == b"ustar\0" && !prefix.is_empty() {
        name = if name.is_empty() { prefix } else { format!("{prefix}/{name}") };
    }
    let flag = block[156];
    let mut e = Entry {
        name,
        type_name: type_name(flag),
        size: parse_octal(&block[124..136])?,
        mode: parse_octal(&block[100..108])? as u32,
        uid: parse_octal(&block[108..116])?,
        gid: parse_octal(&block[116..124])?,
        mtime_ms: Some(parse_octal(&block[136..148])? as f64 * 1000.0),
        linkname: parse_string(&block[157..257]),
        uname: parse_string(&block[265..297]),
        gname: parse_string(&block[297..329]),
        pax: BTreeMap::new(),
        typeflag: Some((flag as char).to_string()),
        data: Vec::new(),
    };
    if flag == 0 {
        e.type_name = if e.name.ends_with('/') { "dir".into() } else { "reg".into() };
    }
    Ok(e)
}

pub fn extract(data: &[u8]) -> Result<Vec<Entry>> {
    let mut offset = 0usize;
    let mut out = Vec::new();
    let mut pax = BTreeMap::new();
    let mut global = BTreeMap::new();
    let mut gnu_long_name: Option<String> = None;
    let mut gnu_long_link: Option<String> = None;
    let mut zero_blocks = 0;
    while offset < data.len() {
        let block = read_block(data, offset)?;
        let hdr_off = offset as u64;
        offset += BLOCK;
        if is_zero(&block) {
            zero_blocks += 1;
            if zero_blocks >= 2 {
                break;
            }
            continue;
        }
        zero_blocks = 0;
        let mut e = parse_header(&block, hdr_off)?;
        let size = e.size;
        let pad = pad_size(size);
        let end = offset.checked_add(size as usize).ok_or_else(|| FormatError::tar(hdr_off, "archive/tar: invalid tar header"))?;
        if end > data.len() {
            return Err(FormatError::tar(offset as u64, "archive/tar: unexpected EOF"));
        }
        let payload = data[offset..end].to_vec();
        offset = end + pad;
        if offset > data.len() && pad > 0 {
            return Err(FormatError::tar(end as u64, "archive/tar: unexpected EOF"));
        }
        match e.typeflag.as_deref() {
            Some("x") => {
                pax = parse_pax(&payload)?;
                continue;
            }
            Some("g") => {
                global = parse_pax(&payload)?;
                e.type_name = "x-global-header".into();
                e.data = payload;
                apply_pax(&mut e, &global)?;
                out.push(e);
                continue;
            }
            Some("L") => {
                gnu_long_name = Some(parse_string(&payload));
                continue;
            }
            Some("K") => {
                gnu_long_link = Some(parse_string(&payload));
                continue;
            }
            Some("S") => {
                return Err(FormatError::tar(hdr_off, "archive/tar: sparse files are not supported"));
            }
            _ => {}
        }
        apply_pax(&mut e, &global)?;
        apply_pax(&mut e, &pax)?;
        pax.clear();
        if let Some(n) = gnu_long_name.take() {
            e.name = n;
        }
        if let Some(n) = gnu_long_link.take() {
            e.linkname = n;
        }
        e.data = payload;
        e.size = e.data.len() as u64;
        out.push(e);
    }
    if zero_blocks < 2 {
        return Err(FormatError::tar(offset as u64, "archive/tar: unexpected EOF"));
    }
    Ok(out)
}

pub struct Reader {
    buf: Vec<u8>,
    consumed: usize,
    pax: BTreeMap<String, String>,
    global: BTreeMap<String, String>,
    gnu_long_name: Option<String>,
    gnu_long_link: Option<String>,
    done: bool,
}

impl Reader {
    pub fn new() -> Self {
        Self {
            buf: Vec::new(),
            consumed: 0,
            pax: BTreeMap::new(),
            global: BTreeMap::new(),
            gnu_long_name: None,
            gnu_long_link: None,
            done: false,
        }
    }

    pub fn write(&mut self, chunk: &[u8]) -> Result<Vec<Entry>> {
        if self.done {
            return Ok(Vec::new());
        }
        self.buf.extend_from_slice(chunk);
        self.drain(false)
    }

    pub fn finish(&mut self) -> Result<Vec<Entry>> {
        let entries = self.drain(true)?;
        if !self.done {
            return Err(FormatError::tar(self.consumed as u64, "archive/tar: unexpected EOF"));
        }
        Ok(entries)
    }

    fn drain(&mut self, eof: bool) -> Result<Vec<Entry>> {
        let mut out = Vec::new();
        loop {
            if self.done {
                break;
            }
            let available = self.buf.len().saturating_sub(self.consumed);
            if available < BLOCK {
                if eof && available > 0 {
                    return Err(FormatError::tar(self.consumed as u64, "archive/tar: unexpected EOF"));
                }
                break;
            }
            let start = self.consumed;
            let mut block = [0u8; BLOCK];
            block.copy_from_slice(&self.buf[start..start + BLOCK]);
            if is_zero(&block) {
                // Need a second zero block to finish; keep the first.
                if available >= BLOCK * 2 {
                    let mut second = [0u8; BLOCK];
                    second.copy_from_slice(&self.buf[start + BLOCK..start + BLOCK * 2]);
                    if is_zero(&second) {
                        self.consumed = start + BLOCK * 2;
                        self.done = true;
                        break;
                    }
                } else if eof {
                    self.consumed = start + BLOCK;
                    self.done = true;
                    break;
                } else {
                    break;
                }
            }
            let mut e = parse_header(&block, start as u64)?;
            let size = e.size as usize;
            let total = BLOCK + size + pad_size(e.size);
            if available < total {
                if eof {
                    return Err(FormatError::tar((start + BLOCK) as u64, "archive/tar: unexpected EOF"));
                }
                break;
            }
            let payload = self.buf[start + BLOCK..start + BLOCK + size].to_vec();
            self.consumed = start + total;
            match e.typeflag.as_deref() {
                Some("x") => {
                    self.pax = parse_pax(&payload)?;
                    continue;
                }
                Some("g") => {
                    self.global = parse_pax(&payload)?;
                    e.type_name = "x-global-header".into();
                    e.data = payload;
                    apply_pax(&mut e, &self.global)?;
                    out.push(e);
                    continue;
                }
                Some("L") => {
                    self.gnu_long_name = Some(parse_string(&payload));
                    continue;
                }
                Some("K") => {
                    self.gnu_long_link = Some(parse_string(&payload));
                    continue;
                }
                Some("S") => {
                    return Err(FormatError::tar(start as u64, "archive/tar: sparse files are not supported"));
                }
                _ => {}
            }
            apply_pax(&mut e, &self.global)?;
            apply_pax(&mut e, &self.pax)?;
            self.pax.clear();
            if let Some(n) = self.gnu_long_name.take() {
                e.name = n;
            }
            if let Some(n) = self.gnu_long_link.take() {
                e.linkname = n;
            }
            e.data = payload;
            e.size = e.data.len() as u64;
            out.push(e);
        }
        if self.consumed > 64 * 1024 {
            self.buf.drain(..self.consumed);
            self.consumed = 0;
        }
        Ok(out)
    }
}

pub struct Writer {
    entries: Vec<Entry>,
    current: Option<Entry>,
    remaining: u64,
}

impl Writer {
    pub fn new() -> Self {
        Self { entries: Vec::new(), current: None, remaining: 0 }
    }

    pub fn write_header(&mut self, mut e: Entry) -> Result<()> {
        self.flush_current()?;
        if e.type_name.is_empty() {
            e.type_name = if e.name.ends_with('/') { "dir".into() } else { "reg".into() };
        }
        self.remaining = if matches!(typeflag(&e.type_name, &e.name), b'1' | b'2' | b'3' | b'4' | b'5' | b'6') {
            0
        } else {
            e.size
        };
        e.data.clear();
        self.current = Some(e);
        Ok(())
    }

    pub fn write(&mut self, chunk: &[u8]) -> Result<()> {
        let cur = self.current.as_mut().ok_or_else(|| FormatError::tar(0, "archive/tar: write before header"))?;
        if chunk.len() as u64 > self.remaining {
            return Err(FormatError::tar(0, "archive/tar: write too long"));
        }
        cur.data.extend_from_slice(chunk);
        self.remaining -= chunk.len() as u64;
        Ok(())
    }

    fn flush_current(&mut self) -> Result<()> {
        if let Some(mut e) = self.current.take() {
            if self.remaining != 0 {
                return Err(FormatError::tar(0, "archive/tar: missed writing data"));
            }
            e.size = e.data.len() as u64;
            self.entries.push(e);
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<Vec<u8>> {
        self.flush_current()?;
        create(&self.entries)
    }
}
