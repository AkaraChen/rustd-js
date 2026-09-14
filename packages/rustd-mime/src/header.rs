/// Go `net/textproto.CanonicalMIMEHeaderKey` (Go 1.24).
///
/// First letter and any letter following a hyphen become upper case; the rest
/// lower case. Invalid tchar bytes return the input unchanged. A space is
/// accepted by the inner path but must not be canonicalized (Go issue 34540).
pub fn canonical_mime_header_key(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut upper = true;
    for &c in bytes {
        if !valid_header_field_byte(c) {
            return s.to_string();
        }
        if (upper && c.is_ascii_lowercase()) || (!upper && c.is_ascii_uppercase()) {
            return canonical_mime_header_key_bytes(bytes).0;
        }
        upper = c == b'-';
    }
    s.to_string()
}

fn canonical_mime_header_key_bytes(a: &[u8]) -> (String, bool) {
    if a.is_empty() {
        return (String::new(), false);
    }
    let mut no_canon = false;
    for &c in a {
        if valid_header_field_byte(c) {
            continue;
        }
        if c == b' ' {
            no_canon = true;
            continue;
        }
        return (String::from_utf8_lossy(a).into_owned(), false);
    }
    if no_canon {
        return (String::from_utf8_lossy(a).into_owned(), true);
    }
    let mut out = a.to_vec();
    let mut upper = true;
    for c in &mut out {
        if upper && c.is_ascii_lowercase() {
            *c = c.to_ascii_uppercase();
        } else if !upper && c.is_ascii_uppercase() {
            *c = c.to_ascii_lowercase();
        }
        upper = *c == b'-';
    }
    (String::from_utf8(out).expect("canonical MIME header key is ASCII"), true)
}

fn valid_header_field_byte(c: u8) -> bool {
    matches!(
        c,
        b'0'..=b'9'
            | b'a'..=b'z'
            | b'A'..=b'Z'
            | b'!'
            | b'#'
            | b'$'
            | b'%'
            | b'&'
            | b'\''
            | b'*'
            | b'+'
            | b'-'
            | b'.'
            | b'^'
            | b'_'
            | b'`'
            | b'|'
            | b'~'
    )
}

#[cfg(test)]
mod tests {
    use super::canonical_mime_header_key;

    #[test]
    fn go_header_test_table() {
        for (input, want) in [
            ("a-b-c", "A-B-C"),
            ("a-1-c", "A-1-C"),
            ("User-Agent", "User-Agent"),
            ("uSER-aGENT", "User-Agent"),
            ("user-agent", "User-Agent"),
            ("USER-AGENT", "User-Agent"),
            ("foo-bar_baz", "Foo-Bar_baz"),
            ("foo-bar$baz", "Foo-Bar$baz"),
            ("foo-bar~baz", "Foo-Bar~baz"),
            ("foo-bar*baz", "Foo-Bar*baz"),
            ("üser-agenT", "üser-agenT"),
            ("a B", "a B"),
            ("C Ontent-Transfer-Encoding", "C Ontent-Transfer-Encoding"),
            ("foo bar", "foo bar"),
        ] {
            assert_eq!(canonical_mime_header_key(input), want, "{input}");
        }
    }
}
