pub const ELF_MAGIC: &[u8] = b"\x7fELF";
pub const PE_MAGIC: &[u8] = b"MZ";

const MACHO32_BE: [u8; 4] = [0xfe, 0xed, 0xfa, 0xce];
const MACHO32_LE: [u8; 4] = [0xce, 0xfa, 0xed, 0xfe];
const MACHO64_BE: [u8; 4] = [0xfe, 0xed, 0xfa, 0xcf];
const MACHO64_LE: [u8; 4] = [0xcf, 0xfa, 0xed, 0xfe];
const FAT_BE: [u8; 4] = [0xca, 0xfe, 0xba, 0xbe];
const FAT64_BE: [u8; 4] = [0xca, 0xfe, 0xba, 0xbf];
const FAT_LE: [u8; 4] = [0xbe, 0xba, 0xfe, 0xca];

const PLAN9_386: u32 = (4 * 11) * 11 + 7;
const PLAN9_ARM: u32 = (4 * 20) * 20 + 7;
const PLAN9_AMD64: u32 = (4 * 26) * 26 + 7 + 0x8000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Elf,
    Macho,
    Pe,
    Plan9,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Elf => "elf",
            Kind::Macho => "macho",
            Kind::Pe => "pe",
            Kind::Plan9 => "plan9",
        }
    }
}

pub fn sniff(head: &[u8]) -> Option<Kind> {
    if head.len() < 4 {
        return None;
    }
    if head.starts_with(ELF_MAGIC) {
        return Some(Kind::Elf);
    }
    if head.starts_with(PE_MAGIC) {
        return Some(Kind::Pe);
    }
    let mag = [head[0], head[1], head[2], head[3]];
    if mag == MACHO32_BE
        || mag == MACHO32_LE
        || mag == MACHO64_BE
        || mag == MACHO64_LE
        || mag == FAT_LE
        || mag == FAT64_BE
    {
        return Some(Kind::Macho);
    }
    if mag == FAT_BE {
        // Java class files also start with CAFEBABE. Fat Mach-O stores nfat_arch
        // as a big-endian u32 at offset 4; real fat files have a small count.
        if head.len() >= 8 {
            let narch = u32::from_be_bytes([head[4], head[5], head[6], head[7]]);
            if narch == 0 || narch > 16 {
                return None;
            }
        }
        return Some(Kind::Macho);
    }
    let be = u32::from_be_bytes(mag);
    if be == PLAN9_386 || be == PLAN9_ARM || be == PLAN9_AMD64 {
        return Some(Kind::Plan9);
    }
    None
}

pub fn is_macho_fat(head: &[u8]) -> bool {
    if head.len() < 4 {
        return false;
    }
    let mag = [head[0], head[1], head[2], head[3]];
    mag == FAT_BE || mag == FAT64_BE || mag == FAT_LE
}
