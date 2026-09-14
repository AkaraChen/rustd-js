//! Go `mime/multipart.Reader.NextPart` (Go 1.24 `multipart.go`) for a complete body.
//!
//! This slice parses a fully buffered body. Incremental 1-byte `write`/`nextPart`
//! interleaving and ReadForm limits are later.

use crate::header::{canonical_mime_header_key, canonical_mime_header_key_ok};
use crate::mediatype::parse_media_type;
use std::collections::HashMap;

#[derive(Clone, Copy)]
enum ReadErr {
    Eof,
    UnexpectedEof,
}

#[derive(Debug)]
pub struct MultipartPart {
    pub header: Vec<(String, Vec<String>)>,
    pub body: Vec<u8>,
    pub form_name: String,
    pub file_name: String,
}

pub struct MultipartReader {
    buf: Vec<u8>,
    pos: usize,
    parts_read: u32,
    current_open: bool,
    finished: bool,
    nl: Vec<u8>,
    nl_dash_boundary: Vec<u8>,
    dash_boundary_dash: Vec<u8>,
    dash_boundary: Vec<u8>,
}

impl MultipartReader {
    pub fn new(boundary: String) -> Self {
        let mut dash_boundary = Vec::with_capacity(2 + boundary.len());
        dash_boundary.extend_from_slice(b"--");
        dash_boundary.extend_from_slice(boundary.as_bytes());
        let mut dash_boundary_dash = dash_boundary.clone();
        dash_boundary_dash.extend_from_slice(b"--");
        let mut nl_dash_boundary = Vec::with_capacity(2 + dash_boundary.len());
        nl_dash_boundary.extend_from_slice(b"\r\n");
        nl_dash_boundary.extend_from_slice(&dash_boundary);
        Self {
            buf: Vec::new(),
            pos: 0,
            parts_read: 0,
            current_open: false,
            finished: false,
            nl: b"\r\n".to_vec(),
            nl_dash_boundary,
            dash_boundary_dash,
            dash_boundary,
        }
    }

    pub fn write(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
    }

    pub fn next_part(&mut self) -> Result<Option<MultipartPart>, String> {
        if self.finished {
            return Ok(None);
        }
        if self.current_open {
            let _ = self.read_part_body();
            self.current_open = false;
        }
        if self.dash_boundary == b"--" {
            return Err("multipart: boundary is empty".into());
        }
        let mut expect_new_part = false;
        loop {
            let (line, eof) = read_slice_nl(&self.buf, &mut self.pos);
            if eof && is_final_boundary(&line, &self.dash_boundary_dash, &self.nl) {
                self.finished = true;
                return Ok(None);
            }
            if eof {
                let wrapped = if line.is_empty() && self.pos >= self.buf.len() {
                    "EOF"
                } else {
                    "unexpected EOF"
                };
                return Err(format!("multipart: NextPart: {wrapped}"));
            }
            if is_boundary_delimiter_line(
                &line,
                &self.dash_boundary,
                &mut self.nl,
                &mut self.nl_dash_boundary,
                self.parts_read,
            ) {
                self.parts_read += 1;
                let header = read_mime_header(&self.buf, &mut self.pos)?;
                let body = self.read_part_body()?;
                self.current_open = false;
                let (form_name, file_name) = disposition_names(&header);
                return Ok(Some(MultipartPart {
                    header,
                    body,
                    form_name,
                    file_name,
                }));
            }
            if is_final_boundary(&line, &self.dash_boundary_dash, &self.nl) {
                self.finished = true;
                return Ok(None);
            }
            if expect_new_part {
                return Err(format!(
                    "multipart: expecting a new Part; got line {}",
                    quoted_go(&line)
                ));
            }
            if self.parts_read == 0 {
                continue;
            }
            if line == self.nl {
                expect_new_part = true;
                continue;
            }
            return Err(format!(
                "multipart: unexpected line in Next(): {}",
                quoted_go(&line)
            ));
        }
    }

    fn read_part_body(&mut self) -> Result<Vec<u8>, String> {
        let mut body = Vec::new();
        let mut total: i64 = 0;
        let mut read_err: Option<ReadErr> = None;
        loop {
            let peek = &self.buf[self.pos..];
            let (n, err) = scan_until_boundary(
                peek,
                &self.dash_boundary,
                &self.nl_dash_boundary,
                total,
                read_err,
            );
            if n == 0 && err.is_none() {
                if self.pos + peek.len() >= self.buf.len() {
                    if matches!(read_err, Some(ReadErr::UnexpectedEof)) {
                        return Err("multipart: NextPart: unexpected EOF".into());
                    }
                    read_err = Some(ReadErr::UnexpectedEof);
                    continue;
                }
                return Err("multipart: NextPart: unexpected EOF".into());
            }
            if n > 0 {
                body.extend_from_slice(&self.buf[self.pos..self.pos + n]);
                self.pos += n;
                total += n as i64;
            }
            match err {
                Some(ReadErr::Eof) => return Ok(body),
                Some(ReadErr::UnexpectedEof) => {
                    return Err("multipart: NextPart: unexpected EOF".into())
                }
                None => {
                    if n == 0 {
                        return Err("multipart: NextPart: unexpected EOF".into());
                    }
                }
            }
        }
    }
}

fn read_slice_nl(buf: &[u8], pos: &mut usize) -> (Vec<u8>, bool) {
    if *pos >= buf.len() {
        return (Vec::new(), true);
    }
    if let Some(rel) = buf[*pos..].iter().position(|&b| b == b'\n') {
        let end = *pos + rel + 1;
        let line = buf[*pos..end].to_vec();
        *pos = end;
        (line, false)
    } else {
        let line = buf[*pos..].to_vec();
        *pos = buf.len();
        (line, true)
    }
}

fn skip_lwsp(b: &[u8]) -> &[u8] {
    let mut i = 0;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    &b[i..]
}

fn is_final_boundary(line: &[u8], dash_boundary_dash: &[u8], nl: &[u8]) -> bool {
    if !line.starts_with(dash_boundary_dash) {
        return false;
    }
    let rest = skip_lwsp(&line[dash_boundary_dash.len()..]);
    rest.is_empty() || rest == nl
}

fn is_boundary_delimiter_line(
    line: &[u8],
    dash_boundary: &[u8],
    nl: &mut Vec<u8>,
    nl_dash_boundary: &mut Vec<u8>,
    parts_read: u32,
) -> bool {
    if !line.starts_with(dash_boundary) {
        return false;
    }
    let rest = skip_lwsp(&line[dash_boundary.len()..]);
    if parts_read == 0 && rest.len() == 1 && rest[0] == b'\n' {
        *nl = b"\n".to_vec();
        if nl_dash_boundary.len() >= 2 && nl_dash_boundary[0] == b'\r' {
            nl_dash_boundary.remove(0);
        }
    }
    rest == nl.as_slice()
}

fn match_after_prefix(buf: &[u8], prefix: &[u8], read_err: Option<ReadErr>) -> i32 {
    if buf.len() == prefix.len() {
        return if read_err.is_some() { 1 } else { 0 };
    }
    let c = buf[prefix.len()];
    if c == b' ' || c == b'\t' || c == b'\r' || c == b'\n' {
        return 1;
    }
    if c == b'-' {
        if buf.len() == prefix.len() + 1 {
            return if read_err.is_some() { -1 } else { 0 };
        }
        if buf[prefix.len() + 1] == b'-' {
            return 1;
        }
    }
    -1
}

fn scan_until_boundary(
    buf: &[u8],
    dash_boundary: &[u8],
    nl_dash_boundary: &[u8],
    total: i64,
    read_err: Option<ReadErr>,
) -> (usize, Option<ReadErr>) {
    if total == 0 {
        if buf.starts_with(dash_boundary) {
            match match_after_prefix(buf, dash_boundary, read_err) {
                -1 => return (dash_boundary.len(), None),
                0 => return (0, None),
                _ => return (0, Some(ReadErr::Eof)),
            }
        }
        if dash_boundary.starts_with(buf) {
            return (0, read_err);
        }
    }
    if let Some(i) = find_subslice(buf, nl_dash_boundary) {
        match match_after_prefix(&buf[i..], nl_dash_boundary, read_err) {
            -1 => return (i + nl_dash_boundary.len(), None),
            0 => return (i, None),
            _ => return (i, Some(ReadErr::Eof)),
        }
    }
    if nl_dash_boundary.starts_with(buf) {
        return (0, read_err);
    }
    let i = buf
        .iter()
        .rposition(|&b| b == nl_dash_boundary[0])
        .unwrap_or(usize::MAX);
    if i != usize::MAX && nl_dash_boundary.starts_with(&buf[i..]) {
        return (i, None);
    }
    (buf.len(), read_err)
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

fn read_mime_header(
    buf: &[u8],
    pos: &mut usize,
) -> Result<Vec<(String, Vec<String>)>, String> {
    if *pos < buf.len() && (buf[*pos] == b' ' || buf[*pos] == b'\t') {
        let (line, _) = read_slice_nl(buf, pos);
        let shown = strip_nl(&line);
        let shown = if shown.len() > 80 { &shown[..80] } else { shown };
        return Err(format!(
            "malformed MIME header initial line: {}",
            String::from_utf8_lossy(shown)
        ));
    }
    let mut headers: Vec<(String, Vec<String>)> = Vec::new();
    loop {
        let kv = match read_continued_line(buf, pos)? {
            None => break,
            Some(line) if line.is_empty() => break,
            Some(line) => line,
        };
        let Some(colon) = kv.iter().position(|&b| b == b':') else {
            return Err(format!(
                "malformed MIME header line: {}",
                String::from_utf8_lossy(&kv)
            ));
        };
        let key = canonical_mime_header_key_ok(&kv[..colon]).ok_or_else(|| {
            format!(
                "malformed MIME header line: {}",
                String::from_utf8_lossy(&kv)
            )
        })?;
        let v = &kv[colon + 1..];
        if !v.iter().copied().all(valid_header_value_byte) {
            return Err(format!(
                "malformed MIME header line: {}",
                String::from_utf8_lossy(&kv)
            ));
        }
        let value = String::from_utf8_lossy(trim_left_space_tab(v)).into_owned();
        if let Some(existing) = headers.iter_mut().find(|(k, _)| *k == key) {
            existing.1.push(value);
        } else {
            headers.push((key, vec![value]));
        }
    }
    Ok(headers)
}

fn read_continued_line(buf: &[u8], pos: &mut usize) -> Result<Option<Vec<u8>>, String> {
    if *pos >= buf.len() {
        return Err("EOF".into());
    }
    let (raw, eof) = read_slice_nl(buf, pos);
    if eof && raw.is_empty() {
        return Err("EOF".into());
    }
    if !raw.is_empty() && !raw.contains(&b':') && !strip_nl(&raw).is_empty() {
        return Err(format!(
            "malformed MIME header: missing colon: {}",
            quoted_go(&raw)
        ));
    }
    let mut line = strip_nl(&raw).to_vec();
    if line.is_empty() {
        return Ok(Some(Vec::new()));
    }
    loop {
        if *pos >= buf.len() {
            break;
        }
        let next = buf[*pos];
        if next != b' ' && next != b'\t' {
            break;
        }
        let (cont, _) = read_slice_nl(buf, pos);
        let cont = strip_nl(&cont);
        let cont = trim_left_space_tab(cont);
        line.push(b' ');
        line.extend_from_slice(cont);
    }
    let _ = eof;
    Ok(Some(line))
}

fn strip_nl(line: &[u8]) -> &[u8] {
    let mut s = line;
    if s.last() == Some(&b'\n') {
        s = &s[..s.len() - 1];
    }
    if s.last() == Some(&b'\r') {
        s = &s[..s.len() - 1];
    }
    s
}

fn trim_left_space_tab(v: &[u8]) -> &[u8] {
    let mut i = 0;
    while i < v.len() && (v[i] == b' ' || v[i] == b'\t') {
        i += 1;
    }
    &v[i..]
}

fn valid_header_value_byte(c: u8) -> bool {
    c == b'\t' || c == b' ' || (0x21..=0x7e).contains(&c) || c >= 0x80
}

fn header_get<'a>(headers: &'a [(String, Vec<String>)], key: &str) -> &'a str {
    let canon = canonical_mime_header_key(key);
    headers
        .iter()
        .find(|(k, _)| *k == canon)
        .and_then(|(_, v)| v.first())
        .map(String::as_str)
        .unwrap_or("")
}

fn disposition_names(headers: &[(String, Vec<String>)]) -> (String, String) {
    let v = header_get(headers, "Content-Disposition");
    let parsed = parse_media_type(v);
    if parsed.error.is_some() && parsed.media_type.is_empty() {
        return (String::new(), String::new());
    }
    let params: HashMap<String, String> = if parsed.error.is_some() && parsed.params.is_empty() {
        HashMap::new()
    } else {
        parsed.params
    };
    let form_name = if parsed.media_type == "form-data" {
        params.get("name").cloned().unwrap_or_default()
    } else {
        String::new()
    };
    let file_name = match params.get("filename") {
        Some(name) if !name.is_empty() => unix_base(name),
        _ => String::new(),
    };
    (form_name, file_name)
}

fn unix_base(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let mut path = path;
    while path.len() > 1 && path.ends_with('/') {
        path = &path[..path.len() - 1];
    }
    match path.rfind('/') {
        Some(i) => {
            let rest = &path[i + 1..];
            if rest.is_empty() {
                "/".into()
            } else {
                rest.to_string()
            }
        }
        None => path.to_string(),
    }
}

fn quoted_go(bytes: &[u8]) -> String {
    format!("{:?}", String::from_utf8_lossy(bytes).as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::writer::MultipartWriter;

    #[test]
    fn next_part_one_field_matches_writer() {
        let mut w = MultipartWriter::new(Some("boundary".into())).unwrap();
        w.write_field("foo", "bar").unwrap();
        let body = w.finish().unwrap();
        let mut r = MultipartReader::new("boundary".into());
        r.write(&body);
        let part = r.next_part().unwrap().expect("one part");
        assert_eq!(part.form_name, "foo");
        assert_eq!(part.file_name, "");
        assert_eq!(part.body, b"bar");
        let disp = part
            .header
            .iter()
            .find(|(k, _)| k == "Content-Disposition")
            .unwrap();
        assert_eq!(disp.1, ["form-data; name=\"foo\""]);
        assert!(r.next_part().unwrap().is_none());
        assert!(r.next_part().unwrap().is_none());
    }

    #[test]
    fn empty_boundary_errors() {
        let mut r = MultipartReader::new(String::new());
        r.write(b"--\r\n\r\n--\r\n");
        assert_eq!(r.next_part().unwrap_err(), "multipart: boundary is empty");
    }
}
