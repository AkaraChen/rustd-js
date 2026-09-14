//! Bounded PE header checks (issue #18 §4.7).
//! Rejects `NumberOfSections = 0` and optional-header `SizeOfImage` that does
//! not cover the in-memory section range.

use crate::file::format_err;
use napi::bindgen_prelude::Result;

const DOS_HEADER: usize = 64;
const PE_SIG: usize = 4;
const COFF_HEADER: usize = 20;
const SECTION_HEADER: usize = 40;
const E_LFANEW: usize = 0x3c;
const OPT_MAGIC_PE32: u16 = 0x10b;
const OPT_MAGIC_PE32PLUS: u16 = 0x20b;
const SIZE_OF_IMAGE_OFF: usize = 56;
const SIZE_OF_HEADERS_OFF: usize = 60;
const SECTION_ALIGN_OFF: usize = 32;

fn u16_le(data: &[u8], off: usize) -> Result<u16> {
    let bytes = data
        .get(off..off + 2)
        .ok_or_else(|| format_err("truncated", off as u64, "u16 field truncated"))?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn u32_le(data: &[u8], off: usize) -> Result<u32> {
    let bytes = data
        .get(off..off + 4)
        .ok_or_else(|| format_err("truncated", off as u64, "u32 field truncated"))?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn align_up(value: u64, align: u64) -> Result<u64> {
    if align <= 1 {
        return Ok(value);
    }
    let rem = value % align;
    if rem == 0 {
        return Ok(value);
    }
    value
        .checked_add(align - rem)
        .ok_or_else(|| format_err("overflow", value, "PE align overflow"))
}

/// Reject empty section tables and `SizeOfImage` that cannot hold the sections.
pub(crate) fn validate_pe(data: &[u8]) -> Result<()> {
    if data.len() < 2 || !data.starts_with(b"MZ") {
        return Err(format_err("magic", 0, "not PE"));
    }
    if data.len() < DOS_HEADER {
        return Err(format_err("truncated", 0, "DOS header truncated"));
    }
    let e_lfanew = u32_le(data, E_LFANEW)? as u64;
    let sig = usize::try_from(e_lfanew)
        .map_err(|_| format_err("overflow", e_lfanew, "e_lfanew exceeds usize"))?;
    let sig_end = sig
        .checked_add(PE_SIG)
        .ok_or_else(|| format_err("overflow", e_lfanew, "PE signature overflow"))?;
    if sig_end > data.len() {
        return Err(format_err("truncated", e_lfanew, "PE signature truncated"));
    }
    if &data[sig..sig_end] != b"PE\0\0" {
        return Err(format_err("magic", e_lfanew, "invalid PE signature"));
    }

    let coff = sig_end;
    let coff_end = coff
        .checked_add(COFF_HEADER)
        .ok_or_else(|| format_err("overflow", coff as u64, "COFF header overflow"))?;
    if coff_end > data.len() {
        return Err(format_err("truncated", coff as u64, "COFF header truncated"));
    }
    let number_of_sections = u16_le(data, coff + 2)?;
    let size_of_optional = u16_le(data, coff + 16)? as usize;
    let nos_off = (coff + 2) as u64;
    if number_of_sections == 0 {
        return Err(format_err(
            "sections",
            nos_off,
            "PE NumberOfSections is 0",
        ));
    }

    let opt = coff_end;
    let opt_end = opt
        .checked_add(size_of_optional)
        .ok_or_else(|| format_err("overflow", opt as u64, "optional header overflow"))?;
    if opt_end > data.len() {
        return Err(format_err(
            "truncated",
            opt as u64,
            "optional header truncated",
        ));
    }

    let sections_off = opt_end;
    let table_len = (number_of_sections as usize)
        .checked_mul(SECTION_HEADER)
        .ok_or_else(|| format_err("overflow", sections_off as u64, "section table overflow"))?;
    let table_end = sections_off
        .checked_add(table_len)
        .ok_or_else(|| format_err("overflow", sections_off as u64, "section table overflow"))?;
    if table_end > data.len() {
        let available = data.len().saturating_sub(sections_off);
        let complete = available / SECTION_HEADER;
        let trunc = sections_off + complete * SECTION_HEADER;
        return Err(format_err(
            "truncated",
            trunc as u64,
            "PE section header truncated",
        ));
    }

    // SizeOfImage lives in the optional header (PE images, not COFF objects).
    if size_of_optional < SIZE_OF_HEADERS_OFF + 4 {
        return Ok(());
    }
    let magic = u16_le(data, opt)?;
    if magic != OPT_MAGIC_PE32 && magic != OPT_MAGIC_PE32PLUS {
        return Err(format_err(
            "magic",
            opt as u64,
            "invalid PE optional header magic",
        ));
    }
    let size_of_image = u64::from(u32_le(data, opt + SIZE_OF_IMAGE_OFF)?);
    let size_of_image_off = (opt + SIZE_OF_IMAGE_OFF) as u64;
    let section_alignment = u64::from(u32_le(data, opt + SECTION_ALIGN_OFF)?).max(1);
    let size_of_headers = u64::from(u32_le(data, opt + SIZE_OF_HEADERS_OFF)?);

    let mut required = align_up(size_of_headers, section_alignment)?;
    for i in 0..number_of_sections as usize {
        let sh = sections_off + i * SECTION_HEADER;
        let virtual_size = u64::from(u32_le(data, sh + 8)?);
        let virtual_address = u64::from(u32_le(data, sh + 12)?);
        let size_of_raw_data = u64::from(u32_le(data, sh + 16)?);
        let mem_size = if virtual_size == 0 {
            size_of_raw_data
        } else {
            virtual_size
        };
        let end = virtual_address
            .checked_add(mem_size)
            .ok_or_else(|| format_err("overflow", virtual_address, "section VA + size overflow"))?;
        required = required.max(align_up(end, section_alignment)?);
    }

    if size_of_image < required {
        return Err(format_err(
            "size_of_image",
            size_of_image_off,
            "PE SizeOfImage smaller than actual sections",
        ));
    }
    if section_alignment > 1 && size_of_image % section_alignment != 0 {
        return Err(format_err(
            "size_of_image",
            size_of_image_off,
            "PE SizeOfImage is not a multiple of SectionAlignment",
        ));
    }
    Ok(())
}
