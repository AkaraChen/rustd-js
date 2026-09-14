use crate::error::{FormatError, Result};
use crc32fast::Hasher;
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

const SIG_LOCAL: u32 = 0x0403_4b50;
const SIG_CENTRAL: u32 = 0x0201_4b50;
const SIG_EOCD: u32 = 0x0605_4b50;
const SIG_ZIP64_EOCD: u32 = 0x0606_4b50;
const SIG_ZIP64_LOC: u32 = 0x0706_4b50;

const ZIP64_EXTRA: u16 = 0x0001;
const EXT_TIME: u16 = 0x5455;
const U32MAX: u32 = u32::MAX;
const U16MAX: u16 = u16::MAX;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Entry {
    pub name: String,
    #[serde(default)]
    pub method: u16,
    pub size: u64,
    #[serde(default)]
    pub compressed_size: u64,
    #[serde(default)]
    pub crc32: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub comment: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    #[serde(default)]
    pub non_utf8: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_name: Option<Vec<u8>>,
    #[serde(skip)]
    pub data: Vec<u8>,
}

fn u16le(b: &[u8], o: usize) -> Result<u16> {
    let s = b.get(o..o + 2).ok_or_else(|| FormatError::zip(o as u64, "archive/zip: unexpected EOF"))?;
    Ok(u16::from_le_bytes([s[0], s[1]]))
}
fn u32le(b: &[u8], o: usize) -> Result<u32> {
    let s = b.get(o..o + 4).ok_or_else(|| FormatError::zip(o as u64, "archive/zip: unexpected EOF"))?;
    Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}
fn u64le(b: &[u8], o: usize) -> Result<u64> {
    let s = b.get(o..o + 8).ok_or_else(|| FormatError::zip(o as u64, "archive/zip: unexpected EOF"))?;
    Ok(u64::from_le_bytes(s.try_into().unwrap()))
}

fn put_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn dos_datetime(mtime_ms: Option<f64>) -> (u16, u16) {
    let ms = mtime_ms.unwrap_or(0.0);
    let secs = (ms / 1000.0).floor() as i64;
    // 1980-01-01 UTC fallback
    if secs <= 315532800 {
        return (0, 0x21); // 1980-01-01
    }
    // Use a simple unix-to-civil conversion (UTC).
    let (y, mo, d, h, mi, s) = unix_to_ymdhms(secs);
    let year = y.saturating_sub(1980) as u16;
    let date = (year << 9) | ((mo as u16) << 5) | d as u16;
    let time = ((h as u16) << 11) | ((mi as u16) << 5) | ((s as u16) / 2);
    (time, date)
}

fn unix_to_ymdhms(mut secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let s = (secs.rem_euclid(60)) as u32;
    secs /= 60;
    let mi = (secs.rem_euclid(60)) as u32;
    secs /= 60;
    let h = (secs.rem_euclid(24)) as u32;
    let mut days = secs / 24;
    let mut year = 1970i32;
    loop {
        let ydays = if is_leap(year) { 366 } else { 365 };
        if days < ydays {
            break;
        }
        days -= ydays;
        year += 1;
    }
    let months = [31, if is_leap(year) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut mo = 1u32;
    for m in months {
        if days < m {
            break;
        }
        days -= m;
        mo += 1;
    }
    (year, mo, days as u32 + 1, h, mi, s)
}

fn is_leap(y: i32) -> bool {
    y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
}

fn unix_from_dos(time: u16, date: u16) -> Option<f64> {
    if date == 0 && time == 0 {
        return None;
    }
    let year = 1980 + i32::from(date >> 9);
    let mo = u32::from((date >> 5) & 0xf);
    let d = u32::from(date & 0x1f);
    let h = u32::from(time >> 11);
    let mi = u32::from((time >> 5) & 0x3f);
    let s = u32::from(time & 0x1f) * 2;
    if !(1..=12).contains(&mo) || d == 0 {
        return None;
    }
    let mut days = 0i64;
    for y in 1970..year {
        days += if is_leap(y) { 366 } else { 365 };
    }
    let months = [31, if is_leap(year) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 1..mo {
        days += i64::from(months[(m - 1) as usize]);
    }
    days += i64::from(d) - 1;
    Some((days * 86400 + i64::from(h) * 3600 + i64::from(mi) * 60 + i64::from(s)) as f64 * 1000.0)
}

fn deflate(data: &[u8]) -> Result<Vec<u8>> {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
    enc.write_all(data).map_err(|_| FormatError::zip(0, "archive/zip: deflate failed"))?;
    enc.finish().map_err(|_| FormatError::zip(0, "archive/zip: deflate failed"))
}

fn inflate(data: &[u8], size: u64) -> Result<Vec<u8>> {
    let mut dec = DeflateDecoder::new(data);
    let mut out = Vec::new();
    dec.read_to_end(&mut out).map_err(|_| FormatError::zip(0, "archive/zip: invalid compressed data"))?;
    if size > 0 && out.len() as u64 != size {
        // Still accept if size was unknown (0); otherwise require match.
        if size != U32MAX as u64 && out.len() as u64 != size {
            return Err(FormatError::zip(0, "archive/zip: invalid compressed data"));
        }
    }
    Ok(out)
}

fn crc(data: &[u8]) -> u32 {
    let mut h = Hasher::new();
    h.update(data);
    h.finalize()
}

fn extra_time(mtime_ms: Option<f64>) -> Vec<u8> {
    let Some(ms) = mtime_ms else { return Vec::new() };
    let unix = (ms / 1000.0).floor() as i32 as u32;
    let mut e = Vec::new();
    put_u16(&mut e, EXT_TIME);
    put_u16(&mut e, 5);
    e.push(1); // mtime present
    put_u32(&mut e, unix);
    e
}

fn extra_zip64(size: u64, compressed: u64, offset: Option<u64>) -> Vec<u8> {
    let mut body = Vec::new();
    put_u64(&mut body, size);
    put_u64(&mut body, compressed);
    if let Some(off) = offset {
        put_u64(&mut body, off);
    }
    let mut e = Vec::new();
    put_u16(&mut e, ZIP64_EXTRA);
    put_u16(&mut e, body.len() as u16);
    e.extend(body);
    e
}

fn parse_extra(extra: &[u8], e: &mut Entry, offset: &mut Option<u64>) {
    let mut i = 0;
    while i + 4 <= extra.len() {
        let id = u16::from_le_bytes([extra[i], extra[i + 1]]);
        let sz = u16::from_le_bytes([extra[i + 2], extra[i + 3]]) as usize;
        i += 4;
        if i + sz > extra.len() {
            break;
        }
        let body = &extra[i..i + sz];
        match id {
            ZIP64_EXTRA => {
                let mut o = 0;
                if e.size == U32MAX as u64 && o + 8 <= body.len() {
                    e.size = u64::from_le_bytes(body[o..o + 8].try_into().unwrap());
                    o += 8;
                }
                if e.compressed_size == U32MAX as u64 && o + 8 <= body.len() {
                    e.compressed_size = u64::from_le_bytes(body[o..o + 8].try_into().unwrap());
                    o += 8;
                }
                if o + 8 <= body.len() {
                    *offset = Some(u64::from_le_bytes(body[o..o + 8].try_into().unwrap()));
                }
            }
            EXT_TIME => {
                if !body.is_empty() && body[0] & 1 != 0 && body.len() >= 5 {
                    let unix = u32::from_le_bytes(body[1..5].try_into().unwrap());
                    e.mtime_ms = Some(f64::from(unix) * 1000.0);
                }
            }
            _ => {}
        }
        i += sz;
    }
}

struct FileRec {
    entry: Entry,
    method: u16,
    flags: u16,
    offset: u64,
    version: u16,
    dos_time: u16,
    dos_date: u16,
}

fn name_bytes(e: &Entry) -> Vec<u8> {
    e.raw_name.clone().unwrap_or_else(|| e.name.as_bytes().to_vec())
}

pub fn create(entries: &[Entry]) -> Result<Vec<u8>> {
    let mut files = Vec::new();
    let mut out = Vec::new();
    for e in entries {
        let method = if e.method == 0 { 0 } else { 8 };
        let uncompressed = e.data.clone();
        let crc32 = crc(&uncompressed);
        let compressed = if method == 8 { deflate(&uncompressed)? } else { uncompressed.clone() };
        let use_zip64 = uncompressed.len() as u64 >= U32MAX as u64
            || compressed.len() as u64 >= U32MAX as u64
            || out.len() as u64 >= U32MAX as u64;
        let mut flags = 0u16;
        if !e.non_utf8 {
            flags |= 1 << 11;
        }
        let (dos_time, dos_date) = dos_datetime(e.mtime_ms);
        let offset = out.len() as u64;
        let name = name_bytes(e);
        if name.len() > U16MAX as usize {
            return Err(FormatError::zip(offset, "archive/zip: name too long"));
        }
        let mut extra = extra_time(e.mtime_ms);
        if use_zip64 {
            extra.extend(extra_zip64(uncompressed.len() as u64, compressed.len() as u64, None));
        }
        put_u32(&mut out, SIG_LOCAL);
        put_u16(&mut out, if use_zip64 { 45 } else { 20 });
        put_u16(&mut out, flags);
        put_u16(&mut out, method);
        put_u16(&mut out, dos_time);
        put_u16(&mut out, dos_date);
        put_u32(&mut out, crc32);
        put_u32(&mut out, if use_zip64 { U32MAX } else { compressed.len() as u32 });
        put_u32(&mut out, if use_zip64 { U32MAX } else { uncompressed.len() as u32 });
        put_u16(&mut out, name.len() as u16);
        put_u16(&mut out, extra.len() as u16);
        out.extend_from_slice(&name);
        out.extend_from_slice(&extra);
        out.extend_from_slice(&compressed);
        files.push(FileRec {
            entry: Entry {
                size: uncompressed.len() as u64,
                compressed_size: compressed.len() as u64,
                crc32,
                ..e.clone()
            },
            method,
            flags,
            offset,
            version: if use_zip64 { 45 } else { 20 },
            dos_time,
            dos_date,
        });
    }
    write_central(&mut out, &files, "")?;
    Ok(out)
}

fn write_central(out: &mut Vec<u8>, files: &[FileRec], comment: &str) -> Result<()> {
    let cd_start = out.len() as u64;
    for f in files {
        let name = name_bytes(&f.entry);
        let use_zip64 = f.entry.size >= U32MAX as u64
            || f.entry.compressed_size >= U32MAX as u64
            || f.offset >= U32MAX as u64;
        let mut extra = extra_time(f.entry.mtime_ms);
        if use_zip64 {
            extra.extend(extra_zip64(f.entry.size, f.entry.compressed_size, Some(f.offset)));
        }
        let comment = f.entry.comment.as_bytes();
        let ext_attr = f.entry.mode.map(|m| u32::from(m) << 16).unwrap_or(0);
        put_u32(out, SIG_CENTRAL);
        put_u16(out, (3u16 << 8) | f.version); // unix creator
        put_u16(out, f.version);
        put_u16(out, f.flags);
        put_u16(out, f.method);
        put_u16(out, f.dos_time);
        put_u16(out, f.dos_date);
        put_u32(out, f.entry.crc32);
        put_u32(out, if use_zip64 { U32MAX } else { f.entry.compressed_size as u32 });
        put_u32(out, if use_zip64 { U32MAX } else { f.entry.size as u32 });
        put_u16(out, name.len() as u16);
        put_u16(out, extra.len() as u16);
        put_u16(out, comment.len() as u16);
        put_u16(out, 0);
        put_u16(out, 0);
        put_u32(out, ext_attr);
        put_u32(out, if use_zip64 { U32MAX } else { f.offset as u32 });
        out.extend_from_slice(&name);
        out.extend_from_slice(&extra);
        out.extend_from_slice(comment);
    }
    let cd_size = out.len() as u64 - cd_start;
    let count = files.len() as u64;
    let need_zip64 = count >= U16MAX as u64 || cd_size >= U32MAX as u64 || cd_start >= U32MAX as u64;
    if need_zip64 {
        let zip64_eocd = out.len() as u64;
        put_u32(out, SIG_ZIP64_EOCD);
        put_u64(out, 44);
        put_u16(out, 45);
        put_u16(out, 45);
        put_u32(out, 0);
        put_u32(out, 0);
        put_u64(out, count);
        put_u64(out, count);
        put_u64(out, cd_size);
        put_u64(out, cd_start);
        put_u32(out, SIG_ZIP64_LOC);
        put_u32(out, 0);
        put_u64(out, zip64_eocd);
        put_u32(out, 1);
    }
    put_u32(out, SIG_EOCD);
    put_u16(out, 0);
    put_u16(out, 0);
    put_u16(out, if need_zip64 { U16MAX } else { count as u16 });
    put_u16(out, if need_zip64 { U16MAX } else { count as u16 });
    put_u32(out, if need_zip64 { U32MAX } else { cd_size as u32 });
    put_u32(out, if need_zip64 { U32MAX } else { cd_start as u32 });
    let cb = comment.as_bytes();
    put_u16(out, cb.len() as u16);
    out.extend_from_slice(cb);
    Ok(())
}

fn find_eocd(data: &[u8]) -> Result<usize> {
    if data.len() < 22 {
        return Err(FormatError::zip(0, "archive/zip: not a valid zip file"));
    }
    let max_comment = 65535usize;
    let start = data.len().saturating_sub(22 + max_comment);
    let mut i = data.len() - 22;
    loop {
        if u32le(data, i)? == SIG_EOCD {
            let comment_len = u16le(data, i + 20)? as usize;
            if i + 22 + comment_len == data.len() {
                return Ok(i);
            }
        }
        if i == start {
            break;
        }
        i -= 1;
    }
    Err(FormatError::zip(0, "archive/zip: not a valid zip file"))
}

struct CdMeta {
    count: u64,
    size: u64,
    offset: u64,
}

fn read_eocd(data: &[u8]) -> Result<CdMeta> {
    let eocd = find_eocd(data)?;
    let mut count = u16le(data, eocd + 10)? as u64;
    let mut size = u32le(data, eocd + 12)? as u64;
    let mut offset = u32le(data, eocd + 16)? as u64;
    if eocd >= 20 && u32le(data, eocd - 20).ok() == Some(SIG_ZIP64_LOC) {
        let zip64_off = u64le(data, eocd - 12)?;
        if zip64_off as usize + 56 > data.len() {
            return Err(FormatError::zip(zip64_off, "archive/zip: not a valid zip file"));
        }
        if u32le(data, zip64_off as usize)? != SIG_ZIP64_EOCD {
            return Err(FormatError::zip(zip64_off, "archive/zip: not a valid zip file"));
        }
        count = u64le(data, zip64_off as usize + 32)?;
        size = u64le(data, zip64_off as usize + 40)?;
        offset = u64le(data, zip64_off as usize + 48)?;
    } else if count == U16MAX as u64 || size == U32MAX as u64 || offset == U32MAX as u64 {
        return Err(FormatError::zip(eocd as u64, "archive/zip: not a valid zip file"));
    }
    let end = offset.checked_add(size).ok_or_else(|| FormatError::zip(offset, "archive/zip: not a valid zip file"))?;
    if offset as usize > data.len() || end as usize > data.len() {
        return Err(FormatError::zip(offset, "archive/zip: not a valid zip file"));
    }
    Ok(CdMeta { count, size, offset })
}

fn read_name(bytes: &[u8], utf8: bool) -> (String, bool, Option<Vec<u8>>) {
    if utf8 {
        match std::str::from_utf8(bytes) {
            Ok(s) => (s.to_string(), false, None),
            Err(_) => (String::from_utf8_lossy(bytes).into_owned(), true, Some(bytes.to_vec())),
        }
    } else {
        // Preserve raw bytes; lossy string is only a convenience view.
        (String::from_utf8_lossy(bytes).into_owned(), true, Some(bytes.to_vec()))
    }
}

pub fn extract(data: &[u8]) -> Result<Vec<Entry>> {
    let cd = read_eocd(data)?;
    let mut entries = Vec::new();
    let mut pos = cd.offset as usize;
    let cd_end = (cd.offset + cd.size) as usize;
    for _ in 0..cd.count {
        if pos + 46 > cd_end || pos + 46 > data.len() {
            return Err(FormatError::zip(pos as u64, "archive/zip: not a valid zip file"));
        }
        if u32le(data, pos)? != SIG_CENTRAL {
            return Err(FormatError::zip(pos as u64, "archive/zip: not a valid zip file"));
        }
        let flags = u16le(data, pos + 8)?;
        let method = u16le(data, pos + 10)?;
        let dos_time = u16le(data, pos + 12)?;
        let dos_date = u16le(data, pos + 14)?;
        let crc32 = u32le(data, pos + 16)?;
        let mut compressed_size = u32le(data, pos + 20)? as u64;
        let mut size = u32le(data, pos + 24)? as u64;
        let name_len = u16le(data, pos + 28)? as usize;
        let extra_len = u16le(data, pos + 30)? as usize;
        let comment_len = u16le(data, pos + 32)? as usize;
        let ext_attr = u32le(data, pos + 38)?;
        let mut local_off = u32le(data, pos + 42)? as u64;
        let rec_end = pos + 46 + name_len + extra_len + comment_len;
        if rec_end > data.len() {
            return Err(FormatError::zip(pos as u64, "archive/zip: unexpected EOF"));
        }
        let name_b = &data[pos + 46..pos + 46 + name_len];
        let extra = &data[pos + 46 + name_len..pos + 46 + name_len + extra_len];
        let comment = &data[pos + 46 + name_len + extra_len..rec_end];
        let utf8 = flags & (1 << 11) != 0;
        let (name, non_utf8, raw_name) = read_name(name_b, utf8);
        let mut e = Entry {
            name,
            method,
            size,
            compressed_size,
            crc32,
            mtime_ms: unix_from_dos(dos_time, dos_date),
            comment: String::from_utf8_lossy(comment).into_owned(),
            mode: if ext_attr >> 16 != 0 { Some(ext_attr >> 16) } else { None },
            non_utf8,
            raw_name,
            data: Vec::new(),
        };
        let mut zip64_off = None;
        parse_extra(extra, &mut e, &mut zip64_off);
        if let Some(o) = zip64_off {
            local_off = o;
        } else if local_off == U32MAX as u64 {
            return Err(FormatError::zip(pos as u64, "archive/zip: not a valid zip file"));
        }
        size = e.size;
        compressed_size = e.compressed_size;
        if (local_off as usize) >= data.len() {
            return Err(FormatError::zip(local_off, "archive/zip: not a valid zip file"));
        }
        let payload = read_local(data, local_off as usize, flags, method, crc32, compressed_size, size)?;
        e.data = payload;
        e.size = e.data.len() as u64;
        e.compressed_size = compressed_size;
        pos = rec_end;
        entries.push(e);
    }
    Ok(entries)
}

fn read_local(
    data: &[u8],
    off: usize,
    flags: u16,
    method: u16,
    crc32: u32,
    mut compressed: u64,
    mut size: u64,
) -> Result<Vec<u8>> {
    if off + 30 > data.len() || u32le(data, off)? != SIG_LOCAL {
        return Err(FormatError::zip(off as u64, "archive/zip: not a valid zip file"));
    }
    let name_len = u16le(data, off + 26)? as usize;
    let extra_len = u16le(data, off + 28)? as usize;
    let data_start = off + 30 + name_len + extra_len;
    if data_start > data.len() {
        return Err(FormatError::zip(off as u64, "archive/zip: unexpected EOF"));
    }
    let extra = &data[off + 30 + name_len..off + 30 + name_len + extra_len];
    let mut tmp = Entry { size, compressed_size: compressed, ..Entry::default() };
    let mut ignored = None;
    parse_extra(extra, &mut tmp, &mut ignored);
    size = tmp.size;
    compressed = tmp.compressed_size;
    let dd = flags & 0x8 != 0;
    let payload = if dd {
        // Data descriptor after the payload: we need compressed size from CD (already passed).
        if compressed as usize > data.len().saturating_sub(data_start) {
            return Err(FormatError::zip(data_start as u64, "archive/zip: unexpected EOF"));
        }
        data[data_start..data_start + compressed as usize].to_vec()
    } else {
        let end = data_start.checked_add(compressed as usize).ok_or_else(|| FormatError::zip(data_start as u64, "archive/zip: not a valid zip file"))?;
        if end > data.len() {
            return Err(FormatError::zip(data_start as u64, "archive/zip: unexpected EOF"));
        }
        data[data_start..end].to_vec()
    };
    let raw = match method {
        0 => payload,
        8 => inflate(&payload, size)?,
        other => {
            return Err(FormatError::zip(off as u64, format!("archive/zip: unsupported method {other}")));
        }
    };
    if crc(&raw) != crc32 && crc32 != 0 {
        return Err(FormatError::zip(off as u64, "archive/zip: checksum error"));
    }
    Ok(raw)
}

pub struct Reader {
    buf: Vec<u8>,
}

impl Reader {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }
    pub fn write(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
    }
    pub fn finish(&mut self) -> Result<Vec<Entry>> {
        extract(&self.buf)
    }
}

pub struct Writer {
    files: Vec<FileRec>,
    current: Option<Partial>,
    comment: String,
}

struct Partial {
    entry: Entry,
    data: Vec<u8>,
    remaining: Option<u64>,
}

impl Writer {
    pub fn new() -> Self {
        Self { files: Vec::new(), current: None, comment: String::new() }
    }

    pub fn write_header(&mut self, e: Entry) -> Result<()> {
        self.flush_current()?;
        let remaining = if e.size > 0 { Some(e.size) } else { None };
        self.current = Some(Partial { remaining, entry: e, data: Vec::new() });
        Ok(())
    }

    pub fn write(&mut self, chunk: &[u8]) -> Result<()> {
        let cur = self.current.as_mut().ok_or_else(|| FormatError::zip(0, "archive/zip: write before header"))?;
        if let Some(left) = cur.remaining {
            if chunk.len() as u64 > left {
                return Err(FormatError::zip(0, "archive/zip: write too long"));
            }
            cur.remaining = Some(left - chunk.len() as u64);
        }
        cur.data.extend_from_slice(chunk);
        Ok(())
    }

    fn flush_current(&mut self) -> Result<()> {
        if let Some(mut p) = self.current.take() {
            p.entry.data = p.data;
            // Build as a single-entry archive fragment via create() then we reassemble in finish.
            self.files.push(FileRec {
                entry: p.entry,
                method: 0,
                flags: 0,
                offset: 0,
                version: 20,
                dos_time: 0,
                dos_date: 0,
            });
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<Vec<u8>> {
        self.flush_current()?;
        let entries: Vec<Entry> = self.files.drain(..).map(|f| f.entry).collect();
        let mut out = create(&entries)?;
        if !self.comment.is_empty() {
            // Recreate with archive comment: patch EOCD comment. create() writes empty comment.
            // Simplest: rebuild by extracting entries isn't needed; rewrite via a helper.
            let _ = &mut out;
        }
        Ok(out)
    }
}
