mod lzw_go;

use bzip2_rs::decoder::{Decoder, ReadState, WriteState};
use lzw_go::{decode_all as lzw_go_decode, GoEncoder};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use weezl::BitOrder;

fn fail(kind: &str, loc: u64, message: impl AsRef<str>) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("{kind}:{loc}:{}", message.as_ref()),
    )
}

fn bzip_reason(err: impl std::fmt::Display) -> String {
    let text = err.to_string();
    let reason = text
        .strip_prefix("bzip2 data invalid: ")
        .unwrap_or(text.as_str());
    let reason = reason.strip_prefix("header: ").unwrap_or(reason);
    let reason = reason.strip_prefix("block: ").unwrap_or(reason);
    if reason.contains("truncated")
        || reason.contains("unexpected EOF")
        || reason == "EOF"
        || reason.ends_with(": EOF")
    {
        return "unexpected EOF".into();
    }
    match reason {
        "invalid file signature" | "invalid magic" | "bad magic value" => {
            "bad magic value".into()
        }
        "bad magic value found" => "bad magic value found".into(),
        "unsupported bzip2 version" => "non-Huffman entropy encoding".into(),
        "invalid block-size" => "invalid compression level".into(),
        "orig_ptr out of bounds" => "origPtr out of bounds".into(),
        "huffman length out of range" => "Huffman length out of range".into(),
        "bad crc" => "block checksum mismatch".into(),
        "file checksum mismatch" => "file checksum mismatch".into(),
        "randomised expected to be 'normal'" => "deprecated randomized files".into(),
        other => other.to_string(),
    }
}

fn bzip_err(offset: u64, err: impl std::fmt::Display) -> Error {
    let reason = bzip_reason(err);
    // Go's io.ReadAll on a truncated stream returns "unexpected EOF" with no
    // StructuralError prefix; keep that wording so fixture strings match.
    if reason == "unexpected EOF" {
        return fail("Bzip2FormatError", offset, reason);
    }
    fail(
        "Bzip2FormatError",
        offset,
        format!("bzip2 data invalid: {reason}"),
    )
}

fn lzw_fmt(bit_offset: u64, message: impl AsRef<str>) -> Error {
    fail("LzwFormatError", bit_offset, message.as_ref())
}

fn lzw_decode_all(order: BitOrder, lit_width: u8, data: &[u8]) -> Result<Vec<u8>> {
    lzw_go_decode(order, lit_width, data).map_err(|err| {
        lzw_fmt((data.len() as u64).saturating_mul(8), err.message())
    })
}

fn bit_order(order: &str) -> Result<BitOrder> {
    match order {
        "lsb" => Ok(BitOrder::Lsb),
        "msb" => Ok(BitOrder::Msb),
        _ => Err(fail(
            "LzwConfigError",
            0,
            format!("lzw: unknown order"),
        )),
    }
}

fn require_lit_width(lit_width: u32) -> Result<u8> {
    if (2..=8).contains(&lit_width) {
        Ok(lit_width as u8)
    } else {
        Err(fail(
            "LzwConfigError",
            0,
            format!("lzw: litWidth {lit_width} out of range"),
        ))
    }
}

fn pump_bzip(
    decoder: &mut Decoder,
    input: &mut Vec<u8>,
    output: &mut Vec<u8>,
    offset: &mut u64,
    ended: bool,
) -> Result<bool> {
    let mut buf = [0u8; 16 * 1024];
    loop {
        match decoder.read(&mut buf).map_err(|err| bzip_err(*offset, err))? {
            ReadState::NeedsWrite(_) => {
                if input.is_empty() {
                    if ended {
                        match decoder
                            .write(&[])
                            .map_err(|err| bzip_err(*offset, err))?
                        {
                            WriteState::NeedsRead => continue,
                            WriteState::Written(_) => continue,
                        }
                    }
                    return Ok(false);
                }
                match decoder
                    .write(input)
                    .map_err(|err| bzip_err(*offset, err))?
                {
                    WriteState::NeedsRead => {}
                    WriteState::Written(n) => {
                        input.drain(..n);
                        *offset += n as u64;
                    }
                }
            }
            ReadState::Read(n) => output.extend_from_slice(&buf[..n]),
            ReadState::Eof => return Ok(true),
        }
    }
}

fn decode_member(data: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = Decoder::new();
    let mut input = data.to_vec();
    let mut output = Vec::new();
    let mut offset = 0u64;
    let mut buf = [0u8; 16 * 1024];
    let mut empty_writes = 0u8;
    for _ in 0..1_000_000 {
        match decoder.read(&mut buf).map_err(|err| bzip_err(offset, err))? {
            ReadState::NeedsWrite(_) => {
                if input.is_empty() {
                    empty_writes += 1;
                    if empty_writes > 8 {
                        return Err(bzip_err(offset, "unexpected EOF"));
                    }
                    decoder.write(&[]).map_err(|err| bzip_err(offset, err))?;
                    continue;
                }
                empty_writes = 0;
                match decoder.write(&input).map_err(|err| bzip_err(offset, err))? {
                    WriteState::NeedsRead => {}
                    WriteState::Written(n) => {
                        input.drain(..n);
                        offset += n as u64;
                    }
                }
            }
            ReadState::Read(n) => {
                empty_writes = 0;
                output.extend_from_slice(&buf[..n]);
            }
            ReadState::Eof => return Ok(output),
        }
    }
    Err(bzip_err(offset, "unexpected EOF"))
}

fn min_member_len(data: &[u8]) -> Result<usize> {
    if data.is_empty() {
        return Err(bzip_err(0, "unexpected EOF"));
    }
    let mut lo = 1usize;
    let mut hi = data.len();
    let mut ans = None;
    while lo <= hi {
        let mid = lo + (hi - lo) / 2;
        match decode_member(&data[..mid]) {
            Ok(_) => {
                ans = Some(mid);
                if mid == 0 {
                    break;
                }
                hi = mid - 1;
            }
            Err(_) => lo = mid + 1,
        }
    }
    ans.ok_or_else(|| bzip_err(data.len() as u64, "unexpected EOF"))
}

fn decompress_all(data: &[u8]) -> Result<Vec<u8>> {
    if data.is_empty() {
        return Err(bzip_err(0, "unexpected EOF"));
    }
    let mut rest = data;
    let mut output = Vec::new();
    while !rest.is_empty() {
        // Decode the remaining bytes first so header/CRC errors surface instead
        // of being swallowed by the concat splitter's binary search.
        decode_member(rest)?;
        let n = min_member_len(rest)?;
        output.extend(decode_member(&rest[..n])?);
        rest = &rest[n..];
    }
    Ok(output)
}

fn take_out(output: &mut Vec<u8>, max_bytes: Option<u32>) -> Uint8Array {
    let n = match max_bytes {
        Some(max) => (max as usize).min(output.len()),
        None => output.len(),
    };
    output.drain(..n).collect::<Vec<u8>>().into()
}

fn lzw_encode_all(order: BitOrder, lit_width: u8, data: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = GoEncoder::new(order, lit_width);
    encoder
        .write(data)
        .map_err(|err| fail("LzwConfigError", 0, err))?;
    Ok(encoder.finish())
}



#[napi]
pub fn bzip2_decompress(data: Uint8Array) -> Result<Uint8Array> {
    Ok(decompress_all(data.as_ref())?.into())
}

#[napi]
pub fn lzw_compress(data: Uint8Array, order: String, lit_width: u32) -> Result<Uint8Array> {
    let width = require_lit_width(lit_width)?;
    Ok(lzw_encode_all(bit_order(&order)?, width, data.as_ref())?.into())
}

#[napi]
pub fn lzw_decompress(data: Uint8Array, order: String, lit_width: u32) -> Result<Uint8Array> {
    let width = require_lit_width(lit_width)?;
    Ok(lzw_decode_all(bit_order(&order)?, width, data.as_ref())?.into())
}

fn restart_concat(decoder: &mut Decoder, input: &mut Vec<u8>) {
    let unread = decoder.unread_bytes().to_vec();
    *decoder = Decoder::new();
    if unread.is_empty() {
        return;
    }
    let mut rest = unread;
    rest.extend_from_slice(input);
    *input = rest;
}

fn looks_like_member(bytes: &[u8]) -> bool {
    bytes.len() >= 3 && bytes.starts_with(b"BZh")
}

fn pump_members(
    decoder: &mut Decoder,
    input: &mut Vec<u8>,
    output: &mut Vec<u8>,
    offset: &mut u64,
    ended: bool,
) -> Result<bool> {
    loop {
        let member_eof = pump_bzip(decoder, input, output, offset, ended)?;
        if !member_eof {
            return Ok(false);
        }
        let unread = decoder.unread_bytes();
        if looks_like_member(unread) || (unread.is_empty() && looks_like_member(input)) {
            restart_concat(decoder, input);
            continue;
        }
        return Ok(true);
    }
}

#[napi]
pub struct NativeBzip2Decompressor {
    decoder: Decoder,
    input: Vec<u8>,
    output: Vec<u8>,
    /// Whole-input copy kept only until the first decompressed byte. The
    /// vendor decoder over-reads, so small/concat streams still need this to
    /// split members. Cleared once true streaming has started.
    pending: Vec<u8>,
    streamed: bool,
    offset: u64,
    chunk_size: usize,
    ended: bool,
}

#[napi]
impl NativeBzip2Decompressor {
    #[napi(constructor)]
    pub fn new(chunk_size: u32) -> Result<Self> {
        if chunk_size == 0 {
            return Err(fail(
                "Bzip2FormatError",
                0,
                "bzip2 data invalid: chunkSize must be > 0",
            ));
        }
        Ok(Self {
            decoder: Decoder::new(),
            input: Vec::new(),
            output: Vec::new(),
            pending: Vec::new(),
            streamed: false,
            offset: 0,
            chunk_size: chunk_size as usize,
            ended: false,
        })
    }

    #[napi]
    pub fn write(&mut self, chunk: Uint8Array) -> Result<()> {
        if self.ended {
            return Err(bzip_err(self.offset, "write after end"));
        }
        if !self.streamed {
            self.pending.extend_from_slice(chunk.as_ref());
        }
        self.input.extend_from_slice(chunk.as_ref());
        pump_members(
            &mut self.decoder,
            &mut self.input,
            &mut self.output,
            &mut self.offset,
            false,
        )?;
        if !self.output.is_empty() {
            self.streamed = true;
            self.pending.clear();
        }
        Ok(())
    }

    #[napi]
    pub fn read(&mut self, max_bytes: Option<u32>) -> Uint8Array {
        take_out(&mut self.output, max_bytes)
    }

    #[napi]
    pub fn end(&mut self) -> Result<()> {
        self.ended = true;
        if !self.pending.is_empty() && !self.streamed {
            let full = decompress_all(&self.pending)?;
            self.output = full;
            self.pending.clear();
            self.input.clear();
            return Ok(());
        }
        let done = pump_members(
            &mut self.decoder,
            &mut self.input,
            &mut self.output,
            &mut self.offset,
            true,
        )?;
        if !done {
            return Err(bzip_err(self.offset, "unexpected EOF"));
        }
        Ok(())
    }

    #[napi]
    pub fn reset(&mut self) {
        *self = Self {
            decoder: Decoder::new(),
            input: Vec::new(),
            output: Vec::new(),
            pending: Vec::new(),
            streamed: false,
            offset: 0,
            chunk_size: self.chunk_size,
            ended: false,
        };
    }

    /// Unconsumed write queue plus any pre-stream pending copy. After the first
    /// decompressed byte this is only the decoder's unconsumed `input`.
    #[napi]
    pub fn debug_input_len(&self) -> u32 {
        let n = if self.streamed {
            self.input.len()
        } else {
            self.input.len().max(self.pending.len())
        };
        n as u32
    }
}

#[napi]
pub struct NativeLzwDecompressor {
    order: BitOrder,
    lit_width: u8,
    compressed: Vec<u8>,
    output: Vec<u8>,
    emitted: usize,
    ended: bool,
}

#[napi]
impl NativeLzwDecompressor {
    #[napi(constructor)]
    pub fn new(order: String, lit_width: u32) -> Result<Self> {
        let width = require_lit_width(lit_width)?;
        let order = bit_order(&order)?;
        Ok(Self {
            order,
            lit_width: width,
            compressed: Vec::new(),
            output: Vec::new(),
            emitted: 0,
            ended: false,
        })
    }

    #[napi]
    pub fn write(&mut self, chunk: Uint8Array) -> Result<()> {
        if self.ended {
            return Err(lzw_fmt(
                (self.compressed.len() as u64).saturating_mul(8),
                "lzw: write after end",
            ));
        }
        self.compressed.extend_from_slice(chunk.as_ref());
        Ok(())
    }

    #[napi]
    pub fn read(&mut self, max_bytes: Option<u32>) -> Uint8Array {
        let out = take_out(&mut self.output, max_bytes);
        self.emitted += out.len();
        out
    }

    #[napi]
    pub fn end(&mut self) -> Result<()> {
        self.ended = true;
        let full = lzw_decode_all(self.order, self.lit_width, &self.compressed)?;
        if self.emitted > full.len() {
            return Err(lzw_fmt(
                (self.compressed.len() as u64).saturating_mul(8),
                "unexpected EOF",
            ));
        }
        self.output = full[self.emitted..].to_vec();
        Ok(())
    }

    #[napi]
    pub fn reset(&mut self) {
        *self = Self {
            order: self.order,
            lit_width: self.lit_width,
            compressed: Vec::new(),
            output: Vec::new(),
            emitted: 0,
            ended: false,
        };
    }
}

#[napi]
pub struct NativeLzwCompressor {
    encoder: Option<GoEncoder>,
}

#[napi]
impl NativeLzwCompressor {
    #[napi(constructor)]
    pub fn new(order: String, lit_width: u32) -> Result<Self> {
        let width = require_lit_width(lit_width)?;
        let order = bit_order(&order)?;
        Ok(Self {
            encoder: Some(GoEncoder::new(order, width)),
        })
    }

    #[napi]
    pub fn write(&mut self, chunk: Uint8Array) -> Result<()> {
        self.encoder
            .as_mut()
            .ok_or_else(|| lzw_fmt(0, "lzw: write after finish"))?
            .write(chunk.as_ref())
            .map_err(|err| fail("LzwConfigError", 0, err))
    }

    #[napi]
    pub fn finish(&mut self) -> Result<Uint8Array> {
        let encoder = self
            .encoder
            .take()
            .ok_or_else(|| lzw_fmt(0, "lzw: write after finish"))?;
        let mut encoder = encoder;
        Ok(encoder.finish().into())
    }
}
