use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use object::{Object, ObjectSection, ObjectSymbol};

use crate::file::{bigint_to_u64, fail, format_err, go_name, u64_big, Shared};

const GO12_MAGIC: u32 = 0xffff_fffb;
const GO116_MAGIC: u32 = 0xffff_fffa;
const GO118_MAGIC: u32 = 0xffff_fff0;
const GO120_MAGIC: u32 = 0xffff_fff1;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Version {
    V12,
    V116,
    V118,
    V120,
}

struct Table {
    data: Vec<u8>,
    gofunc: Vec<u8>,
    version: Version,
    little: bool,
    quantum: u32,
    ptrsize: u32,
    text_start: u64,
    nfunctab: u32,
    #[allow(dead_code)]
    nfiletab: u32,
    funcnametab_off: usize,
    cutab_off: usize,
    filetab_off: usize,
    pctab_off: usize,
    funcdata_off: usize,
    functab: Vec<u8>,
}

const PCDATA_INL_TREE_INDEX: u32 = 2;
const FUNCDATA_INL_TREE: u8 = 3;
const INL_CALL_SIZE: usize = 16;

#[napi]
pub struct NativeGoSymTable {
    file: Arc<Shared>,
    table: Arc<Table>,
}

#[napi(object)]
pub struct JsFuncInfo {
    pub entry: BigInt,
    pub end: BigInt,
    pub name: String,
    pub package: String,
    pub receiver: String,
    pub base: String,
    #[napi(js_name = "static")]
    pub static_: bool,
}

#[napi(object)]
pub struct JsInlineFrame {
    pub file: String,
    pub line: u32,
    pub fn_name: String,
}

#[napi(object)]
pub struct JsPcToLine {
    pub file: String,
    pub line: u32,
    pub func: Option<JsFuncInfo>,
    pub inline_frames: Vec<JsInlineFrame>,
}

#[napi(object)]
pub struct JsSymInfo {
    pub name: String,
    pub addr: BigInt,
    pub kind: String,
    pub go_type: u32,
    pub go_version: u32,
}

fn need(data: &[u8], off: usize, n: usize) -> Result<&[u8]> {
    data.get(off..off.checked_add(n).ok_or_else(|| format_err("pclntab", off as u64, "overflow"))?)
        .ok_or_else(|| format_err("pclntab", off as u64, "truncated pclntab"))
}

fn u32_at(data: &[u8], off: usize, little: bool) -> Result<u32> {
    let b = need(data, off, 4)?;
    let arr = [b[0], b[1], b[2], b[3]];
    Ok(if little {
        u32::from_le_bytes(arr)
    } else {
        u32::from_be_bytes(arr)
    })
}

fn u64_at(data: &[u8], off: usize, little: bool) -> Result<u64> {
    let b = need(data, off, 8)?;
    let arr = [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]];
    Ok(if little {
        u64::from_le_bytes(arr)
    } else {
        u64::from_be_bytes(arr)
    })
}

fn uintptr_at(data: &[u8], off: usize, ptrsize: u32, little: bool) -> Result<u64> {
    if ptrsize == 4 {
        Ok(u64::from(u32_at(data, off, little)?))
    } else {
        u64_at(data, off, little)
    }
}

fn cstring(data: &[u8], off: usize) -> Result<String> {
    let slice = data
        .get(off..)
        .ok_or_else(|| format_err("pclntab", off as u64, "string out of range"))?;
    let end = slice.iter().position(|b| *b == 0).unwrap_or(slice.len());
    Ok(String::from_utf8_lossy(&slice[..end]).into_owned())
}

fn field_size(version: Version, ptrsize: u32) -> usize {
    if matches!(version, Version::V118 | Version::V120) {
        4
    } else {
        ptrsize as usize
    }
}

fn read_uint(buf: &[u8], sz: usize, little: bool) -> Result<u64> {
    if sz == 4 {
        u32_at(buf, 0, little).map(u64::from)
    } else {
        u64_at(buf, 0, little)
    }
}

impl Table {
    fn func_pc(&self, i: u32) -> Result<u64> {
        let sz = field_size(self.version, self.ptrsize);
        let off = 2 * i as usize * sz;
        let raw = read_uint(need(&self.functab, off, sz)?, sz, self.little)?;
        Ok(if matches!(self.version, Version::V118 | Version::V120) {
            raw.saturating_add(self.text_start)
        } else {
            raw
        })
    }

    fn func_off(&self, i: u32) -> Result<u64> {
        let sz = field_size(self.version, self.ptrsize);
        let off = (2 * i as usize + 1) * sz;
        read_uint(need(&self.functab, off, sz)?, sz, self.little)
    }

    fn func_bytes(&self, i: u32) -> Result<&[u8]> {
        let off = self.funcdata_off.saturating_add(self.func_off(i)? as usize);
        self.data
            .get(off..)
            .ok_or_else(|| format_err("pclntab", off as u64, "funcdata out of range"))
    }

    fn field(&self, func: &[u8], n: u32) -> Result<u32> {
        let sz0 = if matches!(self.version, Version::V118 | Version::V120) {
            4
        } else {
            self.ptrsize as usize
        };
        let off = sz0 + (n as usize - 1) * 4;
        u32_at(func, off, self.little)
    }

    fn entry_pc(&self, func: &[u8]) -> Result<u64> {
        if matches!(self.version, Version::V118 | Version::V120) {
            Ok(u64::from(u32_at(func, 0, self.little)?).saturating_add(self.text_start))
        } else {
            uintptr_at(func, 0, self.ptrsize, self.little)
        }
    }

    fn func_name(&self, func: &[u8]) -> Result<String> {
        let off = self.field(func, 1)? as usize;
        cstring(&self.data[self.funcnametab_off..], off)
    }

    fn find_func(&self, pc: u64) -> Result<Option<u32>> {
        if self.nfunctab == 0 {
            return Ok(None);
        }
        let first = self.func_pc(0)?;
        let last = self.func_pc(self.nfunctab)?;
        if pc < first || pc >= last {
            return Ok(None);
        }
        let mut lo = 0u32;
        let mut hi = self.nfunctab;
        while lo + 1 < hi {
            let mid = lo + (hi - lo) / 2;
            if self.func_pc(mid)? <= pc {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        Ok(Some(lo))
    }

    fn read_varint<'a>(&self, p: &mut &'a [u8]) -> Result<u32> {
        let mut v = 0u32;
        let mut shift = 0u32;
        loop {
            if p.is_empty() {
                return Err(format_err("pclntab", 0, "truncated varint"));
            }
            let b = p[0];
            *p = &p[1..];
            v |= u32::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return Ok(v);
            }
            shift += 7;
            if shift >= 32 {
                return Err(format_err("pclntab", 0, "varint overflow"));
            }
        }
    }

    fn step(&self, p: &mut &[u8], pc: &mut u64, val: &mut i32, first: bool) -> Result<bool> {
        let uvdelta = self.read_varint(p)?;
        if uvdelta == 0 && !first {
            return Ok(false);
        }
        let vdelta = if uvdelta & 1 != 0 {
            !((uvdelta >> 1) as i32)
        } else {
            (uvdelta >> 1) as i32
        };
        let pcdelta = u64::from(self.read_varint(p)?) * u64::from(self.quantum);
        *pc = pc.saturating_add(pcdelta);
        *val = val.wrapping_add(vdelta);
        Ok(true)
    }

    fn pcvalue(&self, off: u32, entry: u64, target: u64) -> Result<i32> {
        let mut p = self
            .data
            .get(self.pctab_off.saturating_add(off as usize)..)
            .ok_or_else(|| format_err("pclntab", off as u64, "pctab out of range"))?;
        let mut val = -1i32;
        let mut pc = entry;
        let mut first = true;
        while self.step(&mut p, &mut pc, &mut val, first)? {
            first = false;
            if target < pc {
                return Ok(val);
            }
        }
        Ok(-1)
    }

    fn file_name(&self, func: &[u8], fno: i32) -> Result<String> {
        if fno < 0 {
            return Ok(String::new());
        }
        match self.version {
            Version::V12 => {
                if fno == 0 {
                    return Ok(String::new());
                }
                let off = u32_at(&self.data[self.filetab_off..], 4 * fno as usize, self.little)?;
                cstring(&self.data[self.funcdata_off..], off as usize)
            }
            _ => {
                let cu = self.field(func, 8)?;
                if cu == u32::MAX {
                    return Ok(String::new());
                }
                let idx = (cu.saturating_add(fno as u32)) as usize * 4;
                let fnoff = u32_at(&self.data[self.cutab_off..], idx, self.little)?;
                if fnoff == u32::MAX {
                    return Ok(String::new());
                }
                cstring(&self.data[self.filetab_off..], fnoff as usize)
            }
        }
    }

    fn func_info(&self, i: u32) -> Result<JsFuncInfo> {
        let func = self.func_bytes(i)?;
        let name = self.func_name(func)?;
        let parsed = go_name(&name);
        Ok(JsFuncInfo {
            entry: u64_big(self.func_pc(i)?),
            end: u64_big(self.func_pc(i + 1)?),
            package: parsed.as_ref().map(|g| g.package.clone()).unwrap_or_default(),
            receiver: parsed.as_ref().map(|g| g.receiver.clone()).unwrap_or_default(),
            base: parsed
                .as_ref()
                .map(|g| g.base.clone())
                .unwrap_or_else(|| name.rsplit('.').next().unwrap_or(&name).to_string()),
            static_: parsed.map(|g| g.static_).unwrap_or(false),
            name,
        })
    }

    fn nfuncdata(&self, func: &[u8]) -> Result<u8> {
        let sz0 = if matches!(self.version, Version::V118 | Version::V120) {
            4
        } else {
            self.ptrsize as usize
        };
        let off = sz0 + 9 * 4 + 3;
        Ok(*func
            .get(off)
            .ok_or_else(|| format_err("pclntab", off as u64, "nfuncdata out of range"))?)
    }

    fn pcdata_start(&self, func: &[u8], table: u32) -> Result<Option<u32>> {
        let npc = self.field(func, 7)?;
        if table >= npc {
            return Ok(None);
        }
        let sz0 = if matches!(self.version, Version::V118 | Version::V120) {
            4
        } else {
            self.ptrsize as usize
        };
        let off = sz0 + 9 * 4 + 4 + table as usize * 4;
        let v = u32_at(func, off, self.little)?;
        if v == 0 {
            return Ok(None);
        }
        Ok(Some(v))
    }

    fn funcdata_off(&self, func: &[u8], i: u8) -> Result<Option<u32>> {
        let nfd = self.nfuncdata(func)?;
        if i >= nfd {
            return Ok(None);
        }
        let npc = self.field(func, 7)?;
        let sz0 = if matches!(self.version, Version::V118 | Version::V120) {
            4
        } else {
            self.ptrsize as usize
        };
        let off = sz0 + 9 * 4 + 4 + npc as usize * 4 + i as usize * 4;
        let v = u32_at(func, off, self.little)?;
        if v == u32::MAX {
            return Ok(None);
        }
        Ok(Some(v))
    }

    fn inline_frames(&self, func: &[u8], entry: u64, pc: u64) -> Result<Vec<JsInlineFrame>> {
        if self.gofunc.is_empty() {
            return Ok(Vec::new());
        }
        let Some(tree_off) = self.funcdata_off(func, FUNCDATA_INL_TREE)? else {
            return Ok(Vec::new());
        };
        let Some(pcdata_off) = self.pcdata_start(func, PCDATA_INL_TREE_INDEX)? else {
            return Ok(Vec::new());
        };
        let mut frames = Vec::new();
        let mut current = pc;
        for _ in 0..64 {
            let idx = self.pcvalue(pcdata_off, entry, current)?;
            if idx < 0 {
                break;
            }
            let base = (tree_off as usize).saturating_add(idx as usize * INL_CALL_SIZE);
            let call = match self.gofunc.get(base..base.saturating_add(INL_CALL_SIZE)) {
                Some(c) if c.len() == INL_CALL_SIZE => c,
                _ => break,
            };
            let name_off = u32_at(call, 4, self.little)? as usize;
            let parent_pc = i32::from_le_bytes(
                if self.little {
                    [call[8], call[9], call[10], call[11]]
                } else {
                    [call[11], call[10], call[9], call[8]]
                },
            );
            let name = cstring(&self.data[self.funcnametab_off..], name_off)?;
            let line = self.pcvalue(self.field(func, 6)?, entry, current)?;
            let fno = self.pcvalue(self.field(func, 5)?, entry, current)?;
            let file = self.file_name(func, fno)?;
            frames.push(JsInlineFrame {
                file,
                line: if line < 0 { 0 } else { line as u32 },
                fn_name: name,
            });
            if parent_pc < 0 {
                break;
            }
            current = entry.saturating_add(parent_pc as u64);
        }
        Ok(frames)
    }

    fn line_to_pc(&self, file: &str, line: i32) -> Result<u64> {
        for i in 0..self.nfunctab {
            let func = self.func_bytes(i)?;
            let entry = self.entry_pc(func)?;
            let filetab = self.field(func, 5)?;
            let linetab = self.field(func, 6)?;
            if filetab == 0 || linetab == 0 {
                continue;
            }
            let mut fp = self
                .data
                .get(self.pctab_off.saturating_add(filetab as usize)..)
                .unwrap_or(&[]);
            let mut fl = self
                .data
                .get(self.pctab_off.saturating_add(linetab as usize)..)
                .unwrap_or(&[]);
            let mut file_val = -1i32;
            let mut file_pc = entry;
            let mut line_val = -1i32;
            let mut line_pc = entry;
            let mut file_start = file_pc;
            let mut first_file = true;
            let mut first_line = true;
            while self.step(&mut fp, &mut file_pc, &mut file_val, first_file)? {
                first_file = false;
                let name = self.file_name(func, file_val).unwrap_or_default();
                if name == file && file_start < file_pc {
                    let mut line_start = line_pc;
                    while line_pc < file_pc && self.step(&mut fl, &mut line_pc, &mut line_val, first_line)? {
                        first_line = false;
                        if line_val == line {
                            if file_start <= line_start {
                                return Ok(line_start);
                            }
                            if file_start < line_pc {
                                return Ok(file_start);
                            }
                        }
                        line_start = line_pc;
                    }
                }
                file_start = file_pc;
            }
        }
        Ok(0)
    }
}

fn parse_table(data: Vec<u8>, text_start: u64) -> Result<Table> {
    if data.len() < 16 || data[4] != 0 || data[5] != 0 {
        return Err(fail("UnsupportedFeatureError", "unrecognized pclntab header"));
    }
    if data[6] != 1 && data[6] != 2 && data[6] != 4 {
        return Err(fail("UnsupportedFeatureError", "bad pclntab quantum"));
    }
    if data[7] != 4 && data[7] != 8 {
        return Err(fail("UnsupportedFeatureError", "bad pclntab ptrsize"));
    }
    let le = u32::from_le_bytes(data[0..4].try_into().unwrap());
    let be = u32::from_be_bytes(data[0..4].try_into().unwrap());
    let (little, version) = if le == GO120_MAGIC || be == GO120_MAGIC {
        (le == GO120_MAGIC, Version::V120)
    } else if le == GO118_MAGIC || be == GO118_MAGIC {
        (le == GO118_MAGIC, Version::V118)
    } else if le == GO116_MAGIC || be == GO116_MAGIC {
        (le == GO116_MAGIC, Version::V116)
    } else if le == GO12_MAGIC || be == GO12_MAGIC {
        (le == GO12_MAGIC, Version::V12)
    } else {
        return Err(fail("UnsupportedFeatureError", "unrecognized pclntab magic"));
    };
    let quantum = u32::from(data[6]);
    let ptrsize = u32::from(data[7]);
    let offset = |word: u32| -> Result<u64> {
        uintptr_at(&data, 8 + word as usize * ptrsize as usize, ptrsize, little)
    };
    let (nfunctab, nfiletab, funcnametab_off, cutab_off, filetab_off, pctab_off, funcdata_off) =
        match version {
            Version::V118 | Version::V120 => (
                offset(0)? as u32,
                offset(1)? as u32,
                offset(3)? as usize,
                offset(4)? as usize,
                offset(5)? as usize,
                offset(6)? as usize,
                offset(7)? as usize,
            ),
            Version::V116 => (
                offset(0)? as u32,
                offset(1)? as u32,
                offset(2)? as usize,
                offset(3)? as usize,
                offset(4)? as usize,
                offset(5)? as usize,
                offset(6)? as usize,
            ),
            Version::V12 => {
                let nfunctab = uintptr_at(&data, 8, ptrsize, little)? as u32;
                let functab_off = 8 + ptrsize as usize;
                let sz = field_size(version, ptrsize);
                let functabsize = (nfunctab as usize * 2 + 1) * sz;
                let fileoff = u32_at(&data, functab_off + functabsize, little)? as usize;
                let nfiletab = u32_at(&data, fileoff, little)?;
                (
                    nfunctab,
                    nfiletab,
                    0usize,
                    0usize,
                    fileoff,
                    0usize,
                    0usize,
                )
            }
        };
    let sz = field_size(version, ptrsize);
    let functabsize = (nfunctab as usize * 2 + 1) * sz;
    let functab = data
        .get(funcdata_off..funcdata_off.saturating_add(functabsize))
        .ok_or_else(|| format_err("pclntab", funcdata_off as u64, "functab truncated"))?
        .to_vec();
    Ok(Table {
        data,
        gofunc: Vec::new(),
        version,
        little,
        quantum,
        ptrsize,
        text_start,
        nfunctab,
        nfiletab,
        funcnametab_off,
        cutab_off,
        filetab_off,
        pctab_off,
        funcdata_off,
        functab,
    })
}

fn load_gofunc(obj: &object::File<'_>) -> Result<Vec<u8>> {
    for sym in obj.symbols() {
        let Ok(name) = sym.name() else {
            continue;
        };
        if name != "go:func.*" {
            continue;
        }
        let addr = sym.address();
        let size = sym.size();
        let section = match sym.section() {
            object::SymbolSection::Section(idx) => obj.section_by_index(idx).ok(),
            _ => None,
        };
        let Some(section) = section else {
            continue;
        };
        let data = section
            .data()
            .map_err(|e| format_err("gofunc", 0, e))?;
        let rel = addr.saturating_sub(section.address()) as usize;
        if rel > data.len() {
            continue;
        }
        let end = if size > 0 {
            rel.saturating_add(size as usize).min(data.len())
        } else {
            data.len()
        };
        return Ok(data.get(rel..end).unwrap_or(&[]).to_vec());
    }
    Ok(Vec::new())
}

fn load_pclntab(obj: &object::File<'_>) -> Result<Option<(Vec<u8>, u64, Vec<u8>)>> {
    let mut data = None;
    for name in [".gopclntab", "__gopclntab", ".pclntab", "runtime.pclntab"] {
        if let Some(section) = obj.section_by_name(name) {
            data = Some(
                section
                    .data()
                    .map_err(|e| format_err("pclntab", 0, e))?
                    .to_vec(),
            );
            break;
        }
    }
    if data.is_none() {
        for sym in obj.symbols() {
            if matches!(sym.name(), Ok("runtime.pclntab" | "pclntab")) {
                if let Some(idx) = match sym.section() {
                    object::SymbolSection::Section(i) => Some(i),
                    _ => None,
                } {
                    if let Ok(section) = obj.section_by_index(idx) {
                        data = Some(section.data().map_err(|e| format_err("pclntab", 0, e))?.to_vec());
                    }
                }
                break;
            }
        }
    }
    let Some(data) = data else {
        return Ok(None);
    };
    let gofunc = load_gofunc(obj)?;
    let mut text = 0u64;
    for sym in obj.symbols() {
        if matches!(sym.name(), Ok("runtime.text")) {
            text = sym.address();
            break;
        }
    }
    if text == 0 {
        if let Some(section) = obj.section_by_name(".text").or_else(|| obj.section_by_name("__text")) {
            text = section.address();
        }
    }
    Ok(Some((data, text, gofunc)))
}

pub fn open(file: Arc<Shared>) -> Result<Option<NativeGoSymTable>> {
    if file.closed() {
        return Err(fail("FileClosedError", "debugfmt: file is closed"));
    }
    file.with_bytes(|bytes| {
        if file.kind == crate::sniff::Kind::Plan9 {
            return Ok(None);
        }
        let obj = crate::file::parse_object(bytes)?;
        let Some((data, text, gofunc)) = load_pclntab(&obj)? else {
            return Ok(None);
        };
        let mut table = parse_table(data, text.saturating_add(file.base))?;
        table.gofunc = gofunc;
        Ok(Some(NativeGoSymTable {
            file: file.clone(),
            table: Arc::new(table),
        }))
    })
}

impl NativeGoSymTable {
    fn ensure_open(&self) -> Result<()> {
        if self.file.closed() {
            Err(fail("FileClosedError", "debugfmt: file is closed"))
        } else {
            Ok(())
        }
    }
}

#[napi]
impl NativeGoSymTable {
    #[napi]
    pub fn funcs(&self) -> Result<Vec<JsFuncInfo>> {
        self.ensure_open()?;
        let mut out = Vec::with_capacity(self.table.nfunctab as usize);
        for i in 0..self.table.nfunctab {
            out.push(self.table.func_info(i)?);
        }
        Ok(out)
    }

    #[napi]
    pub fn pc_to_func(&self, pc: BigInt) -> Result<Option<JsFuncInfo>> {
        self.ensure_open()?;
        let pc = bigint_to_u64(pc)?;
        match self.table.find_func(pc)? {
            Some(i) => Ok(Some(self.table.func_info(i)?)),
            None => Ok(None),
        }
    }

    #[napi]
    pub fn lookup_func(&self, name: String) -> Result<Option<JsFuncInfo>> {
        self.ensure_open()?;
        for i in 0..self.table.nfunctab {
            let info = self.table.func_info(i)?;
            if info.name == name {
                return Ok(Some(info));
            }
        }
        Ok(None)
    }

    #[napi]
    pub fn pc_to_line(&self, pc: BigInt) -> Result<JsPcToLine> {
        self.ensure_open()?;
        let pc = bigint_to_u64(pc)?;
        let Some(i) = self.table.find_func(pc)? else {
            return Ok(JsPcToLine {
                file: String::new(),
                line: 0,
                func: None,
                inline_frames: Vec::new(),
            });
        };
        let func = self.table.func_bytes(i)?;
        let entry = self.table.entry_pc(func)?;
        let line = self.table.pcvalue(self.table.field(func, 6)?, entry, pc)?;
        let fno = self.table.pcvalue(self.table.field(func, 5)?, entry, pc)?;
        let file = self.table.file_name(func, fno)?;
        let inline_frames = self.table.inline_frames(func, entry, pc)?;
        Ok(JsPcToLine {
            file,
            line: if line < 0 { 0 } else { line as u32 },
            func: Some(self.table.func_info(i)?),
            inline_frames,
        })
    }

    #[napi]
    pub fn line_to_pc(&self, file: String, line: u32) -> Result<BigInt> {
        self.ensure_open()?;
        Ok(u64_big(self.table.line_to_pc(&file, line as i32)?))
    }

    #[napi]
    pub fn lookup_sym(&self, name: String) -> Result<Option<JsSymInfo>> {
        match self.lookup_func(name)? {
            Some(f) => Ok(Some(JsSymInfo {
                name: f.name,
                addr: f.entry,
                kind: "text".into(),
                go_type: 0,
                go_version: match self.table.version {
                    Version::V12 => 12,
                    Version::V116 => 16,
                    Version::V118 => 18,
                    Version::V120 => 20,
                },
            })),
            None => Ok(None),
        }
    }

    #[napi]
    pub fn sym_by_addr(&self, addr: BigInt) -> Result<Option<JsSymInfo>> {
        match self.pc_to_func(addr)? {
            Some(f) => Ok(Some(JsSymInfo {
                name: f.name,
                addr: f.entry,
                kind: "text".into(),
                go_type: 0,
                go_version: match self.table.version {
                    Version::V12 => 12,
                    Version::V116 => 16,
                    Version::V118 => 18,
                    Version::V120 => 20,
                },
            })),
            None => Ok(None),
        }
    }
}
