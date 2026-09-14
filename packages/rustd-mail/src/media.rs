use crate::error::{go_quote, MailErr};
use std::collections::BTreeMap;

/// Minimal Go `mime.ParseMediaType` subset for Content-Type.
pub fn parse_media_type(v: &str) -> Result<(String, BTreeMap<String, String>), MailErr> {
    let v = v.trim();
    let (base, rest) = match v.split_once(';') {
        Some((b, r)) => (b.trim(), r),
        None => (v, ""),
    };
    if base.is_empty() || !base.contains('/') {
        return Err(MailErr::new(
            "syntax",
            format!("mime: expected token of the form type/subtype: {}", go_quote(v)),
        ));
    }
    let mediatype = base.to_ascii_lowercase();
    let mut params = BTreeMap::new();
    let mut rest = rest;
    while !rest.is_empty() {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        let Some(eq) = rest.find('=') else {
            return Err(MailErr::new("syntax", "mime: invalid media parameter"));
        };
        let key = rest[..eq].trim().to_ascii_lowercase();
        rest = &rest[eq + 1..];
        rest = rest.trim_start();
        let value = if rest.starts_with('"') {
            let mut out = String::new();
            let bytes = rest.as_bytes();
            let mut i = 1;
            let mut escaped = false;
            loop {
                if i >= bytes.len() {
                    return Err(MailErr::new("syntax", "mime: malformed media parameter"));
                }
                let c = bytes[i];
                if escaped {
                    out.push(c as char);
                    escaped = false;
                } else if c == b'\\' {
                    escaped = true;
                } else if c == b'"' {
                    i += 1;
                    rest = &rest[i..];
                    break;
                } else {
                    out.push(c as char);
                }
                i += 1;
            }
            if rest.starts_with(';') {
                rest = &rest[1..];
            }
            out
        } else {
            let end = rest.find(';').unwrap_or(rest.len());
            let val = rest[..end].trim().to_string();
            rest = if end < rest.len() { &rest[end + 1..] } else { "" };
            val
        };
        if !key.is_empty() {
            params.insert(key, value);
        }
    }
    Ok((mediatype, params))
}
