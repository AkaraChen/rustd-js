//! Go 1.24 `encoding/pem` Decode/Encode, ported for byte-accurate parity.
//! Standard base64 is inlined so this crate does not take a `base64` dependency.

const PEM_START: &[u8] = b"\n-----BEGIN ";
const PEM_END: &[u8] = b"\n-----END ";
const PEM_EOL: &[u8] = b"-----";
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PemBlock {
    pub type_name: String,
    pub headers: Vec<(String, String)>,
    pub bytes: Vec<u8>,
}

fn get_line(data: &[u8]) -> (&[u8], &[u8], usize) {
    let mut i = match data.iter().position(|&b| b == b'\n') {
        Some(i) => i,
        None => data.len(),
    };
    let j = if i < data.len() { i + 1 } else { i };
    if i > 0 && data[i - 1] == b'\r' {
        i -= 1;
    }
    let mut line = &data[..i];
    while line.last().is_some_and(|b| *b == b' ' || *b == b'\t') {
        line = &line[..line.len() - 1];
    }
    (line, &data[j..], j)
}

fn remove_spaces_and_tabs(data: &[u8]) -> Vec<u8> {
    if !data.iter().any(|&b| b == b' ' || b == b'\t') {
        return data.to_vec();
    }
    data.iter()
        .copied()
        .filter(|&b| b != b' ' && b != b'\t')
        .collect()
}

fn last_index(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).rposition(|w| w == needle)
}

fn index_of(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn decode_std_base64(src: &[u8]) -> Option<Vec<u8>> {
    let mut decode = [0xffu8; 256];
    for (i, &c) in B64.iter().enumerate() {
        decode[c as usize] = i as u8;
    }
    let filtered: Vec<u8> = src
        .iter()
        .copied()
        .filter(|&b| b != b'\r' && b != b'\n')
        .collect();
    if filtered.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(filtered.len() / 4 * 3);
    for chunk in filtered.chunks_exact(4) {
        let mut vals = [0u8; 4];
        let mut pad = 0usize;
        for (i, &b) in chunk.iter().enumerate() {
            if b == b'=' {
                if i < 2 {
                    return None;
                }
                pad += 1;
                vals[i] = 0;
                continue;
            }
            if pad > 0 {
                return None;
            }
            let v = decode[b as usize];
            if v == 0xff {
                return None;
            }
            vals[i] = v;
        }
        let n = (u32::from(vals[0]) << 18)
            | (u32::from(vals[1]) << 12)
            | (u32::from(vals[2]) << 6)
            | u32::from(vals[3]);
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Some(out)
}

fn encode_std_base64(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity((src.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= src.len() {
        let n = (u32::from(src[i]) << 16) | (u32::from(src[i + 1]) << 8) | u32::from(src[i + 2]);
        out.push(B64[((n >> 18) & 63) as usize]);
        out.push(B64[((n >> 12) & 63) as usize]);
        out.push(B64[((n >> 6) & 63) as usize]);
        out.push(B64[(n & 63) as usize]);
        i += 3;
    }
    if i + 1 == src.len() {
        let n = u32::from(src[i]) << 16;
        out.push(B64[((n >> 18) & 63) as usize]);
        out.push(B64[((n >> 12) & 63) as usize]);
        out.push(b'=');
        out.push(b'=');
    } else if i + 2 == src.len() {
        let n = (u32::from(src[i]) << 16) | (u32::from(src[i + 1]) << 8);
        out.push(B64[((n >> 18) & 63) as usize]);
        out.push(B64[((n >> 12) & 63) as usize]);
        out.push(B64[((n >> 6) & 63) as usize]);
        out.push(b'=');
    }
    out
}

fn wrap_64(b64: &[u8]) -> Vec<u8> {
    if b64.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(b64.len() + b64.len() / 64 + 1);
    for (i, chunk) in b64.chunks(64).enumerate() {
        if i > 0 {
            out.push(b'\n');
        }
        out.extend_from_slice(chunk);
    }
    out.push(b'\n');
    out
}

pub fn decode(data: &[u8]) -> Option<(PemBlock, Vec<u8>)> {
    let mut rest = data;
    let mut end_trailer_index: isize = 0;
    loop {
        if end_trailer_index < 0 || (end_trailer_index as usize) > rest.len() {
            return None;
        }
        rest = &rest[end_trailer_index as usize..];
        let Some(end_index_usize) = index_of(rest, PEM_END) else {
            return None;
        };
        let mut end_index = end_index_usize as isize;
        end_trailer_index = end_index + PEM_END.len() as isize;
        let Some(begin_index) = last_index(&rest[..end_index_usize], &PEM_START[1..]) else {
            continue;
        };
        if begin_index > 0 && rest[begin_index - 1] != b'\n' {
            continue;
        }
        let skip = begin_index + PEM_START.len() - 1;
        rest = &rest[skip..];
        end_index -= skip as isize;
        end_trailer_index -= skip as isize;
        let (type_line, next, consumed) = get_line(rest);
        rest = next;
        end_index -= consumed as isize;
        end_trailer_index -= consumed as isize;
        if !type_line.ends_with(PEM_EOL) {
            continue;
        }
        let type_name = String::from_utf8_lossy(&type_line[..type_line.len() - PEM_EOL.len()]).into_owned();
        let mut headers: Vec<(String, String)> = Vec::new();
        loop {
            if rest.is_empty() {
                return None;
            }
            let (line, next, consumed) = get_line(rest);
            let Some(colon) = line.iter().position(|&b| b == b':') else {
                break;
            };
            let key = line[..colon].trim_ascii();
            let val = line[colon + 1..].trim_ascii();
            headers.push((
                String::from_utf8_lossy(key).into_owned(),
                String::from_utf8_lossy(val).into_owned(),
            ));
            rest = next;
            end_index -= consumed as isize;
            end_trailer_index -= consumed as isize;
        }
        if !headers.is_empty() && end_index < 0 {
            continue;
        }
        let type_bytes = type_name.as_bytes();
        let end_trailer_len = type_bytes.len() + PEM_EOL.len();
        if end_trailer_index < 0 || (end_trailer_index as usize) > rest.len() {
            continue;
        }
        let end_trailer_full = &rest[end_trailer_index as usize..];
        if end_trailer_full.len() < end_trailer_len {
            continue;
        }
        let rest_of_end_line = &end_trailer_full[end_trailer_len..];
        let end_trailer = &end_trailer_full[..end_trailer_len];
        if !end_trailer.starts_with(type_bytes) || !end_trailer.ends_with(PEM_EOL) {
            continue;
        }
        let (s, _, _) = get_line(rest_of_end_line);
        if !s.is_empty() {
            continue;
        }
        let mut bytes = Vec::new();
        if end_index > 0 {
            let slice_end = end_index as usize;
            if slice_end > rest.len() {
                continue;
            }
            let base64_data = remove_spaces_and_tabs(&rest[..slice_end]);
            match decode_std_base64(&base64_data) {
                Some(decoded) => bytes = decoded,
                None => continue,
            }
        }
        let after = end_index + PEM_END.len() as isize - 1;
        if after < 0 || (after as usize) > rest.len() {
            continue;
        }
        let (_, rest_out, _) = get_line(&rest[after as usize..]);
        return Some((
            PemBlock {
                type_name,
                headers,
                bytes,
            },
            rest_out.to_vec(),
        ));
    }
}

pub fn encode(block: &PemBlock) -> Result<Vec<u8>, String> {
    for (k, _) in &block.headers {
        if k.contains(':') {
            return Err("pem: cannot encode a header key that contains a colon".into());
        }
    }
    let mut out = Vec::new();
    out.extend_from_slice(&PEM_START[1..]);
    out.extend_from_slice(block.type_name.as_bytes());
    out.extend_from_slice(b"-----\n");
    if !block.headers.is_empty() {
        let mut others: Vec<(&str, &str)> = Vec::new();
        let mut proc_type: Option<&str> = None;
        for (k, v) in &block.headers {
            if k == "Proc-Type" {
                proc_type = Some(v);
            } else {
                others.push((k, v));
            }
        }
        others.sort_by(|a, b| a.0.cmp(b.0));
        if let Some(v) = proc_type {
            out.extend_from_slice(b"Proc-Type: ");
            out.extend_from_slice(v.as_bytes());
            out.push(b'\n');
        }
        for (k, v) in others {
            out.extend_from_slice(k.as_bytes());
            out.extend_from_slice(b": ");
            out.extend_from_slice(v.as_bytes());
            out.push(b'\n');
        }
        out.push(b'\n');
    }
    out.extend_from_slice(&wrap_64(&encode_std_base64(&block.bytes)));
    out.extend_from_slice(&PEM_END[1..]);
    out.extend_from_slice(block.type_name.as_bytes());
    out.extend_from_slice(b"-----\n");
    Ok(out)
}
