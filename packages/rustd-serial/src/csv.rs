//! Go 1.24 `encoding/csv` Reader/Writer, ported for byte-accurate parity.

use napi::bindgen_prelude::*;

const QUOTE: u8 = b'"';

#[derive(Clone, Copy)]
struct Position {
    line: i32,
    col: i32,
}

pub struct CsvReader {
    input: Vec<u8>,
    pos: usize,
    comma: char,
    comment: char,
    fields_per_record: i32,
    lazy_quotes: bool,
    trim_leading_space: bool,
    num_line: i32,
    offset: i64,
    record_buffer: Vec<u8>,
    field_indexes: Vec<usize>,
    field_positions: Vec<Position>,
}

pub struct CsvWriter {
    comma: char,
    use_crlf: bool,
    buf: Vec<u8>,
    error: Option<String>,
}

pub struct Row {
    pub fields: Vec<Vec<u8>>,
    pub offset: i64,
}

fn decode_rune(b: &[u8]) -> (char, usize) {
    if b.is_empty() {
        return ('\u{FFFD}', 0);
    }
    if b[0] < 0x80 {
        return (b[0] as char, 1);
    }
    match std::str::from_utf8(b) {
        Ok(s) => {
            let ch = s.chars().next().unwrap_or('\u{FFFD}');
            (ch, ch.len_utf8())
        }
        Err(err) => {
            let valid = err.valid_up_to();
            if valid > 0 {
                let ch = std::str::from_utf8(&b[..valid])
                    .unwrap()
                    .chars()
                    .next()
                    .unwrap();
                (ch, ch.len_utf8())
            } else {
                ('\u{FFFD}', 1)
            }
        }
    }
}

fn next_rune(b: &[u8]) -> char {
    decode_rune(b).0
}

fn index_byte(hay: &[u8], needle: u8) -> Option<usize> {
    hay.iter().position(|&b| b == needle)
}

fn index_rune(hay: &[u8], needle: char) -> Option<usize> {
    if (needle as u32) < 0x80 {
        return index_byte(hay, needle as u8);
    }
    if needle == '\u{FFFD}' {
        let mut i = 0;
        while i < hay.len() {
            let (ch, n) = decode_rune(&hay[i..]);
            if ch == '\u{FFFD}' {
                return Some(i);
            }
            i += n.max(1);
        }
        return None;
    }
    let mut enc = [0u8; 4];
    let bytes = needle.encode_utf8(&mut enc).as_bytes();
    hay.windows(bytes.len()).position(|w| w == bytes)
}

fn length_nl(b: &[u8]) -> usize {
    if b.last() == Some(&b'\n') {
        1
    } else {
        0
    }
}

fn is_go_space(c: char) -> bool {
    c.is_whitespace()
}

fn valid_delim(r: char) -> bool {
    r != '\0' && r != '"' && r != '\r' && r != '\n' && r != '\u{FFFD}'
}

fn parse_err(start: i32, line: i32, col: i32, kind: &str, msg: &str) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("CsvParseError:{start}:{line}:{col}:{kind}:{msg}"),
    )
}

fn invalid_delim() -> Error {
    Error::new(
        Status::GenericFailure,
        "CsvParseError:0:0:0:InvalidDelim:csv: invalid field or comment delimiter",
    )
}

impl CsvReader {
    pub fn new(
        input: Vec<u8>,
        comma: u32,
        comment: u32,
        fields_per_record: i32,
        lazy_quotes: bool,
        trim_leading_space: bool,
    ) -> Self {
        let comma = char::from_u32(comma).unwrap_or(',');
        let comma = if comma == '\0' { ',' } else { comma };
        let comment = char::from_u32(comment).unwrap_or('\0');
        Self {
            input,
            pos: 0,
            comma,
            comment,
            fields_per_record,
            lazy_quotes,
            trim_leading_space,
            num_line: 0,
            offset: 0,
            record_buffer: Vec::new(),
            field_indexes: Vec::new(),
            field_positions: Vec::new(),
        }
    }

    pub fn input_offset(&self) -> i64 {
        self.offset
    }

    pub fn field_pos(&self, field: i32) -> Result<(i32, i32)> {
        let idx = field as usize;
        if field < 0 || idx >= self.field_positions.len() {
            return Err(Error::new(
                Status::GenericFailure,
                "RangeError:out of range index passed to FieldPos",
            ));
        }
        let p = self.field_positions[idx];
        Ok((p.line, p.col))
    }

    fn read_line(&mut self) -> (Vec<u8>, bool) {
        if self.pos >= self.input.len() {
            return (Vec::new(), true);
        }
        let start = self.pos;
        let rest = &self.input[start..];
        let (end, hit_nl) = match index_byte(rest, b'\n') {
            Some(i) => (start + i + 1, true),
            None => (self.input.len(), false),
        };
        let mut line = self.input[start..end].to_vec();
        self.pos = end;
        let read_size = line.len();
        let mut eof = !hit_nl;
        if read_size > 0 && eof {
            eof = false;
            if line.last() == Some(&b'\r') {
                line.pop();
            }
        }
        self.num_line += 1;
        self.offset += read_size as i64;
        if line.len() >= 2 && line[line.len() - 2] == b'\r' && line[line.len() - 1] == b'\n' {
            let n = line.len();
            line[n - 2] = b'\n';
            line.pop();
        }
        (line, eof)
    }

    pub fn read(&mut self) -> Result<Option<Row>> {
        match self.read_record() {
            Ok(Some(fields)) => Ok(Some(Row {
                fields,
                offset: self.offset,
            })),
            Ok(None) => Ok(None),
            Err(err) => Err(err),
        }
    }

    fn read_record(&mut self) -> Result<Option<Vec<Vec<u8>>>> {
        if self.comma == self.comment
            || !valid_delim(self.comma)
            || (self.comment != '\0' && !valid_delim(self.comment))
        {
            return Err(invalid_delim());
        }

        let mut line: Vec<u8>;
        let mut err_read: bool;
        loop {
            let (next, eof) = self.read_line();
            line = next;
            err_read = eof;
            if self.comment != '\0' && next_rune(&line) == self.comment {
                continue;
            }
            if !err_read && line.len() == length_nl(&line) {
                continue;
            }
            break;
        }
        if err_read {
            return Ok(None);
        }

        let mut err: Option<Error> = None;
        let comma_len = self.comma.len_utf8();
        let rec_line = self.num_line;
        self.record_buffer.clear();
        self.field_indexes.clear();
        self.field_positions.clear();
        let mut pos = Position {
            line: self.num_line,
            col: 1,
        };
        let mut line_view = line;

        'parse_field: loop {
            if self.trim_leading_space {
                let i = {
                    let mut i = 0;
                    let mut found = None;
                    while i < line_view.len() {
                        let (ch, n) = decode_rune(&line_view[i..]);
                        if !is_go_space(ch) {
                            found = Some(i);
                            break;
                        }
                        i += n.max(1);
                    }
                    found.unwrap_or(line_view.len())
                };
                if i == line_view.len() {
                    pos.col -= length_nl(&line_view) as i32;
                }
                line_view = line_view[i..].to_vec();
                pos.col += i as i32;
            }
            if line_view.is_empty() || line_view[0] != QUOTE {
                let i = index_rune(&line_view, self.comma);
                let mut field = line_view.as_slice();
                if let Some(i) = i {
                    field = &field[..i];
                } else {
                    let n = field.len() - length_nl(field);
                    field = &field[..n];
                }
                if !self.lazy_quotes {
                    if let Some(j) = index_byte(field, QUOTE) {
                        let col = pos.col + j as i32;
                        err = Some(parse_err(
                            rec_line,
                            self.num_line,
                            col,
                            "BareQuote",
                            "bare \" in non-quoted-field",
                        ));
                        break 'parse_field;
                    }
                }
                self.record_buffer.extend_from_slice(field);
                self.field_indexes.push(self.record_buffer.len());
                self.field_positions.push(pos);
                if let Some(i) = i {
                    line_view = line_view[i + comma_len..].to_vec();
                    pos.col += i as i32 + comma_len as i32;
                    continue 'parse_field;
                }
                break 'parse_field;
            } else {
                let field_pos = pos;
                line_view = line_view[1..].to_vec();
                pos.col += 1;
                loop {
                    if let Some(i) = index_byte(&line_view, QUOTE) {
                        self.record_buffer.extend_from_slice(&line_view[..i]);
                        line_view = line_view[i + 1..].to_vec();
                        pos.col += i as i32 + 1;
                        let rn = next_rune(&line_view);
                        if rn == '"' {
                            self.record_buffer.push(QUOTE);
                            line_view = line_view[1..].to_vec();
                            pos.col += 1;
                        } else if rn == self.comma {
                            line_view = line_view[comma_len..].to_vec();
                            pos.col += comma_len as i32;
                            self.field_indexes.push(self.record_buffer.len());
                            self.field_positions.push(field_pos);
                            continue 'parse_field;
                        } else if length_nl(&line_view) == line_view.len() {
                            self.field_indexes.push(self.record_buffer.len());
                            self.field_positions.push(field_pos);
                            break 'parse_field;
                        } else if self.lazy_quotes {
                            self.record_buffer.push(QUOTE);
                        } else {
                            err = Some(parse_err(
                                rec_line,
                                self.num_line,
                                pos.col - 1,
                                "Quote",
                                "extraneous or missing \" in quoted-field",
                            ));
                            break 'parse_field;
                        }
                    } else if !line_view.is_empty() {
                        self.record_buffer.extend_from_slice(&line_view);
                        if err_read {
                            break 'parse_field;
                        }
                        pos.col += line_view.len() as i32;
                        let (next, eof) = self.read_line();
                        err_read = eof;
                        line_view = next;
                        if !line_view.is_empty() {
                            pos.line += 1;
                            pos.col = 1;
                        }
                        if err_read {
                            err_read = false;
                        }
                    } else {
                        if !self.lazy_quotes && !err_read {
                            err = Some(parse_err(
                                rec_line,
                                pos.line,
                                pos.col,
                                "Quote",
                                "extraneous or missing \" in quoted-field",
                            ));
                            break 'parse_field;
                        }
                        self.field_indexes.push(self.record_buffer.len());
                        self.field_positions.push(field_pos);
                        break 'parse_field;
                    }
                }
            }
        }

        let mut fields = Vec::with_capacity(self.field_indexes.len());
        let mut pre = 0usize;
        for &idx in &self.field_indexes {
            fields.push(self.record_buffer[pre..idx].to_vec());
            pre = idx;
        }

        if self.fields_per_record > 0 {
            if fields.len() as i32 != self.fields_per_record && err.is_none() {
                err = Some(parse_err(
                    rec_line,
                    rec_line,
                    1,
                    "FieldCount",
                    "wrong number of fields",
                ));
            }
        } else if self.fields_per_record == 0 {
            self.fields_per_record = fields.len() as i32;
        }

        if let Some(e) = err {
            return Err(e);
        }
        Ok(Some(fields))
    }
}

impl CsvWriter {
    pub fn new(comma: u32, use_crlf: bool) -> Self {
        let comma = char::from_u32(comma).unwrap_or(',');
        let comma = if comma == '\0' { ',' } else { comma };
        Self {
            comma,
            use_crlf,
            buf: Vec::new(),
            error: None,
        }
    }

    pub fn error_text(&self) -> Option<String> {
        self.error.clone()
    }

    pub fn bytes(&self) -> Vec<u8> {
        self.buf.clone()
    }

    pub fn write(&mut self, record: Vec<Vec<u8>>) -> Result<()> {
        if !valid_delim(self.comma) {
            let msg = "csv: invalid field or comment delimiter";
            self.error = Some(msg.into());
            return Err(invalid_delim());
        }
        for (n, field) in record.iter().enumerate() {
            if n > 0 {
                let mut enc = [0u8; 4];
                let s = self.comma.encode_utf8(&mut enc);
                self.buf.extend_from_slice(s.as_bytes());
            }
            if !self.field_needs_quotes(field) {
                self.buf.extend_from_slice(field);
                continue;
            }
            self.buf.push(QUOTE);
            let mut rest = field.as_slice();
            while !rest.is_empty() {
                let i = rest
                    .iter()
                    .position(|&c| c == QUOTE || c == b'\r' || c == b'\n')
                    .unwrap_or(rest.len());
                self.buf.extend_from_slice(&rest[..i]);
                rest = &rest[i..];
                if !rest.is_empty() {
                    match rest[0] {
                        QUOTE => self.buf.extend_from_slice(b"\"\""),
                        b'\r' => {
                            if !self.use_crlf {
                                self.buf.push(b'\r');
                            }
                        }
                        b'\n' => {
                            if self.use_crlf {
                                self.buf.extend_from_slice(b"\r\n");
                            } else {
                                self.buf.push(b'\n');
                            }
                        }
                        _ => {}
                    }
                    rest = &rest[1..];
                }
            }
            self.buf.push(QUOTE);
        }
        if self.use_crlf {
            self.buf.extend_from_slice(b"\r\n");
        } else {
            self.buf.push(b'\n');
        }
        Ok(())
    }

    fn field_needs_quotes(&self, field: &[u8]) -> bool {
        if field.is_empty() {
            return false;
        }
        if field == b"\\." {
            return true;
        }
        if (self.comma as u32) < 0x80 {
            let comma = self.comma as u8;
            if field
                .iter()
                .any(|&c| c == b'\n' || c == b'\r' || c == QUOTE || c == comma)
            {
                return true;
            }
        } else if index_rune(field, self.comma).is_some()
            || field.iter().any(|&c| c == QUOTE || c == b'\r' || c == b'\n')
        {
            return true;
        }
        is_go_space(next_rune(field))
    }
}
