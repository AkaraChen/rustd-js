//! Go `mime/multipart.Reader.NextPart` / `NextRawPart` / `ReadForm` (Go 1.24).
//!
//! `NextPart` transparently decodes `Content-Transfer-Encoding: quoted-printable`
//! and hides that header. `NextRawPart` leaves the CTE and body alone. `write`
//! may split a boundary across chunks; `next_part` returns `Ok(None)` until a
//! complete part (or the closing delimiter) is buffered. `read_form` applies
//! the Go `multipartmaxparts` cap (default 1000) and Go `maxMemory + 10MB`
//! accounting for non-file values (headers + name overhead + body). File spill later.

use crate::header::{canonical_mime_header_key, canonical_mime_header_key_ok};
use crate::mediatype::parse_media_type;
use std::collections::HashMap;

#[derive(Clone, Copy)]
enum ReadErr {
    Eof,
    #[allow(dead_code)]
    UnexpectedEof,
}

enum StreamErr {
    NeedMore,
    Msg(String),
}

#[derive(Debug)]
pub struct MultipartPart {
    pub header: Vec<(String, Vec<String>)>,
    pub body: Vec<u8>,
    pub form_name: String,
    pub file_name: String,
}

#[derive(Debug)]
pub struct FormFileHeader {
    pub filename: String,
    pub header: Vec<(String, Vec<String>)>,
    pub size: i64,
    pub content: Vec<u8>,
}

#[derive(Debug, Default)]
pub struct MultipartForm {
    pub value: Vec<(String, Vec<String>)>,
    pub file: Vec<(String, Vec<FormFileHeader>)>,
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
    max_headers_per_part: i64,
    max_parts: i64,
}

impl MultipartReader {
    #[allow(dead_code)]
    pub fn new(boundary: String) -> Self {
        Self::with_limits(boundary, 10000, 1000)
    }

    #[allow(dead_code)]
    pub fn with_max_headers(boundary: String, max_headers_per_part: i64) -> Self {
        Self::with_limits(boundary, max_headers_per_part, 1000)
    }

    pub fn with_limits(boundary: String, max_headers_per_part: i64, max_parts: i64) -> Self {
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
            max_headers_per_part,
            max_parts,
        }
    }

    pub fn write(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
    }

    pub fn next_part(&mut self) -> Result<Option<MultipartPart>, String> {
        self.next_part_opt(false, i64::MAX)
    }

    pub fn next_raw_part(&mut self) -> Result<Option<MultipartPart>, String> {
        self.next_part_opt(true, i64::MAX)
    }

    /// Go `Reader.ReadForm`: `multipartmaxparts` (default 1000) and
    /// `maxMemory + 10MB` for non-file values. File spill stays later.
    pub fn read_form(&mut self, max_memory: i64) -> Result<MultipartForm, String> {
        const MAP_ENTRY_OVERHEAD: i64 = 200;
        let mut max_memory_bytes = read_form_max_memory_bytes(max_memory);
        let mut remaining = self.max_parts;
        let mut form = MultipartForm::default();
        loop {
            match self.next_part_opt(false, max_memory_bytes)? {
                None => return Ok(form),
                Some(part) => {
                    if remaining <= 0 {
                        return Err("multipart: message too large".into());
                    }
                    remaining -= 1;
                    if part.form_name.is_empty() {
                        continue;
                    }
                    max_memory_bytes -= part.form_name.len() as i64;
                    max_memory_bytes -= MAP_ENTRY_OVERHEAD;
                    if max_memory_bytes < 0 {
                        return Err("multipart: message too large".into());
                    }
                    if part.file_name.is_empty() {
                        max_memory_bytes -= part.body.len() as i64;
                        if max_memory_bytes < 0 {
                            return Err("multipart: message too large".into());
                        }
                        let value = String::from_utf8_lossy(&part.body).into_owned();
                        append_value(&mut form.value, part.form_name, value);
                    } else {
                        let size = part.body.len() as i64;
                        append_file(
                            &mut form.file,
                            part.form_name,
                            FormFileHeader {
                                filename: part.file_name,
                                header: part.header,
                                size,
                                content: part.body,
                            },
                        );
                    }
                }
            }
        }
    }

    fn snapshot(&self) -> (usize, u32, bool, bool, Vec<u8>, Vec<u8>) {
        (
            self.pos,
            self.parts_read,
            self.current_open,
            self.finished,
            self.nl.clone(),
            self.nl_dash_boundary.clone(),
        )
    }

    fn restore(&mut self, snap: (usize, u32, bool, bool, Vec<u8>, Vec<u8>)) {
        self.pos = snap.0;
        self.parts_read = snap.1;
        self.current_open = snap.2;
        self.finished = snap.3;
        self.nl = snap.4;
        self.nl_dash_boundary = snap.5;
    }

    fn next_part_opt(
        &mut self,
        raw: bool,
        max_header_bytes: i64,
    ) -> Result<Option<MultipartPart>, String> {
        if self.finished {
            return Ok(None);
        }
        let snap = self.snapshot();
        match self.try_next_part(raw, max_header_bytes) {
            Ok(part) => Ok(part),
            Err(StreamErr::NeedMore) => {
                self.restore(snap);
                Ok(None)
            }
            Err(StreamErr::Msg(e)) => Err(e),
        }
    }

    fn try_next_part(
        &mut self,
        raw: bool,
        max_header_bytes: i64,
    ) -> Result<Option<MultipartPart>, StreamErr> {
        if self.current_open {
            self.read_part_body()?;
            self.current_open = false;
        }
        if self.dash_boundary == b"--" {
            return Err(StreamErr::Msg("multipart: boundary is empty".into()));
        }
        let mut expect_new_part = false;
        loop {
            let line = self.read_next_line()?;
            if is_boundary_delimiter_line(
                &line,
                &self.dash_boundary,
                &mut self.nl,
                &mut self.nl_dash_boundary,
                self.parts_read,
            ) {
                self.parts_read += 1;
                let mut header = read_mime_header(
                    &self.buf,
                    &mut self.pos,
                    self.max_headers_per_part,
                    max_header_bytes,
                )?;
                let mut body = self.read_part_body()?;
                self.current_open = false;
                if !raw {
                    body =
                        maybe_decode_quoted_printable(&mut header, body).map_err(StreamErr::Msg)?;
                }
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
                return Err(StreamErr::Msg(format!(
                    "multipart: expecting a new Part; got line {}",
                    quoted_go(&line)
                )));
            }
            if self.parts_read == 0 {
                continue;
            }
            if line == self.nl {
                expect_new_part = true;
                continue;
            }
            return Err(StreamErr::Msg(format!(
                "multipart: unexpected line in Next(): {}",
                quoted_go(&line)
            )));
        }
    }

    fn read_next_line(&mut self) -> Result<Vec<u8>, StreamErr> {
        if self.pos >= self.buf.len() {
            return Err(StreamErr::NeedMore);
        }
        if let Some(rel) = self.buf[self.pos..].iter().position(|&b| b == b'\n') {
            let end = self.pos + rel + 1;
            let line = self.buf[self.pos..end].to_vec();
            self.pos = end;
            return Ok(line);
        }
        let rest = &self.buf[self.pos..];
        if is_final_boundary(rest, &self.dash_boundary_dash, &self.nl) {
            let line = rest.to_vec();
            self.pos = self.buf.len();
            return Ok(line);
        }
        Err(StreamErr::NeedMore)
    }

    fn read_part_body(&mut self) -> Result<Vec<u8>, StreamErr> {
        let mut body = Vec::new();
        let mut total: i64 = 0;
        loop {
            let peek = &self.buf[self.pos..];
            let (n, err) = scan_until_boundary(
                peek,
                &self.dash_boundary,
                &self.nl_dash_boundary,
                total,
                None,
            );
            if n == 0 && err.is_none() {
                return Err(StreamErr::NeedMore);
            }
            if n > 0 {
                body.extend_from_slice(&self.buf[self.pos..self.pos + n]);
                self.pos += n;
                total += n as i64;
            }
            match err {
                Some(ReadErr::Eof) => return Ok(body),
                Some(ReadErr::UnexpectedEof) => {
                    return Err(StreamErr::Msg("multipart: NextPart: unexpected EOF".into()))
                }
                None => {
                    if n == 0 {
                        return Err(StreamErr::NeedMore);
                    }
                }
            }
        }
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

fn read_full_line(buf: &[u8], pos: &mut usize) -> Result<Vec<u8>, StreamErr> {
    if *pos >= buf.len() {
        return Err(StreamErr::NeedMore);
    }
    match buf[*pos..].iter().position(|&b| b == b'\n') {
        Some(rel) => {
            let end = *pos + rel + 1;
            let line = buf[*pos..end].to_vec();
            *pos = end;
            Ok(line)
        }
        None => Err(StreamErr::NeedMore),
    }
}

fn read_form_max_memory_bytes(max_memory: i64) -> i64 {
    const RESERVE: i64 = 10 << 20;
    match max_memory.checked_add(RESERVE) {
        Some(n) if n > 0 => n,
        Some(_) if max_memory < 0 => 0,
        _ => i64::MAX,
    }
}

fn read_mime_header(
    buf: &[u8],
    pos: &mut usize,
    mut max_headers: i64,
    mut max_memory: i64,
) -> Result<Vec<(String, Vec<String>)>, StreamErr> {
    if *pos < buf.len() && (buf[*pos] == b' ' || buf[*pos] == b'\t') {
        let line = read_full_line(buf, pos)?;
        let shown = strip_nl(&line);
        let shown = if shown.len() > 80 {
            &shown[..80]
        } else {
            shown
        };
        return Err(StreamErr::Msg(format!(
            "malformed MIME header initial line: {}",
            String::from_utf8_lossy(shown)
        )));
    }
    // Go `net/textproto.readMIMEHeader`: 400-byte map overhead, then 200 per new key.
    max_memory -= 400;
    let mut headers: Vec<(String, Vec<String>)> = Vec::new();
    loop {
        let kv = match read_continued_line(buf, pos)? {
            None => break,
            Some(line) if line.is_empty() => break,
            Some(line) => line,
        };
        let Some(colon) = kv.iter().position(|&b| b == b':') else {
            return Err(StreamErr::Msg(format!(
                "malformed MIME header line: {}",
                String::from_utf8_lossy(&kv)
            )));
        };
        let key = canonical_mime_header_key_ok(&kv[..colon]).ok_or_else(|| {
            StreamErr::Msg(format!(
                "malformed MIME header line: {}",
                String::from_utf8_lossy(&kv)
            ))
        })?;
        let v = &kv[colon + 1..];
        if !v.iter().copied().all(valid_header_value_byte) {
            return Err(StreamErr::Msg(format!(
                "malformed MIME header line: {}",
                String::from_utf8_lossy(&kv)
            )));
        }
        let value = String::from_utf8_lossy(trim_left_space_tab(v)).into_owned();
        max_headers -= 1;
        if max_headers < 0 {
            return Err(StreamErr::Msg("multipart: message too large".into()));
        }
        let is_new = headers.iter().all(|(k, _)| *k != key);
        if is_new {
            max_memory -= key.len() as i64;
            max_memory -= 200;
        }
        max_memory -= value.len() as i64;
        if max_memory < 0 {
            return Err(StreamErr::Msg("multipart: message too large".into()));
        }
        if let Some(existing) = headers.iter_mut().find(|(k, _)| *k == key) {
            existing.1.push(value);
        } else {
            headers.push((key, vec![value]));
        }
    }
    Ok(headers)
}

fn read_continued_line(buf: &[u8], pos: &mut usize) -> Result<Option<Vec<u8>>, StreamErr> {
    let raw = read_full_line(buf, pos)?;
    if !raw.is_empty() && !raw.contains(&b':') && !strip_nl(&raw).is_empty() {
        return Err(StreamErr::Msg(format!(
            "malformed MIME header: missing colon: {}",
            quoted_go(strip_nl(&raw))
        )));
    }
    let mut line = strip_nl(&raw).to_vec();
    if line.is_empty() {
        return Ok(Some(Vec::new()));
    }
    loop {
        if *pos >= buf.len() {
            return Err(StreamErr::NeedMore);
        }
        let next = buf[*pos];
        if next != b' ' && next != b'\t' {
            break;
        }
        if !buf[*pos..].contains(&b'\n') {
            return Err(StreamErr::NeedMore);
        }
        let cont = read_full_line(buf, pos)?;
        let cont = strip_nl(&cont);
        let cont = trim_left_space_tab(cont);
        line.push(b' ');
        line.extend_from_slice(cont);
    }
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

fn maybe_decode_quoted_printable(
    headers: &mut Vec<(String, Vec<String>)>,
    body: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let cte = header_get(headers, "Content-Transfer-Encoding");
    if !cte.eq_ignore_ascii_case("quoted-printable") {
        return Ok(body);
    }
    headers.retain(|(k, _)| k != "Content-Transfer-Encoding");
    let (out, err) = crate::qp::qp_decode(&body);
    match err {
        Some(e) => Err(e),
        None => Ok(out),
    }
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

fn append_value(fields: &mut Vec<(String, Vec<String>)>, name: String, value: String) {
    if let Some(existing) = fields.iter_mut().find(|(k, _)| *k == name) {
        existing.1.push(value);
    } else {
        fields.push((name, vec![value]));
    }
}

fn append_file(
    fields: &mut Vec<(String, Vec<FormFileHeader>)>,
    name: String,
    file: FormFileHeader,
) {
    if let Some(existing) = fields.iter_mut().find(|(k, _)| *k == name) {
        existing.1.push(file);
    } else {
        fields.push((name, vec![file]));
    }
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
        let mut empty = MultipartReader::new(String::new());
        assert_eq!(
            empty.next_part().unwrap_err(),
            "multipart: boundary is empty"
        );
    }

    #[test]
    fn next_part_missing_colon_matches_go() {
        let mut r = MultipartReader::new("b".into());
        r.write(b"--b\r\nNotAHeader\r\n\r\nx\r\n--b--\r\n");
        assert_eq!(
            r.next_part().unwrap_err(),
            r#"malformed MIME header: missing colon: "NotAHeader""#
        );
    }

    #[test]
    fn next_part_missing_closer_returns_none_until_more_bytes() {
        let body = b"\r\nThis is a multi-part message.  This line is ignored.\r\n--MyBoundary\r\nfoo-bar: baz\r\n\r\nOh no, premature EOF!\r\n";
        let mut r = MultipartReader::new("MyBoundary".into());
        r.write(body);
        assert!(r.next_part().unwrap().is_none());
        let mut one = MultipartReader::new("MyBoundary".into());
        for byte in body {
            one.write(std::slice::from_ref(byte));
            assert!(one.next_part().unwrap().is_none());
        }
        assert!(one.next_part().unwrap().is_none());
    }

    fn body_with_boundary_len(n: usize) -> (String, Vec<u8>) {
        let boundary = "x".repeat(n);
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=foo\r\n\r\nhello\r\n--{boundary}--\r\n"
        )
        .into_bytes();
        (boundary, body)
    }

    #[test]
    fn next_part_rfc_boundary_length_70_and_71() {
        for n in [70, 71] {
            let (boundary, body) = body_with_boundary_len(n);
            let parts = collect_parts(&boundary, &body);
            assert_eq!(parts.len(), 1, "n={n}");
            assert_eq!(parts[0].form_name, "foo");
            assert_eq!(parts[0].body, b"hello");
            parts_eq(&parts, &collect_parts_1byte(&boundary, &body));
        }
        match MultipartWriter::new(Some("x".repeat(71))) {
            Ok(_) => panic!("71-char Writer boundary should fail"),
            Err(e) => assert_eq!(e, "mime: invalid boundary length"),
        }
    }

    #[test]
    fn next_part_lf_only_headers_no_crlf() {
        let body = b"--b\nContent-Disposition: form-data; name=foo\n\nhello\n--b--\n";
        let parts = collect_parts("b", body);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].form_name, "foo");
        assert_eq!(parts[0].body, b"hello");
        parts_eq(&parts, &collect_parts_1byte("b", body));
    }

    #[test]
    fn next_part_header_without_blank_crlf_is_missing_colon() {
        let body = b"--b\r\nContent-Disposition: form-data; name=foo\r\nhello\r\n--b--\r\n";
        let mut r = MultipartReader::new("b".into());
        r.write(body);
        assert_eq!(
            r.next_part().unwrap_err(),
            r#"malformed MIME header: missing colon: "hello""#
        );
        let mut one = MultipartReader::new("b".into());
        let mut err = None;
        for byte in body {
            one.write(std::slice::from_ref(byte));
            match one.next_part() {
                Ok(None) => {}
                Ok(Some(_)) => panic!("unexpected part"),
                Err(e) => {
                    err = Some(e);
                    break;
                }
            }
        }
        assert_eq!(
            err.as_deref(),
            Some(r#"malformed MIME header: missing colon: "hello""#)
        );
    }

    #[test]
    fn next_part_truncated_header_without_newline_is_none() {
        let body = b"--b\r\nFoo: bar";
        let mut r = MultipartReader::new("b".into());
        r.write(body);
        assert!(r.next_part().unwrap().is_none());
        parts_eq(&[], &collect_parts_1byte("b", body));
    }

    #[test]
    fn next_part_missing_content_disposition_is_not_error() {
        let only_ct = b"--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b--\r\n";
        let parts = collect_parts("b", only_ct);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].form_name, "");
        assert_eq!(parts[0].file_name, "");
        assert_eq!(parts[0].body, b"hello");
        assert!(parts[0]
            .header
            .iter()
            .all(|(k, _)| k != "Content-Disposition"));
        assert_eq!(
            parts[0]
                .header
                .iter()
                .find(|(k, _)| k == "Content-Type")
                .map(|(_, v)| v.clone()),
            Some(vec!["text/plain".into()])
        );
        parts_eq(&parts, &collect_parts_1byte("b", only_ct));

        let empty = b"--b\r\n\r\nhello\r\n--b--\r\n";
        let empty_parts = collect_parts("b", empty);
        assert_eq!(empty_parts.len(), 1);
        assert!(empty_parts[0].header.is_empty());
        assert_eq!(empty_parts[0].form_name, "");
        parts_eq(&empty_parts, &collect_parts_1byte("b", empty));

        let mixed = b"--b\r\nContent-Type: text/plain\r\n\r\nfirst\r\n--b\r\nContent-Disposition: form-data; name=foo\r\n\r\nsecond\r\n--b--\r\n";
        let mixed_parts = collect_parts("b", mixed);
        assert_eq!(mixed_parts.len(), 2);
        assert_eq!(mixed_parts[0].form_name, "");
        assert_eq!(mixed_parts[1].form_name, "foo");
        assert_eq!(mixed_parts[0].body, b"first");
        assert_eq!(mixed_parts[1].body, b"second");
        parts_eq(&mixed_parts, &collect_parts_1byte("b", mixed));
    }

    fn collect_parts(boundary: &str, body: &[u8]) -> Vec<MultipartPart> {
        let mut r = MultipartReader::new(boundary.into());
        r.write(body);
        let mut parts = Vec::new();
        loop {
            match r.next_part().unwrap() {
                Some(p) => parts.push(p),
                None => break,
            }
        }
        assert!(r.next_part().unwrap().is_none());
        parts
    }

    fn collect_parts_1byte(boundary: &str, body: &[u8]) -> Vec<MultipartPart> {
        let mut r = MultipartReader::new(boundary.into());
        let mut parts = Vec::new();
        for byte in body {
            r.write(std::slice::from_ref(byte));
            while let Some(p) = r.next_part().unwrap() {
                parts.push(p);
            }
        }
        while let Some(p) = r.next_part().unwrap() {
            parts.push(p);
        }
        assert!(r.next_part().unwrap().is_none());
        parts
    }

    fn parts_eq(a: &[MultipartPart], b: &[MultipartPart]) {
        assert_eq!(a.len(), b.len());
        for (i, (l, r)) in a.iter().zip(b).enumerate() {
            assert_eq!(l.form_name, r.form_name, "form_name[{i}]");
            assert_eq!(l.file_name, r.file_name, "file_name[{i}]");
            assert_eq!(l.header, r.header, "header[{i}]");
            assert_eq!(l.body, r.body, "body[{i}]");
        }
    }

    #[test]
    fn next_part_multi_field_matches_writer() {
        let mut w = MultipartWriter::new(Some("boundary".into())).unwrap();
        w.write_field("foo", "bar").unwrap();
        w.write_field("a\"b", "x\\y").unwrap();
        w.write_field("empty", "").unwrap();
        let body = w.finish().unwrap();
        let parts = collect_parts("boundary", &body);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].form_name, "foo");
        assert_eq!(parts[0].file_name, "");
        assert_eq!(parts[0].body, b"bar");
        assert_eq!(parts[1].form_name, "a\"b");
        assert_eq!(parts[1].body, b"x\\y");
        assert_eq!(parts[2].form_name, "empty");
        assert_eq!(parts[2].body, b"");
        assert_eq!(
            parts[1]
                .header
                .iter()
                .find(|(k, _)| k == "Content-Disposition")
                .unwrap()
                .1,
            ["form-data; name=\"a\\\"b\""]
        );
    }

    #[test]
    fn next_part_mixed_create_form_field_and_write_field() {
        let mut w = MultipartWriter::new(Some("MIMEBOUNDARY".into())).unwrap();
        let id = w.create_form_field("note").unwrap();
        w.write_part(id, b"hello\r\nworld").unwrap();
        w.end_part(id).unwrap();
        w.write_field("n", "1").unwrap();
        let body = w.finish().unwrap();
        let parts = collect_parts("MIMEBOUNDARY", &body);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].form_name, "note");
        assert_eq!(parts[0].body, b"hello\r\nworld");
        assert_eq!(parts[1].form_name, "n");
        assert_eq!(parts[1].body, b"1");
    }

    #[test]
    fn next_part_body_containing_boundary_without_crlf_prefix() {
        let mut w = MultipartWriter::new(Some("bound".into())).unwrap();
        w.write_field("keep", "hello--bound--world").unwrap();
        w.write_field("after", "ok").unwrap();
        let body = w.finish().unwrap();
        let parts = collect_parts("bound", &body);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].body, b"hello--bound--world");
        assert_eq!(parts[1].body, b"ok");
    }

    fn qp_form_body(cte: &str) -> Vec<u8> {
        format!(
            "--0016e68ee29c5d515f04cedf6733\r\n\
Content-Type: text/plain; charset=ISO-8859-1\r\n\
Content-Disposition: form-data; name=text\r\n\
Content-Transfer-Encoding: {cte}\r\n\
\r\n\
words words words words words words words words words words words words wor=\r\n\
ds words words words words words words words words words words words words =\r\n\
words words words words words words words words words words words words wor=\r\n\
ds words words words words words words words words words words words words =\r\n\
words words words words words words words words words\r\n\
--0016e68ee29c5d515f04cedf6733\r\n\
Content-Type: text/plain; charset=ISO-8859-1\r\n\
Content-Disposition: form-data; name=submit\r\n\
\r\n\
Submit\r\n\
--0016e68ee29c5d515f04cedf6733--"
        )
        .into_bytes()
    }

    #[test]
    fn next_part_quoted_printable_cte_decodes_and_hides_header() {
        let want = b"words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words";
        for cte in ["quoted-printable", "Quoted-PRINTABLE"] {
            let mut r = MultipartReader::new("0016e68ee29c5d515f04cedf6733".into());
            r.write(&qp_form_body(cte));
            let part = r.next_part().unwrap().expect("qp part");
            assert!(
                part.header
                    .iter()
                    .all(|(k, _)| k != "Content-Transfer-Encoding"),
                "{cte}"
            );
            assert_eq!(part.form_name, "text");
            assert_eq!(part.body, want, "{cte}");
            let submit = r.next_part().unwrap().expect("submit");
            assert_eq!(submit.form_name, "submit");
            assert_eq!(submit.body, b"Submit");
        }
    }

    #[test]
    fn next_raw_part_keeps_quoted_printable_cte() {
        let body = b"--0016e68ee29c5d515f04cedf6733\r\n\
Content-Type: text/plain; charset=\"utf-8\"\r\n\
Content-Transfer-Encoding: quoted-printable\r\n\
\r\n\
<div dir=3D\"ltr\">Hello World.</div>\r\n\
--0016e68ee29c5d515f04cedf6733\r\n\
Content-Type: text/plain; charset=\"utf-8\"\r\n\
Content-Transfer-Encoding: quoted-printable\r\n\
\r\n\
<div dir=3D\"ltr\">Hello World.</div>\r\n\
--0016e68ee29c5d515f04cedf6733--"
            .to_vec();
        let mut r = MultipartReader::new("0016e68ee29c5d515f04cedf6733".into());
        r.write(&body);
        let raw = r.next_raw_part().unwrap().expect("raw");
        assert_eq!(
            raw.header
                .iter()
                .find(|(k, _)| k == "Content-Transfer-Encoding")
                .map(|(_, v)| v.clone()),
            Some(vec!["quoted-printable".into()])
        );
        assert_eq!(raw.body, br#"<div dir=3D"ltr">Hello World.</div>"#);
        let decoded = r.next_part().unwrap().expect("decoded");
        assert!(decoded
            .header
            .iter()
            .all(|(k, _)| k != "Content-Transfer-Encoding"));
        assert_eq!(decoded.body, br#"<div dir="ltr">Hello World.</div>"#);
    }

    #[test]
    fn next_part_leaves_non_qp_cte() {
        let body = b"--b\r\nContent-Transfer-Encoding: 7bit\r\nContent-Disposition: form-data; name=plain\r\n\r\nhi\r\n--b--";
        let mut r = MultipartReader::new("b".into());
        r.write(body);
        let part = r.next_part().unwrap().expect("part");
        assert_eq!(
            part.header
                .iter()
                .find(|(k, _)| k == "Content-Transfer-Encoding")
                .map(|(_, v)| v.clone()),
            Some(vec!["7bit".into()])
        );
        assert_eq!(part.body, b"hi");
    }

    #[test]
    fn next_part_1byte_feed_matches_whole_body() {
        let mut w = MultipartWriter::new(Some("bound".into())).unwrap();
        w.write_field("foo", "bar").unwrap();
        w.write_field("keep", "hello--bound--world").unwrap();
        w.write_field("empty", "").unwrap();
        let body = w.finish().unwrap();
        parts_eq(
            &collect_parts("bound", &body),
            &collect_parts_1byte("bound", &body),
        );

        let qp = qp_form_body("quoted-printable");
        parts_eq(
            &collect_parts("0016e68ee29c5d515f04cedf6733", &qp),
            &collect_parts_1byte("0016e68ee29c5d515f04cedf6733", &qp),
        );
    }

    #[test]
    fn next_part_1byte_returns_none_until_a_complete_part() {
        let mut w = MultipartWriter::new(Some("b".into())).unwrap();
        w.write_field("only", "x").unwrap();
        let body = w.finish().unwrap();
        let mut r = MultipartReader::new("b".into());
        r.write(&body[..1]);
        assert!(r.next_part().unwrap().is_none());
        r.write(&body[1..]);
        let part = r.next_part().unwrap().expect("part");
        assert_eq!(part.form_name, "only");
        assert_eq!(part.body, b"x");
        assert!(r.next_part().unwrap().is_none());
    }

    fn part_with_header_count(n: usize) -> Vec<u8> {
        let mut body = b"--b\r\n".to_vec();
        for i in 0..n {
            body.extend(format!("X-{i}: v\r\n").into_bytes());
        }
        body.extend_from_slice(b"\r\nx\r\n--b--\r\n");
        body
    }

    #[test]
    fn next_part_header_count_limit_matches_go_default() {
        let mut ok = MultipartReader::new("b".into());
        ok.write(&part_with_header_count(10000));
        let part = ok.next_part().unwrap().expect("10000 headers");
        assert_eq!(part.header.len(), 10000);
        assert_eq!(part.body, b"x");

        let mut over = MultipartReader::new("b".into());
        over.write(&part_with_header_count(10001));
        assert_eq!(
            over.next_part().unwrap_err(),
            "multipart: message too large"
        );
    }

    #[test]
    fn next_part_header_count_custom_limit() {
        let body_ok = part_with_header_count(3);
        let mut ok = MultipartReader::with_max_headers("b".into(), 3);
        ok.write(&body_ok);
        assert_eq!(ok.next_part().unwrap().expect("3 headers").header.len(), 3);

        let mut over = MultipartReader::with_max_headers("b".into(), 3);
        over.write(&part_with_header_count(4));
        assert_eq!(
            over.next_part().unwrap_err(),
            "multipart: message too large"
        );
    }

    fn body_with_part_count(n: usize) -> Vec<u8> {
        let mut body = Vec::new();
        for i in 0..n {
            body.extend(
                format!("--b\r\nContent-Disposition: form-data; name=\"f{i}\"\r\n\r\n{i}\r\n")
                    .into_bytes(),
            );
        }
        body.extend_from_slice(b"--b--\r\n");
        body
    }

    fn drain_parts(n: usize) -> usize {
        let mut r = MultipartReader::new("b".into());
        r.write(&body_with_part_count(n));
        let mut got = 0usize;
        loop {
            match r.next_part().unwrap() {
                Some(_) => got += 1,
                None => break,
            }
        }
        got
    }

    #[test]
    fn next_part_1000_and_1001_parts_succeed_like_go() {
        assert_eq!(drain_parts(1000), 1000);
        assert_eq!(drain_parts(1001), 1001);
    }

    fn form_value_count(n: usize) -> Result<usize, String> {
        let mut r = MultipartReader::new("b".into());
        r.write(&body_with_part_count(n));
        r.read_form(1 << 20)
            .map(|form| form.value.iter().map(|(_, v)| v.len()).sum())
    }

    #[test]
    fn read_form_1000_ok_1001_too_large() {
        assert_eq!(form_value_count(1000).unwrap(), 1000);
        assert_eq!(
            form_value_count(1001).unwrap_err(),
            "multipart: message too large"
        );
    }

    #[test]
    fn read_form_max_parts_custom_limit() {
        let mut ok = MultipartReader::with_limits("b".into(), 10000, 3);
        ok.write(&body_with_part_count(3));
        assert_eq!(ok.read_form(1024).unwrap().value.len(), 3);

        let mut over = MultipartReader::with_limits("b".into(), 10000, 3);
        over.write(&body_with_part_count(4));
        assert_eq!(
            over.read_form(1024).unwrap_err(),
            "multipart: message too large"
        );
    }

    #[test]
    fn read_form_empty_form_name_still_counts() {
        let mut body = Vec::new();
        for _ in 0..2 {
            body.extend(b"--b\r\nContent-Type: text/plain\r\n\r\nx\r\n");
        }
        body.extend(b"--b--\r\n");
        let mut r = MultipartReader::with_limits("b".into(), 10000, 1);
        r.write(&body);
        assert_eq!(
            r.read_form(1024).unwrap_err(),
            "multipart: message too large"
        );
    }

    fn value_form_body(name: &str, value: &str) -> Vec<u8> {
        format!(
            "--b\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n--b--\r\n"
        )
        .into_bytes()
    }

    fn two_value_form_body(a: &str, va: &str, b: &str, vb: &str) -> Vec<u8> {
        format!(
            "--b\r\nContent-Disposition: form-data; name=\"{a}\"\r\n\r\n{va}\r\n--b\r\nContent-Disposition: form-data; name=\"{b}\"\r\n\r\n{vb}\r\n--b--\r\n"
        )
        .into_bytes()
    }

    fn read_form_err(body: &[u8], max_memory: i64) -> Result<usize, String> {
        let mut r = MultipartReader::new("b".into());
        r.write(body);
        r.read_form(max_memory)
            .map(|form| form.value.iter().map(|(_, v)| v.len()).sum())
    }

    #[test]
    fn read_form_max_memory_header_cap_matches_go() {
        let body = value_form_body("x", &"1".repeat(100));
        // Content-Disposition: form-data; name="x" → 400 + 19 + 200 + 19 = 638
        let fail_at = 638 - (10 << 20);
        assert_eq!(
            read_form_err(&body, fail_at - 1).unwrap_err(),
            "multipart: message too large"
        );
        assert_eq!(read_form_err(&body, fail_at).unwrap(), 1);
        assert_eq!(read_form_err(&body, 0).unwrap(), 1);
    }

    #[test]
    fn read_form_max_memory_value_body_matches_go() {
        let body = value_form_body("largetext", &"1".repeat(1024));
        // name 9 + 200 + 1024 = 1233 (body dominates the 646-byte header snapshot)
        let fail_at = 1233 - (10 << 20);
        assert_eq!(
            read_form_err(&body, fail_at - 1).unwrap_err(),
            "multipart: message too large"
        );
        assert_eq!(read_form_err(&body, fail_at).unwrap(), 1);
        let form = {
            let mut r = MultipartReader::new("b".into());
            r.write(&body);
            r.read_form(fail_at).unwrap()
        };
        assert_eq!(form.value[0].1[0].len(), 1024);
    }

    #[test]
    fn read_form_max_memory_two_values_matches_go() {
        let body = two_value_form_body("a", "hello", "b", "world");
        // first value persist 206, second header snapshot needs 638 → 844
        let fail_at = 844 - (10 << 20);
        assert_eq!(
            read_form_err(&body, fail_at - 1).unwrap_err(),
            "multipart: message too large"
        );
        assert_eq!(read_form_err(&body, fail_at).unwrap(), 2);
    }

    #[test]
    fn read_form_negative_reserve_zero_is_too_large() {
        let body = value_form_body("x", "hello");
        assert_eq!(
            read_form_err(&body, -(10 << 20)).unwrap_err(),
            "multipart: message too large"
        );
    }
}
