//! Go `compress/lzw` Writer, ported for byte-identical compressed output.
use weezl::BitOrder;

const MAX_CODE: u32 = (1 << 12) - 1;
const INVALID_CODE: u32 = u32::MAX;
const TABLE_SIZE: usize = 4 * (1 << 12);
const TABLE_MASK: u32 = (TABLE_SIZE as u32) - 1;
const INVALID_ENTRY: u32 = 0;

pub struct GoEncoder {
    order: BitOrder,
    lit_width: u32,
    n_bits: u32,
    width: u32,
    bits: u32,
    hi: u32,
    overflow: u32,
    saved_code: u32,
    table: Vec<u32>,
    out: Vec<u8>,
    finished: bool,
}

impl GoEncoder {
    pub fn new(order: BitOrder, lit_width: u8) -> Self {
        let lw = u32::from(lit_width);
        Self {
            order,
            lit_width: lw,
            n_bits: 0,
            width: 1 + lw,
            bits: 0,
            hi: (1 << lw) + 1,
            overflow: 1 << (lw + 1),
            saved_code: INVALID_CODE,
            table: vec![INVALID_ENTRY; TABLE_SIZE],
            out: Vec::new(),
            finished: false,
        }
    }

    fn write_code(&mut self, c: u32) {
        match self.order {
            BitOrder::Lsb => {
                self.bits |= c << self.n_bits;
                self.n_bits += self.width;
                while self.n_bits >= 8 {
                    self.out.push(self.bits as u8);
                    self.bits >>= 8;
                    self.n_bits -= 8;
                }
            }
            BitOrder::Msb => {
                self.bits |= c << (32 - self.width - self.n_bits);
                self.n_bits += self.width;
                while self.n_bits >= 8 {
                    self.out.push((self.bits >> 24) as u8);
                    self.bits <<= 8;
                    self.n_bits -= 8;
                }
            }
        }
    }

    fn inc_hi(&mut self) -> bool {
        self.hi += 1;
        if self.hi == self.overflow {
            self.width += 1;
            self.overflow <<= 1;
        }
        if self.hi == MAX_CODE {
            let clear = 1u32 << self.lit_width;
            self.write_code(clear);
            self.width = self.lit_width + 1;
            self.hi = clear + 1;
            self.overflow = clear << 1;
            self.table.fill(INVALID_ENTRY);
            return true;
        }
        false
    }

    pub fn write(&mut self, mut p: &[u8]) -> Result<(), &'static str> {
        if self.finished {
            return Err("lzw: write after finish");
        }
        if p.is_empty() {
            return Ok(());
        }
        if self.lit_width < 8 {
            let max = ((1u16 << self.lit_width) - 1) as u8;
            if p.iter().any(|&x| x > max) {
                return Err("lzw: input byte too large for the litWidth");
            }
        }
        let mut code = self.saved_code;
        if code == INVALID_CODE {
            let clear = 1u32 << self.lit_width;
            self.write_code(clear);
            code = u32::from(p[0]);
            p = &p[1..];
        }
        for &x in p {
            let literal = u32::from(x);
            let key = code << 8 | literal;
            let mut hash = (key >> 12 ^ key) & TABLE_MASK;
            let mut hit = false;
            let mut t = self.table[hash as usize];
            while t != INVALID_ENTRY {
                if key == t >> 12 {
                    code = t & MAX_CODE;
                    hit = true;
                    break;
                }
                hash = (hash + 1) & TABLE_MASK;
                t = self.table[hash as usize];
            }
            if hit {
                continue;
            }
            self.write_code(code);
            code = literal;
            if self.inc_hi() {
                continue;
            }
            loop {
                if self.table[hash as usize] == INVALID_ENTRY {
                    self.table[hash as usize] = (key << 12) | self.hi;
                    break;
                }
                hash = (hash + 1) & TABLE_MASK;
            }
        }
        self.saved_code = code;
        Ok(())
    }

    pub fn finish(&mut self) -> Vec<u8> {
        if self.finished {
            return std::mem::take(&mut self.out);
        }
        self.finished = true;
        if self.saved_code != INVALID_CODE {
            self.write_code(self.saved_code);
            let _ = self.inc_hi();
        } else {
            let clear = 1u32 << self.lit_width;
            self.write_code(clear);
        }
        let eof = (1u32 << self.lit_width) + 1;
        self.write_code(eof);
        if self.n_bits > 0 {
            if matches!(self.order, BitOrder::Msb) {
                self.bits >>= 24;
            }
            self.out.push(self.bits as u8);
        }
        std::mem::take(&mut self.out)
    }
}
