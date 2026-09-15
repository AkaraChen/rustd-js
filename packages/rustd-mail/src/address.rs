use crate::error::{go_quote, go_quote_rune, MailErr};
use crate::word::{decode_rfc2047_word, encode_word};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Address {
    pub name: String,
    pub address: String,
}

pub struct AddrParser {
    s: String,
}

impl AddrParser {
    pub fn new(s: impl Into<String>) -> Self {
        Self { s: s.into() }
    }

    pub fn parse_address_list(&mut self) -> Result<Vec<Address>, MailErr> {
        let mut list = Vec::new();
        loop {
            self.skip_space();
            if self.consume(b',') {
                continue;
            }
            let addrs = self.parse_address(true)?;
            list.extend(addrs);
            if !self.skip_cfws() {
                return Err(MailErr::new("address", "mail: misformatted parenthetical comment"));
            }
            if self.empty() {
                break;
            }
            if self.peek() != b',' {
                return Err(MailErr::new("address", "mail: expected comma"));
            }
            while self.consume(b',') {
                self.skip_space();
            }
            if self.empty() {
                break;
            }
        }
        Ok(list)
    }

    pub fn parse_single_address(&mut self) -> Result<Address, MailErr> {
        let addrs = self.parse_address(true)?;
        if !self.skip_cfws() {
            return Err(MailErr::new("address", "mail: misformatted parenthetical comment"));
        }
        if !self.empty() {
            return Err(MailErr::new(
                "address",
                format!("mail: expected single address, got {}", go_quote(&self.s)),
            ));
        }
        if addrs.is_empty() {
            return Err(MailErr::new("address", "mail: empty group"));
        }
        if addrs.len() > 1 {
            return Err(MailErr::new("address", "mail: group with multiple addresses"));
        }
        Ok(addrs.into_iter().next().unwrap())
    }

    fn parse_address(&mut self, handle_group: bool) -> Result<Vec<Address>, MailErr> {
        self.skip_space();
        if self.empty() {
            return Err(MailErr::new("address", "mail: no address"));
        }
        let orig = self.s.clone();
        match self.consume_addr_spec() {
            Ok(spec) => {
                let mut display_name = String::new();
                self.skip_space();
                if !self.empty() && self.peek() == b'(' {
                    display_name = self.consume_display_name_comment()?;
                }
                return Ok(vec![Address {
                    name: display_name,
                    address: spec,
                }]);
            }
            Err(_) => {
                self.s = orig;
            }
        }

        let mut display_name = String::new();
        if self.peek() != b'<' {
            display_name = self.consume_phrase()?;
        }
        self.skip_space();
        if handle_group && self.consume(b':') {
            return self.consume_group_list();
        }
        if !self.consume(b'<') {
            let atext = display_name.chars().all(|r| is_atext(r, true));
            if atext {
                return Err(MailErr::new("address", "mail: missing '@' or angle-addr"));
            }
            return Err(MailErr::new("address", "mail: no angle-addr"));
        }
        let spec = self.consume_addr_spec()?;
        if !self.consume(b'>') {
            return Err(MailErr::new("address", "mail: unclosed angle-addr"));
        }
        Ok(vec![Address {
            name: display_name,
            address: spec,
        }])
    }

    fn consume_group_list(&mut self) -> Result<Vec<Address>, MailErr> {
        let mut group = Vec::new();
        self.skip_space();
        if self.consume(b';') {
            if !self.skip_cfws() {
                return Err(MailErr::new("address", "mail: misformatted parenthetical comment"));
            }
            return Ok(group);
        }
        loop {
            self.skip_space();
            let addrs = self.parse_address(false)?;
            group.extend(addrs);
            if !self.skip_cfws() {
                return Err(MailErr::new("address", "mail: misformatted parenthetical comment"));
            }
            if self.consume(b';') {
                if !self.skip_cfws() {
                    return Err(MailErr::new("address", "mail: misformatted parenthetical comment"));
                }
                break;
            }
            if !self.consume(b',') {
                return Err(MailErr::new("address", "mail: expected comma"));
            }
        }
        Ok(group)
    }

    fn consume_addr_spec(&mut self) -> Result<String, MailErr> {
        let orig = self.s.clone();
        let result = (|| {
            self.skip_space();
            if self.empty() {
                return Err(MailErr::new("address", "mail: no addr-spec"));
            }
            let local_part = if self.peek() == b'"' {
                let lp = self.consume_quoted_string()?;
                if lp.is_empty() {
                    return Err(MailErr::new("address", "mail: empty quoted string in addr-spec"));
                }
                lp
            } else {
                self.consume_atom(true, false)?
            };
            if !self.consume(b'@') {
                return Err(MailErr::new("address", "mail: missing @ in addr-spec"));
            }
            self.skip_space();
            if self.empty() {
                return Err(MailErr::new("address", "mail: no domain in addr-spec"));
            }
            let domain = if self.peek() == b'[' {
                self.consume_domain_literal()?
            } else {
                self.consume_atom(true, false)?
            };
            Ok(format!("{local_part}@{domain}"))
        })();
        if result.is_err() {
            self.s = orig;
        }
        result
    }

    fn consume_phrase(&mut self) -> Result<String, MailErr> {
        let mut words: Vec<String> = Vec::new();
        let mut is_prev_encoded = false;
        let mut err: Option<MailErr> = None;
        loop {
            if !words.is_empty() && !self.skip_cfws() {
                return Err(MailErr::new("address", "mail: misformatted parenthetical comment"));
            }
            self.skip_space();
            if self.empty() {
                break;
            }
            let mut is_encoded = false;
            let word = if self.peek() == b'"' {
                match self.consume_quoted_string() {
                    Ok(w) => w,
                    Err(e) => {
                        err = Some(e);
                        break;
                    }
                }
            } else {
                match self.consume_atom(true, true) {
                    Ok(atom) => match decode_rfc2047_word(&atom) {
                        Ok((w, enc)) => {
                            is_encoded = enc;
                            w
                        }
                        Err(e) => {
                            err = Some(e);
                            break;
                        }
                    },
                    Err(e) => {
                        err = Some(e);
                        break;
                    }
                }
            };
            if is_prev_encoded && is_encoded {
                if let Some(last) = words.last_mut() {
                    last.push_str(&word);
                }
            } else {
                words.push(word);
            }
            is_prev_encoded = is_encoded;
        }
        if let Some(e) = err {
            if words.is_empty() {
                return Err(MailErr::new(
                    "address",
                    format!("mail: missing word in phrase: {}", e.message),
                ));
            }
        }
        Ok(words.join(" "))
    }

    fn consume_quoted_string(&mut self) -> Result<String, MailErr> {
        let mut i = 1;
        let mut qsb = String::new();
        let mut escaped = false;
        loop {
            let rest = &self.s[i..];
            let (r, size) = decode_rune(rest);
            if size == 0 {
                return Err(MailErr::new("address", "mail: unclosed quoted-string"));
            }
            if escaped {
                if !is_vchar(r) && !is_wsp(r) {
                    return Err(MailErr::new(
                        "address",
                        format!("mail: bad character in quoted-string: {}", go_quote_rune(r)),
                    ));
                }
                qsb.push(r);
                escaped = false;
            } else if is_qtext(r) || is_wsp(r) {
                qsb.push(r);
            } else if r == '"' {
                self.s = self.s[i + 1..].to_string();
                return Ok(qsb);
            } else if r == '\\' {
                escaped = true;
            } else {
                return Err(MailErr::new(
                    "address",
                    format!("mail: bad character in quoted-string: {}", go_quote_rune(r)),
                ));
            }
            i += size;
        }
    }

    fn consume_atom(&mut self, dot: bool, permissive: bool) -> Result<String, MailErr> {
        let mut i = 0;
        loop {
            let rest = &self.s[i..];
            let (r, size) = decode_rune(rest);
            if size == 0 || !is_atext(r, dot) {
                break;
            }
            if invalid_utf8(rest) {
                return Err(MailErr::new(
                    "address",
                    format!("mail: invalid utf-8 in address: {}", go_quote(&self.s)),
                ));
            }
            i += size;
        }
        if i == 0 {
            return Err(MailErr::new("address", "mail: invalid string"));
        }
        let atom = self.s[..i].to_string();
        self.s = self.s[i..].to_string();
        if !permissive {
            if atom.starts_with('.') {
                return Err(MailErr::new("address", "mail: leading dot in atom"));
            }
            if atom.contains("..") {
                return Err(MailErr::new("address", "mail: double dot in atom"));
            }
            if atom.ends_with('.') {
                return Err(MailErr::new("address", "mail: trailing dot in atom"));
            }
        }
        Ok(atom)
    }

    fn consume_domain_literal(&mut self) -> Result<String, MailErr> {
        if !self.consume(b'[') {
            return Err(MailErr::new("address", r#"mail: missing "[" in domain-literal"#));
        }
        let mut dtext = String::new();
        loop {
            if self.empty() {
                return Err(MailErr::new("address", "mail: unclosed domain-literal"));
            }
            if self.peek() == b']' {
                break;
            }
            if invalid_utf8(&self.s) {
                return Err(MailErr::new(
                    "address",
                    format!("mail: invalid utf-8 in domain-literal: {}", go_quote(&self.s)),
                ));
            }
            let (r, size) = decode_rune(&self.s);
            if !is_dtext(r) {
                return Err(MailErr::new(
                    "address",
                    format!("mail: bad character in domain-literal: {}", go_quote_rune(r)),
                ));
            }
            dtext.push_str(&self.s[..size]);
            self.s = self.s[size..].to_string();
        }
        if !self.consume(b']') {
            return Err(MailErr::new("address", "mail: unclosed domain-literal"));
        }
        if dtext.parse::<std::net::IpAddr>().is_err() {
            return Err(MailErr::new(
                "address",
                format!("mail: invalid IP address in domain-literal: {}", go_quote(&dtext)),
            ));
        }
        Ok(format!("[{dtext}]"))
    }

    fn consume_display_name_comment(&mut self) -> Result<String, MailErr> {
        if !self.consume(b'(') {
            return Err(MailErr::new("address", "mail: comment does not start with ("));
        }
        let (comment, ok) = self.consume_comment();
        if !ok {
            return Err(MailErr::new("address", "mail: misformatted parenthetical comment"));
        }
        let mut words: Vec<String> = fields_func(&comment);
        for word in words.iter_mut() {
            match decode_rfc2047_word(word) {
                Ok((decoded, is_encoded)) => {
                    if is_encoded {
                        *word = decoded;
                    }
                }
                Err(e) => return Err(e),
            }
        }
        Ok(words.join(" "))
    }

    fn consume(&mut self, c: u8) -> bool {
        if self.empty() || self.peek() != c {
            return false;
        }
        self.s = self.s[1..].to_string();
        true
    }

    fn skip_space(&mut self) {
        let trimmed = self.s.trim_start_matches([' ', '\t']);
        self.s = trimmed.to_string();
    }

    fn peek(&self) -> u8 {
        self.s.as_bytes()[0]
    }

    fn empty(&self) -> bool {
        self.s.is_empty()
    }

    pub fn skip_cfws(&mut self) -> bool {
        self.skip_space();
        loop {
            if !self.consume(b'(') {
                break;
            }
            let (_, ok) = self.consume_comment();
            if !ok {
                return false;
            }
            self.skip_space();
        }
        true
    }

    fn consume_comment(&mut self) -> (String, bool) {
        let mut depth = 1;
        let mut comment = String::new();
        while !self.empty() && depth != 0 {
            if self.peek() == b'\\' && self.s.len() > 1 {
                self.s = self.s[1..].to_string();
            } else if self.peek() == b'(' {
                depth += 1;
            } else if self.peek() == b')' {
                depth -= 1;
            }
            if depth > 0 && !self.empty() {
                comment.push(self.s.as_bytes()[0] as char);
            }
            if !self.empty() {
                self.s = self.s[1..].to_string();
            }
        }
        (comment, depth == 0)
    }
}

fn fields_func(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        if ch == ' ' || ch == '\t' {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(ch);
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn decode_rune(s: &str) -> (char, usize) {
    if s.is_empty() {
        return ('\0', 0);
    }
    if !s.is_char_boundary(1) || (s.as_bytes()[0] >= 0x80 && s.chars().next().is_none()) {
        return ('\u{FFFD}', 1);
    }
    match s.chars().next() {
        Some(c) => (c, c.len_utf8()),
        None => ('\u{FFFD}', 1),
    }
}

fn invalid_utf8(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let b = s.as_bytes()[0];
    if b < 0x80 {
        return false;
    }
    std::str::from_utf8(&s.as_bytes()[..1.min(s.len())]).is_err() && {
        // invalid leading byte or incomplete sequence at start
        let width = match b {
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => 1,
        };
        s.len() < width || std::str::from_utf8(&s.as_bytes()[..width.min(s.len())]).is_err()
    }
}

fn is_atext(r: char, dot: bool) -> bool {
    match r {
        '.' => dot,
        '(' | ')' | '<' | '>' | '[' | ']' | ':' | ';' | '@' | '\\' | ',' | '"' => false,
        _ => is_vchar(r),
    }
}

fn is_qtext(r: char) -> bool {
    r != '\\' && r != '"' && is_vchar(r)
}

fn is_vchar(r: char) -> bool {
    ('!'..='~').contains(&r) || is_multibyte(r)
}

fn is_multibyte(r: char) -> bool {
    (r as u32) >= 0x80
}

fn is_wsp(r: char) -> bool {
    r == ' ' || r == '\t'
}

fn is_dtext(r: char) -> bool {
    r != '[' && r != ']' && r != '\\' && is_vchar(r)
}

fn quote_string(s: &str) -> String {
    let mut b = String::from("\"");
    for r in s.chars() {
        if is_qtext(r) || is_wsp(r) {
            b.push(r);
        } else if is_vchar(r) {
            b.push('\\');
            b.push(r);
        }
    }
    b.push('"');
    b
}

pub fn format_address(name: &str, address: &str) -> String {
    let at = address.rfind('@');
    let (local, domain) = match at {
        None => (address, ""),
        Some(i) => (&address[..i], &address[i + 1..]),
    };
    let mut quote_local = false;
    for (i, r) in local.char_indices() {
        if is_atext(r, false) {
            continue;
        }
        if r == '.' {
            if i > 0 && local.as_bytes()[i - 1] != b'.' && i < local.len() - 1 {
                continue;
            }
        }
        quote_local = true;
        break;
    }
    let local = if quote_local {
        quote_string(local)
    } else {
        local.to_string()
    };
    let spec = format!("<{local}@{domain}>");
    if name.is_empty() {
        return spec;
    }
    let mut all_printable = true;
    for r in name.chars() {
        if (!is_vchar(r) && !is_wsp(r)) || is_multibyte(r) {
            all_printable = false;
            break;
        }
    }
    if all_printable {
        return format!("{} {}", quote_string(name), spec);
    }
    if name.contains(|c: char| "\"#$%&'(),.:;<>@[]^`{|}~".contains(c)) {
        return format!("{} {}", encode_word(b'b', "utf-8", name), spec);
    }
    format!("{} {}", encode_word(b'q', "utf-8", name), spec)
}

pub fn parse_address(s: &str) -> Result<Address, MailErr> {
    AddrParser::new(s).parse_single_address()
}

pub fn parse_address_list(s: &str) -> Result<Vec<Address>, MailErr> {
    AddrParser::new(s).parse_address_list()
}
