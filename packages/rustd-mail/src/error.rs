#[derive(Debug)]
pub struct MailErr {
    pub kind: &'static str,
    pub message: String,
}

impl MailErr {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn napi(self) -> napi::Error {
        napi::Error::from_reason(format!("{}|{}", self.kind, self.message))
    }
}

pub fn go_quote(s: &str) -> String {
    let mut out = String::from("\"");
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_ascii() && (' '..='~').contains(&c) => out.push(c),
            c => {
                let u = c as u32;
                if u < 0x10000 {
                    out.push_str(&format!("\\u{u:04x}"));
                } else {
                    out.push_str(&format!("\\U{u:08x}"));
                }
            }
        }
    }
    out.push('"');
    out
}

pub fn go_quote_rune(r: char) -> String {
    match r {
        '\'' => r#"'\\''"#.to_string(),
        '\\' => r#"'\\\\'"#.to_string(),
        '\n' => r#"'\\n'"#.to_string(),
        '\r' => r#"'\\r'"#.to_string(),
        '\t' => r#"'\\t'"#.to_string(),
        c if c.is_ascii() && (' '..='~').contains(&c) => format!("'{c}'"),
        c => {
            let u = c as u32;
            if u < 0x10000 {
                format!("'\\u{u:04x}'")
            } else {
                format!("'\\U{u:08x}'")
            }
        }
    }
}
