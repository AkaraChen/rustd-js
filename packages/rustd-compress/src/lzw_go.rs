//! Go `compress/lzw` Reader/Writer, ported for byte-identical output and errors.
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

const MAX_WIDTH: u32 = 12;
const DECODER_INVALID_CODE: u16 = 0xffff;
const FLUSH_BUFFER: usize = 1 << MAX_WIDTH;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoDecodeError {
    UnexpectedEof,
    InvalidCode,
}

impl GoDecodeError {
    pub fn message(self) -> &'static str {
        match self {
            Self::UnexpectedEof => "unexpected EOF",
            Self::InvalidCode => "lzw: invalid code",
        }
    }
}

/// Incremental Go `compress/lzw` decoder. Leftover bits (`bits`/`n_bits`) are
/// kept across `write` calls so LSB/MSB codes that straddle chunk boundaries
/// match Go's `readLSB`/`readMSB`.
pub struct GoDecoder {
    order: BitOrder,
    lit_width: u32,
    width: u32,
    clear: u16,
    eof: u16,
    hi: u16,
    overflow: u16,
    last: u16,
    bits: u32,
    n_bits: u32,
    input: Vec<u8>,
    input_off: usize,
    suffix: [u8; 1 << MAX_WIDTH],
    prefix: [u16; 1 << MAX_WIDTH],
    scratch: [u8; 2 * (1 << MAX_WIDTH)],
    o: usize,
    decoded: Vec<u8>,
    seen_eof: bool,
    err: Option<GoDecodeError>,
}

impl GoDecoder {
    pub fn new(order: BitOrder, lit_width: u8) -> Self {
        let lit_width = u32::from(lit_width);
        let width = 1 + lit_width;
        let clear = 1u16 << lit_width;
        let eof = clear + 1;
        Self {
            order,
            lit_width,
            width,
            clear,
            eof,
            hi: eof,
            overflow: 1u16 << width,
            last: DECODER_INVALID_CODE,
            bits: 0,
            n_bits: 0,
            input: Vec::new(),
            input_off: 0,
            suffix: [0u8; 1 << MAX_WIDTH],
            prefix: [0u16; 1 << MAX_WIDTH],
            scratch: [0u8; 2 * (1 << MAX_WIDTH)],
            o: 0,
            decoded: Vec::new(),
            seen_eof: false,
            err: None,
        }
    }

    pub fn pending_len(&self) -> usize {
        self.input.len() - self.input_off + (self.n_bits as usize).div_ceil(8)
    }

    pub fn take_decoded(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.decoded)
    }

    pub fn write(&mut self, data: &[u8]) -> Result<(), GoDecodeError> {
        if let Some(err) = self.err {
            return Err(err);
        }
        if self.seen_eof {
            return Ok(());
        }
        if !data.is_empty() {
            self.compact_input();
            self.input.extend_from_slice(data);
        }
        self.pump()
    }

    pub fn finish(&mut self) -> Result<(), GoDecodeError> {
        if let Some(err) = self.err {
            return Err(err);
        }
        self.pump()?;
        if self.seen_eof {
            return Ok(());
        }
        self.err = Some(GoDecodeError::UnexpectedEof);
        Err(GoDecodeError::UnexpectedEof)
    }

    fn compact_input(&mut self) {
        if self.input_off == 0 {
            return;
        }
        self.input.drain(..self.input_off);
        self.input_off = 0;
    }

    fn flush(&mut self) {
        if self.o == 0 {
            return;
        }
        self.decoded.extend_from_slice(&self.scratch[..self.o]);
        self.o = 0;
    }

    fn read_code(&mut self) -> Result<Option<u16>, GoDecodeError> {
        match self.order {
            BitOrder::Lsb => {
                while self.n_bits < self.width {
                    if self.input_off >= self.input.len() {
                        return Ok(None);
                    }
                    let x = self.input[self.input_off];
                    self.input_off += 1;
                    self.bits |= u32::from(x) << self.n_bits;
                    self.n_bits += 8;
                }
                let code = (self.bits & ((1 << self.width) - 1)) as u16;
                self.bits >>= self.width;
                self.n_bits -= self.width;
                Ok(Some(code))
            }
            BitOrder::Msb => {
                while self.n_bits < self.width {
                    if self.input_off >= self.input.len() {
                        return Ok(None);
                    }
                    let x = self.input[self.input_off];
                    self.input_off += 1;
                    self.bits |= u32::from(x) << (24 - self.n_bits);
                    self.n_bits += 8;
                }
                let code = (self.bits >> (32 - self.width)) as u16;
                self.bits <<= self.width;
                self.n_bits -= self.width;
                Ok(Some(code))
            }
        }
    }

    fn pump(&mut self) -> Result<(), GoDecodeError> {
        if self.seen_eof {
            self.flush();
            return Ok(());
        }
        loop {
            let code = match self.read_code() {
                Ok(Some(code)) => code,
                Ok(None) => {
                    self.flush();
                    self.compact_input();
                    return Ok(());
                }
                Err(err) => {
                    self.err = Some(err);
                    self.flush();
                    return Err(err);
                }
            };
            if code < self.clear {
                self.scratch[self.o] = code as u8;
                self.o += 1;
                if self.last != DECODER_INVALID_CODE {
                    self.suffix[self.hi as usize] = code as u8;
                    self.prefix[self.hi as usize] = self.last;
                }
            } else if code == self.clear {
                self.width = 1 + self.lit_width;
                self.hi = self.eof;
                self.overflow = 1u16 << self.width;
                self.last = DECODER_INVALID_CODE;
                continue;
            } else if code == self.eof {
                self.flush();
                self.seen_eof = true;
                self.input.clear();
                self.input_off = 0;
                self.n_bits = 0;
                self.bits = 0;
                return Ok(());
            } else if code <= self.hi {
                let mut c = code;
                let mut i = self.scratch.len() - 1;
                if code == self.hi && self.last != DECODER_INVALID_CODE {
                    c = self.last;
                    while c >= self.clear {
                        c = self.prefix[c as usize];
                    }
                    self.scratch[i] = c as u8;
                    i -= 1;
                    c = self.last;
                }
                while c >= self.clear {
                    self.scratch[i] = self.suffix[c as usize];
                    i -= 1;
                    c = self.prefix[c as usize];
                }
                self.scratch[i] = c as u8;
                let n = self.scratch.len() - i;
                self.scratch.copy_within(i.., self.o);
                self.o += n;
                if self.last != DECODER_INVALID_CODE {
                    self.suffix[self.hi as usize] = c as u8;
                    self.prefix[self.hi as usize] = self.last;
                }
            } else {
                self.err = Some(GoDecodeError::InvalidCode);
                self.flush();
                return Err(GoDecodeError::InvalidCode);
            }
            self.last = code;
            self.hi = self.hi.saturating_add(1);
            if self.hi >= self.overflow {
                if self.width == MAX_WIDTH {
                    self.last = DECODER_INVALID_CODE;
                    self.hi -= 1;
                } else {
                    self.width += 1;
                    self.overflow = 1u16 << self.width;
                }
            }
            if self.o >= FLUSH_BUFFER {
                self.flush();
            }
        }
    }
}

pub fn decode_all(order: BitOrder, lit_width: u8, data: &[u8]) -> Result<Vec<u8>, GoDecodeError> {
    let mut decoder = GoDecoder::new(order, lit_width);
    decoder.write(data)?;
    decoder.finish()?;
    Ok(decoder.take_decoded())
}
