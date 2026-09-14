use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::{Map as JsonMap, Number, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::{fail, named};

const T_BOOL: i32 = 1;
const T_INT: i32 = 2;
const T_UINT: i32 = 3;
const T_FLOAT: i32 = 4;
const T_BYTES: i32 = 5;
const T_STRING: i32 = 6;
const T_COMPLEX: i32 = 7;
const T_INTERFACE: i32 = 8;
const FIRST_USER_ID: i32 = 64;
const DEFAULT_MAX: u64 = 1 << 30;

#[derive(Clone, Debug)]
pub enum GobType {
    Bool,
    Int,
    Int8,
    Int16,
    Int32,
    Int64,
    Uint,
    Uint8,
    Uint16,
    Uint32,
    Uint64,
    Float32,
    Float64,
    Complex64,
    Complex128,
    Bytes,
    String,
    Array { elem: Box<GobType>, len: i64 },
    Slice { elem: Box<GobType> },
    Map { key: Box<GobType>, elem: Box<GobType> },
    Struct { name: String, fields: Vec<(String, GobType)> },
    Interface { name: Option<String> },
    GobEncoder { name: String },
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
enum Wire {
    Array { name: String, id: i32, elem: i32, len: i64 },
    Slice { name: String, id: i32, elem: i32 },
    Struct { name: String, id: i32, fields: Vec<(String, i32)> },
    Map { name: String, id: i32, key: i32, elem: i32 },
    GobEnc { name: String, id: i32 },
}

fn registry() -> &'static Mutex<HashMap<String, GobType>> {
    static REG: OnceLock<Mutex<HashMap<String, GobType>>> = OnceLock::new();
    REG.get_or_init(|| {
        let mut m = HashMap::new();
        for (n, t) in [
            ("bool", GobType::Bool),
            ("int", GobType::Int),
            ("int8", GobType::Int8),
            ("int16", GobType::Int16),
            ("int32", GobType::Int32),
            ("int64", GobType::Int64),
            ("uint", GobType::Uint),
            ("uint8", GobType::Uint8),
            ("uint16", GobType::Uint16),
            ("uint32", GobType::Uint32),
            ("uint64", GobType::Uint64),
            ("uintptr", GobType::Uint),
            ("float32", GobType::Float32),
            ("float64", GobType::Float64),
            ("complex64", GobType::Complex64),
            ("complex128", GobType::Complex128),
            ("string", GobType::String),
            ("[]uint8", GobType::Bytes),
            ("[]byte", GobType::Bytes),
        ] {
            m.insert(n.to_string(), t);
        }
        Mutex::new(m)
    })
}

pub fn register_name(name: String, type_json: String) -> Result<()> {
    if name.is_empty() {
        return Err(fail("GobTypeError", "empty register name"));
    }
    let ty = parse_type_str(&type_json)?;
    registry().lock().unwrap().insert(name, ty);
    Ok(())
}

pub fn parse_type_str(s: &str) -> Result<GobType> {
    let v: Value = serde_json::from_str(s).map_err(|e| fail("GobTypeError", e))?;
    parse_type(&v)
}

fn parse_type(v: &Value) -> Result<GobType> {
    let obj = v
        .as_object()
        .ok_or_else(|| fail("GobTypeError", "type must be an object"))?;
    let kind = obj
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| fail("GobTypeError", "missing kind"))?;
    Ok(match kind {
        "bool" => GobType::Bool,
        "int" => GobType::Int,
        "int8" => GobType::Int8,
        "int16" => GobType::Int16,
        "int32" => GobType::Int32,
        "int64" => GobType::Int64,
        "uint" => GobType::Uint,
        "uint8" => GobType::Uint8,
        "uint16" => GobType::Uint16,
        "uint32" => GobType::Uint32,
        "uint64" => GobType::Uint64,
        "float32" => GobType::Float32,
        "float64" => GobType::Float64,
        "complex64" => GobType::Complex64,
        "complex128" => GobType::Complex128,
        "bytes" => GobType::Bytes,
        "string" => GobType::String,
        "array" => GobType::Array {
            elem: Box::new(parse_type(obj.get("elem").ok_or_else(|| fail("GobTypeError", "array.elem"))?)?),
            len: obj
                .get("len")
                .and_then(Value::as_i64)
                .ok_or_else(|| fail("GobTypeError", "array.len"))?,
        },
        "slice" => GobType::Slice {
            elem: Box::new(parse_type(obj.get("elem").ok_or_else(|| fail("GobTypeError", "slice.elem"))?)?),
        },
        "map" => GobType::Map {
            key: Box::new(parse_type(obj.get("key").ok_or_else(|| fail("GobTypeError", "map.key"))?)?),
            elem: Box::new(parse_type(obj.get("elem").ok_or_else(|| fail("GobTypeError", "map.elem"))?)?),
        },
        "struct" => {
            let name = obj.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let fields = obj
                .get("fields")
                .and_then(Value::as_array)
                .ok_or_else(|| fail("GobTypeError", "struct.fields"))?;
            let mut out = Vec::with_capacity(fields.len());
            for f in fields {
                let n = f
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| fail("GobTypeError", "field.name"))?;
                let t = parse_type(f.get("type").ok_or_else(|| fail("GobTypeError", "field.type"))?)?;
                out.push((n.to_string(), t));
            }
            GobType::Struct { name, fields: out }
        }
        "interface" => GobType::Interface {
            name: obj.get("name").and_then(Value::as_str).map(str::to_string),
        },
        "gobEncoder" => GobType::GobEncoder {
            name: obj
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| fail("GobTypeError", "gobEncoder.name"))?
                .to_string(),
        },
        other => return Err(fail("GobTypeError", format!("unsupported kind {other}"))),
    })
}

fn type_key(t: &GobType) -> String {
    match t {
        GobType::Bool => "bool".into(),
        GobType::Int => "int".into(),
        GobType::Int8 => "int8".into(),
        GobType::Int16 => "int16".into(),
        GobType::Int32 => "int32".into(),
        GobType::Int64 => "int64".into(),
        GobType::Uint => "uint".into(),
        GobType::Uint8 => "uint8".into(),
        GobType::Uint16 => "uint16".into(),
        GobType::Uint32 => "uint32".into(),
        GobType::Uint64 => "uint64".into(),
        GobType::Float32 => "float32".into(),
        GobType::Float64 => "float64".into(),
        GobType::Complex64 => "complex64".into(),
        GobType::Complex128 => "complex128".into(),
        GobType::Bytes => "bytes".into(),
        GobType::String => "string".into(),
        GobType::Array { elem, len } => format!("[{len}]{}", type_key(elem)),
        GobType::Slice { elem } => format!("[]{}", type_key(elem)),
        GobType::Map { key, elem } => format!("map[{}]{}", type_key(key), type_key(elem)),
        GobType::Struct { name, fields } => {
            let fs: Vec<String> = fields.iter().map(|(n, t)| format!("{n}:{}", type_key(t))).collect();
            format!("struct {name}{{{}}}", fs.join(","))
        }
        GobType::Interface { name } => format!("interface {}", name.clone().unwrap_or_default()),
        GobType::GobEncoder { name } => format!("gobEncoder {name}"),
    }
}

fn builtin_id(t: &GobType) -> Option<i32> {
    Some(match t {
        GobType::Bool => T_BOOL,
        GobType::Int | GobType::Int8 | GobType::Int16 | GobType::Int32 | GobType::Int64 => T_INT,
        GobType::Uint | GobType::Uint8 | GobType::Uint16 | GobType::Uint32 | GobType::Uint64 => T_UINT,
        GobType::Float32 | GobType::Float64 => T_FLOAT,
        GobType::Bytes => T_BYTES,
        GobType::Slice { elem } if matches!(**elem, GobType::Uint8) => T_BYTES,
        GobType::String => T_STRING,
        GobType::Complex64 | GobType::Complex128 => T_COMPLEX,
        GobType::Interface { .. } => T_INTERFACE,
        _ => return None,
    })
}

fn needs_def(t: &GobType) -> bool {
    match t {
        GobType::Array { .. } | GobType::Map { .. } | GobType::Struct { .. } | GobType::GobEncoder { .. } => true,
        GobType::Slice { elem } => !matches!(**elem, GobType::Uint8),
        _ => false,
    }
}

pub fn put_uint(buf: &mut Vec<u8>, x: u64) {
    if x <= 0x7f {
        buf.push(x as u8);
        return;
    }
    let be = x.to_be_bytes();
    let lz = (x.leading_zeros() as usize) / 8;
    buf.push((lz as u8).wrapping_sub(8));
    buf.extend_from_slice(&be[lz..]);
}

pub fn put_int(buf: &mut Vec<u8>, i: i64) {
    let x = if i < 0 {
        ((!i as u64).wrapping_shl(1)) | 1
    } else {
        (i as u64) << 1
    };
    put_uint(buf, x);
}

fn float_bits(f: f64) -> u64 {
    f.to_bits().swap_bytes()
}

fn from_float_bits(u: u64) -> f64 {
    f64::from_bits(u.swap_bytes())
}

struct R<'a> {
    data: &'a [u8],
    pos: usize,
}

#[allow(dead_code)]
impl<'a> R<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }
    fn rest(&self) -> &'a [u8] {
        &self.data[self.pos..]
    }
    fn get_uint(&mut self) -> Result<u64> {
        if self.pos >= self.data.len() {
            return Err(named("BufferTooShortError"));
        }
        let b = self.data[self.pos];
        self.pos += 1;
        if b <= 0x7f {
            return Ok(b as u64);
        }
        let n = -(b as i8) as usize;
        if n == 0 || n > 8 {
            return Err(fail("GobTypeError", "bad uint"));
        }
        if self.remaining() < n {
            return Err(named("BufferTooShortError"));
        }
        let mut x = 0u64;
        for i in 0..n {
            x = (x << 8) | self.data[self.pos + i] as u64;
        }
        self.pos += n;
        Ok(x)
    }
    fn get_int(&mut self) -> Result<i64> {
        let x = self.get_uint()?;
        Ok(if x & 1 != 0 { !(x >> 1) as i64 } else { (x >> 1) as i64 })
    }
    fn get_bytes(&mut self) -> Result<&'a [u8]> {
        let n = self.get_uint()? as usize;
        if n > self.remaining() {
            return Err(named("BufferTooShortError"));
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
    fn get_string(&mut self) -> Result<String> {
        let b = self.get_bytes()?;
        String::from_utf8(b.to_vec()).map_err(|e| fail("GobTypeError", e))
    }
}

pub struct Enc {
    out: Vec<u8>,
    cur: Vec<u8>,
    sent: HashMap<String, i32>,
    ids: HashMap<String, i32>,
    next_id: i32,
    registered: HashMap<String, GobType>,
}

impl Default for Enc {
    fn default() -> Self {
        Self {
            out: Vec::new(),
            cur: Vec::new(),
            sent: HashMap::new(),
            ids: HashMap::new(),
            next_id: FIRST_USER_ID,
            registered: registry().lock().unwrap().clone(),
        }
    }
}

impl Enc {
    pub fn reset(&mut self) {
        self.out.clear();
        self.cur.clear();
        self.sent.clear();
        self.ids.clear();
        self.next_id = FIRST_USER_ID;
        self.registered = registry().lock().unwrap().clone();
    }

    fn gob_id(&self, t: &GobType) -> i32 {
        if let Some(id) = builtin_id(t) {
            return id;
        }
        self.ids[&type_key(t)]
    }

    fn assign_ids(&mut self, t: &GobType) {
        if builtin_id(t).is_some() {
            if let GobType::Slice { elem } = t {
                if !matches!(**elem, GobType::Uint8) {
                    // user slice of non-byte
                } else {
                    return;
                }
            } else {
                return;
            }
        }
        let key = type_key(t);
        if self.ids.contains_key(&key) {
            return;
        }
        match t {
            GobType::GobEncoder { .. } => {
                let id = self.next_id;
                self.next_id += 1;
                self.ids.insert(key, id);
            }
            GobType::Struct { fields, .. } => {
                let id = self.next_id;
                self.next_id += 1;
                self.ids.insert(key, id);
                for (_, ft) in fields {
                    self.assign_ids(ft);
                }
            }
            GobType::Array { elem, .. } => {
                self.assign_ids(elem);
                let id = self.next_id;
                self.next_id += 1;
                self.ids.insert(key, id);
            }
            GobType::Slice { elem } => {
                if matches!(**elem, GobType::Uint8) {
                    return;
                }
                self.assign_ids(elem);
                let id = self.next_id;
                self.next_id += 1;
                self.ids.insert(key, id);
            }
            GobType::Map { key: k, elem } => {
                self.assign_ids(k);
                self.assign_ids(elem);
                let id = self.next_id;
                self.next_id += 1;
                self.ids.insert(key, id);
            }
            _ => {}
        }
    }

    fn finish_message(&mut self) {
        let body = std::mem::take(&mut self.cur);
        put_uint(&mut self.out, body.len() as u64);
        self.out.extend(body);
    }

    fn send_type(&mut self, t: &GobType) {
        if !needs_def(t) {
            return;
        }
        let key = type_key(t);
        if self.sent.contains_key(&key) {
            return;
        }
        let id = self.gob_id(t);
        self.sent.insert(key, id);
        put_int(&mut self.cur, -(id as i64));
        self.encode_wire(t, id);
        self.finish_message();
        match t {
            GobType::Struct { fields, .. } => {
                for (_, ft) in fields {
                    self.send_type(ft);
                }
            }
            GobType::Array { elem, .. } | GobType::Slice { elem } => self.send_type(elem),
            GobType::Map { key, elem } => {
                self.send_type(key);
                self.send_type(elem);
            }
            _ => {}
        }
    }

    fn encode_wire(&mut self, t: &GobType, id: i32) {
        let mut body = Vec::new();
        match t {
            GobType::Array { elem, len } => {
                put_uint(&mut body, 1);
                encode_array_type(&mut body, t_name(t), id, self.gob_id(elem), *len);
                put_uint(&mut body, 0);
            }
            GobType::Slice { elem } => {
                put_uint(&mut body, 2);
                encode_slice_type(&mut body, t_name(t), id, self.gob_id(elem));
                put_uint(&mut body, 0);
            }
            GobType::Struct { name, fields } => {
                put_uint(&mut body, 3);
                encode_struct_type(&mut body, name, id, fields, |ft| self.gob_id(ft));
                put_uint(&mut body, 0);
            }
            GobType::Map { key, elem } => {
                put_uint(&mut body, 4);
                encode_map_type(&mut body, t_name(t), id, self.gob_id(key), self.gob_id(elem));
                put_uint(&mut body, 0);
            }
            GobType::GobEncoder { name } => {
                put_uint(&mut body, 5);
                encode_common(&mut body, name, id);
                put_uint(&mut body, 0);
            }
            _ => {}
        }
        self.cur.extend(body);
    }

    pub fn encode(&mut self, ty: &GobType, val: &Value) -> Result<Vec<u8>> {
        self.out.clear();
        self.cur.clear();
        self.assign_ids(ty);
        self.send_type(ty);
        let id = self.gob_id(ty);
        put_int(&mut self.cur, id as i64);
        self.encode_value(ty, val, true)?;
        self.finish_message();
        Ok(std::mem::take(&mut self.out))
    }

    fn encode_value(&mut self, ty: &GobType, val: &Value, top: bool) -> Result<()> {
        if matches!(ty, GobType::Struct { .. }) && !matches!(ty, GobType::GobEncoder { .. }) {
            if top {
                self.encode_struct(ty, val)?;
            } else {
                self.encode_struct(ty, val)?;
            }
            return Ok(());
        }
        if top {
            put_uint(&mut self.cur, 0);
        }
        self.encode_payload(ty, val, true)
    }

    fn encode_struct(&mut self, ty: &GobType, val: &Value) -> Result<()> {
        let GobType::Struct { fields, .. } = ty else {
            return Err(fail("GobTypeError", "expected struct"));
        };
        let obj = match val {
            Value::Null => &JsonMap::new(),
            Value::Object(m) => m,
            _ => return Err(fail("GobTypeError", "expected struct object")),
        };
        let mut fieldnum = -1i32;
        for (i, (name, ft)) in fields.iter().enumerate() {
            let fv = obj.get(name).unwrap_or(&Value::Null);
            if is_zero(ft, fv) {
                continue;
            }
            let n = i as i32;
            put_uint(&mut self.cur, (n - fieldnum) as u64);
            fieldnum = n;
            if matches!(ft, GobType::Struct { .. }) && !matches!(ft, GobType::GobEncoder { .. }) {
                self.encode_struct(ft, fv)?;
            } else {
                self.encode_payload(ft, fv, true)?;
            }
        }
        put_uint(&mut self.cur, 0);
        Ok(())
    }

    fn encode_payload(&mut self, ty: &GobType, val: &Value, send_zero: bool) -> Result<()> {
        match ty {
            GobType::Bool => {
                let b = val.as_bool().unwrap_or(false);
                put_uint(&mut self.cur, if b { 1 } else { 0 });
            }
            GobType::Int | GobType::Int8 | GobType::Int16 | GobType::Int32 | GobType::Int64 => {
                put_int(&mut self.cur, as_i64(val)?);
            }
            GobType::Uint | GobType::Uint8 | GobType::Uint16 | GobType::Uint32 | GobType::Uint64 => {
                put_uint(&mut self.cur, as_u64(val)?);
            }
            GobType::Float32 | GobType::Float64 => {
                put_uint(&mut self.cur, float_bits(as_f64(val)?));
            }
            GobType::Complex64 | GobType::Complex128 => {
                let (re, im) = as_complex(val)?;
                put_uint(&mut self.cur, float_bits(re));
                put_uint(&mut self.cur, float_bits(im));
            }
            GobType::String => {
                let s = val.as_str().unwrap_or("");
                put_uint(&mut self.cur, s.len() as u64);
                self.cur.extend(s.as_bytes());
            }
            GobType::Bytes | GobType::GobEncoder { .. } => {
                let b = as_bytes(val)?;
                put_uint(&mut self.cur, b.len() as u64);
                self.cur.extend(b);
            }
            GobType::Slice { elem } if matches!(**elem, GobType::Uint8) => {
                let b = as_bytes(val)?;
                put_uint(&mut self.cur, b.len() as u64);
                self.cur.extend(b);
            }
            GobType::Slice { elem } => {
                if val.is_null() {
                    put_uint(&mut self.cur, 0);
                    return Ok(());
                }
                let arr = val.as_array().ok_or_else(|| fail("GobTypeError", "expected slice"))?;
                put_uint(&mut self.cur, arr.len() as u64);
                for item in arr {
                    self.encode_elem(elem, item)?;
                }
            }
            GobType::Array { elem, len } => {
                let arr = val.as_array().ok_or_else(|| fail("GobTypeError", "expected array"))?;
                if arr.len() as i64 != *len {
                    return Err(fail("GobTypeError", "array length mismatch"));
                }
                put_uint(&mut self.cur, *len as u64);
                for item in arr {
                    self.encode_elem(elem, item)?;
                }
            }
            GobType::Map { key, elem } => {
                let pairs = as_map_pairs(val)?;
                put_uint(&mut self.cur, pairs.len() as u64);
                for (k, v) in pairs {
                    self.encode_elem(key, &k)?;
                    self.encode_elem(elem, &v)?;
                }
            }
            GobType::Struct { .. } => self.encode_struct(ty, val)?,
            GobType::Interface { .. } => self.encode_interface(val)?,
        }
        let _ = send_zero;
        Ok(())
    }

    fn encode_elem(&mut self, ty: &GobType, val: &Value) -> Result<()> {
        if matches!(ty, GobType::Struct { .. }) && !matches!(ty, GobType::GobEncoder { .. }) {
            return self.encode_struct(ty, val);
        }
        self.encode_payload(ty, val, true)
    }

    fn encode_interface(&mut self, val: &Value) -> Result<()> {
        if val.is_null() {
            put_uint(&mut self.cur, 0);
            return Ok(());
        }
        let obj = val.as_object().ok_or_else(|| fail("GobTypeError", "interface value"))?;
        let name = obj
            .get("$i")
            .and_then(Value::as_str)
            .ok_or_else(|| fail("GobTypeError", "interface name"))?;
        if name.is_empty() {
            put_uint(&mut self.cur, 0);
            return Ok(());
        }
        let concrete = self
            .registered
            .get(name)
            .cloned()
            .ok_or_else(|| fail("GobTypeError", format!("type not registered for interface: {name}")))?;
        put_uint(&mut self.cur, name.len() as u64);
        self.cur.extend(name.as_bytes());
        self.assign_ids(&concrete);
        self.send_type(&concrete);
        let cid = self.gob_id(&concrete);
        put_int(&mut self.cur, cid as i64);
        let inner = obj.get("$v").unwrap_or(&Value::Null);
        let saved = std::mem::take(&mut self.cur);
        self.encode_value(&concrete, inner, true)?;
        let body = std::mem::take(&mut self.cur);
        self.cur = saved;
        put_uint(&mut self.cur, body.len() as u64);
        self.cur.extend(body);
        Ok(())
    }
}

fn t_name(t: &GobType) -> String {
    match t {
        GobType::Struct { name, .. } | GobType::GobEncoder { name } => name.clone(),
        _ => String::new(),
    }
}

fn encode_common(buf: &mut Vec<u8>, name: &str, id: i32) {
    let mut fieldnum = -1i32;
    if !name.is_empty() {
        put_uint(buf, (0 - fieldnum) as u64);
        fieldnum = 0;
        put_uint(buf, name.len() as u64);
        buf.extend(name.as_bytes());
    }
    if id != 0 {
        put_uint(buf, (1 - fieldnum) as u64);
        put_int(buf, id as i64);
    }
    put_uint(buf, 0);
}

fn encode_array_type(buf: &mut Vec<u8>, name: String, id: i32, elem: i32, len: i64) {
    let mut fieldnum = -1i32;
    put_uint(buf, (0 - fieldnum) as u64);
    fieldnum = 0;
    encode_common(buf, &name, id);
    put_uint(buf, (1 - fieldnum) as u64);
    fieldnum = 1;
    put_int(buf, elem as i64);
    put_uint(buf, (2 - fieldnum) as u64);
    put_int(buf, len);
    put_uint(buf, 0);
}

fn encode_slice_type(buf: &mut Vec<u8>, name: String, id: i32, elem: i32) {
    let mut fieldnum = -1i32;
    put_uint(buf, (0 - fieldnum) as u64);
    fieldnum = 0;
    encode_common(buf, &name, id);
    put_uint(buf, (1 - fieldnum) as u64);
    put_int(buf, elem as i64);
    put_uint(buf, 0);
}

fn encode_map_type(buf: &mut Vec<u8>, name: String, id: i32, key: i32, elem: i32) {
    let mut fieldnum = -1i32;
    put_uint(buf, (0 - fieldnum) as u64);
    fieldnum = 0;
    encode_common(buf, &name, id);
    put_uint(buf, (1 - fieldnum) as u64);
    fieldnum = 1;
    put_int(buf, key as i64);
    put_uint(buf, (2 - fieldnum) as u64);
    put_int(buf, elem as i64);
    put_uint(buf, 0);
}

fn encode_struct_type(
    buf: &mut Vec<u8>,
    name: &str,
    id: i32,
    fields: &[(String, GobType)],
    mut id_of: impl FnMut(&GobType) -> i32,
) {
    let mut fieldnum = -1i32;
    put_uint(buf, (0 - fieldnum) as u64);
    fieldnum = 0;
    encode_common(buf, name, id);
    if !fields.is_empty() {
        put_uint(buf, (1 - fieldnum) as u64);
        put_uint(buf, fields.len() as u64);
        for (fname, ft) in fields {
            let fid = id_of(ft);
            let mut fnum = -1i32;
            put_uint(buf, (0 - fnum) as u64);
            fnum = 0;
            put_uint(buf, fname.len() as u64);
            buf.extend(fname.as_bytes());
            put_uint(buf, (1 - fnum) as u64);
            put_int(buf, fid as i64);
            put_uint(buf, 0);
        }
    }
    put_uint(buf, 0);
}

fn is_zero(ty: &GobType, val: &Value) -> bool {
    match ty {
        GobType::Array { .. } | GobType::Struct { .. } | GobType::GobEncoder { .. } => false,
        GobType::Bool => val.as_bool() != Some(true),
        GobType::Int | GobType::Int8 | GobType::Int16 | GobType::Int32 | GobType::Int64 => as_i64(val).ok() == Some(0),
        GobType::Uint | GobType::Uint8 | GobType::Uint16 | GobType::Uint32 | GobType::Uint64 => {
            as_u64(val).ok() == Some(0)
        }
        GobType::Float32 | GobType::Float64 => as_f64(val).ok() == Some(0.0),
        GobType::Complex64 | GobType::Complex128 => as_complex(val).ok() == Some((0.0, 0.0)),
        GobType::String => val.as_str().unwrap_or("").is_empty(),
        GobType::Bytes => as_bytes(val).map(|b| b.is_empty()).unwrap_or(true),
        GobType::Slice { .. } => val.is_null() || val.as_array().map(|a| a.is_empty()).unwrap_or(true),
        GobType::Map { .. } => val.is_null(),
        GobType::Interface { .. } => val.is_null() || val.get("$i").and_then(Value::as_str) == Some(""),
    }
}

fn as_i64(v: &Value) -> Result<i64> {
    if let Some(s) = v.as_str() {
        return s.parse().map_err(|e| fail("GobTypeError", e));
    }
    if let Some(n) = v.as_i64() {
        return Ok(n);
    }
    if let Some(n) = v.as_u64() {
        return i64::try_from(n).map_err(|_| fail("GobTypeError", "int overflow"));
    }
    if v.is_null() {
        return Ok(0);
    }
    Err(fail("GobTypeError", "expected int"))
}

fn as_u64(v: &Value) -> Result<u64> {
    if let Some(s) = v.as_str() {
        return s.parse().map_err(|e| fail("GobTypeError", e));
    }
    if let Some(n) = v.as_u64() {
        return Ok(n);
    }
    if let Some(n) = v.as_i64() {
        return u64::try_from(n).map_err(|_| fail("GobTypeError", "uint overflow"));
    }
    if v.is_null() {
        return Ok(0);
    }
    Err(fail("GobTypeError", "expected uint"))
}

fn as_f64(v: &Value) -> Result<f64> {
    if let Some(n) = v.as_f64() {
        return Ok(n);
    }
    if let Some(s) = v.as_str() {
        return s.parse().map_err(|e| fail("GobTypeError", e));
    }
    if v.is_null() {
        return Ok(0.0);
    }
    Err(fail("GobTypeError", "expected float"))
}

fn as_complex(v: &Value) -> Result<(f64, f64)> {
    if v.is_null() {
        return Ok((0.0, 0.0));
    }
    if let Some(arr) = v.as_array() {
        if arr.len() == 2 {
            return Ok((as_f64(&arr[0])?, as_f64(&arr[1])?));
        }
    }
    if let Some(obj) = v.as_object() {
        let re = obj.get("re").or_else(|| obj.get("real")).unwrap_or(&Value::Null);
        let im = obj.get("im").or_else(|| obj.get("imag")).unwrap_or(&Value::Null);
        return Ok((as_f64(re)?, as_f64(im)?));
    }
    Err(fail("GobTypeError", "expected complex"))
}

fn as_bytes(v: &Value) -> Result<Vec<u8>> {
    if v.is_null() {
        return Ok(Vec::new());
    }
    if let Some(obj) = v.as_object() {
        if let Some(h) = obj.get("$b").or_else(|| obj.get("$g")).and_then(Value::as_str) {
            return hex::decode_hex(h);
        }
    }
    if let Some(s) = v.as_str() {
        return hex::decode_hex(s);
    }
    if let Some(arr) = v.as_array() {
        let mut out = Vec::with_capacity(arr.len());
        for x in arr {
            out.push(u8::try_from(as_u64(x)?).map_err(|_| fail("GobTypeError", "byte overflow"))?);
        }
        return Ok(out);
    }
    Err(fail("GobTypeError", "expected bytes"))
}

mod hex {
    use super::*;
    pub fn decode_hex(s: &str) -> Result<Vec<u8>> {
        if s.len() % 2 != 0 {
            return Err(named("HexLengthError"));
        }
        let mut out = Vec::with_capacity(s.len() / 2);
        let b = s.as_bytes();
        let mut i = 0;
        while i < b.len() {
            let h = from_hex(b[i])?;
            let l = from_hex(b[i + 1])?;
            out.push((h << 4) | l);
            i += 2;
        }
        Ok(out)
    }
    fn from_hex(c: u8) -> Result<u8> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(fail("InvalidByteError", c)),
        }
    }
}

fn as_map_pairs(v: &Value) -> Result<Vec<(Value, Value)>> {
    if v.is_null() {
        return Ok(Vec::new());
    }
    if let Some(obj) = v.as_object() {
        if let Some(arr) = obj.get("$m").and_then(Value::as_array) {
            let mut out = Vec::new();
            for p in arr {
                let a = p.as_array().ok_or_else(|| fail("GobTypeError", "map pair"))?;
                if a.len() != 2 {
                    return Err(fail("GobTypeError", "map pair"));
                }
                out.push((a[0].clone(), a[1].clone()));
            }
            return Ok(out);
        }
        return Ok(obj.iter().map(|(k, v)| (Value::String(k.clone()), v.clone())).collect());
    }
    Err(fail("GobTypeError", "expected map"))
}

pub struct Dec {
    buf: Vec<u8>,
    pos: usize,
    msg: Vec<u8>,
    moff: usize,
    wire: HashMap<i32, Wire>,
    types_seen: Vec<String>,
    max_type_size: u64,
    registered: HashMap<String, GobType>,
}

impl Dec {
    pub fn new(max_type_size: u64) -> Self {
        Self {
            buf: Vec::new(),
            pos: 0,
            msg: Vec::new(),
            moff: 0,
            wire: HashMap::new(),
            types_seen: Vec::new(),
            max_type_size: if max_type_size == 0 { DEFAULT_MAX } else { max_type_size },
            registered: registry().lock().unwrap().clone(),
        }
    }

    pub fn reset(&mut self) {
        self.buf.clear();
        self.pos = 0;
        self.msg.clear();
        self.moff = 0;
        self.wire.clear();
        self.types_seen.clear();
        self.registered = registry().lock().unwrap().clone();
    }

    pub fn write(&mut self, chunk: &[u8]) {
        if self.pos > 0 {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
        self.buf.extend_from_slice(chunk);
    }

    fn rest(&self) -> &[u8] {
        &self.buf[self.pos..]
    }

    fn load_message(&mut self) -> Result<bool> {
        if self.rest().is_empty() {
            return Ok(false);
        }
        let mut r = R::new(self.rest());
        let n = match r.get_uint() {
            Ok(n) => n,
            Err(_) => return Ok(false),
        };
        if n >= self.max_type_size {
            return Err(fail("GobTypeError", "message too big"));
        }
        let n = n as usize;
        if r.remaining() < n {
            return Ok(false);
        }
        let header = r.pos;
        self.msg = self.rest()[header..header + n].to_vec();
        self.moff = 0;
        self.pos += header + n;
        Ok(true)
    }

    fn msg_remaining(&self) -> usize {
        self.msg.len().saturating_sub(self.moff)
    }

    fn msg_get_uint(&mut self) -> Result<u64> {
        let mut r = R::new(&self.msg[self.moff..]);
        let v = r.get_uint()?;
        self.moff += r.pos;
        Ok(v)
    }

    fn msg_get_int(&mut self) -> Result<i64> {
        let x = self.msg_get_uint()?;
        Ok(if x & 1 != 0 { !(x >> 1) as i64 } else { (x >> 1) as i64 })
    }

    fn msg_get_bytes(&mut self) -> Result<Vec<u8>> {
        let n = self.msg_get_uint()? as usize;
        if n > self.msg_remaining() {
            return Err(named("BufferTooShortError"));
        }
        let b = self.msg[self.moff..self.moff + n].to_vec();
        self.moff += n;
        Ok(b)
    }

    fn msg_get_string(&mut self) -> Result<String> {
        String::from_utf8(self.msg_get_bytes()?).map_err(|e| fail("GobTypeError", e))
    }

    fn decode_type_sequence(&mut self, is_interface: bool) -> Result<i32> {
        loop {
            if self.msg_remaining() == 0 && !self.load_message()? {
                return Err(named("BufferTooShortError"));
            }
            let id = self.msg_get_int()? as i32;
            if id >= 0 {
                return Ok(id);
            }
            if self.msg.len() as u64 > self.max_type_size {
                return Err(fail("GobTypeError", "type definition exceeds maxTypeSize"));
            }
            let rest = self.msg[self.moff..].to_vec();
            let n = self.recv_type(-id, &rest)?;
            self.moff += n;
            if self.msg_remaining() > 0 && is_interface {
                let _ = self.msg_get_uint()?;
            }
        }
    }

    fn recv_type(&mut self, id: i32, data: &[u8]) -> Result<usize> {
        if id < FIRST_USER_ID || self.wire.contains_key(&id) {
            return Err(fail("GobTypeError", "duplicate type received"));
        }
        let mut r = R::new(data);
        let wire = decode_wire(&mut r)?;
        let name = wire_name(&wire);
        self.types_seen.push(name);
        self.wire.insert(id, wire);
        Ok(r.pos)
    }

    pub fn read_type(&mut self) -> Result<Option<String>> {
        if let Some(n) = self.types_seen.pop() {
            return Ok(Some(n));
        }
        let saved_pos = self.pos;
        let saved_msg = self.msg.clone();
        let saved_off = self.moff;
        if self.msg_remaining() == 0 && !self.load_message()? {
            return Ok(None);
        }
        let id = self.msg_get_int()? as i32;
        if id >= 0 {
            self.pos = saved_pos;
            self.msg = saved_msg;
            self.moff = saved_off;
            return Ok(None);
        }
        let rest = self.msg[self.moff..].to_vec();
        self.recv_type(-id, &rest)?;
        Ok(self.types_seen.pop())
    }

    pub fn decode(&mut self, ty: &GobType) -> Result<String> {
        let id = self.decode_type_sequence(false)?;
        let val = self.decode_value(ty, id, true)?;
        serde_json::to_string(&val).map_err(|e| fail("GobTypeError", e))
    }

    fn decode_value(&mut self, ty: &GobType, remote: i32, top: bool) -> Result<Value> {
        self.check_compat(ty, remote)?;
        if matches!(ty, GobType::Struct { .. }) && !matches!(ty, GobType::GobEncoder { .. }) && builtin_id(ty).is_none()
        {
            return self.decode_struct(ty, remote);
        }
        if top {
            let delta = self.msg_get_uint()?;
            if delta != 0 {
                return Err(fail("GobTypeError", "non-zero delta for singleton"));
            }
        }
        self.decode_payload(ty, remote)
    }

    fn check_compat(&self, ty: &GobType, remote: i32) -> Result<()> {
        if let Some(id) = builtin_id(ty) {
            if remote != id && remote >= FIRST_USER_ID {
                if matches!(ty, GobType::GobEncoder { .. }) {
                    return Ok(());
                }
            }
            if remote < FIRST_USER_ID && remote != id {
                return Err(fail("GobTypeError", format!("type mismatch: local {} remote {remote}", type_key(ty))));
            }
            return Ok(());
        }
        if remote < FIRST_USER_ID {
            return Err(fail("GobTypeError", format!("type mismatch: local {} remote {remote}", type_key(ty))));
        }
        if !self.wire.contains_key(&remote) {
            return Err(fail("GobTypeError", format!("unknown type id {remote}")));
        }
        Ok(())
    }

    fn decode_struct(&mut self, ty: &GobType, remote: i32) -> Result<Value> {
        let GobType::Struct { fields, .. } = ty else {
            return Err(fail("GobTypeError", "expected struct"));
        };
        let wire_fields = match self.wire.get(&remote) {
            Some(Wire::Struct { fields, .. }) => fields.clone(),
            _ => fields.iter().enumerate().map(|(i, (n, _))| (n.clone(), self.local_id(&fields[i].1))).collect(),
        };
        let mut map = JsonMap::new();
        for (n, ft) in fields {
            map.insert(n.clone(), zero_value(ft));
        }
        let mut fieldnum = -1i32;
        loop {
            if self.msg_remaining() == 0 {
                break;
            }
            let delta = self.msg_get_uint()? as i32;
            if delta == 0 {
                break;
            }
            if delta < 0 {
                return Err(fail("GobTypeError", "negative delta"));
            }
            fieldnum += delta;
            if fieldnum as usize >= wire_fields.len() {
                return Err(fail("GobTypeError", "field number out of bounds"));
            }
            let (wname, wid) = &wire_fields[fieldnum as usize];
            if let Some((_, ft)) = fields.iter().find(|(n, _)| n == wname) {
                let v = if matches!(ft, GobType::Struct { .. }) {
                    self.decode_struct(ft, *wid)?
                } else {
                    self.decode_payload(ft, *wid)?
                };
                map.insert(wname.clone(), v);
            } else {
                let w = self.wire.get(wid).cloned();
                ignore_payload_msg(self, w.as_ref())?;
            }
        }
        Ok(Value::Object(map))
    }

    fn local_id(&self, t: &GobType) -> i32 {
        builtin_id(t).unwrap_or(0)
    }

    fn decode_payload(&mut self, ty: &GobType, remote: i32) -> Result<Value> {
        match ty {
            GobType::Bool => Ok(Value::Bool(self.msg_get_uint()? != 0)),
            GobType::Int | GobType::Int8 | GobType::Int16 | GobType::Int32 => {
                Ok(Value::Number(self.msg_get_int()?.into()))
            }
            GobType::Int64 => Ok(Value::String(self.msg_get_int()?.to_string())),
            GobType::Uint | GobType::Uint8 | GobType::Uint16 | GobType::Uint32 => {
                let n = self.msg_get_uint()?;
                if n <= i64::MAX as u64 {
                    Ok(Value::Number((n as i64).into()))
                } else {
                    Ok(Value::String(n.to_string()))
                }
            }
            GobType::Uint64 => Ok(Value::String(self.msg_get_uint()?.to_string())),
            GobType::Float32 | GobType::Float64 => {
                let f = from_float_bits(self.msg_get_uint()?);
                Ok(Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null))
            }
            GobType::Complex64 | GobType::Complex128 => {
                let re = from_float_bits(self.msg_get_uint()?);
                let im = from_float_bits(self.msg_get_uint()?);
                let mut o = JsonMap::new();
                if let Some(n) = Number::from_f64(re) {
                    o.insert("re".into(), Value::Number(n));
                }
                if let Some(n) = Number::from_f64(im) {
                    o.insert("im".into(), Value::Number(n));
                }
                Ok(Value::Object(o))
            }
            GobType::String => Ok(Value::String(self.msg_get_string()?)),
            GobType::Bytes | GobType::GobEncoder { .. } => {
                let b = self.msg_get_bytes()?;
                let mut o = JsonMap::new();
                o.insert("$b".into(), Value::String(to_hex(&b)));
                Ok(Value::Object(o))
            }
            GobType::Slice { elem } if matches!(**elem, GobType::Uint8) => {
                let b = self.msg_get_bytes()?;
                let mut o = JsonMap::new();
                o.insert("$b".into(), Value::String(to_hex(&b)));
                Ok(Value::Object(o))
            }
            GobType::Slice { elem } => {
                let n = self.msg_get_uint()? as usize;
                let mut arr = Vec::with_capacity(n);
                let eid = elem_remote(self, remote, elem);
                for _ in 0..n {
                    arr.push(self.decode_elem(elem, eid)?);
                }
                Ok(Value::Array(arr))
            }
            GobType::Array { elem, len } => {
                let n = self.msg_get_uint()? as i64;
                if n != *len {
                    return Err(fail("GobTypeError", "array length mismatch"));
                }
                let mut arr = Vec::with_capacity(n as usize);
                let eid = elem_remote(self, remote, elem);
                for _ in 0..n {
                    arr.push(self.decode_elem(elem, eid)?);
                }
                Ok(Value::Array(arr))
            }
            GobType::Map { key, elem } => {
                let n = self.msg_get_uint()? as usize;
                let (kid, vid) = map_remotes(self, remote, key, elem);
                let mut pairs = Vec::with_capacity(n);
                for _ in 0..n {
                    let k = self.decode_elem(key, kid)?;
                    let v = self.decode_elem(elem, vid)?;
                    pairs.push(Value::Array(vec![k, v]));
                }
                let mut o = JsonMap::new();
                o.insert("$m".into(), Value::Array(pairs));
                Ok(Value::Object(o))
            }
            GobType::Struct { .. } => self.decode_struct(ty, remote),
            GobType::Interface { .. } => self.decode_interface(),
        }
    }

    fn decode_elem(&mut self, ty: &GobType, remote: i32) -> Result<Value> {
        if matches!(ty, GobType::Struct { .. }) && builtin_id(ty).is_none() {
            return self.decode_struct(ty, remote);
        }
        self.decode_payload(ty, remote)
    }

    fn decode_interface(&mut self) -> Result<Value> {
        let name = self.msg_get_string()?;
        if name.is_empty() {
            return Ok(Value::Null);
        }
        let concrete = self
            .registered
            .get(&name)
            .cloned()
            .ok_or_else(|| fail("GobTypeError", format!("type not registered for interface: {name}")))?;
        let id = self.decode_type_sequence(true)?;
        let n = self.msg_get_uint()? as usize;
        if n > self.msg_remaining() {
            return Err(named("BufferTooShortError"));
        }
        let saved = std::mem::take(&mut self.msg);
        let saved_off = self.moff;
        self.msg = saved[saved_off..saved_off + n].to_vec();
        self.moff = 0;
        let v = self.decode_value(&concrete, id, true)?;
        let leftover_off = saved_off + n;
        self.msg = saved;
        self.moff = leftover_off;
        let mut o = JsonMap::new();
        o.insert("$i".into(), Value::String(name));
        o.insert("$v".into(), v);
        Ok(Value::Object(o))
    }
}

fn elem_remote(dec: &Dec, remote: i32, elem: &GobType) -> i32 {
    match dec.wire.get(&remote) {
        Some(Wire::Slice { elem, .. } | Wire::Array { elem, .. }) => *elem,
        _ => builtin_id(elem).unwrap_or(remote),
    }
}

fn map_remotes(dec: &Dec, remote: i32, key: &GobType, elem: &GobType) -> (i32, i32) {
    match dec.wire.get(&remote) {
        Some(Wire::Map { key, elem, .. }) => (*key, *elem),
        _ => (
            builtin_id(key).unwrap_or(0),
            builtin_id(elem).unwrap_or(0),
        ),
    }
}

fn zero_value(ty: &GobType) -> Value {
    match ty {
        GobType::Bool => Value::Bool(false),
        GobType::Int | GobType::Int8 | GobType::Int16 | GobType::Int32 => Value::Number(0.into()),
        GobType::Int64 | GobType::Uint64 => Value::String("0".into()),
        GobType::Uint | GobType::Uint8 | GobType::Uint16 | GobType::Uint32 => Value::Number(0.into()),
        GobType::Float32 | GobType::Float64 => Number::from_f64(0.0).map(Value::Number).unwrap_or(Value::Null),
        GobType::String => Value::String(String::new()),
        GobType::Bytes | GobType::GobEncoder { .. } => {
            let mut o = JsonMap::new();
            o.insert("$b".into(), Value::String(String::new()));
            Value::Object(o)
        }
        GobType::Slice { .. } | GobType::Array { .. } => Value::Array(vec![]),
        GobType::Map { .. } => {
            let mut o = JsonMap::new();
            o.insert("$m".into(), Value::Array(vec![]));
            Value::Object(o)
        }
        GobType::Struct { fields, .. } => {
            let mut m = JsonMap::new();
            for (n, t) in fields {
                m.insert(n.clone(), zero_value(t));
            }
            Value::Object(m)
        }
        GobType::Interface { .. } | GobType::Complex64 | GobType::Complex128 => Value::Null,
    }
}

fn ignore_payload_msg(dec: &mut Dec, wire: Option<&Wire>) -> Result<()> {
    match wire {
        Some(Wire::Struct { .. }) => loop {
            if dec.msg_remaining() == 0 {
                break;
            }
            let delta = dec.msg_get_uint()?;
            if delta == 0 {
                break;
            }
            let _ = dec.msg_get_uint()?;
        },
        _ => {
            let _ = dec.msg_get_uint()?;
        }
    }
    Ok(())
}

fn decode_wire(r: &mut R) -> Result<Wire> {
    let mut fieldnum = -1i32;
    let mut got: Option<Wire> = None;
    loop {
        if r.remaining() == 0 {
            break;
        }
        let delta = r.get_uint()? as i32;
        if delta == 0 {
            break;
        }
        fieldnum += delta;
        match fieldnum {
            0 => got = Some(decode_array_wire(r)?),
            1 => got = Some(decode_slice_wire(r)?),
            2 => got = Some(decode_struct_wire(r)?),
            3 => got = Some(decode_map_wire(r)?),
            4 | 5 | 6 => {
                let (name, id) = decode_common(r)?;
                got = Some(Wire::GobEnc { name, id });
            }
            _ => return Err(fail("GobTypeError", "unknown wireType field")),
        }
    }
    got.ok_or_else(|| fail("GobTypeError", "empty wireType"))
}

fn decode_common(r: &mut R) -> Result<(String, i32)> {
    let mut fieldnum = -1i32;
    let mut name = String::new();
    let mut id = 0i32;
    loop {
        if r.remaining() == 0 {
            break;
        }
        let delta = r.get_uint()? as i32;
        if delta == 0 {
            break;
        }
        fieldnum += delta;
        match fieldnum {
            0 => name = r.get_string()?,
            1 => id = r.get_int()? as i32,
            _ => return Err(fail("GobTypeError", "bad CommonType")),
        }
    }
    Ok((name, id))
}

fn decode_array_wire(r: &mut R) -> Result<Wire> {
    let mut fieldnum = -1i32;
    let mut name = String::new();
    let mut id = 0i32;
    let mut elem = 0i32;
    let mut len = 0i64;
    loop {
        if r.remaining() == 0 {
            break;
        }
        let delta = r.get_uint()? as i32;
        if delta == 0 {
            break;
        }
        fieldnum += delta;
        match fieldnum {
            0 => {
                let c = decode_common(r)?;
                name = c.0;
                id = c.1;
            }
            1 => elem = r.get_int()? as i32,
            2 => len = r.get_int()?,
            _ => return Err(fail("GobTypeError", "bad arrayType")),
        }
    }
    Ok(Wire::Array { name, id, elem, len })
}

fn decode_slice_wire(r: &mut R) -> Result<Wire> {
    let mut fieldnum = -1i32;
    let mut name = String::new();
    let mut id = 0i32;
    let mut elem = 0i32;
    loop {
        if r.remaining() == 0 {
            break;
        }
        let delta = r.get_uint()? as i32;
        if delta == 0 {
            break;
        }
        fieldnum += delta;
        match fieldnum {
            0 => {
                let c = decode_common(r)?;
                name = c.0;
                id = c.1;
            }
            1 => elem = r.get_int()? as i32,
            _ => return Err(fail("GobTypeError", "bad sliceType")),
        }
    }
    Ok(Wire::Slice { name, id, elem })
}

fn decode_map_wire(r: &mut R) -> Result<Wire> {
    let mut fieldnum = -1i32;
    let mut name = String::new();
    let mut id = 0i32;
    let mut key = 0i32;
    let mut elem = 0i32;
    loop {
        if r.remaining() == 0 {
            break;
        }
        let delta = r.get_uint()? as i32;
        if delta == 0 {
            break;
        }
        fieldnum += delta;
        match fieldnum {
            0 => {
                let c = decode_common(r)?;
                name = c.0;
                id = c.1;
            }
            1 => key = r.get_int()? as i32,
            2 => elem = r.get_int()? as i32,
            _ => return Err(fail("GobTypeError", "bad mapType")),
        }
    }
    Ok(Wire::Map { name, id, key, elem })
}

fn decode_struct_wire(r: &mut R) -> Result<Wire> {
    let mut fieldnum = -1i32;
    let mut name = String::new();
    let mut id = 0i32;
    let mut fields = Vec::new();
    loop {
        if r.remaining() == 0 {
            break;
        }
        let delta = r.get_uint()? as i32;
        if delta == 0 {
            break;
        }
        fieldnum += delta;
        match fieldnum {
            0 => {
                let c = decode_common(r)?;
                name = c.0;
                id = c.1;
            }
            1 => {
                let n = r.get_uint()? as usize;
                for _ in 0..n {
                    fields.push(decode_field_type(r)?);
                }
            }
            _ => return Err(fail("GobTypeError", "bad structType")),
        }
    }
    Ok(Wire::Struct { name, id, fields })
}

fn decode_field_type(r: &mut R) -> Result<(String, i32)> {
    let mut fieldnum = -1i32;
    let mut name = String::new();
    let mut id = 0i32;
    loop {
        if r.remaining() == 0 {
            break;
        }
        let delta = r.get_uint()? as i32;
        if delta == 0 {
            break;
        }
        fieldnum += delta;
        match fieldnum {
            0 => name = r.get_string()?,
            1 => id = r.get_int()? as i32,
            _ => return Err(fail("GobTypeError", "bad fieldType")),
        }
    }
    Ok((name, id))
}

fn wire_name(w: &Wire) -> String {
    match w {
        Wire::Array { name, .. }
        | Wire::Slice { name, .. }
        | Wire::Struct { name, .. }
        | Wire::Map { name, .. }
        | Wire::GobEnc { name, .. } => name.clone(),
    }
}

fn to_hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for &x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 0xf) as usize] as char);
    }
    s
}

#[napi]
pub struct NativeGobEncoder {
    inner: Enc,
}

#[napi]
impl NativeGobEncoder {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: Enc::default() }
    }

    #[napi]
    pub fn encode(&mut self, type_json: String, value_json: String) -> Result<Uint8Array> {
        let ty = parse_type_str(&type_json)?;
        let val: Value = serde_json::from_str(&value_json).map_err(|e| fail("GobTypeError", e))?;
        Ok(self.inner.encode(&ty, &val)?.into())
    }

    #[napi]
    pub fn reset(&mut self) {
        self.inner.reset();
    }
}

#[napi]
pub struct NativeGobDecoder {
    inner: Dec,
}

#[napi]
impl NativeGobDecoder {
    #[napi(constructor)]
    pub fn new(max_type_size: BigInt) -> Result<Self> {
        let max = if max_type_size.words.is_empty() {
            DEFAULT_MAX
        } else {
            let (_, v, lossless) = max_type_size.get_u64();
            if !lossless {
                return Err(fail("GobTypeError", "maxTypeSize exceeds uint64"));
            }
            if v == 0 { DEFAULT_MAX } else { v }
        };
        Ok(Self { inner: Dec::new(max) })
    }

    #[napi]
    pub fn write(&mut self, chunk: Uint8Array) {
        self.inner.write(chunk.as_ref());
    }

    #[napi]
    pub fn decode(&mut self, type_json: String) -> Result<String> {
        let ty = parse_type_str(&type_json)?;
        self.inner.decode(&ty)
    }

    #[napi]
    pub fn read_type(&mut self) -> Result<Option<String>> {
        self.inner.read_type()
    }

    #[napi]
    pub fn reset(&mut self) {
        self.inner.reset();
    }
}

#[napi]
pub fn gob_register_name_native(name: String, type_json: String) -> Result<()> {
    register_name(name, type_json)
}
