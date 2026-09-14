mod fold;
mod parse;
mod perl_groups;
mod print;
mod regexp;
mod unicode_tables;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use parse::parse;
use regexp::{
    cap_names, dump_fixed, max_cap, regexp_string, tree_json, CLASS_NL, DOT_NL, FOLD_CASE, LITERAL, MATCH_NL, NON_GREEDY,
    ONE_LINE, PERL, PERL_X, POSIX, SIMPLE, UNICODE_GROUPS, WAS_DOLLAR,
};

#[napi(object)]
pub struct ParseRow {
    pub dump: String,
    pub printed: String,
    pub json: String,
    pub max_cap: i32,
    pub cap_names: Vec<String>,
}

#[napi]
pub fn syntax_parse(pattern: String, flags: u32) -> Result<ParseRow> {
    match parse(&pattern, flags as u16) {
        Ok((nodes, id)) => Ok(ParseRow {
            dump: dump_fixed(&nodes, id),
            printed: regexp_string(&nodes, id),
            json: tree_json(&nodes, id),
            max_cap: max_cap(&nodes, id),
            cap_names: cap_names(&nodes, id),
        }),
        Err(err) => Err(Error::new(
            Status::InvalidArg,
            format!("SyntaxError:{}:{}:{}", err.code, err.expr, err.message()),
        )),
    }
}

#[napi]
pub fn flag_fold_case() -> u32 {
    FOLD_CASE as u32
}
#[napi]
pub fn flag_literal() -> u32 {
    LITERAL as u32
}
#[napi]
pub fn flag_class_nl() -> u32 {
    CLASS_NL as u32
}
#[napi]
pub fn flag_dot_nl() -> u32 {
    DOT_NL as u32
}
#[napi]
pub fn flag_one_line() -> u32 {
    ONE_LINE as u32
}
#[napi]
pub fn flag_non_greedy() -> u32 {
    NON_GREEDY as u32
}
#[napi]
pub fn flag_perl_x() -> u32 {
    PERL_X as u32
}
#[napi]
pub fn flag_unicode_groups() -> u32 {
    UNICODE_GROUPS as u32
}
#[napi]
pub fn flag_was_dollar() -> u32 {
    WAS_DOLLAR as u32
}
#[napi]
pub fn flag_simple() -> u32 {
    SIMPLE as u32
}
#[napi]
pub fn flag_match_nl() -> u32 {
    MATCH_NL as u32
}
#[napi]
pub fn flag_perl() -> u32 {
    PERL as u32
}
#[napi]
pub fn flag_posix() -> u32 {
    POSIX as u32
}
