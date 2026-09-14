const LINE_MAX_LEN: usize = 76;
const UPPERHEX: &[u8; 16] = b"0123456789ABCDEF";

#[derive(Debug, Clone)]
pub enum QpError {
    Message(String),
    Eof,
}

impl QpError {
    pub fn message(&self) -> &str {
        match self {
            QpError::Message(s) => s,
            QpError::Eof => "EOF",
        }
    }
}

pub struct QpReader {
    data: Vec<u8>,
    pos: usize,
    line: Vec<u8>,
    rerr: Option<QpError>,
    closed: bool,
}

impl QpReader {
    pub fn new(data: Vec<u8>) -> Self {
        Self {
            data,
            pos: 0,
            line: Vec::new(),
            rerr: None,
            closed: false,
        }
    }

    pub fn close(&mut self) {
        self.closed = true;
        self.line.clear();
        self.pos = self.data.len();
    }

    fn read_slice_nl(&mut self) -> (Vec<u8>, Option<QpError>) {
        if self.pos >= self.data.len() {
            return (Vec::new(), Some(QpError::Eof));
        }
        let rest = &self.data[self.pos..];
        if let Some(i) = rest.iter().position(|&b| b == b'\n') {
            let line = rest[..=i].to_vec();
            self.pos += i + 1;
            (line, None)
        } else {
            let line = rest.to_vec();
            self.pos = self.data.len();
            (line, Some(QpError::Eof))
        }
    }

    pub fn read(&mut self, max: usize) -> Result<Vec<u8>, QpError> {
        if self.closed {
            return Err(QpError::Message("quotedprintable: reader closed".into()));
        }
        let mut out = Vec::new();
        while out.len() < max {
            if self.line.is_empty() {
                if let Some(err) = self.rerr.take() {
                    if out.is_empty() {
                        return match err {
                            QpError::Eof => Ok(out),
                            other => Err(other),
                        };
                    }
                    self.rerr = Some(err);
                    return Ok(out);
                }
                let (whole_line, rerr) = self.read_slice_nl();
                self.rerr = rerr;
                let has_lf = whole_line.ends_with(&[b'\n']);
                let has_cr = whole_line.ends_with(&[b'\r', b'\n']);
                let mut line = trim_right_qp_ws(&whole_line);
                if line.ends_with(&[b'=']) {
                    let stripped_at = line.len() - 1;
                    let right = &whole_line[stripped_at + 1..];
                    line.truncate(stripped_at);
                    let ok_eof = right.is_empty()
                        && !line.is_empty()
                        && matches!(self.rerr, Some(QpError::Eof));
                    if !right.starts_with(&[b'\n'])
                        && !right.starts_with(&[b'\r', b'\n'])
                        && !ok_eof
                    {
                        self.rerr = Some(QpError::Message(format!(
                            "quotedprintable: invalid bytes after =: {:?}",
                            String::from_utf8_lossy(right)
                        )));
                    }
                    self.line = line;
                } else if has_lf {
                    if has_cr {
                        line.extend_from_slice(b"\r\n");
                    } else {
                        line.push(b'\n');
                    }
                    self.line = line;
                } else {
                    self.line = line;
                }
                continue;
            }
            let mut b = self.line[0];
            match b {
                b'=' => match read_hex_byte(&self.line[1..]) {
                    Ok(decoded) => {
                        b = decoded;
                        self.line.drain(..2);
                    }
                    Err(err) => {
                        if self.line.len() >= 2 && self.line[1] != b'\r' && self.line[1] != b'\n' {
                            b = b'=';
                        } else if out.is_empty() {
                            return Err(err);
                        } else {
                            self.rerr = Some(err);
                            return Ok(out);
                        }
                    }
                },
                b'\t' | b'\r' | b'\n' => {}
                0x80..=0xff => {}
                c if c < b' ' || c > b'~' => {
                    let err = QpError::Message(format!(
                        "quotedprintable: invalid unescaped byte 0x{c:02x} in body"
                    ));
                    if out.is_empty() {
                        return Err(err);
                    }
                    self.rerr = Some(err);
                    return Ok(out);
                }
                _ => {}
            }
            out.push(b);
            self.line.drain(..1);
        }
        Ok(out)
    }
}

fn trim_right_qp_ws(line: &[u8]) -> Vec<u8> {
    let mut end = line.len();
    while end > 0 {
        match line[end - 1] {
            b'\n' | b'\r' | b' ' | b'\t' => end -= 1,
            _ => break,
        }
    }
    line[..end].to_vec()
}

fn from_hex(b: u8) -> Result<u8, QpError> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        _ => Err(QpError::Message(format!(
            "quotedprintable: invalid hex byte 0x{b:02x}"
        ))),
    }
}

fn read_hex_byte(v: &[u8]) -> Result<u8, QpError> {
    if v.len() < 2 {
        return Err(QpError::Message("quotedprintable: unexpected EOF".into()));
    }
    Ok(from_hex(v[0])? << 4 | from_hex(v[1])?)
}

pub struct QpWriter {
    binary: bool,
    out: Vec<u8>,
    i: usize,
    line: [u8; 78],
    cr: bool,
    closed: bool,
}

impl QpWriter {
    pub fn new(binary: bool) -> Self {
        Self {
            binary,
            out: Vec::new(),
            i: 0,
            line: [0; 78],
            cr: false,
            closed: false,
        }
    }

    pub fn write(&mut self, p: &[u8]) -> Result<(), QpError> {
        if self.closed {
            return Err(QpError::Message("quotedprintable: writer closed".into()));
        }
        let mut n = 0;
        for (i, &b) in p.iter().enumerate() {
            let simple = (b >= b'!' && b <= b'~' && b != b'=')
                || is_whitespace(b)
                || (!self.binary && (b == b'\n' || b == b'\r'));
            if simple {
                continue;
            }
            if i > n {
                self.write_plain(&p[n..i])?;
                n = i;
            }
            self.encode(b)?;
            n += 1;
        }
        if n != p.len() {
            self.write_plain(&p[n..])?;
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, QpError> {
        if !self.closed {
            self.check_last_byte()?;
            self.flush();
            self.closed = true;
        }
        Ok(self.out.clone())
    }

    fn write_plain(&mut self, p: &[u8]) -> Result<(), QpError> {
        for &b in p {
            if b == b'\n' || b == b'\r' {
                if self.cr && b == b'\n' {
                    self.cr = false;
                    continue;
                }
                if b == b'\r' {
                    self.cr = true;
                }
                self.check_last_byte()?;
                self.insert_crlf();
                continue;
            }
            if self.i == LINE_MAX_LEN - 1 {
                self.insert_soft_line_break();
            }
            self.line[self.i] = b;
            self.i += 1;
            self.cr = false;
        }
        Ok(())
    }

    fn encode(&mut self, b: u8) -> Result<(), QpError> {
        if LINE_MAX_LEN - 1 - self.i < 3 {
            self.insert_soft_line_break();
        }
        self.line[self.i] = b'=';
        self.line[self.i + 1] = UPPERHEX[(b >> 4) as usize];
        self.line[self.i + 2] = UPPERHEX[(b & 0x0f) as usize];
        self.i += 3;
        Ok(())
    }

    fn check_last_byte(&mut self) -> Result<(), QpError> {
        if self.i == 0 {
            return Ok(());
        }
        let b = self.line[self.i - 1];
        if is_whitespace(b) {
            self.i -= 1;
            self.encode(b)?;
        }
        Ok(())
    }

    fn insert_soft_line_break(&mut self) {
        self.line[self.i] = b'=';
        self.i += 1;
        self.insert_crlf();
    }

    fn insert_crlf(&mut self) {
        self.line[self.i] = b'\r';
        self.line[self.i + 1] = b'\n';
        self.i += 2;
        self.flush();
    }

    fn flush(&mut self) {
        self.out.extend_from_slice(&self.line[..self.i]);
        self.i = 0;
    }
}

fn is_whitespace(b: u8) -> bool {
    b == b' ' || b == b'\t'
}

pub fn qp_encode(data: &[u8], binary: bool) -> Result<Vec<u8>, QpError> {
    let mut w = QpWriter::new(binary);
    w.write(data)?;
    w.finish()
}

pub fn qp_decode(data: &[u8]) -> (Vec<u8>, Option<String>) {
    let mut r = QpReader::new(data.to_vec());
    let mut out = Vec::new();
    loop {
        match r.read(4096) {
            Ok(chunk) if chunk.is_empty() => return (out, None),
            Ok(chunk) => out.extend(chunk),
            Err(QpError::Eof) => return (out, None),
            Err(e) => return (out, Some(e.message().to_string())),
        }
    }
}
