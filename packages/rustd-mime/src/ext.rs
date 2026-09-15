use crate::mediatype::{format_media_type, parse_media_type};
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::sync::Mutex;

const BUILTIN: &[(&str, &str)] = &[
    (".avif", "image/avif"),
    (".css", "text/css; charset=utf-8"),
    (".gif", "image/gif"),
    (".htm", "text/html; charset=utf-8"),
    (".html", "text/html; charset=utf-8"),
    (".jpeg", "image/jpeg"),
    (".jpg", "image/jpeg"),
    (".js", "text/javascript; charset=utf-8"),
    (".json", "application/json"),
    (".mjs", "text/javascript; charset=utf-8"),
    (".pdf", "application/pdf"),
    (".png", "image/png"),
    (".svg", "image/svg+xml"),
    (".wasm", "application/wasm"),
    (".webp", "image/webp"),
    (".xml", "text/xml; charset=utf-8"),
];

const GLOBS: &[&str] = &["/usr/local/share/mime/globs2", "/usr/share/mime/globs2"];
const TYPE_FILES: &[&str] = &[
    "/etc/mime.types",
    "/etc/apache2/mime.types",
    "/etc/apache/mime.types",
    "/etc/httpd/conf/mime.types",
];

struct Tables {
    mime_types: HashMap<String, String>,
    mime_types_lower: HashMap<String, String>,
    extensions: HashMap<String, Vec<String>>,
}

static TABLES: Mutex<Option<Tables>> = Mutex::new(None);

fn builtin_map() -> HashMap<String, String> {
    BUILTIN.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect()
}

fn set_mime_types(tables: &mut Tables, lower_ext: &HashMap<String, String>, mix_ext: &HashMap<String, String>) {
    tables.mime_types.clear();
    tables.mime_types_lower.clear();
    tables.extensions.clear();
    tables.mime_types_lower.extend(lower_ext.clone());
    tables.mime_types.extend(mix_ext.clone());
    for (k, v) in lower_ext {
        let parsed = parse_media_type(v);
        if parsed.error.is_some() {
            continue;
        }
        tables
            .extensions
            .entry(parsed.media_type)
            .or_default()
            .push(k.clone());
    }
}

fn ensure(tables: &mut Option<Tables>) -> &mut Tables {
    if tables.is_none() {
        let mut t = Tables {
            mime_types: HashMap::new(),
            mime_types_lower: HashMap::new(),
            extensions: HashMap::new(),
        };
        let builtin = builtin_map();
        set_mime_types(&mut t, &builtin, &builtin);
        init_unix(&mut t);
        *tables = Some(t);
    }
    tables.as_mut().unwrap()
}

fn init_unix(tables: &mut Tables) {
    let _ = load_unix_defaults(tables);
}

fn load_unix_defaults(tables: &mut Tables) -> u32 {
    for filename in GLOBS {
        if let Ok(n) = load_mime_globs_file(tables, filename) {
            return n;
        }
    }
    let mut n = 0;
    for filename in TYPE_FILES {
        n += load_mime_file(tables, filename);
    }
    n
}

fn load_one_path(tables: &mut Tables, path: &str) -> u32 {
    if path.ends_with("globs2") {
        load_mime_globs_file(tables, path).unwrap_or(0)
    } else {
        load_mime_file(tables, path)
    }
}

fn load_mime_globs_file(tables: &mut Tables, filename: &str) -> Result<u32, ()> {
    let file = File::open(filename).map_err(|_| ())?;
    let reader = BufReader::new(file);
    let mut n = 0u32;
    for line in reader.lines().map_while(Result::ok) {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() < 3 || fields[0].is_empty() || fields[2].len() < 3 {
            continue;
        }
        let f0 = fields[0].as_bytes();
        let f2 = fields[2].as_bytes();
        if f0[0] == b'#' || f2[0] != b'*' || f2[1] != b'.' {
            continue;
        }
        let extension = &fields[2][1..];
        if extension.contains(['?', '*', '[']) {
            continue;
        }
        if tables.mime_types.contains_key(extension) {
            continue;
        }
        if set_extension_type(tables, extension, fields[1]).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

fn load_mime_file(tables: &mut Tables, filename: &str) -> u32 {
    let Ok(file) = File::open(filename) else { return 0 };
    let reader = BufReader::new(file);
    let mut n = 0;
    for line in reader.lines().map_while(Result::ok) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() <= 1 || fields[0].starts_with('#') {
            continue;
        }
        let mime_type = fields[0];
        for ext in &fields[1..] {
            if ext.starts_with('#') {
                break;
            }
            if set_extension_type(tables, &format!(".{ext}"), mime_type).is_ok() {
                n += 1;
            }
        }
    }
    n
}

fn set_extension_type(tables: &mut Tables, extension: &str, mime_type: &str) -> Result<(), String> {
    let parsed = parse_media_type(mime_type);
    if let Some(err) = parsed.error {
        return Err(err);
    }
    let just_type = parsed.media_type;
    let mut mime_type = mime_type.to_string();
    if mime_type.starts_with("text/") && parsed.params.get("charset").map(String::as_str).unwrap_or("") == "" {
        let mut param: BTreeMap<String, String> = parsed.params.into_iter().collect();
        param.insert("charset".into(), "utf-8".into());
        mime_type = format_media_type(&mime_type, &param);
    }
    let ext_lower = extension.to_ascii_lowercase();
    tables.mime_types.insert(extension.to_string(), mime_type.clone());
    tables.mime_types_lower.insert(ext_lower.clone(), mime_type);
    let exts = tables.extensions.entry(just_type).or_default();
    if !exts.iter().any(|v| v == &ext_lower) {
        exts.push(ext_lower);
    }
    Ok(())
}

pub fn type_by_extension(ext: &str) -> String {
    let mut guard = TABLES.lock().expect("mime type table");
    let tables = ensure(&mut guard);
    if let Some(v) = tables.mime_types.get(ext) {
        return v.clone();
    }
    tables
        .mime_types_lower
        .get(&ext.to_ascii_lowercase())
        .cloned()
        .unwrap_or_default()
}

pub fn extensions_by_type(typ: &str) -> Result<Vec<String>, String> {
    let parsed = parse_media_type(typ);
    if let Some(err) = parsed.error {
        return Err(err);
    }
    let mut guard = TABLES.lock().expect("mime type table");
    let tables = ensure(&mut guard);
    let mut ret = tables
        .extensions
        .get(&parsed.media_type)
        .cloned()
        .unwrap_or_default();
    ret.sort();
    Ok(ret)
}

pub fn add_extension_type(ext: &str, typ: &str) -> Result<(), String> {
    if !ext.starts_with('.') {
        return Err(format!("mime: extension {ext:?} missing leading dot"));
    }
    let mut guard = TABLES.lock().expect("mime type table");
    let tables = ensure(&mut guard);
    set_extension_type(tables, ext, typ)
}

pub fn load_system_mime_types(paths: Option<Vec<String>>) -> u32 {
    let mut guard = TABLES.lock().expect("mime type table");
    let tables = ensure(&mut guard);
    match paths {
        None => {
            // mime.types can overwrite existing entries (unlike globs2). Report
            // changes to the resulting table, not lines re-read on a no-op reload.
            let before = tables.mime_types.clone();
            load_unix_defaults(tables);
            tables.mime_types.iter().filter(|(ext, typ)| before.get(*ext) != Some(*typ)).count() as u32
        }
        Some(list) => list.iter().map(|path| load_one_path(tables, path)).sum(),
    }
}
