//! Bounded Mach-O fat header checks (issue #18 §4.7).
//! Selects the native-arch slice without walking an out-of-range `offset`.

use crate::file::{fail, format_err};
use napi::bindgen_prelude::Result;

const FAT_MAGIC: u32 = 0xcafebabe;
const FAT_MAGIC_64: u32 = 0xcafebabf;
const CPU_ARCH_ABI64: u32 = 0x0100_0000;
const CPU_TYPE_X86: u32 = 7;
const CPU_TYPE_X86_64: u32 = CPU_TYPE_X86 | CPU_ARCH_ABI64;
const CPU_TYPE_ARM: u32 = 12;
const CPU_TYPE_ARM64: u32 = CPU_TYPE_ARM | CPU_ARCH_ABI64;
const FAT_HEADER: usize = 8;
const FAT_ARCH32: usize = 20;
const FAT_ARCH64: usize = 32;

fn u32_be(data: &[u8], off: usize) -> Result<u32> {
    let bytes = data
        .get(off..off + 4)
        .ok_or_else(|| format_err("truncated", off as u64, "u32 field truncated"))?;
    Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn u64_be(data: &[u8], off: usize) -> Result<u64> {
    let bytes = data
        .get(off..off + 8)
        .ok_or_else(|| format_err("truncated", off as u64, "u64 field truncated"))?;
    Ok(u64::from_be_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]))
}

fn native_cputype() -> u32 {
    if cfg!(target_arch = "x86_64") {
        CPU_TYPE_X86_64
    } else if cfg!(target_arch = "aarch64") {
        CPU_TYPE_ARM64
    } else if cfg!(target_arch = "x86") {
        CPU_TYPE_X86
    } else if cfg!(target_arch = "arm") {
        CPU_TYPE_ARM
    } else {
        0
    }
}

/// Pick the native-architecture slice from a fat Mach-O.
///
/// Truncated fat_arch tables and a native slice whose `offset`/`size` run past
/// EOF are `BinaryFormatError`. A well-formed fat file that simply has no
/// native slice is `UnsupportedFeatureError`.
pub(crate) fn select_fat_slice(data: &[u8]) -> Result<(usize, usize)> {
    if data.len() < FAT_HEADER {
        return Err(format_err("truncated", 0, "fat Mach-O header truncated"));
    }
    let magic = u32_be(data, 0)?;
    let nfat_arch = u32_be(data, 4)? as usize;
    let arch_size = match magic {
        FAT_MAGIC => FAT_ARCH32,
        FAT_MAGIC_64 => FAT_ARCH64,
        _ => return Err(format_err("magic", 0, "invalid fat Mach-O magic")),
    };
    if nfat_arch == 0 {
        return Err(fail(
            "UnsupportedFeatureError",
            "fat Mach-O has no slice for this process architecture",
        ));
    }
    let table_len = nfat_arch
        .checked_mul(arch_size)
        .ok_or_else(|| format_err("overflow", 4, "nfat_arch overflow"))?;
    let table_end = FAT_HEADER
        .checked_add(table_len)
        .ok_or_else(|| format_err("overflow", 4, "fat arch table overflow"))?;
    if table_end > data.len() {
        let available = data.len().saturating_sub(FAT_HEADER);
        let complete = available / arch_size;
        let trunc = FAT_HEADER + complete * arch_size;
        return Err(format_err(
            "truncated",
            trunc as u64,
            "fat arch header truncated",
        ));
    }

    let native = native_cputype();
    let file_len = data.len() as u64;
    for i in 0..nfat_arch {
        let base = FAT_HEADER + i * arch_size;
        let cputype = u32_be(data, base)?;
        let (offset, size) = if magic == FAT_MAGIC_64 {
            (u64_be(data, base + 8)?, u64_be(data, base + 16)?)
        } else {
            (
                u64::from(u32_be(data, base + 8)?),
                u64::from(u32_be(data, base + 12)?),
            )
        };
        if cputype != native {
            continue;
        }
        let end = offset
            .checked_add(size)
            .ok_or_else(|| format_err("overflow", offset, "fat arch offset + size overflow"))?;
        if offset > file_len || end > file_len {
            return Err(format_err(
                "truncated",
                offset,
                "fat arch offset exceeds file",
            ));
        }
        let off = usize::try_from(offset)
            .map_err(|_| format_err("overflow", offset, "fat arch offset exceeds usize"))?;
        let len = usize::try_from(size)
            .map_err(|_| format_err("overflow", offset, "fat arch size exceeds usize"))?;
        return Ok((off, len));
    }
    Err(fail(
        "UnsupportedFeatureError",
        "fat Mach-O has no slice for this process architecture",
    ))
}
