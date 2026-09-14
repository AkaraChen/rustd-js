use crate::sniff;

const MAGIC64: u32 = 0x8000;

#[derive(Clone, Debug)]
pub struct Plan9File {
    pub _magic: u32,
    pub entry: u64,
    pub ptr_size: u8,
    pub sections: Vec<Plan9Section>,
    pub symbols: Vec<Plan9Symbol>,
}

#[derive(Clone, Debug)]
pub struct Plan9Section {
    pub name: String,
    pub offset: u64,
    pub size: u64,
}

#[derive(Clone, Debug)]
pub struct Plan9Symbol {
    pub name: String,
    pub value: u64,
    pub kind: u8,
}

pub fn parse(data: &[u8]) -> Result<Plan9File, String> {
    if sniff::sniff(data) != Some(sniff::Kind::Plan9) {
        return Err("not a Plan 9 a.out".into());
    }
    if data.len() < 32 {
        return Err("truncated Plan 9 header".into());
    }
    let magic = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
    let text = u32::from_be_bytes([data[4], data[5], data[6], data[7]]) as u64;
    let data_sz = u32::from_be_bytes([data[8], data[9], data[10], data[11]]) as u64;
    let _bss = u32::from_be_bytes([data[12], data[13], data[14], data[15]]) as u64;
    let syms = u32::from_be_bytes([data[16], data[17], data[18], data[19]]) as u64;
    let entry32 = u32::from_be_bytes([data[20], data[21], data[22], data[23]]) as u64;
    let spsz = u32::from_be_bytes([data[24], data[25], data[26], data[27]]) as u64;
    let pcsz = u32::from_be_bytes([data[28], data[29], data[30], data[31]]) as u64;
    let (entry, hdr, ptr_size) = if magic & MAGIC64 != 0 {
        if data.len() < 40 {
            return Err("truncated Plan 9 64-bit header".into());
        }
        (
            u64::from_be_bytes([
                data[32], data[33], data[34], data[35], data[36], data[37], data[38], data[39],
            ]),
            40u64,
            8u8,
        )
    } else {
        (entry32, 32u64, 4u8)
    };
    let mut off = hdr;
    let mut sections = Vec::new();
    for (name, size) in [
        ("text", text),
        ("data", data_sz),
        ("syms", syms),
        ("spsz", spsz),
        ("pcsz", pcsz),
    ] {
        sections.push(Plan9Section {
            name: name.into(),
            offset: off,
            size,
        });
        off = off.saturating_add(size);
    }
    let symbols = sections
        .iter()
        .find(|s| s.name == "syms")
        .map(|s| parse_syms(data, s.offset, s.size, ptr_size as usize))
        .unwrap_or_default();
    Ok(Plan9File {
        _magic: magic,
        entry,
        ptr_size,
        sections,
        symbols,
    })
}

fn parse_syms(data: &[u8], offset: u64, size: u64, ptr_size: usize) -> Vec<Plan9Symbol> {
    let start = offset as usize;
    let end = start.saturating_add(size as usize).min(data.len());
    if start >= end {
        return Vec::new();
    }
    let mut p = &data[start..end];
    let mut out = Vec::new();
    while p.len() >= ptr_size + 1 {
        let value = if ptr_size == 8 {
            let v = u64::from_be_bytes(p[0..8].try_into().unwrap());
            p = &p[8..];
            v
        } else {
            let v = u32::from_be_bytes(p[0..4].try_into().unwrap()) as u64;
            p = &p[4..];
            v
        };
        let kind = p[0];
        p = &p[1..];
        let mut n = 0;
        while n < p.len() && p[n] != 0 {
            n += 1;
        }
        let name = String::from_utf8_lossy(&p[..n]).into_owned();
        if n < p.len() {
            p = &p[n + 1..];
        } else {
            p = &[];
        }
        out.push(Plan9Symbol { name, value, kind });
    }
    out
}
