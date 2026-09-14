use napi::bindgen_prelude::*;
use napi_derive::napi;
use siphasher::sip::SipHasher13;
use std::hash::Hasher;
use std::sync::Arc;

fn error(code: &str, message: &str) -> Error {
    Error::new(Status::InvalidArg, format!("{code}: {message}"))
}

const IEEE: u32 = 0xedb88320;
const OFFSET32: u32 = 2_166_136_261;
const PRIME32: u32 = 16_777_619;
const OFFSET64: u64 = 14_695_981_039_346_656_037;
const PRIME64: u64 = 1_099_511_628_211;
const OFFSET128_HI: u64 = 0x6c62272e07bb0142;
const OFFSET128_LO: u64 = 0x62b821756295c58d;
const PRIME128_LOWER: u64 = 0x13b;
const PRIME128_SHIFT: u32 = 24;

fn make_crc32_table(poly: u32) -> [u32; 256] {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut crc = i as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ poly
            } else {
                crc >> 1
            };
        }
        *slot = crc;
    }
    table
}

fn make_crc64_table(poly: u64) -> [u64; 256] {
    let mut table = [0u64; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut crc = i as u64;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ poly
            } else {
                crc >> 1
            };
        }
        *slot = crc;
    }
    table
}

fn crc32_table_update(mut crc: u32, table: &[u32; 256], data: &[u8]) -> u32 {
    crc = !crc;
    for &b in data {
        crc = table[((crc as u8) ^ b) as usize] ^ (crc >> 8);
    }
    !crc
}

fn crc32_update(crc: u32, poly: u32, table: Option<&[u32; 256]>, data: &[u8]) -> u32 {
    if poly == IEEE {
        let mut hasher = crc32fast::Hasher::new_with_initial(crc);
        hasher.update(data);
        hasher.finalize()
    } else if let Some(table) = table {
        crc32_table_update(crc, table, data)
    } else {
        crc32_table_update(crc, &make_crc32_table(poly), data)
    }
}

fn crc64_update(mut crc: u64, table: &[u64; 256], data: &[u8]) -> u64 {
    crc = !crc;
    for &b in data {
        crc = table[((crc as u8) ^ b) as usize] ^ (crc >> 8);
    }
    !crc
}

fn fnv128_mul(hi: &mut u64, lo: &mut u64) {
    let prod = u128::from(PRIME128_LOWER) * u128::from(*lo);
    let prod_lo = prod as u64;
    let prod_hi = (prod >> 64) as u64;
    let new_hi = prod_hi
        .wrapping_add(*lo << PRIME128_SHIFT)
        .wrapping_add(PRIME128_LOWER.wrapping_mul(*hi));
    *lo = prod_lo;
    *hi = new_hi;
}

fn fnv128_write(hi: &mut u64, lo: &mut u64, data: &[u8], a: bool) {
    for &b in data {
        if a {
            *lo ^= u64::from(b);
            fnv128_mul(hi, lo);
        } else {
            fnv128_mul(hi, lo);
            *lo ^= u64::from(b);
        }
    }
}

fn be32(v: u32) -> [u8; 4] {
    v.to_be_bytes()
}
fn be64(v: u64) -> [u8; 8] {
    v.to_be_bytes()
}
fn be128(hi: u64, lo: u64) -> [u8; 16] {
    let mut out = [0u8; 16];
    out[..8].copy_from_slice(&hi.to_be_bytes());
    out[8..].copy_from_slice(&lo.to_be_bytes());
    out
}

fn u64_from_bigint(value: &BigInt) -> Result<u64> {
    let (signed, n, lossless) = value.get_u64();
    if signed || !lossless {
        return Err(error(
            "ChecksumError",
            "checksum: expected an unsigned 64-bit integer",
        ));
    }
    Ok(n)
}

fn u128_from_bigint(value: &BigInt) -> Result<u128> {
    let (signed, n, lossless) = value.get_u128();
    if signed || !lossless {
        return Err(error(
            "ChecksumError",
            "checksum: expected an unsigned 128-bit integer",
        ));
    }
    Ok(n)
}

fn bigint_u64(n: u64) -> BigInt {
    BigInt::from(n)
}

fn bigint_u128(n: u128) -> BigInt {
    BigInt::from(n)
}

fn split_seed(seed: &BigInt) -> Result<(u64, u64)> {
    let n = u128_from_bigint(seed)?;
    if n == 0 {
        return Err(error(
            "UninitializedSeedError",
            "maphash: use of uninitialized Seed",
        ));
    }
    Ok(((n >> 64) as u64, n as u64))
}

fn join_seed(k0: u64, k1: u64) -> u128 {
    (u128::from(k0) << 64) | u128::from(k1)
}

fn sip(k0: u64, k1: u64) -> SipHasher13 {
    SipHasher13::new_with_keys(k0, k1)
}

#[napi]
pub struct Crc32Table {
    poly: u32,
    table: Arc<[u32; 256]>,
}

#[napi]
impl Crc32Table {
    #[napi(constructor)]
    pub fn new(poly: u32) -> Self {
        Self {
            poly,
            table: Arc::new(make_crc32_table(poly)),
        }
    }

    #[napi]
    pub fn checksum(&self, data: Uint8Array, seed: Option<u32>) -> u32 {
        crc32_update(seed.unwrap_or(0), self.poly, Some(self.table.as_ref()), data.as_ref())
    }

    #[napi]
    pub fn update(&self, crc: u32, data: Uint8Array) -> u32 {
        crc32_update(crc, self.poly, Some(self.table.as_ref()), data.as_ref())
    }

    #[napi(getter)]
    pub fn poly(&self) -> u32 {
        self.poly
    }
}

#[napi]
pub struct Crc64Table {
    table: Arc<[u64; 256]>,
}

#[napi]
impl Crc64Table {
    #[napi(constructor)]
    pub fn new(poly: BigInt) -> Result<Self> {
        Ok(Self {
            table: Arc::new(make_crc64_table(u64_from_bigint(&poly)?)),
        })
    }

    #[napi]
    pub fn checksum(&self, data: Uint8Array, seed: Option<BigInt>) -> Result<BigInt> {
        let seed = match seed {
            Some(v) => u64_from_bigint(&v)?,
            None => 0,
        };
        Ok(bigint_u64(crc64_update(seed, self.table.as_ref(), data.as_ref())))
    }

    #[napi]
    pub fn update(&self, crc: BigInt, data: Uint8Array) -> Result<BigInt> {
        Ok(bigint_u64(crc64_update(
            u64_from_bigint(&crc)?,
            self.table.as_ref(),
            data.as_ref(),
        )))
    }
}

enum State {
    Adler32(adler2::Adler32),
    Crc32 {
        crc: u32,
        poly: u32,
        table: Arc<[u32; 256]>,
    },
    Crc64 {
        crc: u64,
        table: Arc<[u64; 256]>,
    },
    Fnv32 {
        hash: u32,
        a: bool,
    },
    Fnv64 {
        hash: u64,
        a: bool,
    },
    Fnv128 {
        hi: u64,
        lo: u64,
        a: bool,
    },
    MapHash {
        k0: u64,
        k1: u64,
        hasher: SipHasher13,
    },
}

impl Clone for State {
    fn clone(&self) -> Self {
        match self {
            Self::Adler32(h) => Self::Adler32(h.clone()),
            Self::Crc32 { crc, poly, table } => Self::Crc32 {
                crc: *crc,
                poly: *poly,
                table: Arc::clone(table),
            },
            Self::Crc64 { crc, table } => Self::Crc64 {
                crc: *crc,
                table: Arc::clone(table),
            },
            Self::Fnv32 { hash, a } => Self::Fnv32 {
                hash: *hash,
                a: *a,
            },
            Self::Fnv64 { hash, a } => Self::Fnv64 {
                hash: *hash,
                a: *a,
            },
            Self::Fnv128 { hi, lo, a } => Self::Fnv128 {
                hi: *hi,
                lo: *lo,
                a: *a,
            },
            Self::MapHash { k0, k1, hasher } => Self::MapHash {
                k0: *k0,
                k1: *k1,
                hasher: hasher.clone(),
            },
        }
    }
}

impl State {
    fn update(&mut self, data: &[u8]) {
        match self {
            Self::Adler32(h) => h.write_slice(data),
            Self::Crc32 { crc, poly, table } => {
                *crc = crc32_update(*crc, *poly, Some(table.as_ref()), data)
            }
            Self::Crc64 { crc, table } => *crc = crc64_update(*crc, table.as_ref(), data),
            Self::Fnv32 { hash, a } => {
                for &b in data {
                    if *a {
                        *hash ^= u32::from(b);
                        *hash = hash.wrapping_mul(PRIME32);
                    } else {
                        *hash = hash.wrapping_mul(PRIME32);
                        *hash ^= u32::from(b);
                    }
                }
            }
            Self::Fnv64 { hash, a } => {
                for &b in data {
                    if *a {
                        *hash ^= u64::from(b);
                        *hash = hash.wrapping_mul(PRIME64);
                    } else {
                        *hash = hash.wrapping_mul(PRIME64);
                        *hash ^= u64::from(b);
                    }
                }
            }
            Self::Fnv128 { hi, lo, a } => fnv128_write(hi, lo, data, *a),
            Self::MapHash { hasher, .. } => hasher.write(data),
        }
    }

    fn digest(&self) -> Vec<u8> {
        match self {
            Self::Adler32(h) => be32(h.checksum()).to_vec(),
            Self::Crc32 { crc, .. } => be32(*crc).to_vec(),
            Self::Crc64 { crc, .. } => be64(*crc).to_vec(),
            Self::Fnv32 { hash, .. } => be32(*hash).to_vec(),
            Self::Fnv64 { hash, .. } => be64(*hash).to_vec(),
            Self::Fnv128 { hi, lo, .. } => be128(*hi, *lo).to_vec(),
            Self::MapHash { hasher, .. } => be64(hasher.finish()).to_vec(),
        }
    }

    fn digest32(&self) -> Result<u32> {
        match self {
            Self::Adler32(h) => Ok(h.checksum()),
            Self::Crc32 { crc, .. } => Ok(*crc),
            Self::Fnv32 { hash, .. } => Ok(*hash),
            _ => Err(error(
                "ChecksumError",
                "checksum: digest32 requires a 32-bit hash",
            )),
        }
    }

    fn digest64(&self) -> Result<u64> {
        match self {
            Self::Crc64 { crc, .. } => Ok(*crc),
            Self::Fnv64 { hash, .. } => Ok(*hash),
            Self::MapHash { hasher, .. } => Ok(hasher.finish()),
            _ => Err(error(
                "ChecksumError",
                "checksum: digest64 requires a 64-bit hash",
            )),
        }
    }

    fn digest128(&self) -> Result<u128> {
        match self {
            Self::Fnv128 { hi, lo, .. } => Ok((u128::from(*hi) << 64) | u128::from(*lo)),
            _ => Err(error(
                "ChecksumError",
                "checksum: digest128 requires a 128-bit hash",
            )),
        }
    }

    fn size(&self) -> u32 {
        match self {
            Self::Adler32(_) | Self::Crc32 { .. } | Self::Fnv32 { .. } => 4,
            Self::Crc64 { .. } | Self::Fnv64 { .. } | Self::MapHash { .. } => 8,
            Self::Fnv128 { .. } => 16,
        }
    }

    fn block_size(&self) -> u32 {
        match self {
            Self::MapHash { .. } => 128,
            _ => 1,
        }
    }

    fn seed(&self) -> Result<u128> {
        match self {
            Self::MapHash { k0, k1, .. } => Ok(join_seed(*k0, *k1)),
            _ => Err(error(
                "ChecksumError",
                "checksum: seed() is only defined for MapHash",
            )),
        }
    }

    fn set_seed(&mut self, k0: u64, k1: u64) -> Result<()> {
        match self {
            Self::MapHash {
                k0: a,
                k1: b,
                hasher,
            } => {
                *a = k0;
                *b = k1;
                *hasher = sip(k0, k1);
                Ok(())
            }
            _ => Err(error(
                "ChecksumError",
                "checksum: setSeed is only defined for MapHash",
            )),
        }
    }
}

#[napi]
pub struct NativeHash {
    state: State,
    initial: State,
}

impl NativeHash {
    fn wrap(state: State) -> Self {
        Self {
            initial: state.clone(),
            state,
        }
    }
}

#[napi]
impl NativeHash {
    #[napi(factory)]
    pub fn adler32(seed: Option<u32>) -> Self {
        let state = match seed {
            Some(sum) => State::Adler32(adler2::Adler32::from_checksum(sum)),
            None => State::Adler32(adler2::Adler32::new()),
        };
        Self::wrap(state)
    }

    #[napi(factory)]
    pub fn crc32(table: &Crc32Table) -> Self {
        Self::wrap(State::Crc32 {
            crc: 0,
            poly: table.poly,
            table: Arc::clone(&table.table),
        })
    }

    #[napi(factory)]
    pub fn crc64(table: &Crc64Table) -> Self {
        Self::wrap(State::Crc64 {
            crc: 0,
            table: Arc::clone(&table.table),
        })
    }

    #[napi(factory)]
    pub fn fnv32(a: bool) -> Self {
        Self::wrap(State::Fnv32 {
            hash: OFFSET32,
            a,
        })
    }

    #[napi(factory)]
    pub fn fnv64(a: bool) -> Self {
        Self::wrap(State::Fnv64 {
            hash: OFFSET64,
            a,
        })
    }

    #[napi(factory)]
    pub fn fnv128(a: bool) -> Self {
        Self::wrap(State::Fnv128 {
            hi: OFFSET128_HI,
            lo: OFFSET128_LO,
            a,
        })
    }

    #[napi(factory)]
    pub fn maphash(seed: BigInt) -> Result<Self> {
        let (k0, k1) = split_seed(&seed)?;
        Ok(Self::wrap(State::MapHash {
            k0,
            k1,
            hasher: sip(k0, k1),
        }))
    }

    #[napi]
    pub fn update(&mut self, data: Uint8Array) {
        self.state.update(data.as_ref());
    }

    #[napi]
    pub fn digest(&self) -> Uint8Array {
        self.state.digest().into()
    }

    #[napi]
    pub fn digest32(&self) -> Result<u32> {
        self.state.digest32()
    }

    #[napi]
    pub fn digest64(&self) -> Result<BigInt> {
        Ok(bigint_u64(self.state.digest64()?))
    }

    #[napi]
    pub fn digest128(&self) -> Result<BigInt> {
        Ok(bigint_u128(self.state.digest128()?))
    }

    #[napi]
    pub fn reset(&mut self) {
        self.state = self.initial.clone();
    }

    #[napi]
    pub fn clone_hash(&self) -> Self {
        Self {
            state: self.state.clone(),
            initial: self.initial.clone(),
        }
    }

    #[napi]
    pub fn size(&self) -> u32 {
        self.state.size()
    }

    #[napi]
    pub fn block_size(&self) -> u32 {
        self.state.block_size()
    }

    #[napi]
    pub fn seed(&self) -> Result<BigInt> {
        Ok(bigint_u128(self.state.seed()?))
    }

    #[napi]
    pub fn set_seed(&mut self, seed: BigInt) -> Result<()> {
        let (k0, k1) = split_seed(&seed)?;
        self.state.set_seed(k0, k1)?;
        self.initial.set_seed(k0, k1)?;
        Ok(())
    }
}

#[napi]
pub fn adler32(data: Uint8Array, seed: Option<u32>) -> u32 {
    let mut hasher = match seed {
        Some(sum) => adler2::Adler32::from_checksum(sum),
        None => adler2::Adler32::new(),
    };
    hasher.write_slice(data.as_ref());
    hasher.checksum()
}

#[napi]
pub fn crc32_ieee(data: Uint8Array, seed: Option<u32>) -> u32 {
    crc32_update(seed.unwrap_or(0), IEEE, None, data.as_ref())
}

#[napi]
pub fn crc32_poly(data: Uint8Array, poly: u32, seed: Option<u32>) -> u32 {
    crc32_update(seed.unwrap_or(0), poly, None, data.as_ref())
}

#[napi]
pub fn crc64_poly(data: Uint8Array, poly: BigInt, seed: Option<BigInt>) -> Result<BigInt> {
    let table = make_crc64_table(u64_from_bigint(&poly)?);
    let seed = match seed {
        Some(v) => u64_from_bigint(&v)?,
        None => 0,
    };
    Ok(bigint_u64(crc64_update(seed, &table, data.as_ref())))
}

#[napi]
pub fn fnv32(data: Uint8Array, a: bool) -> u32 {
    let mut h = NativeHash::fnv32(a);
    h.update(data);
    h.digest32().expect("fnv32")
}

#[napi]
pub fn fnv64(data: Uint8Array, a: bool) -> BigInt {
    let mut h = NativeHash::fnv64(a);
    h.update(data);
    h.digest64().expect("fnv64")
}

#[napi]
pub fn fnv128(data: Uint8Array, a: bool) -> Uint8Array {
    let mut h = NativeHash::fnv128(a);
    h.update(data);
    h.digest()
}

#[napi]
pub fn maphash_bytes(seed: BigInt, data: Uint8Array) -> Result<BigInt> {
    let (k0, k1) = split_seed(&seed)?;
    let mut hasher = sip(k0, k1);
    hasher.write(data.as_ref());
    Ok(bigint_u64(hasher.finish()))
}
