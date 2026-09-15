use crate::error::MailErr;

#[derive(Debug, Clone)]
pub struct HeaderPair {
    pub key: String,
    pub value: String,
}

#[derive(Debug)]
pub struct Message {
    pub headers: Vec<HeaderPair>,
    pub body: Vec<u8>,
    pub raw: Vec<u8>,
}

pub fn canonical_header_key(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut upper = true;
    for &c in bytes {
        if !valid_header_field_byte(c) {
            return s.to_string();
        }
        if upper && c.is_ascii_lowercase() {
            return canonicalize(bytes);
        }
        if !upper && c.is_ascii_uppercase() {
            return canonicalize(bytes);
        }
        upper = c == b'-';
    }
    s.to_string()
}

fn canonicalize(src: &[u8]) -> String {
    let mut a = src.to_vec();
    let mut no_canon = false;
    for &c in &a {
        if valid_header_field_byte(c) {
            continue;
        }
        if c == b' ' {
            no_canon = true;
            continue;
        }
        return String::from_utf8_lossy(src).into_owned();
    }
    if no_canon {
        return String::from_utf8_lossy(&a).into_owned();
    }
    let mut upper = true;
    for c in &mut a {
        if upper && c.is_ascii_lowercase() {
            *c -= b'a' - b'A';
        } else if !upper && c.is_ascii_uppercase() {
            *c += b'a' - b'A';
        }
        upper = *c == b'-';
    }
    String::from_utf8(a).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

fn valid_header_field_byte(c: u8) -> bool {
    matches!(
        c,
        b'0'..=b'9'
            | b'a'..=b'z'
            | b'A'..=b'Z'
            | b'!'
            | b'#'
            | b'$'
            | b'%'
            | b'&'
            | b'\''
            | b'*'
            | b'+'
            | b'-'
            | b'.'
            | b'^'
            | b'_'
            | b'`'
            | b'|'
            | b'~'
    )
}

fn trim_spht(s: &[u8]) -> &[u8] {
    let mut i = 0;
    while i < s.len() && (s[i] == b' ' || s[i] == b'\t') {
        i += 1;
    }
    let mut n = s.len();
    while n > i && (s[n - 1] == b' ' || s[n - 1] == b'\t') {
        n -= 1;
    }
    &s[i..n]
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn read_line(&mut self) -> Result<Vec<u8>, MailErr> {
        if self.pos >= self.data.len() {
            return Err(MailErr::new("header", "EOF"));
        }
        let start = self.pos;
        while self.pos < self.data.len() && self.data[self.pos] != b'\n' {
            self.pos += 1;
        }
        let mut line = &self.data[start..self.pos];
        if self.pos < self.data.len() && self.data[self.pos] == b'\n' {
            self.pos += 1;
            if !line.is_empty() && line[line.len() - 1] == b'\r' {
                line = &line[..line.len() - 1];
            }
        }
        Ok(line.to_vec())
    }

    fn peek(&self) -> Option<u8> {
        self.data.get(self.pos).copied()
    }

    fn skip_space(&mut self) -> usize {
        let mut n = 0;
        while self.pos < self.data.len() {
            let c = self.data[self.pos];
            if c != b' ' && c != b'\t' {
                break;
            }
            self.pos += 1;
            n += 1;
        }
        n
    }

    fn read_continued_line(&mut self) -> Result<Vec<u8>, MailErr> {
        let line = self.read_line()?;
        if line.is_empty() {
            return Ok(line);
        }
        let mut buf = trim_spht(&line).to_vec();
        loop {
            match self.peek() {
                Some(b' ') | Some(b'\t') => {
                    self.skip_space();
                    buf.push(b' ');
                    match self.read_line() {
                        Ok(cont) => buf.extend_from_slice(trim_spht(&cont)),
                        Err(_) => break,
                    }
                }
                _ => break,
            }
        }
        Ok(buf)
    }
}

pub fn read_message(raw: &[u8]) -> Result<Message, MailErr> {
    let mut r = Reader { data: raw, pos: 0 };
    if let Some(b) = r.peek() {
        if b == b' ' || b == b'\t' {
            let line = r.read_line().unwrap_or_default();
            return Err(MailErr::new(
                "header",
                format!("malformed initial line: {}", String::from_utf8_lossy(&line)),
            ));
        }
    }
    let mut headers = Vec::new();
    loop {
        let kv = match r.read_continued_line() {
            Ok(v) => v,
            Err(e) => {
                if headers.is_empty() {
                    return Err(e);
                }
                // EOF after some headers without a blank line: Go returns the
                // message with remaining (empty) body.
                break;
            }
        };
        if kv.is_empty() {
            break;
        }
        let Some(colon) = kv.iter().position(|&c| c == b':') else {
            return Err(MailErr::new(
                "header",
                format!("malformed header line: {}", String::from_utf8_lossy(&kv)),
            ));
        };
        let key_raw = String::from_utf8_lossy(&kv[..colon]).into_owned();
        let key = canonical_header_key(&key_raw);
        if key.is_empty() {
            continue;
        }
        let value_bytes = &kv[colon + 1..];
        let start = value_bytes
            .iter()
            .position(|&c| c != b' ' && c != b'\t')
            .unwrap_or(value_bytes.len());
        let value = String::from_utf8_lossy(&value_bytes[start..]).into_owned();
        headers.push(HeaderPair { key, value });
    }
    let body = r.data[r.pos..].to_vec();
    Ok(Message {
        headers,
        body,
        raw: raw.to_vec(),
    })
}
