use std::fs::File;
use std::sync::{Arc, Mutex};

use memmap2::Mmap;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use object::{
    Architecture, Endianness, Object, ObjectSection, ObjectSegment, ObjectSymbol, SectionFlags,
    SectionKind, SymbolKind, SymbolSection,
};

use crate::buildinfo;
use crate::dwarf::NativeDwarfReader;
use crate::gosym::NativeGoSymTable;
use crate::plan9;
use crate::sniff::{self, Kind};

const DEFAULT_MAX_SECTION: u64 = 256 * 1024 * 1024;

pub(crate) enum Source {
    Map(Mmap),
    Bytes(Vec<u8>),
}

pub(crate) struct Shared {
    pub(crate) kind: Kind,
    pub(crate) size: u64,
    pub(crate) is_fat: bool,
    pub(crate) selected_off: usize,
    pub(crate) selected_len: usize,
    pub(crate) max_section_bytes: u64,
    pub(crate) base: u64,
    source: Mutex<Option<Source>>,
}

impl Shared {
    pub(crate) fn with_bytes<T>(&self, f: impl FnOnce(&[u8]) -> Result<T>) -> Result<T> {
        let guard = self
            .source
            .lock()
            .map_err(|_| fail("FileClosedError", "debugfmt: file is closed"))?;
        let src = guard
            .as_ref()
            .ok_or_else(|| fail("FileClosedError", "debugfmt: file is closed"))?;
        let bytes = match src {
            Source::Map(m) => m.as_ref(),
            Source::Bytes(b) => b.as_slice(),
        };
        let end = self
            .selected_off
            .checked_add(self.selected_len)
            .ok_or_else(|| format_err("overflow", 0, "section range overflow"))?;
        if end > bytes.len() {
            return Err(format_err("truncated", 0, "selected slice exceeds file"));
        }
        f(&bytes[self.selected_off..end])
    }

    pub(crate) fn closed(&self) -> bool {
        self.source
            .lock()
            .map(|g| g.is_none())
            .unwrap_or(true)
    }
}

#[napi]
pub struct NativeBinaryFile {
    inner: Arc<Shared>,
}

#[napi(object)]
pub struct JsSection {
    pub name: String,
    #[napi(js_name = "type")]
    pub type_name: String,
    pub flags: Vec<String>,
    pub addr: BigInt,
    pub offset: BigInt,
    pub size: BigInt,
    pub link: u32,
    pub info: u32,
    pub addralign: BigInt,
    pub entsize: BigInt,
    pub compressed: bool,
}

#[napi(object)]
pub struct JsSegment {
    pub name: String,
    #[napi(js_name = "type")]
    pub type_name: String,
    pub offset: BigInt,
    pub vaddr: BigInt,
    pub paddr: BigInt,
    pub filesz: BigInt,
    pub memsz: BigInt,
    pub prot: Vec<String>,
    pub align: BigInt,
}

#[napi(object)]
pub struct JsGoName {
    pub package: String,
    pub receiver: String,
    pub base: String,
    #[napi(js_name = "static")]
    pub static_: bool,
}

#[napi(object)]
pub struct JsSymbol {
    pub name: String,
    pub value: BigInt,
    pub size: BigInt,
    pub section: Option<String>,
    pub kind: String,
    pub global: bool,
    pub external: bool,
    pub version: Option<String>,
    pub library: Option<String>,
    pub go: Option<JsGoName>,
}

#[napi(object)]
pub struct JsModule {
    pub path: String,
    pub version: String,
    pub sum: String,
    pub replace_path: Option<String>,
    pub replace_version: Option<String>,
    pub replace_sum: Option<String>,
}

#[napi(object)]
pub struct JsBuildSetting {
    pub key: String,
    pub value: String,
}

#[napi(object)]
pub struct JsBuildInfo {
    pub go_version: String,
    pub path: String,
    pub main: JsModule,
    pub deps: Vec<JsModule>,
    pub settings: Vec<JsBuildSetting>,
}

#[napi(object)]
pub struct JsElfHeader {
    pub class: u32,
    pub data: String,
    pub osabi: String,
    pub abi_version: u32,
    pub machine: String,
    #[napi(js_name = "type")]
    pub type_name: String,
    pub entry: BigInt,
    pub version: u32,
    pub flags: u32,
}

#[napi(object)]
pub struct JsProg {
    #[napi(js_name = "type")]
    pub type_name: String,
    pub flags: Vec<String>,
    pub off: BigInt,
    pub vaddr: BigInt,
    pub paddr: BigInt,
    pub filesz: BigInt,
    pub memsz: BigInt,
    pub align: BigInt,
}

#[napi(object)]
pub struct JsMachHeader {
    pub magic: String,
    pub cpu: String,
    pub file_type: String,
    pub ncmds: u32,
    pub flags: u32,
}

#[napi(object)]
pub struct JsDylib {
    pub path: String,
    pub compat_version: String,
    pub current_version: String,
}

#[napi(object)]
pub struct JsCoffHeader {
    pub machine: String,
    pub number_of_sections: u32,
    pub time_date_stamp: u32,
    pub characteristics: u32,
}

pub(crate) fn fail(code: &str, message: impl ToString) -> Error {
    Error::new(Status::GenericFailure, format!("{code}: {}", message.to_string()))
}

pub(crate) fn format_err(kind: &str, offset: u64, message: impl ToString) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("BinaryFormatError:{kind}:{offset}:{}", message.to_string()),
    )
}

pub(crate) fn u64_big(v: u64) -> BigInt {
    BigInt::from(v)
}

fn native_arch() -> Architecture {
    if cfg!(target_arch = "x86_64") {
        Architecture::X86_64
    } else if cfg!(target_arch = "aarch64") {
        Architecture::Aarch64
    } else if cfg!(target_arch = "x86") {
        Architecture::I386
    } else {
        Architecture::Unknown
    }
}

fn arch_name(arch: Architecture) -> String {
    match arch {
        Architecture::X86_64 | Architecture::X86_64_X32 => "amd64".into(),
        Architecture::Aarch64 | Architecture::Aarch64_Ilp32 => "arm64".into(),
        Architecture::I386 => "386".into(),
        Architecture::Arm => "arm".into(),
        Architecture::S390x => "s390x".into(),
        Architecture::PowerPc64 => "ppc64".into(),
        Architecture::PowerPc => "ppc".into(),
        Architecture::Mips | Architecture::Mips64 => "mips".into(),
        Architecture::Riscv64 => "riscv64".into(),
        Architecture::LoongArch64 => "loong64".into(),
        other => format!("{other:?}"),
    }
}

fn select_slice(data: &[u8]) -> Result<(usize, usize, bool, Kind)> {
    let kind = sniff::sniff(data).ok_or_else(|| format_err("magic", 0, "unrecognized binary format"))?;
    if kind == Kind::Macho && sniff::is_macho_fat(data) {
        if let Ok((off, len)) = fat_slice(data) {
            return Ok((off, len, true, Kind::Macho));
        }
        return Err(fail(
            "UnsupportedFeatureError",
            "fat Mach-O has no slice for this process architecture",
        ));
    }
    Ok((0, data.len(), false, kind))
}

fn fat_slice(data: &[u8]) -> std::result::Result<(usize, usize), ()> {
    use object::read::macho::{FatArch, MachOFatFile32, MachOFatFile64};
    let native = native_arch();
    let pick = |offset: u64, size: u64, architecture: Architecture| -> Option<(usize, usize)> {
        if architecture != native {
            return None;
        }
        let off = usize::try_from(offset).ok()?;
        let len = usize::try_from(size).ok()?;
        off.checked_add(len).filter(|end| *end <= data.len())?;
        Some((off, len))
    };
    if let Ok(fat) = MachOFatFile32::parse(data) {
        for arch in fat.arches() {
            if let Some(s) = pick(u64::from(arch.offset()), u64::from(arch.size()), arch.architecture()) {
                return Ok(s);
            }
        }
    }
    if let Ok(fat) = MachOFatFile64::parse(data) {
        for arch in fat.arches() {
            if let Some(s) = pick(arch.offset(), arch.size(), arch.architecture()) {
                return Ok(s);
            }
        }
    }
    Err(())
}

fn open_shared(source: Source, size: u64, max_section_bytes: u64, base: u64) -> Result<NativeBinaryFile> {
    let preview = match &source {
        Source::Map(m) => m.get(..16).unwrap_or(&m[..]).to_vec(),
        Source::Bytes(b) => b.get(..16).unwrap_or(b).to_vec(),
    };
    let _ = sniff::sniff(&preview).ok_or_else(|| format_err("magic", 0, "unrecognized binary format"))?;
    let (selected_off, selected_len, is_fat, kind) = match &source {
        Source::Map(m) => select_slice(m)?,
        Source::Bytes(b) => select_slice(b)?,
    };
    {
        let bytes = match &source {
            Source::Map(m) => m.as_ref(),
            Source::Bytes(b) => b.as_slice(),
        };
        let end = selected_off
            .checked_add(selected_len)
            .ok_or_else(|| format_err("overflow", 0, "section range overflow"))?;
        if end > bytes.len() {
            return Err(format_err("truncated", 0, "selected slice exceeds file"));
        }
        let slice = &bytes[selected_off..end];
        match kind {
            Kind::Plan9 => {
                plan9::parse(slice).map_err(|e| format_err("plan9", 0, e))?;
            }
            _ => {
                parse_object(slice)?;
            }
        }
    }
    Ok(NativeBinaryFile {
        inner: Arc::new(Shared {
            kind,
            size,
            is_fat,
            selected_off,
            selected_len,
            max_section_bytes,
            base,
            source: Mutex::new(Some(source)),
        }),
    })
}

#[napi]
pub fn native_sniff(head: Uint8Array) -> Option<String> {
    sniff::sniff(head.as_ref()).map(|k| k.as_str().to_string())
}

#[napi]
pub fn native_open(
    path: String,
    max_section_bytes: Option<BigInt>,
    base: Option<BigInt>,
) -> Result<NativeBinaryFile> {
    let file = File::open(&path).map_err(|e| format_err("io", 0, e))?;
    let size = file
        .metadata()
        .map_err(|e| format_err("io", 0, e))?
        .len();
    let mmap = unsafe { Mmap::map(&file) }.map_err(|e| format_err("mmap", 0, e))?;
    drop(file);
    open_shared(
        Source::Map(mmap),
        size,
        bigint_u64(max_section_bytes, DEFAULT_MAX_SECTION)?,
        bigint_u64(base, 0)?,
    )
}

#[napi]
pub fn native_open_bytes(
    buf: Uint8Array,
    max_section_bytes: Option<BigInt>,
    base: Option<BigInt>,
) -> Result<NativeBinaryFile> {
    let bytes = buf.to_vec();
    let size = bytes.len() as u64;
    open_shared(
        Source::Bytes(bytes),
        size,
        bigint_u64(max_section_bytes, DEFAULT_MAX_SECTION)?,
        bigint_u64(base, 0)?,
    )
}

pub(crate) fn bigint_to_u64(value: BigInt) -> Result<u64> {
    bigint_u64(Some(value), 0)
}

fn bigint_u64(value: Option<BigInt>, default: u64) -> Result<u64> {
    match value {
        None => Ok(default),
        Some(v) => {
            if v.sign_bit {
                return Err(fail("BinaryFormatError", "negative bigint"));
            }
            if v.words.len() > 1 {
                return Err(fail("BinaryFormatError", "bigint exceeds u64"));
            }
            Ok(v.words.first().copied().unwrap_or(0))
        }
    }
}

#[napi]
impl NativeBinaryFile {
    #[napi(getter)]
    pub fn kind(&self) -> String {
        self.inner.kind.as_str().into()
    }

    #[napi(getter)]
    pub fn size(&self) -> BigInt {
        u64_big(self.inner.size)
    }

    #[napi(getter)]
    pub fn is_fat(&self) -> bool {
        self.inner.is_fat
    }

    #[napi(getter)]
    pub fn closed(&self) -> bool {
        self.inner.closed()
    }

    #[napi]
    pub fn close(&self) {
        if let Ok(mut g) = self.inner.source.lock() {
            *g = None;
        }
    }

    #[napi]
    pub fn arch(&self) -> Result<String> {
        self.inner.with_bytes(|bytes| match self.inner.kind {
            Kind::Plan9 => {
                let f = plan9::parse(bytes).map_err(|e| format_err("plan9", 0, e))?;
                Ok(match f.ptr_size {
                    8 => "amd64".into(),
                    _ => "386".into(),
                })
            }
            _ => {
                let file = parse_object(bytes)?;
                Ok(arch_name(file.architecture()))
            }
        })
    }

    #[napi]
    pub fn endian(&self) -> Result<String> {
        self.inner.with_bytes(|bytes| match self.inner.kind {
            Kind::Plan9 => Ok("big".into()),
            _ => {
                let file = parse_object(bytes)?;
                Ok(match file.endianness() {
                    Endianness::Little => "little".into(),
                    Endianness::Big => "big".into(),
                })
            }
        })
    }

    #[napi]
    pub fn entry_point(&self) -> Result<BigInt> {
        let base = self.inner.base;
        self.inner.with_bytes(|bytes| match self.inner.kind {
            Kind::Plan9 => {
                let f = plan9::parse(bytes).map_err(|e| format_err("plan9", 0, e))?;
                Ok(u64_big(f.entry.saturating_add(base)))
            }
            _ => {
                let file = parse_object(bytes)?;
                Ok(u64_big(file.entry().saturating_add(base)))
            }
        })
    }

    #[napi]
    pub fn sections(&self) -> Result<Vec<JsSection>> {
        let base = self.inner.base;
        self.inner.with_bytes(|bytes| match self.inner.kind {
            Kind::Plan9 => {
                let f = plan9::parse(bytes).map_err(|e| format_err("plan9", 0, e))?;
                Ok(f.sections
                    .into_iter()
                    .map(|s| JsSection {
                        name: s.name,
                        type_name: "SHT_PROGBITS".into(),
                        flags: Vec::new(),
                        addr: u64_big(s.offset.saturating_add(base)),
                        offset: u64_big(s.offset),
                        size: u64_big(s.size),
                        link: 0,
                        info: 0,
                        addralign: u64_big(1),
                        entsize: u64_big(0),
                        compressed: false,
                    })
                    .collect())
            }
            _ => {
                let file = parse_object(bytes)?;
                Ok(file.sections().map(|s| section_info(&s, base)).collect())
            }
        })
    }

    #[napi]
    pub fn section(&self, name: String) -> Result<Option<JsSection>> {
        Ok(self.sections()?.into_iter().find(|s| s.name == name))
    }

    #[napi]
    pub fn segments(&self) -> Result<Vec<JsSegment>> {
        let base = self.inner.base;
        self.inner.with_bytes(|bytes| {
            if self.inner.kind == Kind::Plan9 {
                return Ok(Vec::new());
            }
            let file = parse_object(bytes)?;
            Ok(file
                .segments()
                .map(|seg| {
                    let (offset, filesz) = seg.file_range();
                    JsSegment {
                        name: seg.name().ok().flatten().unwrap_or("").to_string(),
                        type_name: "PT_LOAD".into(),
                        offset: u64_big(offset),
                        vaddr: u64_big(seg.address().saturating_add(base)),
                        paddr: u64_big(seg.address().saturating_add(base)),
                        filesz: u64_big(filesz),
                        memsz: u64_big(seg.size()),
                        prot: prot_from_flags(&seg),
                        align: u64_big(seg.align()),
                    }
                })
                .collect())
        })
    }

    #[napi]
    pub fn symbols(&self) -> Result<Vec<JsSymbol>> {
        let base = self.inner.base;
        self.inner.with_bytes(|bytes| match self.inner.kind {
            Kind::Plan9 => {
                let f = plan9::parse(bytes).map_err(|e| format_err("plan9", 0, e))?;
                Ok(f.symbols
                    .into_iter()
                    .map(|s| {
                        let kind = plan9_kind(s.kind);
                        JsSymbol {
                            go: go_name_with_static(&s.name, s.kind.is_ascii_lowercase()),
                            name: s.name,
                            value: u64_big(s.value.saturating_add(base)),
                            size: u64_big(0),
                            section: None,
                            kind,
                            global: true,
                            external: false,
                            version: None,
                            library: None,
                        }
                    })
                    .collect())
            }
            _ => {
                let file = parse_object(bytes)?;
                let mut out = Vec::new();
                for sym in file.symbols() {
                    out.push(map_symbol(&file, &sym, base)?);
                }
                Ok(out)
            }
        })
    }

    #[napi]
    pub fn dynamic_symbols(&self) -> Result<Vec<JsSymbol>> {
        let base = self.inner.base;
        self.inner.with_bytes(|bytes| {
            if self.inner.kind == Kind::Plan9 {
                return Ok(Vec::new());
            }
            let file = parse_object(bytes)?;
            let mut out = Vec::new();
            for sym in file.dynamic_symbols() {
                out.push(map_symbol(&file, &sym, base)?);
            }
            Ok(out)
        })
    }

    #[napi]
    pub fn imported_symbols(&self) -> Result<Vec<String>> {
        self.inner.with_bytes(|bytes| {
            if self.inner.kind == Kind::Plan9 {
                return Ok(Vec::new());
            }
            let file = parse_object(bytes)?;
            let imports = file.imports().map_err(|e| format_err("import", 0, e))?;
            Ok(imports
                .iter()
                .map(|i| String::from_utf8_lossy(i.name()).into_owned())
                .collect())
        })
    }

    #[napi]
    pub fn imported_libraries(&self) -> Result<Vec<String>> {
        self.inner.with_bytes(|bytes| {
            if self.inner.kind == Kind::Plan9 {
                return Ok(Vec::new());
            }
            let file = parse_object(bytes)?;
            let imports = file.imports().map_err(|e| format_err("import", 0, e))?;
            let mut libs = Vec::new();
            for i in imports {
                let lib = String::from_utf8_lossy(i.library()).into_owned();
                if !lib.is_empty() && !libs.contains(&lib) {
                    libs.push(lib);
                }
            }
            Ok(libs)
        })
    }

    #[napi]
    pub fn dynamic_strings(&self) -> Result<Vec<String>> {
        self.imported_libraries()
    }

    #[napi]
    pub fn dynamic_value(&self, tag: String) -> Result<Option<BigInt>> {
        let _ = tag;
        Ok(None)
    }

    #[napi]
    pub fn dwarf(&self) -> Result<Option<NativeDwarfReader>> {
        crate::dwarf::open(self.inner.clone())
    }

    #[napi]
    pub fn gosym(&self) -> Result<Option<NativeGoSymTable>> {
        crate::gosym::open(self.inner.clone())
    }

    #[napi]
    pub fn has_debug_info(&self) -> Result<bool> {
        Ok(self.sections()?.iter().any(|s| {
            s.name.starts_with(".debug_")
                || s.name.starts_with(".zdebug_")
                || s.name.starts_with("__debug_")
                || s.name == "__debug_info"
        }))
    }

    #[napi]
    pub fn section_data(&self, name: String) -> Result<Uint8Array> {
        let max = self.inner.max_section_bytes;
        self.inner.with_bytes(|bytes| {
            if self.inner.kind == Kind::Plan9 {
                let f = plan9::parse(bytes).map_err(|e| format_err("plan9", 0, e))?;
                let s = f
                    .sections
                    .iter()
                    .find(|s| s.name == name)
                    .ok_or_else(|| format_err("section", 0, "section not found"))?;
                if s.size > max {
                    return Err(fail(
                        "BlockedRegionError",
                        format!("section {} size {} exceeds maxSectionBytes", name, s.size),
                    ));
                }
                let start = s.offset as usize;
                let end = start
                    .checked_add(s.size as usize)
                    .ok_or_else(|| format_err("overflow", s.offset, "section overflow"))?;
                if end > bytes.len() {
                    return Err(format_err("truncated", s.offset, "section exceeds file"));
                }
                return Ok(bytes[start..end].to_vec().into());
            }
            let file = parse_object(bytes)?;
            let section = file
                .section_by_name(&name)
                .ok_or_else(|| format_err("section", 0, "section not found"))?;
            if section.size() > max {
                return Err(fail(
                    "BlockedRegionError",
                    format!(
                        "section {} size {} exceeds maxSectionBytes",
                        name,
                        section.size()
                    ),
                ));
            }
            if is_compressed(&section) {
                return Err(fail(
                    "UnsupportedFeatureError",
                    format!("compressed section {name} (rustd-compress not wired in this slice)"),
                ));
            }
            let data = section
                .data()
                .map_err(|e| format_err("section", section.file_range().map(|r| r.0).unwrap_or(0), e))?;
            Ok(data.to_vec().into())
        })
    }

    #[napi]
    pub fn build_info(&self) -> Result<Option<JsBuildInfo>> {
        self.inner.with_bytes(|bytes| {
            let blob = buildinfo_bytes(bytes, self.inner.kind);
            Ok(blob.and_then(|b| buildinfo::parse_blob(&b)).map(to_js_buildinfo))
        })
    }

    #[napi]
    pub fn elf_header(&self) -> Result<JsElfHeader> {
        self.inner.with_bytes(|bytes| {
            let file = parse_object(bytes)?;
            if !matches!(file.format(), object::BinaryFormat::Elf) {
                return Err(format_err("kind", 0, "not ELF"));
            }
            Ok(JsElfHeader {
                class: if file.is_64() { 64 } else { 32 },
                data: match file.endianness() {
                    Endianness::Little => "little".into(),
                    Endianness::Big => "big".into(),
                },
                osabi: "ELFOSABI_NONE".into(),
                abi_version: 0,
                machine: arch_name(file.architecture()),
                type_name: match file.kind() {
                    object::ObjectKind::Executable => "ET_EXEC".into(),
                    object::ObjectKind::Dynamic => "ET_DYN".into(),
                    object::ObjectKind::Relocatable => "ET_REL".into(),
                    object::ObjectKind::Core => "ET_CORE".into(),
                    _ => "ET_NONE".into(),
                },
                entry: u64_big(file.entry().saturating_add(self.inner.base)),
                version: 1,
                flags: 0,
            })
        })
    }

    #[napi]
    pub fn elf_prog_headers(&self) -> Result<Vec<JsProg>> {
        Ok(self
            .segments()?
            .into_iter()
            .map(|s| JsProg {
                type_name: s.type_name,
                flags: s.prot,
                off: s.offset,
                vaddr: s.vaddr,
                paddr: s.paddr,
                filesz: s.filesz,
                memsz: s.memsz,
                align: s.align,
            })
            .collect())
    }

    #[napi]
    pub fn macho_header(&self) -> Result<JsMachHeader> {
        self.inner.with_bytes(|bytes| {
            let file = parse_object(bytes)?;
            if !matches!(file.format(), object::BinaryFormat::MachO) {
                return Err(format_err("kind", 0, "not Mach-O"));
            }
            Ok(JsMachHeader {
                magic: if file.is_64() {
                    "Magic64".into()
                } else {
                    "Magic32".into()
                },
                cpu: arch_name(file.architecture()),
                file_type: format!("{:?}", file.kind()),
                ncmds: file.segments().count() as u32,
                flags: 0,
            })
        })
    }

    #[napi]
    pub fn macho_dylibs(&self) -> Result<Vec<JsDylib>> {
        Ok(self
            .imported_libraries()?
            .into_iter()
            .map(|path| JsDylib {
                path,
                compat_version: "0.0.0".into(),
                current_version: "0.0.0".into(),
            })
            .collect())
    }

    #[napi]
    pub fn coff_header(&self) -> Result<JsCoffHeader> {
        self.inner.with_bytes(|bytes| {
            let file = parse_object(bytes)?;
            if !matches!(file.format(), object::BinaryFormat::Pe | object::BinaryFormat::Coff) {
                return Err(format_err("kind", 0, "not PE"));
            }
            Ok(JsCoffHeader {
                machine: arch_name(file.architecture()),
                number_of_sections: file.sections().count() as u32,
                time_date_stamp: 0,
                characteristics: 0,
            })
        })
    }
}

pub(crate) fn parse_object(bytes: &[u8]) -> Result<object::File<'_>> {
    object::File::parse(bytes).map_err(|e| format_err("object", 0, e))
}

fn section_info(section: &object::Section<'_, '_>, base: u64) -> JsSection {
    let (offset, _) = section.file_range().unwrap_or((0, 0));
    JsSection {
        name: section.name().unwrap_or("").to_string(),
        type_name: sht_name(section.kind()),
        flags: shf_flags(section.flags()),
        addr: u64_big(section.address().saturating_add(base)),
        offset: u64_big(offset),
        size: u64_big(section.size()),
        link: 0,
        info: 0,
        addralign: u64_big(section.align()),
        entsize: u64_big(0),
        compressed: is_compressed(section),
    }
}

pub(crate) fn is_compressed(section: &object::Section<'_, '_>) -> bool {
    if section.name().map(|n| n.starts_with(".zdebug_")).unwrap_or(false) {
        return true;
    }
    match section.flags() {
        SectionFlags::Elf { sh_flags } => sh_flags & 0x800 != 0,
        _ => false,
    }
}

fn sht_name(kind: SectionKind) -> String {
    match kind {
        SectionKind::Text | SectionKind::Data | SectionKind::ReadOnlyData | SectionKind::Debug => {
            "SHT_PROGBITS".into()
        }
        SectionKind::UninitializedData | SectionKind::UninitializedTls | SectionKind::Common => {
            "SHT_NOBITS".into()
        }
        SectionKind::Note => "SHT_NOTE".into(),
        SectionKind::Tls => "SHT_PROGBITS".into(),
        SectionKind::Metadata => "SHT_NULL".into(),
        SectionKind::Elf(object::elf::SHT_SYMTAB) => "SHT_SYMTAB".into(),
        SectionKind::Elf(object::elf::SHT_DYNSYM) => "SHT_DYNSYM".into(),
        SectionKind::Elf(object::elf::SHT_STRTAB) => "SHT_STRTAB".into(),
        SectionKind::Elf(object::elf::SHT_DYNAMIC) => "SHT_DYNAMIC".into(),
        SectionKind::Elf(object::elf::SHT_RELA) => "SHT_RELA".into(),
        SectionKind::Elf(object::elf::SHT_REL) => "SHT_REL".into(),
        SectionKind::Elf(object::elf::SHT_HASH) => "SHT_HASH".into(),
        SectionKind::Elf(n) => format!("SHT_{n}"),
        other => format!("{other:?}"),
    }
}

fn shf_flags(flags: SectionFlags) -> Vec<String> {
    match flags {
        SectionFlags::Elf { sh_flags } => {
            let mut out = Vec::new();
            if sh_flags & 0x1 != 0 {
                out.push("SHF_WRITE".into());
            }
            if sh_flags & 0x2 != 0 {
                out.push("SHF_ALLOC".into());
            }
            if sh_flags & 0x4 != 0 {
                out.push("SHF_EXECINSTR".into());
            }
            if sh_flags & 0x10 != 0 {
                out.push("SHF_MERGE".into());
            }
            if sh_flags & 0x20 != 0 {
                out.push("SHF_STRINGS".into());
            }
            if sh_flags & 0x400 != 0 {
                out.push("SHF_TLS".into());
            }
            if sh_flags & 0x800 != 0 {
                out.push("SHF_COMPRESSED".into());
            }
            out
        }
        _ => Vec::new(),
    }
}

fn prot_from_flags(seg: &object::Segment<'_, '_>) -> Vec<String> {
    let mut prot = Vec::new();
    let flags = format!("{:?}", seg.flags());
    if flags.contains("READ") || flags.contains("R") {
        prot.push("read".into());
    }
    if flags.contains("WRITE") || flags.contains("W") {
        prot.push("write".into());
    }
    if flags.contains("EXECUTE") || flags.contains("X") {
        prot.push("execute".into());
    }
    if prot.is_empty() {
        prot.push("read".into());
    }
    prot
}

fn map_symbol(file: &object::File<'_>, sym: &object::Symbol<'_, '_>, base: u64) -> Result<JsSymbol> {
    let name = match sym.name() {
        Ok(n) => n.to_string(),
        Err(_) => String::from_utf8_lossy(sym.name_bytes().unwrap_or(b"")).into_owned(),
    };
    let section = match sym.section() {
        SymbolSection::Section(index) => file
            .section_by_index(index)
            .ok()
            .and_then(|s| s.name().ok().map(str::to_string)),
        _ => None,
    };
    let kind = symbol_kind(file, sym);
    Ok(JsSymbol {
        go: go_name_with_static(&name, !sym.is_global() && !sym.is_undefined()),
        name,
        value: u64_big(sym.address().saturating_add(base)),
        size: u64_big(sym.size()),
        section,
        kind,
        global: sym.is_global(),
        external: sym.is_undefined(),
        version: None,
        library: None,
    })
}

fn symbol_kind(file: &object::File<'_>, sym: &object::Symbol<'_, '_>) -> String {
    if sym.is_undefined() {
        return "undefined".into();
    }
    if sym.is_common() {
        return "bss".into();
    }
    // STT_FILE / SHN_ABS: go tool nm emits `_` (`?` lowercased). Issue #18 maps F to `file`.
    if sym.kind() == SymbolKind::File {
        return "file".into();
    }
    if let SymbolSection::Section(index) = sym.section() {
        if let Ok(section) = file.section_by_index(index) {
            if let SectionFlags::Elf { sh_flags } = section.flags() {
                return elf_nm_kind(sh_flags);
            }
            return match section.kind() {
                SectionKind::Text => "text".into(),
                SectionKind::ReadOnlyData | SectionKind::ReadOnlyString => "rodata".into(),
                SectionKind::UninitializedData | SectionKind::Common => "bss".into(),
                _ => fallback_symbol_kind(sym),
            };
        }
    }
    fallback_symbol_kind(sym)
}

/// Match `cmd/internal/objfile` ELF codes: ALLOC|EXEC→T, ALLOC→R, ALLOC|WRITE→D.
/// `.bss` is SHF_ALLOC|SHF_WRITE, so go tool nm reports `D`/`d`, not `B`.
fn elf_nm_kind(sh_flags: u64) -> String {
    let write = sh_flags & 0x1 != 0;
    let alloc = sh_flags & 0x2 != 0;
    let exec = sh_flags & 0x4 != 0;
    if alloc && exec {
        return "text".into();
    }
    if alloc && !write {
        return "rodata".into();
    }
    if alloc && write {
        return "data".into();
    }
    "unknown".into()
}

fn fallback_symbol_kind(sym: &object::Symbol<'_, '_>) -> String {
    match sym.kind() {
        SymbolKind::Text => "text".into(),
        SymbolKind::File => "file".into(),
        SymbolKind::Section => "section".into(),
        SymbolKind::Data | SymbolKind::Tls => "data".into(),
        SymbolKind::Unknown | SymbolKind::Label => "unknown".into(),
        _ => "unknown".into(),
    }
}

fn plan9_kind(t: u8) -> String {
    match t as char {
        'T' | 't' => "text".into(),
        'D' | 'd' => "data".into(),
        'B' | 'b' => "bss".into(),
        'R' | 'r' => "rodata".into(),
        'U' | 'u' => "undefined".into(),
        'f' | 'F' => "file".into(),
        _ => "unknown".into(),
    }
}

/// Strip the outermost `[...]` instantiation, matching `debug/gosym.Sym.nameWithoutInst`.
fn name_without_inst(name: &str) -> String {
    let Some(start) = name.find('[') else {
        return name.to_string();
    };
    let Some(end) = name.rfind(']') else {
        return name.to_string();
    };
    if end < start {
        return name.to_string();
    }
    let mut out = String::with_capacity(name.len() - (end - start + 1));
    out.push_str(&name[..start]);
    out.push_str(&name[end + 1..]);
    out
}

fn go_package_name(name: &str) -> String {
    let stripped = name_without_inst(name);
    // Go 1.20+ compiler-generated symbols (issue #18 §4.4 / debug/gosym).
    if stripped.starts_with("go:") || stripped.starts_with("type:") {
        return String::new();
    }
    let pathend = stripped.rfind('/').unwrap_or(0);
    match stripped[pathend..].find('.') {
        Some(i) => stripped[..pathend + i].to_string(),
        None => String::new(),
    }
}

fn go_receiver_name(name: &str) -> String {
    let stripped = name_without_inst(name);
    let pathend = stripped.rfind('/').unwrap_or(0);
    let Some(l) = stripped[pathend..].find('.') else {
        return String::new();
    };
    let Some(r) = stripped[pathend..].rfind('.') else {
        return String::new();
    };
    if l == r {
        return String::new();
    }
    let Some(r_orig) = name.get(pathend..).and_then(|s| s.rfind('.')) else {
        return String::new();
    };
    name[pathend + l + 1..pathend + r_orig].to_string()
}

fn go_base_name(name: &str) -> String {
    let stripped = name_without_inst(name);
    let Some(mut i) = stripped.rfind('.') else {
        return name.to_string();
    };
    if name != stripped {
        if let Some(brack) = name.find('[') {
            if i > brack {
                if let Some(j) = name.rfind('.') {
                    i = j;
                }
            }
        }
    }
    name[i + 1..].to_string()
}

/// Split a Go symbol the way `debug/gosym.Sym` does (issue #18 §4.4).
/// `static_` is nm's lowercase type letter (`Type >= 'a'`), not the name itself.
pub(crate) fn go_name(name: &str) -> Option<JsGoName> {
    go_name_with_static(name, false)
}

pub(crate) fn go_name_with_static(name: &str, static_: bool) -> Option<JsGoName> {
    if name.is_empty() {
        return None;
    }
    if name.contains("@@") {
        return None;
    }
    if !name.contains('.') && !name.contains('/') {
        return None;
    }
    Some(JsGoName {
        package: go_package_name(name),
        receiver: go_receiver_name(name),
        base: go_base_name(name),
        static_,
    })
}

fn to_js_buildinfo(info: buildinfo::BuildInfo) -> JsBuildInfo {
    fn module(m: buildinfo::Module) -> JsModule {
        let (replace_path, replace_version, replace_sum) = match m.replace {
            Some(r) => (Some(r.path.clone()), Some(r.version.clone()), Some(r.sum.clone())),
            None => (None, None, None),
        };
        JsModule {
            path: m.path,
            version: m.version,
            sum: m.sum,
            replace_path,
            replace_version,
            replace_sum,
        }
    }
    JsBuildInfo {
        go_version: info.go_version,
        path: info.path,
        main: module(info.main),
        deps: info.deps.into_iter().map(module).collect(),
        settings: info
            .settings
            .into_iter()
            .map(|(key, value)| JsBuildSetting { key, value })
            .collect(),
    }
}

fn buildinfo_bytes(bytes: &[u8], kind: Kind) -> Option<Vec<u8>> {
    if kind == Kind::Plan9 {
        return Some(bytes.to_vec());
    }
    let file = object::File::parse(bytes).ok()?;
    if let Some(section) = file
        .section_by_name(".go.buildinfo")
        .or_else(|| file.section_by_name("__go_buildinfo"))
    {
        return section.data().ok().map(|d| d.to_vec());
    }
    // Fallback: search the whole mapped image (needed for PE / unnamed blobs).
    Some(bytes.to_vec())
}

#[napi]
pub fn native_read_buildinfo_bytes(buf: Uint8Array) -> Result<JsBuildInfo> {
    let bytes = buf.to_vec();
    let kind = sniff::sniff(&bytes).ok_or_else(|| format_err("magic", 0, "unrecognized binary format"))?;
    let blob = buildinfo_bytes(&bytes, kind).unwrap_or(bytes);
    buildinfo::parse_blob(&blob)
        .map(to_js_buildinfo)
        .ok_or_else(|| fail("BinaryFormatError", "not a Go executable"))
}
