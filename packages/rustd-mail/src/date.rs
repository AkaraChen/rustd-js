use crate::address::AddrParser;
use crate::error::MailErr;

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

fn cutspace(s: &str) -> &str {
    s.trim_start_matches(' ')
}

fn skip<'a>(value: &'a str, prefix: &str) -> Result<&'a str, ()> {
    let mut value = value;
    let mut prefix = prefix;
    while !prefix.is_empty() {
        if prefix.as_bytes()[0] == b' ' {
            if !value.is_empty() && value.as_bytes()[0] != b' ' {
                return Err(());
            }
            prefix = cutspace(prefix);
            value = cutspace(value);
            continue;
        }
        if value.is_empty() || value.as_bytes()[0] != prefix.as_bytes()[0] {
            return Err(());
        }
        prefix = &prefix[1..];
        value = &value[1..];
    }
    Ok(value)
}

fn getnum(s: &str, fixed: bool) -> Result<(i32, &str), ()> {
    if s.is_empty() || !s.as_bytes()[0].is_ascii_digit() {
        return Err(());
    }
    if s.len() < 2 || !s.as_bytes()[1].is_ascii_digit() {
        if fixed {
            return Err(());
        }
        return Ok(((s.as_bytes()[0] - b'0') as i32, &s[1..]));
    }
    Ok((
        (s.as_bytes()[0] - b'0') as i32 * 10 + (s.as_bytes()[1] - b'0') as i32,
        &s[2..],
    ))
}

fn lookup<'a>(tab: &[&str], val: &'a str) -> Result<(usize, &'a str), ()> {
    for (i, name) in tab.iter().enumerate() {
        if val.starts_with(name)
            && (val.len() == name.len()
                || !val.as_bytes()[name.len()].is_ascii_lowercase())
        {
            return Ok((i, &val[name.len()..]));
        }
    }
    Err(())
}

fn parse_time_zone(value: &str) -> Option<usize> {
    if value.len() < 3 {
        return None;
    }
    if value.len() >= 4 && (value.starts_with("ChST") || value.starts_with("MeST")) {
        return Some(4);
    }
    if value.starts_with("GMT") {
        return Some(3 + parse_signed_offset(&value[3..]));
    }
    if value.as_bytes()[0] == b'+' || value.as_bytes()[0] == b'-' {
        let n = parse_signed_offset(value);
        return if n > 0 { Some(n) } else { None };
    }
    let mut n_upper = 0;
    while n_upper < 6 && n_upper < value.len() {
        let c = value.as_bytes()[n_upper];
        if !c.is_ascii_uppercase() {
            break;
        }
        n_upper += 1;
    }
    match n_upper {
        5 if value.as_bytes()[4] == b'T' => Some(5),
        4 if value.as_bytes()[3] == b'T' || value.starts_with("WITA") => Some(4),
        3 => Some(3),
        _ => None,
    }
}

fn parse_signed_offset(value: &str) -> usize {
    if value.is_empty() {
        return 0;
    }
    let sign = value.as_bytes()[0];
    if sign != b'+' && sign != b'-' {
        return 0;
    }
    let mut i = 1;
    let mut x = 0i32;
    while i < value.len() && value.as_bytes()[i].is_ascii_digit() {
        x = x * 10 + (value.as_bytes()[i] - b'0') as i32;
        i += 1;
    }
    if i == 1 || x > 23 {
        return 0;
    }
    i
}

fn is_leap(year: i32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn days_in(month: i32, year: i32) -> i32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

fn unix_ms(year: i32, month: i32, day: i32, hour: i32, min: i32, sec: i32, offset: i32) -> i64 {
    let mut days: i64 = 0;
    let mut y = 1970;
    if year >= 1970 {
        while y < year {
            days += if is_leap(y) { 366 } else { 365 };
            y += 1;
        }
    } else {
        y = year;
        while y < 1970 {
            days -= if is_leap(y) { 366 } else { 365 };
            y += 1;
        }
    }
    for m in 1..month {
        days += days_in(m, year) as i64;
    }
    days += (day - 1) as i64;
    let secs = days * 86400 + hour as i64 * 3600 + min as i64 * 60 + sec as i64 - offset as i64;
    secs * 1000
}

struct Parsed {
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    min: i32,
    sec: i32,
    zone_offset: Option<i32>,
    zone_name: Option<String>,
}

fn parse_layout(layout: &str, value: &str) -> Result<Parsed, ()> {
    let mut value = value;
    let mut year = 0;
    let mut month = -1;
    let mut day = -1;
    let mut hour = 0;
    let mut min = 0;
    let mut sec = 0;
    let mut zone_offset = None;
    let mut zone_name = None;
    let mut rest_layout = layout;
    loop {
        let (prefix, kind, suffix) = next_chunk(rest_layout);
        value = skip(value, prefix)?;
        match kind {
            Chunk::End => {
                if !value.is_empty() {
                    return Err(());
                }
                break;
            }
            Chunk::Year2 => {
                if value.len() < 2 {
                    return Err(());
                }
                let mut y = value[..2].parse::<i32>().map_err(|_| ())?;
                value = &value[2..];
                y = if y >= 69 { y + 1900 } else { y + 2000 };
                year = y;
            }
            Chunk::Year4 => {
                if value.len() < 4 || !value.as_bytes()[0].is_ascii_digit() {
                    return Err(());
                }
                year = value[..4].parse::<i32>().map_err(|_| ())?;
                value = &value[4..];
            }
            Chunk::Month => {
                let (i, rest) = lookup(&MONTHS, value)?;
                month = i as i32 + 1;
                value = rest;
            }
            Chunk::Weekday => {
                let (_, rest) = lookup(&DAYS, value)?;
                value = rest;
            }
            Chunk::Day => {
                let (d, rest) = getnum(value, false)?;
                day = d;
                value = rest;
            }
            Chunk::Day2 => {
                let (d, rest) = getnum(value, true)?;
                day = d;
                value = rest;
            }
            Chunk::Hour => {
                let (h, rest) = getnum(value, false)?;
                if !(0..24).contains(&h) {
                    return Err(());
                }
                hour = h;
                value = rest;
            }
            Chunk::Minute => {
                let (m, rest) = getnum(value, true)?;
                if !(0..60).contains(&m) {
                    return Err(());
                }
                min = m;
                value = rest;
            }
            Chunk::Second => {
                let (s, rest) = getnum(value, true)?;
                if !(0..60).contains(&s) {
                    return Err(());
                }
                sec = s;
                value = rest;
            }
            Chunk::NumTZ => {
                if value.len() < 5 {
                    return Err(());
                }
                let sign = value.as_bytes()[0];
                let hr = value[1..3].parse::<i32>().map_err(|_| ())?;
                let mm = value[3..5].parse::<i32>().map_err(|_| ())?;
                value = &value[5..];
                if hr > 24 || mm > 60 {
                    return Err(());
                }
                let mut off = (hr * 60 + mm) * 60;
                match sign {
                    b'+' => {}
                    b'-' => off = -off,
                    _ => return Err(()),
                }
                zone_offset = Some(off);
            }
            Chunk::NamedTZ => {
                if value.len() >= 3 && value.starts_with("UTC") {
                    zone_name = Some("UTC".into());
                    zone_offset = Some(0);
                    value = &value[3..];
                } else {
                    let n = parse_time_zone(value).ok_or(())?;
                    zone_name = Some(value[..n].to_string());
                    value = &value[n..];
                    if zone_name.as_deref() == Some("GMT")
                        || zone_name.as_deref() == Some("UT")
                        || zone_name.as_deref() == Some("UTC")
                    {
                        zone_offset = Some(0);
                    } else {
                        zone_offset = Some(0);
                    }
                }
            }
        }
        rest_layout = suffix;
    }
    if day < 1 || month < 1 || day > days_in(month, year) {
        return Err(());
    }
    Ok(Parsed {
        year,
        month,
        day,
        hour,
        min,
        sec,
        zone_offset,
        zone_name,
    })
}

#[derive(Clone, Copy)]
enum Chunk {
    End,
    Year2,
    Year4,
    Month,
    Weekday,
    Day,
    Day2,
    Hour,
    Minute,
    Second,
    NumTZ,
    NamedTZ,
}

fn next_chunk(layout: &str) -> (&str, Chunk, &str) {
    if layout.is_empty() {
        return ("", Chunk::End, "");
    }
    if let Some(i) = layout.find("Mon") {
        if i == 0 || !layout[..i].contains("Jan") && layout.find("2006").is_none() && layout.find("15:04").is_none() {
            // fall through to scan
        }
    }
    // Scan like Go nextStdChunk for our limited layouts.
    let bytes = layout.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'J' if layout[i..].starts_with("Jan") => {
                return (&layout[..i], Chunk::Month, &layout[i + 3..]);
            }
            b'M' if layout[i..].starts_with("Mon") => {
                return (&layout[..i], Chunk::Weekday, &layout[i + 3..]);
            }
            b'M' if layout[i..].starts_with("MST") => {
                return (&layout[..i], Chunk::NamedTZ, &layout[i + 3..]);
            }
            b'2' if layout[i..].starts_with("2006") => {
                return (&layout[..i], Chunk::Year4, &layout[i + 4..]);
            }
            b'0' if layout[i..].starts_with("06") => {
                return (&layout[..i], Chunk::Year2, &layout[i + 2..]);
            }
            b'0' if layout[i..].starts_with("02") => {
                return (&layout[..i], Chunk::Day2, &layout[i + 2..]);
            }
            b'2' => return (&layout[..i], Chunk::Day, &layout[i + 1..]),
            b'1' if layout[i..].starts_with("15") => {
                return (&layout[..i], Chunk::Hour, &layout[i + 2..]);
            }
            b'0' if layout[i..].starts_with("04") => {
                return (&layout[..i], Chunk::Minute, &layout[i + 2..]);
            }
            b'0' if layout[i..].starts_with("05") => {
                return (&layout[..i], Chunk::Second, &layout[i + 2..]);
            }
            b'-' if layout[i..].starts_with("-0700") => {
                return (&layout[..i], Chunk::NumTZ, &layout[i + 5..]);
            }
            _ => i += 1,
        }
    }
    (layout, Chunk::End, "")
}

fn layouts() -> Vec<String> {
    let dows = ["", "Mon, "];
    let days = ["2", "02"];
    let years = ["2006", "06"];
    let seconds = [":05", ""];
    let zones = ["-0700", "MST", "UT"];
    let mut out = Vec::new();
    for dow in dows {
        for day in days {
            for year in years {
                for second in seconds {
                    for zone in zones {
                        out.push(format!("{dow}{day} Jan {year} 15:04{second} {zone}"));
                    }
                }
            }
        }
    }
    out
}

pub fn parse_date(date: &str) -> Result<i64, MailErr> {
    let date = date.replace("\r\n", "");
    if date.contains('\r') {
        return Err(MailErr::new("date", "mail: header has a CR without LF"));
    }
    let mut s = date.as_str();
    s = s.trim_start_matches([' ', '\t']);
    let (date_part, rest) = if let Some(ind) = s.find(['+', '-']) {
        if s.len() >= ind + 5 {
            (&s[..ind + 5], &s[ind + 5..])
        } else {
            split_on_t(s)
        }
    } else {
        split_on_t(s)
    };
    let mut rest_parser = AddrParser::new(rest.to_string());
    if !rest_parser.skip_cfws() {
        return Err(MailErr::new("date", "mail: misformatted parenthetical comment"));
    }
    for layout in layouts() {
        if let Ok(parsed) = parse_layout(&layout, date_part) {
            let offset = parsed.zone_offset.unwrap_or(0);
            let _ = parsed.zone_name;
            return Ok(unix_ms(
                parsed.year,
                parsed.month,
                parsed.day,
                parsed.hour,
                parsed.min,
                parsed.sec,
                offset,
            ));
        }
    }
    Err(MailErr::new("date", "mail: header could not be parsed"))
}

fn split_on_t(s: &str) -> (&str, &str) {
    let mut ind = s.find('T');
    if ind == Some(0) {
        ind = s[1..].find('T').map(|i| i + 1);
    }
    if let Some(ind) = ind {
        if s.len() >= ind + 1 {
            return (&s[..ind + 1], &s[ind + 1..]);
        }
    }
    (s, "")
}

pub fn format_date(ms: f64) -> String {
    let secs = (ms / 1000.0).floor() as i64;
    let (year, month, day, hour, min, sec) = civil_from_unix(secs);
    let weekday = {
        // Unix epoch was Thursday.
        let days = secs.div_euclid(86400);
        DAYS[((days + 4).rem_euclid(7)) as usize]
    };
    format!(
        "{weekday}, {day:02} {month} {year} {hour:02}:{min:02}:{sec:02} +0000",
        month = MONTHS[(month - 1) as usize]
    )
}

fn civil_from_unix(secs: i64) -> (i32, i32, i32, i32, i32, i32) {
    let mut days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let hour = (rem / 3600) as i32;
    let min = ((rem % 3600) / 60) as i32;
    let sec = (rem % 60) as i32;
    let mut year = 1970;
    loop {
        let ydays = if is_leap(year) { 366 } else { 365 };
        if days >= 0 && days < ydays {
            break;
        }
        if days >= ydays {
            days -= ydays;
            year += 1;
        } else {
            year -= 1;
            days += if is_leap(year) { 366 } else { 365 };
        }
    }
    let mut month = 1;
    while month <= 12 {
        let md = days_in(month, year) as i64;
        if days < md {
            break;
        }
        days -= md;
        month += 1;
    }
    (year, month, days as i32 + 1, hour, min, sec)
}
