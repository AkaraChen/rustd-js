mod address;
mod date;
mod error;
mod header;
mod media;
mod smtp;
mod word;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;

use address::{format_address as fmt_addr, parse_address, parse_address_list};
use date::{format_date, parse_date};
use header::{canonical_header_key, read_message};
use media::parse_media_type;

fn map_err(err: error::MailErr) -> Error {
    err.napi()
}

#[napi(object)]
pub struct NativeAddress {
    pub name: String,
    pub address: String,
}

#[napi(object)]
pub struct NativeHeaderPair {
    pub key: String,
    pub value: String,
}

#[napi(object)]
pub struct NativeMessage {
    pub headers: Vec<NativeHeaderPair>,
    pub body: Uint8Array,
    pub raw: Uint8Array,
}

#[napi(object)]
pub struct NativeMediaType {
    #[napi(js_name = "type")]
    pub typ: String,
    pub params: HashMap<String, String>,
}

#[napi(js_name = "canonicalHeaderKey")]
pub fn canonical_header_key_export(key: String) -> String {
    canonical_header_key(&key)
}

#[napi(js_name = "parseAddress")]
pub fn parse_address_export(s: String) -> Result<NativeAddress> {
    let a = parse_address(&s).map_err(map_err)?;
    Ok(NativeAddress {
        name: a.name,
        address: a.address,
    })
}

#[napi(js_name = "parseAddressList")]
pub fn parse_address_list_export(s: String) -> Result<Vec<NativeAddress>> {
    let list = parse_address_list(&s).map_err(map_err)?;
    Ok(list
        .into_iter()
        .map(|a| NativeAddress {
            name: a.name,
            address: a.address,
        })
        .collect())
}

#[napi(js_name = "formatAddress")]
pub fn format_address_export(name: String, address: String) -> String {
    fmt_addr(&name, &address)
}

#[napi(js_name = "parseDate")]
pub fn parse_date_export(s: String) -> Result<f64> {
    Ok(parse_date(&s).map_err(map_err)? as f64)
}

#[napi(js_name = "formatDate")]
pub fn format_date_export(ms: f64) -> String {
    format_date(ms)
}

#[napi(js_name = "readMessage")]
pub fn read_message_export(data: Uint8Array) -> Result<NativeMessage> {
    let msg = read_message(data.as_ref()).map_err(map_err)?;
    Ok(NativeMessage {
        headers: msg
            .headers
            .into_iter()
            .map(|h| NativeHeaderPair {
                key: h.key,
                value: h.value,
            })
            .collect(),
        body: msg.body.into(),
        raw: msg.raw.into(),
    })
}

#[napi(js_name = "parseMediaType")]
pub fn parse_media_type_export(s: String) -> Result<NativeMediaType> {
    let (typ, params) = parse_media_type(&s).map_err(map_err)?;
    Ok(NativeMediaType { typ, params: params.into_iter().collect() })
}
