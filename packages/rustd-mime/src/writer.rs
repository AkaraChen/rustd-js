//! Go `mime/multipart.Writer` (Go 1.24 `writer.go` + Go 1.25 `FileContentDisposition`).
//!
//! This slice is CreateFormField / CreateFormFile / WriteField / Close.
//! No CreatePart (generic MIMEHeader part).

use getrandom::getrandom;

pub struct MultipartWriter {
    buf: Vec<u8>,
    boundary: String,
    has_part: bool,
    part_open: bool,
    finished: bool,
    part_id: u32,
}

impl MultipartWriter {
    pub fn new(boundary: Option<String>) -> Result<Self, String> {
        let boundary = match boundary {
            Some(b) => {
                validate_boundary(&b)?;
                b
            }
            None => random_boundary()?,
        };
        Ok(Self {
            buf: Vec::new(),
            boundary,
            has_part: false,
            part_open: false,
            finished: false,
            part_id: 0,
        })
    }

    pub fn boundary(&self) -> &str {
        &self.boundary
    }

    pub fn set_boundary(&mut self, boundary: &str) -> Result<(), String> {
        if self.has_part {
            return Err("mime: SetBoundary called after write".into());
        }
        validate_boundary(boundary)?;
        self.boundary = boundary.to_string();
        Ok(())
    }

    pub fn form_data_content_type(&self) -> String {
        let mut b = self.boundary.clone();
        if b.contains(|c: char| "()<>@,;:\\\"/[]?= ".contains(c)) {
            b = format!("\"{b}\"");
        }
        format!("multipart/form-data; boundary={b}")
    }

    pub fn create_form_field(&mut self, fieldname: &str) -> Result<u32, String> {
        self.start_part()?;
        let disp = format!("form-data; name=\"{}\"", escape_quotes(fieldname));
        self.buf.extend_from_slice(b"Content-Disposition: ");
        self.buf.extend_from_slice(disp.as_bytes());
        self.buf.extend_from_slice(b"\r\n\r\n");
        Ok(self.open_part())
    }

    pub fn create_form_file(&mut self, fieldname: &str, filename: &str) -> Result<u32, String> {
        self.start_part()?;
        let disp = file_content_disposition(fieldname, filename);
        self.buf.extend_from_slice(b"Content-Disposition: ");
        self.buf.extend_from_slice(disp.as_bytes());
        self.buf.extend_from_slice(b"\r\nContent-Type: application/octet-stream\r\n\r\n");
        Ok(self.open_part())
    }

    pub fn write_part(&mut self, part_id: u32, data: &[u8]) -> Result<(), String> {
        if part_id == 0 || part_id != self.part_id || !self.part_open || self.finished {
            return Err("multipart: can't write to finished part".into());
        }
        self.buf.extend_from_slice(data);
        Ok(())
    }

    pub fn end_part(&mut self, part_id: u32) -> Result<(), String> {
        if part_id == 0 || part_id != self.part_id {
            return Err("multipart: can't write to finished part".into());
        }
        self.part_open = false;
        Ok(())
    }

    pub fn write_field(&mut self, fieldname: &str, value: &str) -> Result<(), String> {
        let id = self.create_form_field(fieldname)?;
        self.write_part(id, value.as_bytes())?;
        Ok(())
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, String> {
        if self.finished {
            return Ok(self.buf.clone());
        }
        self.part_open = false;
        self.buf.extend_from_slice(b"\r\n--");
        self.buf.extend_from_slice(self.boundary.as_bytes());
        self.buf.extend_from_slice(b"--\r\n");
        self.finished = true;
        Ok(self.buf.clone())
    }

    fn start_part(&mut self) -> Result<(), String> {
        self.close_current_part()?;
        if self.finished {
            return Err("multipart: can't write to finished part".into());
        }
        if self.has_part {
            self.buf.extend_from_slice(b"\r\n--");
        } else {
            self.buf.extend_from_slice(b"--");
        }
        self.buf.extend_from_slice(self.boundary.as_bytes());
        self.buf.extend_from_slice(b"\r\n");
        Ok(())
    }

    fn open_part(&mut self) -> u32 {
        self.has_part = true;
        self.part_open = true;
        self.part_id = self.part_id.wrapping_add(1);
        if self.part_id == 0 {
            self.part_id = 1;
        }
        self.part_id
    }

    fn close_current_part(&mut self) -> Result<(), String> {
        self.part_open = false;
        Ok(())
    }
}

/// Go 1.25 `multipart.FileContentDisposition` (same bytes as Go 1.24 `CreateFormFile`).
pub fn file_content_disposition(fieldname: &str, filename: &str) -> String {
    format!(
        "form-data; name=\"{}\"; filename=\"{}\"",
        escape_quotes(fieldname),
        escape_quotes(filename)
    )
}

fn escape_quotes(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

pub fn validate_boundary(boundary: &str) -> Result<(), String> {
    let bytes = boundary.as_bytes();
    if bytes.is_empty() || bytes.len() > 70 {
        return Err("mime: invalid boundary length".into());
    }
    let end = bytes.len() - 1;
    for (i, &b) in bytes.iter().enumerate() {
        if b.is_ascii_alphanumeric() {
            continue;
        }
        match b {
            b'\'' | b'(' | b')' | b'+' | b'_' | b',' | b'-' | b'.' | b'/' | b':' | b'='
            | b'?' => continue,
            b' ' if i != end => continue,
            _ => return Err("mime: invalid boundary character".into()),
        }
    }
    Ok(())
}

fn random_boundary() -> Result<String, String> {
    let mut buf = [0u8; 30];
    getrandom(&mut buf).map_err(|e| format!("mime: getrandom: {e}"))?;
    let mut out = String::with_capacity(60);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for b in buf {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_field_one_part_matches_go() {
        let mut w = MultipartWriter::new(Some("boundary".into())).unwrap();
        w.write_field("foo", "bar").unwrap();
        let got = w.finish().unwrap();
        let want = b"--boundary\r\nContent-Disposition: form-data; name=\"foo\"\r\n\r\nbar\r\n--boundary--\r\n";
        assert_eq!(got, want);
    }

    #[test]
    fn create_form_file_one_part_matches_go() {
        let mut w = MultipartWriter::new(Some("boundary".into())).unwrap();
        let id = w.create_form_file("file", "a.txt").unwrap();
        w.write_part(id, b"hi").unwrap();
        let got = w.finish().unwrap();
        let want = b"--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\nContent-Type: application/octet-stream\r\n\r\nhi\r\n--boundary--\r\n";
        assert_eq!(got, want);
        assert_eq!(
            file_content_disposition("file", "a.txt"),
            "form-data; name=\"file\"; filename=\"a.txt\""
        );
    }

    #[test]
    fn set_boundary_rejects_trailing_space() {
        let mut w = MultipartWriter::new(None).unwrap();
        assert_eq!(
            w.set_boundary("badspace ").unwrap_err(),
            "mime: invalid boundary character"
        );
    }
}
