use crate::error::{go_quote, MailErr};

const UPPERHEX: &[u8; 16] = b"0123456789ABCDEF";
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_encode(data: &[u8]) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | data[i + 2] as u32;
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(B64[((n >> 6) & 63) as usize] as char);
        out.push(B64[(n & 63) as usize] as char);
        i += 3;
    }
    match data.len() - i {
        1 => {
            let n = (data[i] as u32) << 16;
            out.push(B64[((n >> 18) & 63) as usize] as char);
            out.push(B64[((n >> 12) & 63) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
            out.push(B64[((n >> 18) & 63) as usize] as char);
            out.push(B64[((n >> 12) & 63) as usize] as char);
            out.push(B64[((n >> 6) & 63) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

fn b64_val(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, MailErr> {
    let bytes = s.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err(MailErr::new("address", "mime: invalid RFC 2047 encoded-word"));
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut i = 0;
    while i < bytes.len() {
        let mut v = [0u8; 4];
        let mut pad = 0;
        for j in 0..4 {
            let c = bytes[i + j];
            if c == b'=' {
                pad += 1;
                if pad > 2 || i + 4 != bytes.len() && j < 3 {
                    return Err(MailErr::new("address", "mime: invalid RFC 2047 encoded-word"));
                }
                v[j] = 0;
            } else {
                if pad > 0 {
                    return Err(MailErr::new("address", "mime: invalid RFC 2047 encoded-word"));
                }
                v[j] = b64_val(c)
                    .ok_or_else(|| MailErr::new("address", "mime: invalid RFC 2047 encoded-word"))?;
            }
        }
        out.push((v[0] << 2) | (v[1] >> 4));
        if pad < 2 {
            out.push((v[1] << 4) | (v[2] >> 2));
        }
        if pad < 1 {
            out.push((v[2] << 6) | v[3]);
        }
        i += 4;
    }
    Ok(out)
}

fn from_hex(b: u8) -> Result<u8, MailErr> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        _ => Err(MailErr::new(
            "address",
            format!("mime: invalid hex byte {b:#04x}"),
        )),
    }
}

fn q_decode(s: &str) -> Result<Vec<u8>, MailErr> {
    let bytes = s.as_bytes();
    let mut dec = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'_' => dec.push(b' '),
            b'=' => {
                if i + 2 >= bytes.len() {
                    return Err(MailErr::new("address", "mime: invalid RFC 2047 encoded-word"));
                }
                let hb = from_hex(bytes[i + 1])?;
                let lb = from_hex(bytes[i + 2])?;
                dec.push((hb << 4) | lb);
                i += 2;
            }
            c if (c <= b'~' && c >= b' ') || c == b'\n' || c == b'\r' || c == b'\t' => dec.push(c),
            _ => return Err(MailErr::new("address", "mime: invalid RFC 2047 encoded-word")),
        }
        i += 1;
    }
    Ok(dec)
}

fn convert(charset: &str, content: &[u8]) -> Result<String, MailErr> {
    if charset.eq_ignore_ascii_case("utf-8") {
        return String::from_utf8(content.to_vec()).or_else(|_| {
            Ok(String::from_utf8_lossy(content).into_owned())
        });
    }
    if charset.eq_ignore_ascii_case("iso-8859-1") {
        return Ok(content.iter().map(|&c| char::from(c)).collect());
    }
    if charset.eq_ignore_ascii_case("us-ascii") {
        return Ok(content
            .iter()
            .map(|&c| {
                if c >= 0x80 {
                    char::REPLACEMENT_CHARACTER
                } else {
                    c as char
                }
            })
            .collect());
    }
    Err(MailErr::new(
        "address",
        format!("charset not supported: {}", go_quote(&charset.to_ascii_lowercase())),
    ))
}

pub fn decode_word(word: &str) -> Result<String, MailErr> {
    if word.len() < 8
        || !word.starts_with("=?")
        || !word.ends_with("?=")
        || word.matches('?').count() != 4
    {
        return Err(MailErr::new("address", "mime: invalid RFC 2047 encoded-word"));
    }
    let inner = &word[2..word.len() - 2];
    let Some((charset, rest)) = inner.split_once('?') else {
        return Err(MailErr::new("address", "mime: invalid RFC 2047 encoded-word"));
    };
    if charset.is_empty() {
        return Err(MailErr::new("address", "mime: invalid RFC 2047 encoded-word"));
    }
    let Some((encoding, text)) = rest.split_once('?') else {
        return Err(MailErr::new("address", "mime: invalid RFC 2047 encoded-word"));
    };
    if encoding.len() != 1 {
        return Err(MailErr::new("address", "mime: invalid RFC 2047 encoded-word"));
    }
    let content = match encoding.as_bytes()[0] {
        b'B' | b'b' => b64_decode(text)?,
        b'Q' | b'q' => q_decode(text)?,
        _ => return Err(MailErr::new("address", "mime: invalid RFC 2047 encoded-word")),
    };
    convert(charset, &content)
}

/// Mail's decodeRFC2047Word: invalid encoded-words are ignored; unsupported
/// charset returns the original token with an error.
pub fn decode_rfc2047_word(s: &str) -> Result<(String, bool), MailErr> {
    match decode_word(s) {
        Ok(word) => Ok((word, true)),
        Err(err) if err.message.starts_with("charset not supported:") => {
            Err(MailErr::new("address", err.message))
        }
        Err(_) => Ok((s.to_string(), false)),
    }
}

fn needs_encoding(s: &str) -> bool {
    s.chars().any(|b| (b < ' ' || b > '~') && b != '\t')
}

fn is_utf8(charset: &str) -> bool {
    charset.eq_ignore_ascii_case("UTF-8")
}

const MAX_ENCODED_WORD_LEN: usize = 75;
fn max_content_len(charset: &str) -> usize {
    MAX_ENCODED_WORD_LEN - format!("=?{charset}?q?").len() - 2
}

fn write_q_string(buf: &mut String, s: &str) {
    for b in s.bytes() {
        match b {
            b' ' => buf.push('_'),
            b if b >= b'!' && b <= b'~' && b != b'=' && b != b'?' && b != b'_' => {
                buf.push(b as char)
            }
            _ => {
                buf.push('=');
                buf.push(UPPERHEX[(b >> 4) as usize] as char);
                buf.push(UPPERHEX[(b & 0x0f) as usize] as char);
            }
        }
    }
}

fn open_word(buf: &mut String, charset: &str, enc: u8) {
    buf.push_str("=?");
    buf.push_str(charset);
    buf.push('?');
    buf.push(enc as char);
    buf.push('?');
}

fn close_word(buf: &mut String) {
    buf.push_str("?=");
}

pub fn encode_word(enc: u8, charset: &str, s: &str) -> String {
    if !needs_encoding(s) {
        return s.to_string();
    }
    let mut buf = String::new();
    open_word(&mut buf, charset, enc);
    if enc == b'b' {
        b_encode(&mut buf, charset, s);
    } else {
        q_encode(&mut buf, charset, s);
    }
    close_word(&mut buf);
    buf
}

fn b_encode(buf: &mut String, charset: &str, s: &str) {
    let max_content = max_content_len(charset);
    let max_base64_len = max_content * 3 / 4;
    if !is_utf8(charset) || b64_encode(s.as_bytes()).len() <= max_content {
        buf.push_str(&b64_encode(s.as_bytes()));
        return;
    }
    let bytes = s.as_bytes();
    let mut current_len = 0;
    let mut last = 0;
    let mut i = 0;
    while i < bytes.len() {
        let rune_len = utf8_len(bytes, i);
        if current_len + rune_len <= max_base64_len {
            current_len += rune_len;
        } else {
            buf.push_str(&b64_encode(&bytes[last..i]));
            close_word(buf);
            buf.push(' ');
            open_word(buf, charset, b'b');
            last = i;
            current_len = rune_len;
        }
        i += rune_len;
    }
    buf.push_str(&b64_encode(&bytes[last..]));
}

fn q_encode(buf: &mut String, charset: &str, s: &str) {
    if !is_utf8(charset) {
        write_q_string(buf, s);
        return;
    }
    let max_content = max_content_len(charset);
    let bytes = s.as_bytes();
    let mut current_len = 0;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        let (rune_len, enc_len) = if b >= b' ' && b <= b'~' && b != b'=' && b != b'?' && b != b'_' {
            (1, 1)
        } else {
            let n = utf8_len(bytes, i);
            (n, 3 * n)
        };
        if current_len + enc_len > max_content {
            close_word(buf);
            buf.push(' ');
            open_word(buf, charset, b'q');
            current_len = 0;
        }
        write_q_string(buf, &s[i..i + rune_len]);
        current_len += enc_len;
        i += rune_len;
    }
}

fn utf8_len(bytes: &[u8], i: usize) -> usize {
    match std::str::from_utf8(&bytes[i..]) {
        Ok(s) => s.chars().next().map(|c| c.len_utf8()).unwrap_or(1),
        Err(e) if e.valid_up_to() == 0 => 1,
        Err(_) => std::str::from_utf8(&bytes[i..])
            .ok()
            .and_then(|s| s.chars().next().map(|c| c.len_utf8()))
            .unwrap_or(1),
    }
}
