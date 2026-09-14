use crate::mediatype::needs_encoding;

const UPPERHEX: &[u8; 16] = b"0123456789ABCDEF";
const MAX_ENCODED_WORD_LEN: usize = 75;
const MAX_CONTENT_LEN: usize = MAX_ENCODED_WORD_LEN - "=?UTF-8?q?".len() - "?=".len();

fn max_base64_len() -> usize {
    // base64.StdEncoding.DecodedLen(maxContentLen)
    MAX_CONTENT_LEN / 4 * 3
}

#[derive(Clone, Copy)]
pub enum WordEnc {
    B,
    Q,
}

impl WordEnc {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "b" | "B" => Some(Self::B),
            "q" | "Q" => Some(Self::Q),
            _ => None,
        }
    }
    fn as_byte(self) -> u8 {
        match self {
            Self::B => b'b',
            Self::Q => b'q',
        }
    }
}

pub fn encode_word(charset: &str, s: &str, enc: WordEnc) -> String {
    if !needs_encoding(s) {
        return s.to_string();
    }
    encode_word_forced(charset, s, enc)
}

fn encode_word_forced(charset: &str, s: &str, enc: WordEnc) -> String {
    let mut buf = String::new();
    open_word(&mut buf, charset, enc);
    match enc {
        WordEnc::B => b_encode(&mut buf, charset, s, enc),
        WordEnc::Q => q_encode(&mut buf, charset, s, enc),
    }
    close_word(&mut buf);
    buf
}

fn open_word(buf: &mut String, charset: &str, enc: WordEnc) {
    buf.push_str("=?");
    buf.push_str(charset);
    buf.push('?');
    buf.push(enc.as_byte() as char);
    buf.push('?');
}

fn close_word(buf: &mut String) {
    buf.push_str("?=");
}

fn split_word(buf: &mut String, charset: &str, enc: WordEnc) {
    close_word(buf);
    buf.push(' ');
    open_word(buf, charset, enc);
}

fn is_utf8(charset: &str) -> bool {
    charset.eq_ignore_ascii_case("UTF-8")
}

fn b_encode(buf: &mut String, charset: &str, s: &str, enc: WordEnc) {
    let encoded_len = base64_encoded_len(s.len());
    if !is_utf8(charset) || encoded_len <= MAX_CONTENT_LEN {
        buf.push_str(&base64_encode(s.as_bytes()));
        return;
    }
    let bytes = s.as_bytes();
    let mut current_len = 0;
    let mut last = 0;
    let mut i = 0;
    while i < bytes.len() {
        let rune_len = utf8_rune_len(bytes, i);
        if current_len + rune_len <= max_base64_len() {
            current_len += rune_len;
        } else {
            buf.push_str(&base64_encode(&bytes[last..i]));
            split_word(buf, charset, enc);
            last = i;
            current_len = rune_len;
        }
        i += rune_len;
    }
    buf.push_str(&base64_encode(&bytes[last..]));
}

fn q_encode(buf: &mut String, charset: &str, s: &str, enc: WordEnc) {
    if !is_utf8(charset) {
        write_q_string(buf, s.as_bytes());
        return;
    }
    let bytes = s.as_bytes();
    let mut current_len = 0;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        let (rune_len, enc_len) = if b >= b' ' && b <= b'~' && b != b'=' && b != b'?' && b != b'_' {
            (1, 1)
        } else {
            let rune_len = utf8_rune_len(bytes, i);
            (rune_len, 3 * rune_len)
        };
        if current_len + enc_len > MAX_CONTENT_LEN {
            split_word(buf, charset, enc);
            current_len = 0;
        }
        write_q_string(buf, &bytes[i..i + rune_len]);
        current_len += enc_len;
        i += rune_len;
    }
}

fn write_q_string(buf: &mut String, s: &[u8]) {
    for &b in s {
        match b {
            b' ' => buf.push('_'),
            b'!'..=b'~' if b != b'=' && b != b'?' && b != b'_' => buf.push(b as char),
            _ => {
                buf.push('=');
                buf.push(UPPERHEX[(b >> 4) as usize] as char);
                buf.push(UPPERHEX[(b & 0x0f) as usize] as char);
            }
        }
    }
}

fn utf8_rune_len(bytes: &[u8], i: usize) -> usize {
    let rest = &bytes[i..];
    match rest.first().copied() {
        None => 1,
        Some(b) if b < 0x80 => 1,
        Some(b) => {
            let width = if b < 0xE0 { 2 } else if b < 0xF0 { 3 } else { 4 };
            if rest.len() >= width && std::str::from_utf8(&rest[..width]).is_ok() {
                width
            } else {
                1
            }
        }
    }
}

fn base64_encoded_len(n: usize) -> usize {
    ((n + 2) / 3) * 4
}

fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | data[i + 2] as u32;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(T[((n >> 6) & 63) as usize] as char);
        out.push(T[(n & 63) as usize] as char);
        i += 3;
    }
    match data.len() - i {
        1 => {
            let n = (data[i] as u32) << 16;
            out.push(T[((n >> 18) & 63) as usize] as char);
            out.push(T[((n >> 12) & 63) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
            out.push(T[((n >> 18) & 63) as usize] as char);
            out.push(T[((n >> 12) & 63) as usize] as char);
            out.push(T[((n >> 6) & 63) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("mime: invalid RFC 2047 encoded-word".into()),
        }
    }
    let bytes = s.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err("mime: invalid RFC 2047 encoded-word".into());
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let pad = (bytes[i + 2] == b'=') as usize + (bytes[i + 3] == b'=') as usize;
        let a = val(bytes[i])?;
        let b = val(bytes[i + 1])?;
        let c = if pad == 2 { 0 } else { val(bytes[i + 2])? };
        let d = if pad >= 1 { 0 } else { val(bytes[i + 3])? };
        let n = ((a as u32) << 18) | ((b as u32) << 12) | ((c as u32) << 6) | d as u32;
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
        i += 4;
    }
    Ok(out)
}

#[derive(Debug, Clone)]
pub struct Converted {
    pub text: Option<String>,
    pub charset: Option<String>,
    pub content: Option<Vec<u8>>,
}

pub fn decode_word(word: &str) -> Result<Converted, String> {
    if word.len() < 8 || !word.starts_with("=?") || !word.ends_with("?=") || word.matches('?').count() != 4 {
        return Err("mime: invalid RFC 2047 encoded-word".into());
    }
    let inner = &word[2..word.len() - 2];
    let Some((charset, rest)) = inner.split_once('?') else {
        return Err("mime: invalid RFC 2047 encoded-word".into());
    };
    if charset.is_empty() {
        return Err("mime: invalid RFC 2047 encoded-word".into());
    }
    let Some((encoding, text)) = rest.split_once('?') else {
        return Err("mime: invalid RFC 2047 encoded-word".into());
    };
    if encoding.len() != 1 {
        return Err("mime: invalid RFC 2047 encoded-word".into());
    }
    let content = decode_payload(encoding.as_bytes()[0], text)?;
    convert(charset, &content)
}

fn decode_payload(encoding: u8, text: &str) -> Result<Vec<u8>, String> {
    match encoding {
        b'B' | b'b' => base64_decode(text),
        b'Q' | b'q' => q_decode(text),
        _ => Err("mime: invalid RFC 2047 encoded-word".into()),
    }
}

fn convert(charset: &str, content: &[u8]) -> Result<Converted, String> {
    if charset.eq_ignore_ascii_case("utf-8") {
        return Ok(Converted {
            text: Some(String::from_utf8_lossy(content).into_owned()),
            charset: None,
            content: None,
        });
    }
    if charset.eq_ignore_ascii_case("iso-8859-1") {
        let text: String = content.iter().map(|&c| char::from(c)).collect();
        return Ok(Converted {
            text: Some(text),
            charset: None,
            content: None,
        });
    }
    if charset.eq_ignore_ascii_case("us-ascii") {
        let text: String = content
            .iter()
            .map(|&c| if c >= 0x80 { '\u{FFFD}' } else { c as char })
            .collect();
        return Ok(Converted {
            text: Some(text),
            charset: None,
            content: None,
        });
    }
    Ok(Converted {
        text: None,
        charset: Some(charset.to_ascii_lowercase()),
        content: Some(content.to_vec()),
    })
}

fn q_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut dec = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'_' => dec.push(b' '),
            b'=' => {
                if i + 2 >= bytes.len() {
                    return Err("mime: invalid RFC 2047 encoded-word".into());
                }
                dec.push(read_hex_byte(bytes[i + 1], bytes[i + 2])?);
                i += 2;
            }
            c if (c <= b'~' && c >= b' ') || c == b'\n' || c == b'\r' || c == b'\t' => dec.push(c),
            _ => return Err("mime: invalid RFC 2047 encoded-word".into()),
        }
        i += 1;
    }
    Ok(dec)
}

fn read_hex_byte(a: u8, b: u8) -> Result<u8, String> {
    Ok(from_hex(a)? << 4 | from_hex(b)?)
}

fn from_hex(b: u8) -> Result<u8, String> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        _ => Err(format!("mime: invalid hex byte {b:#04x}")),
    }
}

fn has_non_whitespace(s: &str) -> bool {
    s.chars().any(|b| !matches!(b, ' ' | '\t' | '\n' | '\r'))
}

pub fn decode_header_parts(header: &str) -> Result<Vec<Converted>, String> {
    let Some(i) = header.find("=?") else {
        return Ok(vec![Converted {
            text: Some(header.to_string()),
            charset: None,
            content: None,
        }]);
    };
    let mut parts = Vec::new();
    if i > 0 {
        parts.push(Converted {
            text: Some(header[..i].to_string()),
            charset: None,
            content: None,
        });
    }
    let mut header = &header[i..];
    let mut between_words = false;
    loop {
        let Some(start) = header.find("=?") else { break };
        let mut cur = start + 2;
        let Some(i) = header[cur..].find('?') else { break };
        let charset = &header[cur..cur + i];
        cur += i + 1;
        if header.len() < cur + 4 {
            break;
        }
        let encoding = header.as_bytes()[cur];
        cur += 1;
        if header.as_bytes().get(cur) != Some(&b'?') {
            break;
        }
        cur += 1;
        let Some(j) = header[cur..].find("?=") else { break };
        let text = &header[cur..cur + j];
        let end = cur + j + 2;
        match decode_payload(encoding, text) {
            Err(_) => {
                between_words = false;
                parts.push(Converted {
                    text: Some(header[..start + 2].to_string()),
                    charset: None,
                    content: None,
                });
                header = &header[start + 2..];
                continue;
            }
            Ok(content) => {
                if start > 0 && (!between_words || has_non_whitespace(&header[..start])) {
                    parts.push(Converted {
                        text: Some(header[..start].to_string()),
                        charset: None,
                        content: None,
                    });
                }
                parts.push(convert(charset, &content)?);
                header = &header[end..];
                between_words = true;
            }
        }
    }
    if !header.is_empty() {
        parts.push(Converted {
            text: Some(header.to_string()),
            charset: None,
            content: None,
        });
    }
    Ok(parts)
}
