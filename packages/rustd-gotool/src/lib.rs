use napi_derive::napi;
use std::collections::HashMap;

mod fileset;
mod scanner;
mod token;
mod unicode_go;

pub use fileset::{FileSet, GoFile, GoPosition};
pub use scanner::{Scanner, SCAN_COMMENTS};

// Semantics match Go 1.24.13 `internal/gover` + `go/version` (toolchain names, not semver).
#[derive(Clone, Default, PartialEq, Eq)]
struct Version {
    major: String,
    minor: String,
    patch: String,
    kind: String,
    pre: String,
}

fn strip_go(v: &str) -> &str {
    let v = v.split_once('-').map(|(head, _)| head).unwrap_or(v);
    if v.len() < 2 || !v.as_bytes().starts_with(b"go") {
        ""
    } else {
        &v[2..]
    }
}

fn cut_int(x: &str) -> Option<(&str, &str)> {
    let bytes = x.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 || (bytes[0] == b'0' && i != 1) {
        return None;
    }
    Some((&x[..i], &x[i..]))
}

fn parse(x: &str) -> Version {
    let Some((major, rest)) = cut_int(x) else {
        return Version::default();
    };
    if rest.is_empty() {
        return Version {
            major: major.to_string(),
            minor: "0".into(),
            patch: "0".into(),
            kind: String::new(),
            pre: String::new(),
        };
    }
    if !rest.starts_with('.') {
        return Version::default();
    }
    let Some((minor, rest)) = cut_int(&rest[1..]) else {
        return Version::default();
    };
    if rest.is_empty() {
        let patch = if cmp_int(minor, "21") < 0 {
            "0".to_string()
        } else {
            String::new()
        };
        return Version {
            major: major.to_string(),
            minor: minor.to_string(),
            patch,
            kind: String::new(),
            pre: String::new(),
        };
    }
    if rest.starts_with('.') {
        let Some((patch, rest)) = cut_int(&rest[1..]) else {
            return Version::default();
        };
        if !rest.is_empty() {
            return Version::default();
        }
        return Version {
            major: major.to_string(),
            minor: minor.to_string(),
            patch: patch.to_string(),
            kind: String::new(),
            pre: String::new(),
        };
    }
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() && !bytes[i].is_ascii_digit() {
        if !bytes[i].is_ascii_lowercase() {
            return Version::default();
        }
        i += 1;
    }
    if i == 0 {
        return Version::default();
    }
    let kind = &rest[..i];
    let rest = &rest[i..];
    if rest.is_empty() {
        return Version {
            major: major.to_string(),
            minor: minor.to_string(),
            patch: String::new(),
            kind: kind.to_string(),
            pre: String::new(),
        };
    }
    let Some((pre, rest)) = cut_int(rest) else {
        return Version::default();
    };
    if !rest.is_empty() {
        return Version::default();
    }
    Version {
        major: major.to_string(),
        minor: minor.to_string(),
        patch: String::new(),
        kind: kind.to_string(),
        pre: pre.to_string(),
    }
}

fn cmp_int(x: &str, y: &str) -> i32 {
    if x == y {
        0
    } else if x.len() < y.len() {
        -1
    } else if x.len() > y.len() {
        1
    } else if x < y {
        -1
    } else {
        1
    }
}

fn gover_compare(x: &str, y: &str) -> i32 {
    let vx = parse(x);
    let vy = parse(y);
    let fields = [
        cmp_int(&vx.major, &vy.major),
        cmp_int(&vx.minor, &vy.minor),
        cmp_int(&vx.patch, &vy.patch),
        match vx.kind.cmp(&vy.kind) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        },
        cmp_int(&vx.pre, &vy.pre),
    ];
    fields.into_iter().find(|&c| c != 0).unwrap_or(0)
}

fn gover_lang(x: &str) -> String {
    let v = parse(x);
    if v.minor.is_empty() || (v.major == "1" && v.minor == "0") {
        v.major
    } else {
        format!("{}.{}", v.major, v.minor)
    }
}

fn gover_is_valid(x: &str) -> bool {
    parse(x) != Version::default()
}

fn lang(x: &str) -> String {
    let stripped = strip_go(x);
    let v = gover_lang(stripped);
    if v.is_empty() {
        return String::new();
    }
    if x.len() >= 2 && x[2..].starts_with(&v) {
        x[..2 + v.len()].to_string()
    } else {
        format!("go{v}")
    }
}

#[napi]
pub fn version_compare(x: String, y: String) -> i32 {
    gover_compare(strip_go(&x), strip_go(&y))
}

#[napi]
pub fn version_is_valid(x: String) -> bool {
    gover_is_valid(strip_go(&x))
}

#[napi]
pub fn version_lang(x: String) -> String {
    lang(&x)
}

#[napi]
pub fn token_lookup(ident: String) -> i32 {
    token::lookup(&ident)
}

#[napi]
pub fn token_is_keyword(tok: i32) -> bool {
    token::is_keyword_tok(tok)
}

#[napi]
pub fn token_is_exported(name: String) -> bool {
    fileset::is_exported(&name)
}

#[napi]
pub fn token_string(tok: i32) -> String {
    token::token_string(tok)
}

#[napi]
pub fn token_constants() -> HashMap<String, i32> {
    token::TOKEN_ENTRIES
        .iter()
        .map(|(k, v)| ((*k).to_string(), *v))
        .collect()
}

#[napi]
pub fn scan_mode_constants() -> HashMap<String, u32> {
    let mut m = HashMap::new();
    m.insert("ScanComments".into(), SCAN_COMMENTS);
    m
}
