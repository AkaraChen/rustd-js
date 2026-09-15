#[path = "rng_cooked.rs"]
mod rng_cooked;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rng_cooked::RNG_COOKED;

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

fn i64_arg(value: BigInt) -> Result<i64> {
    let (signed, lossless) = value.get_i64();
    if !lossless {
        return Err(range("math/rand: value out of range"));
    }
    Ok(signed)
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

const RNG_LEN: usize = 607;
const RNG_TAP: usize = 273;
const RNG_MASK: u64 = (1 << 63) - 1;
const INT32_MAX: i32 = 2_147_483_647;

fn seedrand(x: i32) -> i32 {
    const A: i32 = 48_271;
    const Q: i32 = 44_488;
    const R: i32 = 3_399;
    let hi = x / Q;
    let lo = x % Q;
    let mut x = A.wrapping_mul(lo).wrapping_sub(R.wrapping_mul(hi));
    if x < 0 {
        x = x.wrapping_add(INT32_MAX);
    }
    x
}

struct RngSource {
    tap: i32,
    feed: i32,
    vec: [i64; RNG_LEN],
}

impl RngSource {
    fn seed(seed: i64) -> Self {
        let mut rng = Self {
            tap: 0,
            feed: (RNG_LEN - RNG_TAP) as i32,
            vec: [0; RNG_LEN],
        };
        let mut seed = seed % i64::from(INT32_MAX);
        if seed < 0 {
            seed += i64::from(INT32_MAX);
        }
        if seed == 0 {
            seed = 89_482_311;
        }
        let mut x = seed as i32;
        for i in -20..RNG_LEN as i32 {
            x = seedrand(x);
            if i >= 0 {
                let mut u = (i64::from(x)) << 40;
                x = seedrand(x);
                u ^= (i64::from(x)) << 20;
                x = seedrand(x);
                u ^= i64::from(x);
                u ^= RNG_COOKED[i as usize];
                rng.vec[i as usize] = u;
            }
        }
        rng
    }

    fn uint64(&mut self) -> u64 {
        self.tap -= 1;
        if self.tap < 0 {
            self.tap += RNG_LEN as i32;
        }
        self.feed -= 1;
        if self.feed < 0 {
            self.feed += RNG_LEN as i32;
        }
        let x = self.vec[self.feed as usize].wrapping_add(self.vec[self.tap as usize]);
        self.vec[self.feed as usize] = x;
        x as u64
    }

    fn int63(&mut self) -> i64 {
        (self.uint64() & RNG_MASK) as i64
    }

    fn float64(&mut self) -> f64 {
        loop {
            let f = (self.int63() as f64) / ((1u64 << 63) as f64);
            if f != 1.0 {
                return f;
            }
        }
    }

    fn read(&mut self, p: &mut [u8], read_val: &mut i64, read_pos: &mut i8) {
        let mut pos = *read_pos;
        let mut val = *read_val;
        for slot in p.iter_mut() {
            if pos == 0 {
                val = self.int63();
                pos = 7;
            }
            *slot = val as u8;
            val >>= 8;
            pos -= 1;
        }
        *read_pos = pos;
        *read_val = val;
    }
}

enum Inner {
    Pcg(Pcg),
    ChaCha8(ChaCha8),
    Rng(RngSource),
}

impl Inner {
    fn uint64(&mut self) -> u64 {
        match self {
            Inner::Pcg(p) => p.uint64(),
            Inner::ChaCha8(c) => c.uint64(),
            Inner::Rng(r) => r.uint64(),
        }
    }

    fn is_v1(&self) -> bool {
        matches!(self, Inner::Rng(_))
    }

    fn rng(&mut self) -> Result<&mut RngSource> {
        match self {
            Inner::Rng(r) => Ok(r),
            _ => Err(range("math/rand: this method is a v1 API")),
        }
    }
}

fn uint64n(src: &mut Inner, n: u64) -> u64 {
    if n & (n - 1) == 0 {
        return src.uint64() & (n - 1);
    }
    let (mut hi, mut lo) = mul64(src.uint64(), n);
    if lo < n {
        let thresh = n.wrapping_neg() % n;
        while lo < thresh {
            let next = mul64(src.uint64(), n);
            hi = next.0;
            lo = next.1;
        }
    }
    hi
}

fn v2_float64(src: &mut Inner) -> f64 {
    (src.uint64() << 11 >> 11) as f64 / ((1u64 << 53) as f64)
}

fn v2_float32(src: &mut Inner) -> f32 {
    let x = (src.uint64() >> 32) as u32;
    (x << 8 >> 8) as f32 / ((1u32 << 24) as f32)
}

fn v1_int63n(rng: &mut RngSource, n: i64) -> Result<i64> {
    if n <= 0 {
        return Err(range("invalid argument to Int63n"));
    }
    if n & (n - 1) == 0 {
        return Ok(rng.int63() & (n - 1));
    }
    let max = (i64::MAX as u64 - ((1u64 << 63) % n as u64)) as i64;
    let mut v = rng.int63();
    while v > max {
        v = rng.int63();
    }
    Ok(v % n)
}

fn v1_int31(rng: &mut RngSource) -> i32 {
    (rng.int63() >> 32) as i32
}

fn v1_uint32(rng: &mut RngSource) -> u32 {
    (rng.int63() >> 31) as u32
}

fn v1_int31n(rng: &mut RngSource, n: i32) -> Result<i32> {
    if n <= 0 {
        return Err(range("invalid argument to Int31n"));
    }
    if n & (n - 1) == 0 {
        return Ok(v1_int31(rng) & (n - 1));
    }
    let max = (i32::MAX as u32 - ((1u32 << 31) % n as u32)) as i32;
    let mut v = v1_int31(rng);
    while v > max {
        v = v1_int31(rng);
    }
    Ok(v % n)
}

fn v1_int31n_fast(rng: &mut RngSource, n: i32) -> i32 {
    let v = v1_uint32(rng);
    let mut prod = u64::from(v) * u64::from(n as u32);
    let mut low = prod as u32;
    if low < n as u32 {
        let thresh = (n as u32).wrapping_neg() % (n as u32);
        while low < thresh {
            let v = v1_uint32(rng);
            prod = u64::from(v) * u64::from(n as u32);
            low = prod as u32;
        }
    }
    (prod >> 32) as i32
}

fn v1_intn(rng: &mut RngSource, n: i64) -> Result<i64> {
    if n <= 0 {
        return Err(range("invalid argument to Intn"));
    }
    if n <= i64::from(i32::MAX) {
        Ok(i64::from(v1_int31n(rng, n as i32)?))
    } else {
        v1_int63n(rng, n)
    }
}

fn abs_int32(i: i32) -> u32 {
    if i < 0 {
        i.wrapping_neg() as u32
    } else {
        i as u32
    }
}

fn sample_float64(src: &mut Inner) -> f64 {
    if src.is_v1() {
        match src {
            Inner::Rng(r) => r.float64(),
            _ => unreachable!(),
        }
    } else {
        v2_float64(src)
    }
}

fn v2_norm_float64(src: &mut Inner) -> f64 {
    loop {
        let u = src.uint64();
        let j = u as i32;
        let i = ((u >> 32) & 0x7F) as usize;
        let x = f64::from(j) * f64::from(crate::ziggurat::WN[i]);
        if abs_int32(j) < crate::ziggurat::KN[i] {
            return x;
        }
        if i == 0 {
            let tail = loop {
                let x = -sample_float64(src).ln() * (1.0 / crate::ziggurat::RN);
                let y = -sample_float64(src).ln();
                if y + y >= x * x {
                    break x;
                }
            };
            return if j > 0 {
                crate::ziggurat::RN + tail
            } else {
                -crate::ziggurat::RN - tail
            };
        }
        if crate::ziggurat::FN[i]
            + (sample_float64(src) as f32) * (crate::ziggurat::FN[i - 1] - crate::ziggurat::FN[i])
            < ((-0.5 * x * x).exp() as f32)
        {
            return x;
        }
    }
}

fn v1_norm_float64(rng: &mut RngSource) -> f64 {
    loop {
        let j = v1_uint32(rng) as i32;
        let i = (j as u32 & 0x7F) as usize;
        let x = f64::from(j) * f64::from(crate::ziggurat::WN[i]);
        if abs_int32(j) < crate::ziggurat::KN[i] {
            return x;
        }
        if i == 0 {
            let tail = loop {
                let x = -rng.float64().ln() * (1.0 / crate::ziggurat::RN);
                let y = -rng.float64().ln();
                if y + y >= x * x {
                    break x;
                }
            };
            return if j > 0 {
                crate::ziggurat::RN + tail
            } else {
                -crate::ziggurat::RN - tail
            };
        }
        if crate::ziggurat::FN[i]
            + (rng.float64() as f32) * (crate::ziggurat::FN[i - 1] - crate::ziggurat::FN[i])
            < ((-0.5 * x * x).exp() as f32)
        {
            return x;
        }
    }
}

fn v2_exp_float64(src: &mut Inner) -> f64 {
    loop {
        let u = src.uint64();
        let j = u as u32;
        let i = ((u >> 32) as u8) as usize;
        let x = f64::from(j) * f64::from(crate::ziggurat::WE[i]);
        if j < crate::ziggurat::KE[i] {
            return x;
        }
        if i == 0 {
            return crate::ziggurat::RE - sample_float64(src).ln();
        }
        if crate::ziggurat::FE[i]
            + (sample_float64(src) as f32) * (crate::ziggurat::FE[i - 1] - crate::ziggurat::FE[i])
            < ((-x).exp() as f32)
        {
            return x;
        }
    }
}

fn v1_exp_float64(rng: &mut RngSource) -> f64 {
    loop {
        let j = v1_uint32(rng);
        let i = (j & 0xFF) as usize;
        let x = f64::from(j) * f64::from(crate::ziggurat::WE[i]);
        if j < crate::ziggurat::KE[i] {
            return x;
        }
        if i == 0 {
            return crate::ziggurat::RE - rng.float64().ln();
        }
        if crate::ziggurat::FE[i]
            + (rng.float64() as f32) * (crate::ziggurat::FE[i - 1] - crate::ziggurat::FE[i])
            < ((-x).exp() as f32)
        {
            return x;
        }
    }
}

fn zipf_h(v: f64, oneminus_q: f64, oneminus_q_inv: f64, x: f64) -> f64 {
    (oneminus_q * (v + x).ln()).exp() * oneminus_q_inv
}

fn zipf_hinv(v: f64, oneminus_q: f64, oneminus_q_inv: f64, x: f64) -> f64 {
    (oneminus_q_inv * (oneminus_q * x).ln()).exp() - v
}

#[napi(object)]
pub struct ZipfParams {
    pub imax: f64,
    pub v: f64,
    pub q: f64,
    pub s: f64,
    pub oneminus_q: f64,
    pub oneminus_q_inv: f64,
    pub hxm: f64,
    pub hx0_minus_hxm: f64,
}

#[napi(js_name = "zipfParams")]
pub fn zipf_params(s: f64, v: f64, imax: f64) -> Result<ZipfParams> {
    if s <= 1.0 || v < 1.0 {
        return Err(range("invalid argument to Zipf"));
    }
    let q = s;
    let oneminus_q = 1.0 - q;
    let oneminus_q_inv = 1.0 / oneminus_q;
    let hxm = zipf_h(v, oneminus_q, oneminus_q_inv, imax + 0.5);
    let hx0_minus_hxm = zipf_h(v, oneminus_q, oneminus_q_inv, 0.5) - (v.ln() * (-q)).exp() - hxm;
    let s_hat = 1.0
        - zipf_hinv(
            v,
            oneminus_q,
            oneminus_q_inv,
            zipf_h(v, oneminus_q, oneminus_q_inv, 1.5) - ((-q) * (v + 1.0).ln()).exp(),
        );
    Ok(ZipfParams {
        imax,
        v,
        q,
        s: s_hat,
        oneminus_q,
        oneminus_q_inv,
        hxm,
        hx0_minus_hxm,
    })
}

fn shuffle_slice<T>(src: &mut Inner, arr: &mut [T]) {
    let n = arr.len();
    if src.is_v1() {
        let rng = match src {
            Inner::Rng(r) => r,
            _ => unreachable!(),
        };
        let mut i = n as i64 - 1;
        while i > (1i64 << 31) - 2 {
            let j = v1_int63n(rng, i + 1).expect("shuffle n > 0") as usize;
            arr.swap(i as usize, j);
            i -= 1;
        }
        while i > 0 {
            let j = v1_int31n_fast(rng, (i + 1) as i32) as usize;
            arr.swap(i as usize, j);
            i -= 1;
        }
        return;
    }
    for i in (1..n).rev() {
        let j = uint64n(src, (i + 1) as u64) as usize;
        arr.swap(i, j);
    }
}

#[napi]
pub struct NativeRand {
    inner: Inner,
    read_val: i64,
    read_pos: i8,
}

fn wrap(inner: Inner) -> NativeRand {
    NativeRand {
        inner,
        read_val: 0,
        read_pos: 0,
    }
}

#[napi]
impl NativeRand {
    #[napi(js_name = "isV1")]
    pub fn is_v1(&self) -> bool {
        self.inner.is_v1()
    }

    #[napi]
    pub fn uint64(&mut self) -> Result<BigInt> {
        Ok(u64_out(self.inner.uint64()))
    }

    #[napi(js_name = "uint64N")]
    pub fn uint64_n(&mut self, n: BigInt) -> Result<BigInt> {
        let n = u64_arg(n)?;
        if n == 0 {
            return Err(range("invalid argument to Uint64N"));
        }
        Ok(u64_out(uint64n(&mut self.inner, n)))
    }

    #[napi]
    pub fn uint32(&mut self) -> u32 {
        (self.inner.uint64() >> 32) as u32
    }

    #[napi(js_name = "uint32N")]
    pub fn uint32_n(&mut self, n: u32) -> Result<u32> {
        if n == 0 {
            return Err(range("invalid argument to Uint32N"));
        }
        Ok(uint64n(&mut self.inner, u64::from(n)) as u32)
    }

    #[napi]
    pub fn uint(&mut self) -> Result<BigInt> {
        Ok(u64_out(self.inner.uint64()))
    }

    #[napi(js_name = "uintN")]
    pub fn uint_n(&mut self, n: BigInt) -> Result<BigInt> {
        let n = u64_arg(n)?;
        if n == 0 {
            return Err(range("invalid argument to UintN"));
        }
        Ok(u64_out(uint64n(&mut self.inner, n)))
    }

    #[napi]
    pub fn int64(&mut self) -> Result<BigInt> {
        Ok(u64_out(self.inner.uint64() & !(1u64 << 63)))
    }

    #[napi(js_name = "int64N")]
    pub fn int64_n(&mut self, n: BigInt) -> Result<BigInt> {
        let n = i64_arg(n)?;
        if n <= 0 {
            return Err(range("invalid argument to Int64N"));
        }
        Ok(u64_out(uint64n(&mut self.inner, n as u64)))
    }

    #[napi]
    pub fn int32(&mut self) -> i32 {
        (self.inner.uint64() >> 33) as i32
    }

    #[napi(js_name = "int32N")]
    pub fn int32_n(&mut self, n: i32) -> Result<i32> {
        if n <= 0 {
            return Err(range("invalid argument to Int32N"));
        }
        Ok(uint64n(&mut self.inner, n as u64) as i32)
    }

    #[napi(js_name = "int")]
    pub fn int_value(&mut self) -> Result<BigInt> {
        Ok(u64_out(self.inner.uint64() << 1 >> 1))
    }

    #[napi(js_name = "intN")]
    pub fn int_n(&mut self, n: i64) -> Result<i64> {
        if n <= 0 {
            return Err(range("invalid argument to IntN"));
        }
        Ok(uint64n(&mut self.inner, n as u64) as i64)
    }

    #[napi]
    pub fn int63(&mut self) -> Result<BigInt> {
        Ok(u64_out(self.inner.rng()?.int63() as u64))
    }

    #[napi(js_name = "int63n")]
    pub fn int63n(&mut self, n: BigInt) -> Result<BigInt> {
        let n = i64_arg(n)?;
        Ok(u64_out(v1_int63n(self.inner.rng()?, n)? as u64))
    }

    #[napi]
    pub fn int31(&mut self) -> Result<i32> {
        Ok(v1_int31(self.inner.rng()?))
    }

    #[napi(js_name = "int31n")]
    pub fn int31n(&mut self, n: i32) -> Result<i32> {
        v1_int31n(self.inner.rng()?, n)
    }

    #[napi(js_name = "intn")]
    pub fn intn(&mut self, n: i64) -> Result<i64> {
        v1_intn(self.inner.rng()?, n)
    }

    #[napi(js_name = "uint32v1")]
    pub fn uint32_v1(&mut self) -> Result<u32> {
        Ok(v1_uint32(self.inner.rng()?))
    }

    #[napi]
    pub fn float64(&mut self) -> Result<f64> {
        if self.inner.is_v1() {
            Ok(self.inner.rng()?.float64())
        } else {
            Ok(v2_float64(&mut self.inner))
        }
    }

    #[napi]
    pub fn float32(&mut self) -> Result<f32> {
        if self.inner.is_v1() {
            loop {
                let f = self.inner.rng()?.float64() as f32;
                if f != 1.0 {
                    return Ok(f);
                }
            }
        } else {
            Ok(v2_float32(&mut self.inner))
        }
    }

    #[napi(js_name = "shuffleInPlaceU32")]
    pub fn shuffle_in_place_u32(&mut self, mut arr: Uint32Array) -> Result<()> {
        shuffle_slice(&mut self.inner, unsafe { arr.as_mut() });
        Ok(())
    }

    #[napi(js_name = "shuffleInPlaceF64")]
    pub fn shuffle_in_place_f64(&mut self, mut arr: Float64Array) -> Result<()> {
        shuffle_slice(&mut self.inner, unsafe { arr.as_mut() });
        Ok(())
    }

    #[napi(js_name = "normFloat64")]
    pub fn norm_float64(&mut self) -> Result<f64> {
        if self.inner.is_v1() {
            Ok(v1_norm_float64(self.inner.rng()?))
        } else {
            Ok(v2_norm_float64(&mut self.inner))
        }
    }

    #[napi(js_name = "expFloat64")]
    pub fn exp_float64(&mut self) -> Result<f64> {
        if self.inner.is_v1() {
            Ok(v1_exp_float64(self.inner.rng()?))
        } else {
            Ok(v2_exp_float64(&mut self.inner))
        }
    }

    #[napi(js_name = "zipfUint64")]
    pub fn zipf_uint64(&mut self, p: ZipfParams) -> Result<BigInt> {
        loop {
            let r = sample_float64(&mut self.inner);
            let ur = p.hxm + r * p.hx0_minus_hxm;
            let x = zipf_hinv(p.v, p.oneminus_q, p.oneminus_q_inv, ur);
            let k = (x + 0.5).floor();
            if k - x <= p.s {
                return Ok(u64_out(k as u64));
            }
            if ur
                >= zipf_h(p.v, p.oneminus_q, p.oneminus_q_inv, k + 0.5)
                    - (-(k + p.v).ln() * p.q).exp()
            {
                return Ok(u64_out(k as u64));
            }
        }
    }

    #[napi]
    pub fn read(&mut self, n: u32) -> Result<Buffer> {
        match &mut self.inner {
            Inner::Rng(r) => {
                let mut buf = vec![0u8; n as usize];
                r.read(&mut buf, &mut self.read_val, &mut self.read_pos);
                Ok(Buffer::from(buf))
            }
            _ => Err(range("math/rand: Read is a v1 API")),
        }
    }

    #[napi]
    pub fn state(&self) -> Result<Buffer> {
        let bytes = match &self.inner {
            Inner::Pcg(p) => p.marshal(),
            Inner::ChaCha8(c) => c.marshal(),
            Inner::Rng(_) => {
                return Err(range("math/rand: v1 rngSource has no MarshalBinary"));
            }
        };
        Ok(Buffer::from(bytes))
    }
}

#[napi]
pub fn new_pcg(seed1: BigInt, seed2: BigInt) -> Result<NativeRand> {
    Ok(wrap(Inner::Pcg(Pcg::new(u64_arg(seed1)?, u64_arg(seed2)?))))
}

#[napi(js_name = "newChaCha8")]
pub fn new_chacha8(seed: Uint8Array) -> Result<NativeRand> {
    let seed = seed.as_ref();
    if seed.len() != 32 {
        return Err(range("math/rand: ChaCha8 seed must be 32 bytes"));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(seed);
    Ok(wrap(Inner::ChaCha8(ChaCha8::new(&arr))))
}

#[napi(js_name = "newSource")]
pub fn new_source(seed: BigInt) -> Result<NativeRand> {
    Ok(wrap(Inner::Rng(RngSource::seed(i64_arg(seed)?))))
}

#[napi]
pub fn rand_from_state(state: Uint8Array) -> Result<NativeRand> {
    let data = state.as_ref();
    if data.starts_with(b"pcg:") {
        return Ok(wrap(Inner::Pcg(Pcg::unmarshal(data)?)));
    }
    if data.starts_with(b"readbuf:") || data.starts_with(b"chacha8:") {
        return Ok(wrap(Inner::ChaCha8(ChaCha8::unmarshal(data)?)));
    }
    Err(range("invalid PCG encoding"))
}
