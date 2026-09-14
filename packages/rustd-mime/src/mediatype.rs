use std::collections::{BTreeMap, HashMap};

const UPPERHEX: &[u8; 16] = b"0123456789ABCDEF";

pub fn is_tspecial(c: u8) -> bool {
    matches!(
        c,
        b'(' | b')' | b'<' | b'>' | b'@' | b',' | b';' | b':' | b'\\' | b'"' | b'/' | b'[' | b']' | b'?' | b'='
    )
}

pub fn is_token_char(c: u8) -> bool {
    c > 0x20 && c < 0x7f && !is_tspecial(c)
}

pub fn is_token(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(is_token_char)
}

pub fn needs_encoding(s: &str) -> bool {
    s.chars().any(|b| (b < ' ' || b > '~') && b != '\t')
}

fn is_space(c: char) -> bool {
    c.is_whitespace()
}

pub fn format_media_type(t: &str, param: &BTreeMap<String, String>) -> String {
    let mut b = Vec::new();
    if let Some((major, sub)) = t.split_once('/') {
        if !is_token(major) || !is_token(sub) {
            return String::new();
        }
        b.extend(major.to_ascii_lowercase().as_bytes());
        b.push(b'/');
        b.extend(sub.to_ascii_lowercase().as_bytes());
    } else {
        if !is_token(t) {
            return String::new();
        }
        b.extend(t.to_ascii_lowercase().as_bytes());
    }

    for (attribute, value) in param {
        b.extend(b"; ");
        if !is_token(attribute) {
            return String::new();
        }
        b.extend(attribute.to_ascii_lowercase().as_bytes());
        let need_enc = needs_encoding(value);
        if need_enc {
            b.push(b'*');
        }
        b.push(b'=');
        if need_enc {
            b.extend(b"utf-8''");
            let bytes = value.as_bytes();
            let mut offset = 0;
            for (index, &ch) in bytes.iter().enumerate() {
                if ch <= b' ' || ch >= 0x7F || ch == b'*' || ch == b'\'' || ch == b'%' || is_tspecial(ch) {
                    b.extend(&bytes[offset..index]);
                    offset = index + 1;
                    b.push(b'%');
                    b.push(UPPERHEX[(ch >> 4) as usize]);
                    b.push(UPPERHEX[(ch & 0x0F) as usize]);
                }
            }
            b.extend(&bytes[offset..]);
            continue;
        }
        if is_token(value) {
            b.extend(value.as_bytes());
            continue;
        }
        b.push(b'"');
        let bytes = value.as_bytes();
        let mut offset = 0;
        for (index, &character) in bytes.iter().enumerate() {
            if character == b'"' || character == b'\\' {
                b.extend(&bytes[offset..index]);
                offset = index;
                b.push(b'\\');
            }
        }
        b.extend(&bytes[offset..]);
        b.push(b'"');
    }
    String::from_utf8_lossy(&b).into_owned()
}

fn check_media_type_disposition(s: &str) -> Result<(), String> {
    let (typ, rest) = consume_token(s);
    if typ.is_empty() {
        return Err("mime: no media type".into());
    }
    if rest.is_empty() {
        return Ok(());
    }
    if !rest.starts_with('/') {
        return Err("mime: expected slash after first token".into());
    }
    let (subtype, rest) = consume_token(&rest[1..]);
    if subtype.is_empty() {
        return Err("mime: expected token after slash".into());
    }
    if !rest.is_empty() {
        return Err("mime: unexpected content after media subtype".into());
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct ParseMediaType {
    pub media_type: String,
    pub params: HashMap<String, String>,
    pub error: Option<String>,
}

pub fn parse_media_type(v: &str) -> ParseMediaType {
    let base = v.split_once(';').map(|(a, _)| a).unwrap_or(v);
    let mediatype = base.trim().to_ascii_lowercase();
    if let Err(err) = check_media_type_disposition(&mediatype) {
        return ParseMediaType {
            media_type: String::new(),
            params: HashMap::new(),
            error: Some(err),
        };
    }

    let mut params = HashMap::new();
    let mut continuation: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut rest = &v[base.len()..];
    loop {
        rest = rest.trim_start_matches(is_space);
        if rest.is_empty() {
            break;
        }
        let (key, value, next) = consume_media_param(rest);
        if key.is_empty() {
            if next.trim() == ";" {
                break;
            }
            return ParseMediaType {
                media_type: mediatype,
                params: HashMap::new(),
                error: Some("mime: invalid media parameter".into()),
            };
        }
        let pmap = if let Some((base_name, _)) = key.split_once('*') {
            continuation.entry(base_name.to_string()).or_default()
        } else {
            &mut params
        };
        if let Some(existing) = pmap.get(&key) {
            if existing != &value {
                return ParseMediaType {
                    media_type: String::new(),
                    params: HashMap::new(),
                    error: Some("mime: duplicate parameter name".into()),
                };
            }
        }
        pmap.insert(key, value);
        rest = next;
    }

    for (key, piece_map) in &continuation {
        let single = format!("{key}*");
        if let Some(v) = piece_map.get(&single) {
            if let Some(decv) = decode_2231_enc(v) {
                params.insert(key.clone(), decv);
            }
            continue;
        }
        let mut buf = String::new();
        let mut valid = false;
        for n in 0.. {
            let simple = format!("{key}*{n}");
            if let Some(v) = piece_map.get(&simple) {
                valid = true;
                buf.push_str(v);
                continue;
            }
            let encoded = format!("{simple}*");
            let Some(v) = piece_map.get(&encoded) else { break };
            valid = true;
            if n == 0 {
                if let Some(decv) = decode_2231_enc(v) {
                    buf.push_str(&decv);
                }
            } else {
                buf.push_str(&percent_hex_unescape(v).unwrap_or_else(|_| v.clone()));
            }
        }
        if valid {
            params.insert(key.clone(), buf);
        }
    }

    ParseMediaType {
        media_type: mediatype,
        params,
        error: None,
    }
}

fn decode_2231_enc(v: &str) -> Option<String> {
    let mut parts = v.splitn(3, '\'');
    let charset = parts.next()?.to_ascii_lowercase();
    let _lang = parts.next()?;
    let enc = parts.next()?;
    if charset.is_empty() || (charset != "us-ascii" && charset != "utf-8") {
        return None;
    }
    percent_hex_unescape(enc).ok()
}

pub fn consume_token(v: &str) -> (&str, &str) {
    match v.char_indices().find(|(_, c)| {
        let mut buf = [0; 4];
        let bytes = c.encode_utf8(&mut buf).as_bytes();
        bytes.len() != 1 || !is_token_char(bytes[0])
    }) {
        None => (v, ""),
        Some((0, _)) => ("", v),
        Some((i, _)) => (&v[..i], &v[i..]),
    }
}

pub fn consume_value_bytes(v: &str) -> (String, &str) {
    if v.is_empty() {
        return (String::new(), v);
    }
    if v.as_bytes()[0] != b'"' {
        let (tok, rest) = consume_token(v);
        return (tok.to_string(), rest);
    }
    let bytes = v.as_bytes();
    let mut out = Vec::new();
    let mut i = 1;
    while i < bytes.len() {
        let r = bytes[i];
        if r == b'"' {
            let value = match std::str::from_utf8(&out) {
                Ok(s) => s.to_string(),
                Err(_) => String::from_utf8_lossy(&out).into_owned(),
            };
            return (value, &v[i + 1..]);
        }
        if r == b'\\' && i + 1 < bytes.len() && is_tspecial(bytes[i + 1]) {
            out.push(bytes[i + 1]);
            i += 2;
            continue;
        }
        if r == b'\r' || r == b'\n' {
            return (String::new(), v);
        }
        out.push(bytes[i]);
        i += 1;
    }
    (String::new(), v)
}

fn consume_media_param(v: &str) -> (String, String, &str) {
    let rest = v.trim_start_matches(is_space);
    if !rest.starts_with(';') {
        return (String::new(), String::new(), v);
    }
    let rest = rest[1..].trim_start_matches(is_space);
    let (param, rest) = consume_token(rest);
    let param = param.to_ascii_lowercase();
    if param.is_empty() {
        return (String::new(), String::new(), v);
    }
    let rest = rest.trim_start_matches(is_space);
    if !rest.starts_with('=') {
        return (String::new(), String::new(), v);
    }
    let rest = rest[1..].trim_start_matches(is_space);
    let (value, rest2) = consume_value_bytes(rest);
    if value.is_empty() && rest2 == rest {
        return (String::new(), String::new(), v);
    }
    (param, value, rest2)
}

fn ishex(c: u8) -> bool {
    c.is_ascii_hexdigit()
}

fn unhex(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => 0,
    }
}

fn percent_hex_unescape(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut percents = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            i += 1;
            continue;
        }
        percents += 1;
        if i + 2 >= bytes.len() || !ishex(bytes[i + 1]) || !ishex(bytes[i + 2]) {
            let end = (i + 3).min(bytes.len());
            let frag = &s[i..end];
            return Err(format!("mime: bogus characters after %: {frag:?}"));
        }
        i += 3;
    }
    if percents == 0 {
        return Ok(s.to_string());
    }
    let mut t = Vec::with_capacity(bytes.len() - 2 * percents);
    i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            t.push(unhex(bytes[i + 1]) << 4 | unhex(bytes[i + 2]));
            i += 3;
        } else {
            t.push(bytes[i]);
            i += 1;
        }
    }
    match String::from_utf8(t.clone()) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::from_utf8_lossy(&t).into_owned()),
    }
}
