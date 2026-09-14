//! Bounded ELF header-table checks (issue #18 §4.7).
//! Does not allocate from `sh_size`; only reads the ident, Ehdr, and Shdr table.

use crate::file::format_err;
use napi::bindgen_prelude::Result;

const ELFCLASS32: u8 = 1;
const ELFCLASS64: u8 = 2;
const ELFDATA2LSB: u8 = 1;
const ELFDATA2MSB: u8 = 2;
const EI_NIDENT: usize = 16;
const EHDR32: usize = 52;
const EHDR64: usize = 64;
const SHDR32: u16 = 40;
const SHDR64: u16 = 64;

fn u16_at(data: &[u8], off: usize, little: bool) -> Result<u16> {
    let bytes = data
        .get(off..off + 2)
        .ok_or_else(|| format_err("truncated", off as u64, "u16 field truncated"))?;
    let arr = [bytes[0], bytes[1]];
    Ok(if little {
        u16::from_le_bytes(arr)
    } else {
        u16::from_be_bytes(arr)
    })
}

fn u32_at(data: &[u8], off: usize, little: bool) -> Result<u32> {
    let bytes = data
        .get(off..off + 4)
        .ok_or_else(|| format_err("truncated", off as u64, "u32 field truncated"))?;
    let arr = [bytes[0], bytes[1], bytes[2], bytes[3]];
    Ok(if little {
        u32::from_le_bytes(arr)
    } else {
        u32::from_be_bytes(arr)
    })
}

fn u64_at(data: &[u8], off: usize, little: bool) -> Result<u64> {
    let bytes = data
        .get(off..off + 8)
        .ok_or_else(|| format_err("truncated", off as u64, "u64 field truncated"))?;
    let arr = [
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ];
    Ok(if little {
        u64::from_le_bytes(arr)
    } else {
        u64::from_be_bytes(arr)
    })
}

/// Reject a truncated section-header table before `object` walks it.
/// Complete headers with a huge `sh_size` are allowed through so `data()` can
/// raise `BlockedRegionError` without allocating.
pub(crate) fn validate_section_headers(data: &[u8]) -> Result<()> {
    if data.len() < EI_NIDENT {
        return Err(format_err("truncated", 0, "ELF ident truncated"));
    }
    if !data.starts_with(b"\x7fELF") {
        return Err(format_err("magic", 0, "not ELF"));
    }
    let class = data[4];
    let encoding = data[5];
    let little = match encoding {
        ELFDATA2LSB => true,
        ELFDATA2MSB => false,
        _ => return Err(format_err("ident", 5, "invalid EI_DATA")),
    };
    let (ehsize, shdr_size) = match class {
        ELFCLASS32 => (EHDR32, SHDR32),
        ELFCLASS64 => (EHDR64, SHDR64),
        _ => return Err(format_err("ident", 4, "invalid EI_CLASS")),
    };
    if data.len() < ehsize {
        return Err(format_err("truncated", 0, "ELF header truncated"));
    }

    let (shoff, shentsize, shnum_field) = if class == ELFCLASS64 {
        (u64_at(data, 40, little)?, u16_at(data, 58, little)?, u16_at(data, 60, little)?)
    } else {
        (
            u64::from(u32_at(data, 32, little)?),
            u16_at(data, 46, little)?,
            u16_at(data, 48, little)?,
        )
    };

    if shoff == 0 && shnum_field == 0 {
        return Ok(());
    }
    if shentsize != shdr_size {
        return Err(format_err(
            "shentsize",
            if class == ELFCLASS64 { 58 } else { 46 },
            "invalid e_shentsize",
        ));
    }

    let file_len = data.len() as u64;
    let mut shnum = u64::from(shnum_field);
    if shnum == 0 {
        let hdr0_end = shoff
            .checked_add(u64::from(shentsize))
            .ok_or_else(|| format_err("overflow", shoff, "section header 0 overflow"))?;
        if hdr0_end > file_len {
            return Err(format_err("truncated", shoff, "section header 0 truncated"));
        }
        let size_field = shoff + if class == ELFCLASS64 { 32 } else { 20 };
        shnum = if class == ELFCLASS64 {
            u64_at(data, size_field as usize, little)?
        } else {
            u64::from(u32_at(data, size_field as usize, little)?)
        };
    }

    let table_len = shnum
        .checked_mul(u64::from(shentsize))
        .ok_or_else(|| format_err("overflow", shoff, "section header table overflow"))?;
    let table_end = shoff
        .checked_add(table_len)
        .ok_or_else(|| format_err("overflow", shoff, "section header table overflow"))?;
    if table_end > file_len {
        let available = file_len.saturating_sub(shoff);
        let complete = available / u64::from(shentsize);
        let trunc = shoff.saturating_add(complete.saturating_mul(u64::from(shentsize)));
        return Err(format_err("truncated", trunc, "section header truncated"));
    }
    Ok(())
}
