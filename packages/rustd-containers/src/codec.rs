//! Go index/suffixarray Read/Write private format (Go 1.24.13).

const MAX_VARINT_LEN64: usize = 10;
const BUF_SIZE: usize = 16 << 10;

pub fn write_index(data: &[u8], sa: &[i32]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = vec![0u8; BUF_SIZE];
    write_int(&mut out, &mut buf, data.len() as i64);
    out.extend_from_slice(data);
    let mut offset = 0usize;
    while offset < sa.len() {
        offset += write_slice(&mut out, &mut buf, &sa[offset..]);
    }
    out
}

pub fn read_index(bytes: &[u8]) -> Result<(Vec<u8>, Vec<i32>), String> {
    let mut pos = 0usize;
    let n64 = read_int(bytes, &mut pos)?;
    if n64 < 0 || n64 > i32::MAX as i64 {
        return Err("suffixarray: data too large".into());
    }
    let n = n64 as usize;
    let rest = bytes.len().saturating_sub(pos);
    if n > rest {
        return Err("suffixarray: truncated data".into());
    }
    let data = bytes[pos..pos + n].to_vec();
    pos += n;
    let mut sa = vec![0i32; n];
    let mut filled = 0usize;
    while filled < n {
        let got = read_slice(bytes, &mut pos, &mut sa[filled..])?;
        if got == 0 {
            return Err("suffixarray: zero-length slice".into());
        }
        filled += got;
    }
    Ok((data, sa))
}

fn put_uvarint(buf: &mut [u8], mut x: u64) -> usize {
    let mut i = 0;
    while x >= 0x80 {
        buf[i] = (x as u8) | 0x80;
        x >>= 7;
        i += 1;
    }
    buf[i] = x as u8;
    i + 1
}

fn put_varint(buf: &mut [u8], x: i64) -> usize {
    let mut ux = (x as u64) << 1;
    if x < 0 {
        ux = !ux;
    }
    put_uvarint(buf, ux)
}

fn uvarint(buf: &[u8]) -> Result<(u64, usize), String> {
    let mut x = 0u64;
    let mut s = 0u32;
    for (i, &b) in buf.iter().enumerate() {
        if b < 0x80 {
            if i > 9 || i == 9 && b > 1 {
                return Err("suffixarray: uvarint overflow".into());
            }
            return Ok((x | (u64::from(b) << s), i + 1));
        }
        x |= u64::from(b & 0x7f) << s;
        s += 7;
    }
    Err("suffixarray: uvarint truncated".into())
}

fn varint(buf: &[u8]) -> Result<(i64, usize), String> {
    let (ux, n) = uvarint(buf)?;
    let mut x = (ux >> 1) as i64;
    if ux & 1 != 0 {
        x = !x;
    }
    Ok((x, n))
}

fn write_int(out: &mut Vec<u8>, buf: &mut [u8], x: i64) {
    put_varint(buf, x);
    out.extend_from_slice(&buf[..MAX_VARINT_LEN64]);
}

fn read_int(bytes: &[u8], pos: &mut usize) -> Result<i64, String> {
    if *pos + MAX_VARINT_LEN64 > bytes.len() {
        return Err("suffixarray: truncated int".into());
    }
    let (x, _) = varint(&bytes[*pos..*pos + MAX_VARINT_LEN64])?;
    *pos += MAX_VARINT_LEN64;
    Ok(x)
}

fn write_slice(out: &mut Vec<u8>, buf: &mut [u8], data: &[i32]) -> usize {
    let mut p = MAX_VARINT_LEN64;
    let mut n = 0usize;
    while n < data.len() && p + MAX_VARINT_LEN64 <= buf.len() {
        p += put_uvarint(&mut buf[p..], data[n] as u32 as u64);
        n += 1;
    }
    put_varint(buf, p as i64);
    out.extend_from_slice(&buf[..p]);
    n
}

fn read_slice(bytes: &[u8], pos: &mut usize, data: &mut [i32]) -> Result<usize, String> {
    let size64 = read_int(bytes, pos)?;
    if size64 < MAX_VARINT_LEN64 as i64 || size64 > BUF_SIZE as i64 {
        return Err("suffixarray: data too large".into());
    }
    let size = size64 as usize;
    let payload = size - MAX_VARINT_LEN64;
    if *pos + payload > bytes.len() {
        return Err("suffixarray: truncated slice".into());
    }
    let chunk = &bytes[*pos - MAX_VARINT_LEN64..*pos + payload];
    *pos += payload;
    let mut n = 0usize;
    let mut p = MAX_VARINT_LEN64;
    while p < size {
        if n >= data.len() {
            return Err("suffixarray: slice longer than remaining index".into());
        }
        let (x, w) = uvarint(&chunk[p..size])?;
        if w == 0 {
            return Err("suffixarray: zero-width uvarint".into());
        }
        if x > i32::MAX as u64 {
            return Err("suffixarray: sa entry out of range".into());
        }
        data[n] = x as i32;
        n += 1;
        p += w;
    }
    Ok(n)
}
