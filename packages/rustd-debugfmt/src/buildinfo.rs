//! Go 1.18+ inline buildinfo blob (`\xff Go buildinf:`) plus the older pointer form.

const MAGIC: &[u8] = b"\xff Go buildinf:";
const ALIGN: usize = 16;
const HEADER: usize = 32;
const FLAGS_VERSION_INL: u8 = 0x2;
const FLAGS_ENDIAN_BIG: u8 = 0x1;

#[derive(Clone, Debug)]
pub struct BuildInfo {
    pub go_version: String,
    pub path: String,
    pub main: Module,
    pub deps: Vec<Module>,
    pub settings: Vec<(String, String)>,
}

#[derive(Clone, Debug, Default)]
pub struct Module {
    pub path: String,
    pub version: String,
    pub sum: String,
    pub replace: Option<Box<Module>>,
}

pub fn parse_blob(bytes: &[u8]) -> Option<BuildInfo> {
    let addr = find_magic(bytes)?;
    if addr + HEADER > bytes.len() {
        return None;
    }
    let header = &bytes[addr..addr + HEADER];
    if !header.starts_with(MAGIC) {
        return None;
    }
    let flags = header[15];
    let (vers, modinfo) = if flags & FLAGS_VERSION_INL == FLAGS_VERSION_INL {
        let (vers, next) = decode_bytes(bytes, addr + HEADER)?;
        let (modinfo, _) = decode_bytes(bytes, next)?;
        (String::from_utf8_lossy(&vers).into_owned(), modinfo)
    } else {
        let ptr_size = header[14] as usize;
        if ptr_size != 4 && ptr_size != 8 {
            return None;
        }
        let big = flags & FLAGS_ENDIAN_BIG != 0;
        let vers_ptr = read_ptr(&header[16..], ptr_size, big)?;
        let mod_ptr = read_ptr(&header[16 + ptr_size..], ptr_size, big)?;
        let vers = read_go_string(bytes, vers_ptr as usize, ptr_size, big)?;
        let modinfo = read_go_bytes(bytes, mod_ptr as usize, ptr_size, big).unwrap_or_default();
        (vers, modinfo)
    };
    if vers.is_empty() {
        return None;
    }
    let modinfo = strip_mod_framing(&modinfo);
    Some(parse_modinfo(vers, &modinfo))
}

fn find_magic(bytes: &[u8]) -> Option<usize> {
    let mut i = (0 + ALIGN - 1) & !(ALIGN - 1);
    while i + MAGIC.len() <= bytes.len() {
        if bytes[i..].starts_with(MAGIC) {
            return Some(i);
        }
        i += ALIGN;
        if i >= bytes.len() {
            break;
        }
        // Fast-path: scan for 0xff at aligned offsets only.
    }
    // The loop steps by 16 from 0, which is complete. None if missing.
    None
}

fn decode_bytes(bytes: &[u8], addr: usize) -> Option<(Vec<u8>, usize)> {
    if addr >= bytes.len() {
        return None;
    }
    let (len, n) = uvarint(&bytes[addr..])?;
    let start = addr + n;
    let end = start.checked_add(len)?;
    if end > bytes.len() {
        return None;
    }
    Some((bytes[start..end].to_vec(), end))
}

fn uvarint(buf: &[u8]) -> Option<(usize, usize)> {
    let mut x: u64 = 0;
    let mut s = 0;
    for (i, b) in buf.iter().copied().enumerate() {
        if i == 10 {
            return None;
        }
        if b < 0x80 {
            if i == 9 && b > 1 {
                return None;
            }
            x |= u64::from(b) << s;
            return usize::try_from(x).ok().map(|v| (v, i + 1));
        }
        x |= u64::from(b & 0x7f) << s;
        s += 7;
    }
    None
}

fn read_ptr(buf: &[u8], ptr_size: usize, big: bool) -> Option<u64> {
    if buf.len() < ptr_size {
        return None;
    }
    Some(if ptr_size == 4 {
        let v = [buf[0], buf[1], buf[2], buf[3]];
        u64::from(if big {
            u32::from_be_bytes(v)
        } else {
            u32::from_le_bytes(v)
        })
    } else {
        let v = [
            buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
        ];
        if big {
            u64::from_be_bytes(v)
        } else {
            u64::from_le_bytes(v)
        }
    })
}

fn read_go_string(bytes: &[u8], addr: usize, ptr_size: usize, big: bool) -> Option<String> {
    read_go_bytes(bytes, addr, ptr_size, big).map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn read_go_bytes(bytes: &[u8], addr: usize, ptr_size: usize, big: bool) -> Option<Vec<u8>> {
    if addr.checked_add(2 * ptr_size)? > bytes.len() {
        return None;
    }
    let data_addr = read_ptr(&bytes[addr..], ptr_size, big)? as usize;
    let data_len = read_ptr(&bytes[addr + ptr_size..], ptr_size, big)? as usize;
    let end = data_addr.checked_add(data_len)?;
    if end > bytes.len() {
        return None;
    }
    Some(bytes[data_addr..end].to_vec())
}

fn strip_mod_framing(modinfo: &[u8]) -> String {
    if modinfo.len() >= 33 && modinfo[modinfo.len() - 17] == b'\n' {
        String::from_utf8_lossy(&modinfo[16..modinfo.len() - 16]).into_owned()
    } else {
        String::new()
    }
}

fn parse_modinfo(go_version: String, data: &str) -> BuildInfo {
    let mut info = BuildInfo {
        go_version,
        path: String::new(),
        main: Module::default(),
        deps: Vec::new(),
        settings: Vec::new(),
    };
    let mut last_is_dep = false;
    for line in data.split('\n') {
        if let Some(rest) = line.strip_prefix("path\t") {
            info.path = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("mod\t") {
            info.main = parse_module(rest);
            last_is_dep = false;
        } else if let Some(rest) = line.strip_prefix("dep\t") {
            info.deps.push(parse_module(rest));
            last_is_dep = true;
        } else if let Some(rest) = line.strip_prefix("=>\t") {
            let repl = parse_module(rest);
            if last_is_dep {
                if let Some(dep) = info.deps.last_mut() {
                    dep.replace = Some(Box::new(repl));
                }
            } else {
                info.main.replace = Some(Box::new(repl));
            }
        } else if let Some(rest) = line.strip_prefix("build\t") {
            if let Some((k, v)) = rest.split_once('=') {
                let key = unquote(k);
                let value = unquote(v);
                info.settings.push((key, value));
            }
        }
    }
    info
}

fn parse_module(line: &str) -> Module {
    let mut parts = line.split('\t');
    Module {
        path: parts.next().unwrap_or("").to_string(),
        version: parts.next().unwrap_or("").to_string(),
        sum: parts.next().unwrap_or("").to_string(),
        replace: None,
    }
}

fn unquote(s: &str) -> String {
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        unescape(&s[1..s.len() - 1])
    } else {
        s.to_string()
    }
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some('\\') => out.push('\\'),
                Some('"') => out.push('"'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}
