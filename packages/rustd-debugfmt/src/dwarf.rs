use std::collections::HashSet;
use std::sync::Arc;

use gimli::{
    AttributeValue, DwarfSections, EndianSlice, Endianity, RunTimeEndian, SectionId, Unit,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use object::{Object, ObjectSection};

use crate::file::{bigint_to_u64, fail, format_err, is_compressed, u64_big, Shared};

type Slice<'a> = EndianSlice<'a, RunTimeEndian>;

/// Cap on DW_AT_specification / abstract_origin / type ref chains (issue #18 §3/§4.7).
const MAX_SPEC_DEPTH: u32 = 32;

struct OwnedDwarf {
    sections: DwarfSections<Vec<u8>>,
    endian: RunTimeEndian,
    version: u16,
    address_size: u8,
}

#[napi]
pub struct NativeDwarfReader {
    file: Arc<Shared>,
    dwarf: Arc<OwnedDwarf>,
}

#[napi(object)]
pub struct JsDwarfAttr {
    pub attr: String,
    pub class: String,
    pub kind: String,
    pub value_u64: Option<BigInt>,
    pub value_i64: Option<BigInt>,
    pub value_str: Option<String>,
    pub value_buf: Option<Uint8Array>,
    pub value_bool: Option<bool>,
    pub value_f64: Option<f64>,
}

#[napi(object)]
pub struct JsDwarfEntry {
    pub tag: String,
    pub tag_value: u32,
    pub offset: BigInt,
    pub children: bool,
    pub attrs: Vec<JsDwarfAttr>,
}

#[napi(object)]
pub struct JsLineEntry {
    pub address: BigInt,
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub is_stmt: bool,
    pub end_sequence: bool,
    pub prologue_end: bool,
    pub epilogue_begin: bool,
    pub discriminator: u32,
}

#[napi(object)]
pub struct JsRange {
    pub low: BigInt,
    pub high: BigInt,
}

#[napi(object)]
pub struct JsTypeInfo {
    pub kind: String,
    pub name: String,
    pub byte_size: Option<BigInt>,
    pub go_kind: Option<String>,
}

fn dwarf_err(e: gimli::Error) -> Error {
    format_err("dwarf", 0, e)
}

fn dw_name(prefix: &str, value: u16, static_name: Option<&str>) -> String {
    match static_name {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => format!("{prefix}_{value}"),
    }
}

fn load_section(file: &object::File<'_>, id: SectionId, max: u64) -> Result<Vec<u8>> {
    let elf = id.name();
    let macho = format!("__{}", elf.trim_start_matches('.'));
    let zdebug = format!(".z{}", elf.trim_start_matches('.'));
    let section = file
        .section_by_name(elf)
        .or_else(|| file.section_by_name(&macho));
    if let Some(section) = section {
        return section_bytes(&section, file.is_64(), file.endianness(), max);
    }
    if let Some(section) = file.section_by_name(&zdebug) {
        return section_bytes(&section, file.is_64(), file.endianness(), max);
    }
    Ok(Vec::new())
}

fn section_bytes(
    section: &object::Section<'_, '_>,
    is_64: bool,
    endian: object::Endianness,
    max: u64,
) -> Result<Vec<u8>> {
    let raw = section
        .data()
        .map_err(|e| format_err("dwarf", 0, e))?;
    let gnu_zdebug = section
        .name()
        .map(|n| n.starts_with(".zdebug_"))
        .unwrap_or(false);
    if is_compressed(section) || gnu_zdebug {
        return decompress_debug(raw, is_64, endian, max, gnu_zdebug);
    }
    if section.size() > max {
        return Err(fail(
            "BlockedRegionError",
            format!("debug section exceeds maxSectionBytes"),
        ));
    }
    Ok(raw.to_vec())
}

fn u32_endian(b: [u8; 4], endian: object::Endianness) -> u32 {
    match endian {
        object::Endianness::Little => u32::from_le_bytes(b),
        object::Endianness::Big => u32::from_be_bytes(b),
    }
}

fn u64_endian(b: [u8; 8], endian: object::Endianness) -> u64 {
    match endian {
        object::Endianness::Little => u64::from_le_bytes(b),
        object::Endianness::Big => u64::from_be_bytes(b),
    }
}

fn decompress_debug(
    raw: &[u8],
    is_64: bool,
    endian: object::Endianness,
    max: u64,
    gnu_zdebug: bool,
) -> Result<Vec<u8>> {
    if gnu_zdebug {
        if raw.len() < 12 || !raw.starts_with(b"ZLIB") {
            return Err(format_err("compressed", 0, "truncated zdebug header"));
        }
        let size = u64::from_be_bytes(raw[4..12].try_into().unwrap());
        return inflate_declared(&raw[12..], size, max);
    }
    let (ch_type, ch_size, header) = if is_64 {
        if raw.len() < 24 {
            return Err(format_err("compressed", 0, "truncated ELF compression header"));
        }
        let ch_type = u32_endian(raw[0..4].try_into().unwrap(), endian);
        let ch_size = u64_endian(raw[8..16].try_into().unwrap(), endian);
        (ch_type, ch_size, 24usize)
    } else {
        if raw.len() < 12 {
            return Err(format_err("compressed", 0, "truncated ELF compression header"));
        }
        let ch_type = u32_endian(raw[0..4].try_into().unwrap(), endian);
        let ch_size = u64::from(u32_endian(raw[4..8].try_into().unwrap(), endian));
        (ch_type, ch_size, 12usize)
    };
    match ch_type {
        1 => inflate_declared(&raw[header..], ch_size, max),
        2 => Err(fail("UnsupportedFeatureError", "zstd compressed DWARF")),
        other => Err(fail(
            "UnsupportedFeatureError",
            format!("ELFCOMPRESS type {other}"),
        )),
    }
}

fn size_mismatch(got: Option<u64>, declared: u64) -> Error {
    match got {
        Some(got) => format_err(
            "compressed",
            0,
            format!("uncompressed size {got} != declared {declared}"),
        ),
        None => format_err(
            "compressed",
            0,
            format!("uncompressed size exceeds declared {declared}"),
        ),
    }
}

fn inflate_declared(src: &[u8], expected: u64, max: u64) -> Result<Vec<u8>> {
    if expected > max {
        return Err(fail(
            "BlockedRegionError",
            "uncompressed debug section exceeds maxSectionBytes",
        ));
    }
    let limit = match usize::try_from(expected.max(1)) {
        Ok(n) => n,
        Err(_) => {
            return Err(fail(
                "BlockedRegionError",
                "uncompressed debug section exceeds maxSectionBytes",
            ))
        }
    };
    match miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(src, limit) {
        Ok(out) => {
            if out.len() as u64 != expected {
                return Err(size_mismatch(Some(out.len() as u64), expected));
            }
            Ok(out)
        }
        Err(e) if e.status == miniz_oxide::inflate::TINFLStatus::HasMoreOutput => {
            Err(size_mismatch(None, expected))
        }
        Err(e) => Err(format_err("dwarf", 0, format!("zlib: {e:?}"))),
    }
}

fn slice_to_string(slice: Slice<'_>) -> String {
    String::from_utf8_lossy(slice.slice()).into_owned()
}

fn attr_to_string(dwarf: &gimli::Dwarf<Slice<'_>>, attr: AttributeValue<Slice<'_>>) -> Option<String> {
    match attr {
        AttributeValue::String(s) => Some(slice_to_string(s)),
        AttributeValue::DebugStrRef(off) => dwarf.debug_str.get_str(off).ok().map(slice_to_string),
        AttributeValue::DebugLineStrRef(off) => dwarf.debug_line_str.get_str(off).ok().map(slice_to_string),
        _ => None,
    }
}

fn convert_attr(
    dwarf: &gimli::Dwarf<Slice<'_>>,
    unit: &Unit<Slice<'_>>,
    attr: gimli::Attribute<Slice<'_>>,
) -> Result<JsDwarfAttr> {
    let name = dw_name("DW_AT", attr.name().0, attr.name().static_string());
    let value = attr.value();
    if let Ok(Some(addr)) = dwarf.attr_address(unit, value.clone()) {
        return Ok(JsDwarfAttr {
            attr: name,
            class: "ClassAddr".into(),
            kind: "addr".into(),
            value_u64: Some(u64_big(addr)),
            value_i64: None,
            value_str: None,
            value_buf: None,
            value_bool: None,
            value_f64: None,
        });
    }
    if let Ok(s) = dwarf.attr_string(unit, value.clone()) {
        return Ok(JsDwarfAttr {
            attr: name,
            class: "ClassString".into(),
            kind: "str".into(),
            value_u64: None,
            value_i64: None,
            value_str: Some(slice_to_string(s)),
            value_buf: None,
            value_bool: None,
            value_f64: None,
        });
    }
    match value {
        AttributeValue::Flag(b) => Ok(JsDwarfAttr {
            attr: name,
            class: "ClassFlag".into(),
            kind: "flag".into(),
            value_u64: None,
            value_i64: None,
            value_str: None,
            value_buf: None,
            value_bool: Some(b),
            value_f64: None,
        }),
        AttributeValue::Block(block) => Ok(JsDwarfAttr {
            attr: name,
            class: "ClassBlock".into(),
            kind: "block".into(),
            value_u64: None,
            value_i64: None,
            value_str: None,
            value_buf: Some(Uint8Array::from(block.slice().to_vec())),
            value_bool: None,
            value_f64: None,
        }),
        AttributeValue::Exprloc(expr) => Ok(JsDwarfAttr {
            attr: name,
            class: "ClassExprLoc".into(),
            kind: "block".into(),
            value_u64: None,
            value_i64: None,
            value_str: None,
            value_buf: Some(Uint8Array::from(expr.0.slice().to_vec())),
            value_bool: None,
            value_f64: None,
        }),
        AttributeValue::UnitRef(offset) => Ok(JsDwarfAttr {
            attr: name,
            class: "ClassReference".into(),
            kind: "ref".into(),
            value_u64: Some(u64_big(offset.0 as u64)),
            value_i64: None,
            value_str: None,
            value_buf: None,
            value_bool: None,
            value_f64: None,
        }),
        AttributeValue::DebugInfoRef(offset) => Ok(JsDwarfAttr {
            attr: name,
            class: "ClassReference".into(),
            kind: "ref".into(),
            value_u64: Some(u64_big(offset.0 as u64)),
            value_i64: None,
            value_str: None,
            value_buf: None,
            value_bool: None,
            value_f64: None,
        }),
        AttributeValue::Sdata(v) => Ok(JsDwarfAttr {
            attr: name,
            class: "ClassConstant".into(),
            kind: "i64".into(),
            value_u64: None,
            value_i64: Some(BigInt {
                sign_bit: v < 0,
                words: vec![v.unsigned_abs()],
            }),
            value_str: None,
            value_buf: None,
            value_bool: None,
            value_f64: None,
        }),
        other => {
            let class = match other {
                AttributeValue::DebugLineRef(_) => "ClassLinePtr",
                AttributeValue::LocationListsRef(_) => "ClassLocListPtr",
                AttributeValue::RangeListsRef(_) => "ClassRangeListPtr",
                AttributeValue::SecOffset(_) => match name.as_str() {
                    "DW_AT_stmt_list" => "ClassLinePtr",
                    "DW_AT_ranges" => "ClassRangeListPtr",
                    "DW_AT_location" | "DW_AT_string_length" | "DW_AT_return_addr"
                    | "DW_AT_data_member_location" | "DW_AT_frame_base"
                    | "DW_AT_segment" | "DW_AT_static_link" | "DW_AT_use_location"
                    | "DW_AT_vtable_elem_location" => "ClassLocListPtr",
                    _ => "ClassConstant",
                },
                _ => "ClassConstant",
            };
            let n = attr
                .udata_value()
                .or_else(|| attr.offset_value().map(|o| o as u64))
                .or_else(|| match other {
                    AttributeValue::DebugLineRef(v) => Some(v.0 as u64),
                    AttributeValue::LocationListsRef(v) => Some(v.0 as u64),
                    AttributeValue::RangeListsRef(v) => Some(v.0 as u64),
                    AttributeValue::DebugMacinfoRef(v) => Some(v.0 as u64),
                    AttributeValue::DebugMacroRef(v) => Some(v.0 as u64),
                    AttributeValue::DebugAddrIndex(v) => Some(v.0 as u64),
                    AttributeValue::DebugLocListsIndex(v) => Some(v.0 as u64),
                    AttributeValue::DebugRngListsIndex(v) => Some(v.0 as u64),
                    AttributeValue::DebugStrOffsetsIndex(v) => Some(v.0 as u64),
                    AttributeValue::Language(v) => Some(u64::from(v.0)),
                    AttributeValue::Encoding(v) => Some(u64::from(v.0)),
                    AttributeValue::Inline(v) => Some(u64::from(v.0)),
                    AttributeValue::CallingConvention(v) => Some(u64::from(v.0)),
                    AttributeValue::Virtuality(v) => Some(u64::from(v.0)),
                    AttributeValue::Accessibility(v) => Some(u64::from(v.0)),
                    AttributeValue::Visibility(v) => Some(u64::from(v.0)),
                    AttributeValue::IdentifierCase(v) => Some(u64::from(v.0)),
                    AttributeValue::DecimalSign(v) => Some(u64::from(v.0)),
                    AttributeValue::Endianity(v) => Some(u64::from(v.0)),
                    AttributeValue::Ordering(v) => Some(u64::from(v.0)),
                    AttributeValue::AddressClass(v) => Some(u64::from(v.0)),
                    AttributeValue::FileIndex(v) => Some(v),
                    _ => None,
                })
                .unwrap_or(0);
            Ok(JsDwarfAttr {
                attr: name,
                class: class.into(),
                kind: "u64".into(),
                value_u64: Some(u64_big(n)),
                value_i64: None,
                value_str: None,
                value_buf: None,
                value_bool: None,
                value_f64: None,
            })
        }
    }
}

fn unit_section_offset(unit: &Unit<Slice<'_>>) -> u64 {
    match unit.header.offset() {
        gimli::UnitSectionOffset::DebugInfoOffset(o) => o.0 as u64,
        gimli::UnitSectionOffset::DebugTypesOffset(o) => o.0 as u64,
    }
}

fn entry_offset(unit: &Unit<Slice<'_>>, entry: &gimli::DebuggingInformationEntry<Slice<'_>>) -> u64 {
    unit_section_offset(unit).saturating_add(entry.offset().0 as u64)
}

fn attr_die_offset(unit: &Unit<Slice<'_>>, value: AttributeValue<Slice<'_>>) -> Option<u64> {
    match value {
        AttributeValue::UnitRef(offset) => {
            Some(unit_section_offset(unit).saturating_add(offset.0 as u64))
        }
        AttributeValue::DebugInfoRef(offset) => Some(offset.0 as u64),
        _ => None,
    }
}

fn type_kind(tag: gimli::DwTag) -> Option<&'static str> {
    match tag {
        gimli::DW_TAG_base_type => Some("basic"),
        gimli::DW_TAG_structure_type => Some("struct"),
        gimli::DW_TAG_union_type => Some("union"),
        gimli::DW_TAG_enumeration_type => Some("enum"),
        gimli::DW_TAG_array_type => Some("array"),
        gimli::DW_TAG_pointer_type => Some("ptr"),
        gimli::DW_TAG_typedef => Some("typedef"),
        gimli::DW_TAG_subroutine_type => Some("func"),
        _ => None,
    }
}

fn type_info_from_die(
    dwarf: &gimli::Dwarf<Slice<'_>>,
    unit: &Unit<Slice<'_>>,
    entry: &gimli::DebuggingInformationEntry<Slice<'_>>,
) -> JsTypeInfo {
    let kind = type_kind(entry.tag()).unwrap_or("unsupported");
    let name = entry
        .attr_value(gimli::DW_AT_name)
        .ok()
        .flatten()
        .and_then(|v| dwarf.attr_string(unit, v).ok())
        .map(slice_to_string)
        .unwrap_or_default();
    let byte_size = entry
        .attr_value(gimli::DW_AT_byte_size)
        .ok()
        .flatten()
        .and_then(|v| v.udata_value())
        .map(u64_big);
    JsTypeInfo {
        kind: kind.into(),
        name,
        byte_size,
        go_kind: None,
    }
}

fn first_ref(
    unit: &Unit<Slice<'_>>,
    entry: &gimli::DebuggingInformationEntry<Slice<'_>>,
    attr: gimli::DwAt,
) -> Result<Option<u64>> {
    Ok(entry
        .attr_value(attr)
        .map_err(dwarf_err)?
        .and_then(|value| attr_die_offset(unit, value)))
}

fn convert_entry(
    dwarf: &gimli::Dwarf<Slice<'_>>,
    unit: &Unit<Slice<'_>>,
    entry: &gimli::DebuggingInformationEntry<Slice<'_>>,
) -> Result<JsDwarfEntry> {
    let mut attrs = Vec::new();
    let mut iter = entry.attrs();
    while let Some(attr) = iter.next().map_err(dwarf_err)? {
        attrs.push(convert_attr(dwarf, unit, attr)?);
    }
    Ok(JsDwarfEntry {
        tag: dw_name("DW_TAG", entry.tag().0, entry.tag().static_string()),
        tag_value: u32::from(entry.tag().0),
        offset: u64_big(entry_offset(unit, entry)),
        children: entry.has_children(),
        attrs,
    })
}

fn with_dwarf<T>(owned: &OwnedDwarf, f: impl FnOnce(&gimli::Dwarf<Slice<'_>>) -> Result<T>) -> Result<T> {
    let dwarf = owned
        .sections
        .borrow(|section| EndianSlice::new(section, owned.endian));
    f(&dwarf)
}

fn walk_entries(
    dwarf: &gimli::Dwarf<Slice<'_>>,
    mut visit: impl FnMut(&Unit<Slice<'_>>, &gimli::DebuggingInformationEntry<Slice<'_>>) -> Result<bool>,
) -> Result<()> {
    let mut units = dwarf.units();
    while let Some(header) = units.next().map_err(dwarf_err)? {
        if header.version() > 5 {
            return Err(fail(
                "UnsupportedFeatureError",
                format!("DWARF {}", header.version()),
            ));
        }
        let unit = dwarf.unit(header).map_err(dwarf_err)?;
        let mut entries = unit.entries();
        while let Some((_, entry)) = entries.next_dfs().map_err(dwarf_err)? {
            if !visit(&unit, entry)? {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn high_pc(dwarf: &gimli::Dwarf<Slice<'_>>, unit: &Unit<Slice<'_>>, entry: &gimli::DebuggingInformationEntry<Slice<'_>>, low: u64) -> Result<Option<u64>> {
    let Some(value) = entry.attr_value(gimli::DW_AT_high_pc).map_err(dwarf_err)? else {
        return Ok(None);
    };
    if let Ok(Some(addr)) = dwarf.attr_address(unit, value.clone()) {
        return Ok(Some(addr));
    }
    Ok(value.udata_value().map(|len| low.saturating_add(len)))
}

fn file_path(
    dwarf: &gimli::Dwarf<Slice<'_>>,
    header: &gimli::LineProgramHeader<Slice<'_>>,
    file_index: u64,
) -> String {
    let Some(file) = header.file(file_index) else {
        return String::new();
    };
    let mut path = String::new();
    if let Some(dir) = file.directory(header) {
        if let Some(dir) = attr_to_string(dwarf, dir) {
            path.push_str(&dir);
            if !path.is_empty() && !path.ends_with('/') {
                path.push('/');
            }
        }
    }
    if let Some(name) = attr_to_string(dwarf, file.path_name()) {
        path.push_str(&name);
    }
    path
}

pub fn open(file: Arc<Shared>) -> Result<Option<NativeDwarfReader>> {
    if file.closed() {
        return Err(fail("FileClosedError", "debugfmt: file is closed"));
    }
    file.with_bytes(|bytes| {
        if file.kind == crate::sniff::Kind::Plan9 {
            return Ok(None);
        }
        let obj = crate::file::parse_object(bytes)?;
        let endian = match obj.endianness() {
            object::Endianness::Little => RunTimeEndian::Little,
            object::Endianness::Big => RunTimeEndian::Big,
        };
        let sections = DwarfSections::load(|id| load_section(&obj, id, file.max_section_bytes))?;
        let (version, address_size) = {
            let dwarf = sections.borrow(|section| EndianSlice::new(section, endian));
            let header = match dwarf.units().next().map_err(dwarf_err)? {
                Some(h) => h,
                None => return Ok(None),
            };
            if !(2..=5).contains(&header.version()) {
                return Err(fail(
                    "UnsupportedFeatureError",
                    format!("DWARF {}", header.version()),
                ));
            }
            (header.version(), header.encoding().address_size)
        };
        Ok(Some(NativeDwarfReader {
            file: file.clone(),
            dwarf: Arc::new(OwnedDwarf {
                sections,
                endian,
                version,
                address_size,
            }),
        }))
    })
}

impl NativeDwarfReader {
    fn ensure_open(&self) -> Result<()> {
        if self.file.closed() {
            Err(fail("FileClosedError", "debugfmt: file is closed"))
        } else {
            Ok(())
        }
    }
}

#[napi]
impl NativeDwarfReader {
    #[napi(getter)]
    pub fn version(&self) -> u32 {
        u32::from(self.dwarf.version)
    }

    #[napi(getter)]
    pub fn address_size(&self) -> u32 {
        u32::from(self.dwarf.address_size)
    }

    #[napi(getter)]
    pub fn byte_order(&self) -> String {
        if self.dwarf.endian.is_little_endian() {
            "little".into()
        } else {
            "big".into()
        }
    }

    #[napi]
    pub fn entries(&self) -> Result<Vec<JsDwarfEntry>> {
        self.ensure_open()?;
        let mut out = Vec::new();
        with_dwarf(&self.dwarf, |dwarf| {
            walk_entries(dwarf, |unit, entry| {
                out.push(convert_entry(dwarf, unit, entry)?);
                Ok(true)
            })
        })?;
        Ok(out)
    }

    #[napi]
    pub fn entry_at(&self, offset: BigInt) -> Result<Option<JsDwarfEntry>> {
        self.ensure_open()?;
        let target = bigint_to_u64(offset)?;
        let mut found = None;
        with_dwarf(&self.dwarf, |dwarf| {
            walk_entries(dwarf, |unit, entry| {
                if entry_offset(unit, entry) == target {
                    found = Some(convert_entry(dwarf, unit, entry)?);
                    return Ok(false);
                }
                Ok(true)
            })
        })?;
        Ok(found)
    }

    #[napi]
    pub fn seek_pc(&self, addr: BigInt) -> Result<Option<JsDwarfEntry>> {
        self.ensure_open()?;
        let pc = bigint_to_u64(addr)?;
        let mut found = None;
        with_dwarf(&self.dwarf, |dwarf| {
            walk_entries(dwarf, |unit, entry| {
                if entry.tag() != gimli::DW_TAG_subprogram
                    && entry.tag() != gimli::DW_TAG_inlined_subroutine
                {
                    return Ok(true);
                }
                let Some(low_attr) = entry.attr_value(gimli::DW_AT_low_pc).map_err(dwarf_err)? else {
                    return Ok(true);
                };
                let Some(low) = dwarf.attr_address(unit, low_attr).ok().flatten() else {
                    return Ok(true);
                };
                let Some(high) = high_pc(dwarf, unit, entry, low)? else {
                    return Ok(true);
                };
                if pc >= low && pc < high {
                    found = Some(convert_entry(dwarf, unit, entry)?);
                    return Ok(false);
                }
                Ok(true)
            })
        })?;
        Ok(found)
    }

    #[napi]
    pub fn line_entries(&self) -> Result<Vec<JsLineEntry>> {
        self.ensure_open()?;
        let mut out = Vec::new();
        with_dwarf(&self.dwarf, |dwarf| {
            let mut units = dwarf.units();
            while let Some(header) = units.next().map_err(dwarf_err)? {
                let unit = dwarf.unit(header).map_err(dwarf_err)?;
                let Some(program) = unit.line_program.clone() else {
                    continue;
                };
                let mut rows = program.rows();
                while let Some((header, row)) = rows.next_row().map_err(dwarf_err)? {
                    out.push(JsLineEntry {
                        address: u64_big(row.address()),
                        file: file_path(dwarf, header, row.file_index()),
                        line: row.line().map(|l| l.get() as u32).unwrap_or(0),
                        column: match row.column() {
                            gimli::ColumnType::LeftEdge => 0,
                            gimli::ColumnType::Column(c) => c.get() as u32,
                        },
                        is_stmt: row.is_stmt(),
                        end_sequence: row.end_sequence(),
                        prologue_end: row.prologue_end(),
                        epilogue_begin: row.epilogue_begin(),
                        discriminator: row.discriminator() as u32,
                    });
                }
            }
            Ok(())
        })?;
        Ok(out)
    }

    #[napi]
    pub fn ranges_for_offset(&self, offset: BigInt) -> Result<Vec<JsRange>> {
        self.ensure_open()?;
        let target = bigint_to_u64(offset)?;
        let mut out = Vec::new();
        with_dwarf(&self.dwarf, |dwarf| {
            walk_entries(dwarf, |unit, entry| {
                if entry_offset(unit, entry) != target {
                    return Ok(true);
                }
                if let Some(low_attr) = entry.attr_value(gimli::DW_AT_low_pc).map_err(dwarf_err)? {
                    if let Some(low) = dwarf.attr_address(unit, low_attr).ok().flatten() {
                        if let Some(high) = high_pc(dwarf, unit, entry, low)? {
                            out.push(JsRange {
                                low: u64_big(low),
                                high: u64_big(high),
                            });
                        }
                    }
                }
                Ok(false)
            })
        })?;
        Ok(out)
    }

    #[napi]
    pub fn types(&self) -> Result<Vec<JsTypeInfo>> {
        self.ensure_open()?;
        let mut out = Vec::new();
        with_dwarf(&self.dwarf, |dwarf| {
            walk_entries(dwarf, |unit, entry| {
                if type_kind(entry.tag()).is_none() {
                    return Ok(true);
                }
                out.push(type_info_from_die(dwarf, unit, entry));
                Ok(true)
            })
        })?;
        Ok(out)
    }

    /// Follow DW_AT_specification / abstract_origin / type with a hard depth cap.
    #[napi]
    pub fn type_at(&self, offset: BigInt) -> Result<Option<JsTypeInfo>> {
        self.ensure_open()?;
        let start = bigint_to_u64(offset)?;
        with_dwarf(&self.dwarf, |dwarf| resolve_type_at(dwarf, start))
    }
}

enum TypeStep {
    Follow(u64),
    Done(JsTypeInfo),
}

fn resolve_type_at(dwarf: &gimli::Dwarf<Slice<'_>>, start: u64) -> Result<Option<JsTypeInfo>> {
    let mut current = start;
    let mut visited = HashSet::new();
    for _ in 0..MAX_SPEC_DEPTH {
        if !visited.insert(current) {
            return Err(format_err(
                "dwarf_cycle",
                current,
                format!("DW_AT_specification chain exceeds depth {MAX_SPEC_DEPTH}"),
            ));
        }
        let mut step = None;
        walk_entries(dwarf, |unit, entry| {
            if entry_offset(unit, entry) != current {
                return Ok(true);
            }
            if let Some(off) = first_ref(unit, entry, gimli::DW_AT_specification)? {
                step = Some(TypeStep::Follow(off));
                return Ok(false);
            }
            if let Some(off) = first_ref(unit, entry, gimli::DW_AT_abstract_origin)? {
                step = Some(TypeStep::Follow(off));
                return Ok(false);
            }
            if type_kind(entry.tag()).is_some() {
                step = Some(TypeStep::Done(type_info_from_die(dwarf, unit, entry)));
                return Ok(false);
            }
            if let Some(off) = first_ref(unit, entry, gimli::DW_AT_type)? {
                step = Some(TypeStep::Follow(off));
                return Ok(false);
            }
            step = Some(TypeStep::Done(type_info_from_die(dwarf, unit, entry)));
            Ok(false)
        })?;
        match step {
            Some(TypeStep::Follow(next)) => current = next,
            Some(TypeStep::Done(info)) => return Ok(Some(info)),
            None => return Ok(None),
        }
    }
    Err(format_err(
        "dwarf_cycle",
        current,
        format!("DW_AT_specification chain exceeds depth {MAX_SPEC_DEPTH}"),
    ))
}
