use napi::bindgen_prelude::*;
use napi_derive::napi;

fn range(message: &str) -> Error {
    Error::new(Status::GenericFailure, format!("RangeError: {message}"))
}

fn u64_arg(value: BigInt) -> Result<u64> {
    let (negative, magnitude, lossless) = value.get_u64();
    if negative || !lossless {
        return Err(range("math/rand: value out of range"));
    }
    Ok(magnitude)
}

fn u64_out(value: u64) -> BigInt {
    BigInt::from(value)
}

fn mul64(x: u64, y: u64) -> (u64, u64) {
    let z = u128::from(x) * u128::from(y);
    ((z >> 64) as u64, z as u64)
}

fn add64(x: u64, y: u64, carry: u64) -> (u64, u64) {
    let sum = u128::from(x) + u128::from(y) + u128::from(carry);
    (sum as u64, (sum >> 64) as u64)
}

struct Pcg {
    hi: u64,
    lo: u64,
}

impl Pcg {
    fn new(seed1: u64, seed2: u64) -> Self {
        Self { hi: seed1, lo: seed2 }
    }

    fn next(&mut self) -> (u64, u64) {
        const MUL_HI: u64 = 2_549_297_995_355_413_924;
        const MUL_LO: u64 = 4_865_540_595_714_422_341;
        const INC_HI: u64 = 6_364_136_223_846_793_005;
        const INC_LO: u64 = 1_442_695_040_888_963_407;
        let (mut hi, lo) = mul64(self.lo, MUL_LO);
        hi = hi
            .wrapping_add(self.hi.wrapping_mul(MUL_LO))
            .wrapping_add(self.lo.wrapping_mul(MUL_HI));
        let (lo, c) = add64(lo, INC_LO, 0);
        let (hi, _) = add64(hi, INC_HI, c);
        self.lo = lo;
        self.hi = hi;
        (hi, lo)
    }

    fn uint64(&mut self) -> u64 {
        const CHEAP_MUL: u64 = 0xda94_2042_e4dd_58b5;
        let (mut hi, lo) = self.next();
        hi ^= hi >> 32;
        hi = hi.wrapping_mul(CHEAP_MUL);
        hi ^= hi >> 48;
        hi.wrapping_mul(lo | 1)
    }

    fn marshal(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(20);
        out.extend_from_slice(b"pcg:");
        out.extend_from_slice(&self.hi.to_be_bytes());
        out.extend_from_slice(&self.lo.to_be_bytes());
        out
    }

    fn unmarshal(data: &[u8]) -> Result<Self> {
        if data.len() != 20 || &data[..4] != b"pcg:" {
            return Err(range("invalid PCG encoding"));
        }
        Ok(Self {
            hi: u64::from_be_bytes(data[4..12].try_into().unwrap()),
            lo: u64::from_be_bytes(data[12..20].try_into().unwrap()),
        })
    }
}

const CTR_INC: u32 = 4;
const CTR_MAX: u32 = 16;
const CHUNK: u32 = 32;
const RESEED: u32 = 4;

struct ChaCha8State {
    buf: [u64; 32],
    seed: [u64; 4],
    i: u32,
    n: u32,
    c: u32,
}

impl ChaCha8State {
    fn init(seed: [u64; 4]) -> Self {
        let mut s = Self {
            buf: [0; 32],
            seed,
            i: 0,
            n: CHUNK,
            c: 0,
        };
        block(&s.seed, &mut s.buf, 0);
        s
    }

    fn init_bytes(seed: &[u8; 32]) -> Self {
        Self::init([
            u64::from_le_bytes(seed[0..8].try_into().unwrap()),
            u64::from_le_bytes(seed[8..16].try_into().unwrap()),
            u64::from_le_bytes(seed[16..24].try_into().unwrap()),
            u64::from_le_bytes(seed[24..32].try_into().unwrap()),
        ])
    }

    fn next(&mut self) -> Option<u64> {
        if self.i >= self.n {
            return None;
        }
        let i = self.i;
        self.i = i + 1;
        Some(self.buf[(i & 31) as usize])
    }

    fn refill(&mut self) {
        self.c += CTR_INC;
        if self.c == CTR_MAX {
            let n = self.buf.len();
            self.seed[0] = self.buf[n - 4];
            self.seed[1] = self.buf[n - 3];
            self.seed[2] = self.buf[n - 2];
            self.seed[3] = self.buf[n - 1];
            self.c = 0;
        }
        block(&self.seed, &mut self.buf, self.c);
        self.i = 0;
        self.n = CHUNK;
        if self.c == CTR_MAX - CTR_INC {
            self.n = CHUNK - RESEED;
        }
    }

    fn uint64(&mut self) -> u64 {
        loop {
            if let Some(x) = self.next() {
                return x;
            }
            self.refill();
        }
    }

    fn marshal(&self) -> Vec<u8> {
        let mut data = vec![0u8; 48];
        data[..8].copy_from_slice(b"chacha8:");
        let used = u64::from((self.c / CTR_INC) * CHUNK + self.i);
        data[8..16].copy_from_slice(&used.to_be_bytes());
        for (i, seed) in self.seed.iter().enumerate() {
            let start = (2 + i) * 8;
            data[start..start + 8].copy_from_slice(&seed.to_le_bytes());
        }
        data
    }

    fn unmarshal(data: &[u8]) -> Result<Self> {
        if data.len() != 48 || &data[..8] != b"chacha8:" {
            return Err(range("invalid ChaCha8 encoding"));
        }
        let used = u64::from_be_bytes(data[8..16].try_into().unwrap());
        if used > u64::from((CTR_MAX / CTR_INC) * CHUNK - RESEED) {
            return Err(range("invalid ChaCha8 encoding"));
        }
        let mut seed = [0u64; 4];
        for (i, slot) in seed.iter_mut().enumerate() {
            let start = (2 + i) * 8;
            *slot = u64::from_le_bytes(data[start..start + 8].try_into().unwrap());
        }
        let mut s = Self {
            buf: [0; 32],
            seed,
            i: 0,
            n: CHUNK,
            c: CTR_INC * (used as u32 / CHUNK),
        };
        block(&s.seed, &mut s.buf, s.c);
        s.i = used as u32 % CHUNK;
        if s.c == CTR_MAX - CTR_INC {
            s.n = CHUNK - RESEED;
        }
        Ok(s)
    }
}

struct ChaCha8 {
    state: ChaCha8State,
    read_buf: [u8; 8],
    read_len: usize,
}

impl ChaCha8 {
    fn new(seed: &[u8; 32]) -> Self {
        Self {
            state: ChaCha8State::init_bytes(seed),
            read_buf: [0; 8],
            read_len: 0,
        }
    }

    fn uint64(&mut self) -> u64 {
        self.state.uint64()
    }

    fn marshal(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(64);
        if self.read_len > 0 {
            out.extend_from_slice(b"readbuf:");
            out.push(self.read_len as u8);
            out.extend_from_slice(&self.read_buf[8 - self.read_len..]);
        }
        out.extend_from_slice(&self.state.marshal());
        out
    }

    fn unmarshal(mut data: &[u8]) -> Result<Self> {
        let mut read_buf = [0u8; 8];
        let mut read_len = 0usize;
        if let Some(rest) = data.strip_prefix(b"readbuf:") {
            if rest.is_empty() || rest.len() < 1 + rest[0] as usize {
                return Err(range("invalid ChaCha8 Read buffer encoding"));
            }
            let n = rest[0] as usize;
            let buf = &rest[1..1 + n];
            read_len = n;
            read_buf[8 - n..].copy_from_slice(buf);
            data = &rest[1 + n..];
        }
        Ok(Self {
            state: ChaCha8State::unmarshal(data)?,
            read_buf,
            read_len,
        })
    }
}

fn qr(mut a: u32, mut b: u32, mut c: u32, mut d: u32) -> (u32, u32, u32, u32) {
    a = a.wrapping_add(b);
    d ^= a;
    d = d.rotate_left(16);
    c = c.wrapping_add(d);
    b ^= c;
    b = b.rotate_left(12);
    a = a.wrapping_add(b);
    d ^= a;
    d = d.rotate_left(8);
    c = c.wrapping_add(d);
    b ^= c;
    b = b.rotate_left(7);
    (a, b, c, d)
}

fn block(seed: &[u64; 4], buf: &mut [u64; 32], counter: u32) {
    let mut b = [[0u32; 4]; 16];
    for i in 0..4 {
        b[0][i] = 0x6170_7865;
        b[1][i] = 0x3320_646e;
        b[2][i] = 0x7962_2d32;
        b[3][i] = 0x6b20_6574;
    }
    let words = [
        seed[0] as u32,
        (seed[0] >> 32) as u32,
        seed[1] as u32,
        (seed[1] >> 32) as u32,
        seed[2] as u32,
        (seed[2] >> 32) as u32,
        seed[3] as u32,
        (seed[3] >> 32) as u32,
    ];
    for (row, word) in words.iter().enumerate() {
        for i in 0..4 {
            b[4 + row][i] = *word;
        }
    }
    for i in 0..4 {
        b[12][i] = counter + i as u32;
    }

    for i in 0..4 {
        let (mut b0, mut b1, mut b2, mut b3) = (b[0][i], b[1][i], b[2][i], b[3][i]);
        let (mut b4, mut b5, mut b6, mut b7) = (b[4][i], b[5][i], b[6][i], b[7][i]);
        let (mut b8, mut b9, mut b10, mut b11) = (b[8][i], b[9][i], b[10][i], b[11][i]);
        let (mut b12, mut b13, mut b14, mut b15) = (b[12][i], b[13][i], b[14][i], b[15][i]);
        for _ in 0..4 {
            (b0, b4, b8, b12) = qr(b0, b4, b8, b12);
            (b1, b5, b9, b13) = qr(b1, b5, b9, b13);
            (b2, b6, b10, b14) = qr(b2, b6, b10, b14);
            (b3, b7, b11, b15) = qr(b3, b7, b11, b15);
            (b0, b5, b10, b15) = qr(b0, b5, b10, b15);
            (b1, b6, b11, b12) = qr(b1, b6, b11, b12);
            (b2, b7, b8, b13) = qr(b2, b7, b8, b13);
            (b3, b4, b9, b14) = qr(b3, b4, b9, b14);
        }
        b[0][i] = b0;
        b[1][i] = b1;
        b[2][i] = b2;
        b[3][i] = b3;
        b[4][i] = b[4][i].wrapping_add(b4);
        b[5][i] = b[5][i].wrapping_add(b5);
        b[6][i] = b[6][i].wrapping_add(b6);
        b[7][i] = b[7][i].wrapping_add(b7);
        b[8][i] = b[8][i].wrapping_add(b8);
        b[9][i] = b[9][i].wrapping_add(b9);
        b[10][i] = b[10][i].wrapping_add(b10);
        b[11][i] = b[11][i].wrapping_add(b11);
        b[12][i] = b12;
        b[13][i] = b13;
        b[14][i] = b14;
        b[15][i] = b15;
    }

    for row in 0..16 {
        buf[row * 2] = u64::from(b[row][0]) | (u64::from(b[row][1]) << 32);
        buf[row * 2 + 1] = u64::from(b[row][2]) | (u64::from(b[row][3]) << 32);
    }
}

enum Inner {
    Pcg(Pcg),
    ChaCha8(ChaCha8),
}

#[napi]
pub struct NativeRand {
    inner: Inner,
}

#[napi]
impl NativeRand {
    #[napi]
    pub fn uint64(&mut self) -> BigInt {
        match &mut self.inner {
            Inner::Pcg(p) => u64_out(p.uint64()),
            Inner::ChaCha8(c) => u64_out(c.uint64()),
        }
    }

    #[napi]
    pub fn state(&self) -> Buffer {
        let bytes = match &self.inner {
            Inner::Pcg(p) => p.marshal(),
            Inner::ChaCha8(c) => c.marshal(),
        };
        Buffer::from(bytes)
    }
}

#[napi]
pub fn new_pcg(seed1: BigInt, seed2: BigInt) -> Result<NativeRand> {
    Ok(NativeRand {
        inner: Inner::Pcg(Pcg::new(u64_arg(seed1)?, u64_arg(seed2)?)),
    })
}

#[napi(js_name = "newChaCha8")]
pub fn new_chacha8(seed: Uint8Array) -> Result<NativeRand> {
    let seed = seed.as_ref();
    if seed.len() != 32 {
        return Err(range("math/rand: ChaCha8 seed must be 32 bytes"));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(seed);
    Ok(NativeRand {
        inner: Inner::ChaCha8(ChaCha8::new(&arr)),
    })
}

#[napi]
pub fn rand_from_state(state: Uint8Array) -> Result<NativeRand> {
    let data = state.as_ref();
    if data.starts_with(b"pcg:") {
        return Ok(NativeRand {
            inner: Inner::Pcg(Pcg::unmarshal(data)?),
        });
    }
    if data.starts_with(b"readbuf:") || data.starts_with(b"chacha8:") {
        return Ok(NativeRand {
            inner: Inner::ChaCha8(ChaCha8::unmarshal(data)?),
        });
    }
    Err(range("invalid PCG encoding"))
}
