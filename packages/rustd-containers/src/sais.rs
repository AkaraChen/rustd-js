// Port of Go 1.24.13 index/suffixarray SA-IS (sais.go + 32-bit sais2.go).
// Control flow and LMS order must match Go so Lookup/Write stay byte-identical.

pub fn text_32(text: &[u8], sa: &mut [i32]) {
    assert_eq!(text.len(), sa.len());
    assert!(text.len() <= i32::MAX as usize);
    sa.fill(0);
    let mut tmp = vec![0i32; 2 * 256];
    sais_8_32(text, 256, sa, &mut tmp);
}

fn sais_8_32(text: &[u8], text_max: usize, sa: &mut [i32], tmp: &mut [i32]) {
    assert_eq!(sa.len(), text.len());
    assert!(tmp.len() >= text_max);
    if text.is_empty() {
        return;
    }
    if text.len() == 1 {
        sa[0] = 0;
        return;
    }
    let two = tmp.len() >= 2 * text_max;
    if two {
        tmp[0] = -1;
    }
    let num_lms = {
        let (freq, bucket) = split_freq_bucket(tmp, text_max, two);
        place_lms_8_32(text, sa, freq, bucket)
    };
    if num_lms > 1 {
        {
            let (freq, bucket) = split_freq_bucket(tmp, text_max, two);
            induce_sub_l_8_32(text, sa, freq, bucket);
        }
        {
            let (freq, bucket) = split_freq_bucket(tmp, text_max, two);
            induce_sub_s_8_32(text, sa, freq, bucket);
        }
        length_8_32(text, sa, num_lms);
        let max_id = assign_id_8_32(text, sa, num_lms);
        if max_id < num_lms {
            map_32(sa, num_lms);
            recurse_32(sa, tmp, num_lms, max_id);
            unmap_8_32(text, sa, num_lms);
        } else {
            let n = sa.len();
            sa.copy_within(n - num_lms..n, 0);
        }
        {
            let (freq, bucket) = split_freq_bucket(tmp, text_max, two);
            expand_8_32(text, freq, bucket, sa, num_lms);
        }
    }
    {
        let (freq, bucket) = split_freq_bucket(tmp, text_max, two);
        induce_l_8_32(text, sa, freq, bucket);
    }
    {
        let (freq, bucket) = split_freq_bucket(tmp, text_max, two);
        induce_s_8_32(text, sa, freq, bucket);
    }
    tmp[0] = -1;
}

fn split_freq_bucket(tmp: &mut [i32], text_max: usize, two: bool) -> (Option<&mut [i32]>, &mut [i32]) {
    if two {
        let (freq, rest) = tmp.split_at_mut(text_max);
        (Some(freq), &mut rest[..text_max])
    } else {
        (None, &mut tmp[..text_max])
    }
}

fn freq_8_32(text: &[u8], freq: Option<&mut [i32]>, bucket: &mut [i32]) -> [i32; 256] {
    if let Some(freq) = freq {
        if freq[0] >= 0 {
            let mut out = [0i32; 256];
            out.copy_from_slice(&freq[..256]);
            return out;
        }
        freq[..256].fill(0);
        for &c in text {
            freq[c as usize] += 1;
        }
        let mut out = [0i32; 256];
        out.copy_from_slice(&freq[..256]);
        out
    } else {
        bucket[..256].fill(0);
        for &c in text {
            bucket[c as usize] += 1;
        }
        let mut out = [0i32; 256];
        out.copy_from_slice(&bucket[..256]);
        out
    }
}

fn bucket_min_8_32(text: &[u8], freq: Option<&mut [i32]>, bucket: &mut [i32]) {
    let freq = freq_8_32(text, freq, bucket);
    let mut total = 0i32;
    for i in 0..256 {
        bucket[i] = total;
        total += freq[i];
    }
}

fn bucket_max_8_32(text: &[u8], freq: Option<&mut [i32]>, bucket: &mut [i32]) {
    let freq = freq_8_32(text, freq, bucket);
    let mut total = 0i32;
    for i in 0..256 {
        total += freq[i];
        bucket[i] = total;
    }
}

fn place_lms_8_32(text: &[u8], sa: &mut [i32], freq: Option<&mut [i32]>, bucket: &mut [i32]) -> usize {
    bucket_max_8_32(text, freq, bucket);
    let mut num_lms = 0usize;
    let mut last_b = -1i32;
    let mut c0 = 0u8;
    let mut c1 = 0u8;
    let mut is_type_s = false;
    for i in (0..text.len()).rev() {
        c1 = c0;
        c0 = text[i];
        if c0 < c1 {
            is_type_s = true;
        } else if c0 > c1 && is_type_s {
            is_type_s = false;
            let b = bucket[c1 as usize] - 1;
            bucket[c1 as usize] = b;
            sa[b as usize] = (i + 1) as i32;
            last_b = b;
            num_lms += 1;
        }
    }
    if num_lms > 1 {
        sa[last_b as usize] = 0;
    }
    num_lms
}

fn induce_sub_l_8_32(text: &[u8], sa: &mut [i32], freq: Option<&mut [i32]>, bucket: &mut [i32]) {
    bucket_min_8_32(text, freq, bucket);
    let mut k = (text.len() - 1) as isize;
    let c0 = text[k as usize - 1];
    let c1 = text[k as usize];
    if c0 < c1 {
        k = -k;
    }
    let mut c_b = c1;
    let mut b = bucket[c_b as usize];
    sa[b as usize] = k as i32;
    b += 1;
    for i in 0..sa.len() {
        let j = sa[i] as isize;
        if j == 0 {
            continue;
        }
        if j < 0 {
            sa[i] = (-j) as i32;
            continue;
        }
        sa[i] = 0;
        let mut k = j - 1;
        let c1 = text[k as usize];
        let c0 = text[k as usize - 1];
        if c0 < c1 {
            k = -k;
        }
        if c_b != c1 {
            bucket[c_b as usize] = b;
            c_b = c1;
            b = bucket[c_b as usize];
        }
        sa[b as usize] = k as i32;
        b += 1;
    }
}

fn induce_sub_s_8_32(text: &[u8], sa: &mut [i32], freq: Option<&mut [i32]>, bucket: &mut [i32]) {
    bucket_max_8_32(text, freq, bucket);
    let mut c_b = 0u8;
    let mut b = bucket[c_b as usize];
    let mut top = sa.len();
    for i in (0..sa.len()).rev() {
        let j = sa[i] as isize;
        if j == 0 {
            continue;
        }
        sa[i] = 0;
        if j < 0 {
            top -= 1;
            sa[top] = (-j) as i32;
            continue;
        }
        let mut k = j - 1;
        let c1 = text[k as usize];
        let c0 = text[k as usize - 1];
        if c0 > c1 {
            k = -k;
        }
        if c_b != c1 {
            bucket[c_b as usize] = b;
            c_b = c1;
            b = bucket[c_b as usize];
        }
        b -= 1;
        sa[b as usize] = k as i32;
    }
}

fn length_8_32(text: &[u8], sa: &mut [i32], _num_lms: usize) {
    let mut end = 0usize;
    let mut cx = 0u32;
    let mut c0 = 0u8;
    let mut c1 = 0u8;
    let mut is_type_s = false;
    for i in (0..text.len()).rev() {
        c1 = c0;
        c0 = text[i];
        cx = cx << 8 | u32::from(c1.wrapping_add(1));
        if c0 < c1 {
            is_type_s = true;
        } else if c0 > c1 && is_type_s {
            is_type_s = false;
            let j = i + 1;
            let code = if end == 0 {
                0
            } else {
                let mut code = (end - j) as i32;
                if code <= 32 / 8 && !cx >= text.len() as u32 {
                    code = !cx as i32;
                }
                code
            };
            sa[j >> 1] = code;
            end = j + 1;
            cx = u32::from(c1.wrapping_add(1));
        }
    }
}

fn assign_id_8_32(text: &[u8], sa: &mut [i32], num_lms: usize) -> usize {
    let mut id = 0i32;
    let mut last_len = -1i32;
    let mut last_pos = 0i32;
    let start = sa.len() - num_lms;
    for idx in start..sa.len() {
        let j = sa[idx];
        let n = sa[(j as usize) / 2];
        let mut is_new = n != last_len;
        if !is_new {
            if (n as u32) >= text.len() as u32 {
                is_new = false;
            } else {
                let nn = n as usize;
                let ju = j as usize;
                let lu = last_pos as usize;
                is_new = text[ju..ju + nn] != text[lu..lu + nn];
            }
        }
        if is_new {
            id += 1;
            last_pos = j;
            last_len = n;
        }
        sa[(j as usize) / 2] = id;
    }
    id as usize
}

fn map_32(sa: &mut [i32], _num_lms: usize) {
    let mut w = sa.len();
    let mut i = sa.len() / 2;
    loop {
        let j = sa[i];
        if j > 0 {
            w -= 1;
            sa[w] = j - 1;
        }
        if i == 0 {
            break;
        }
        i -= 1;
    }
}

fn recurse_32(sa: &mut [i32], old_tmp: &mut [i32], num_lms: usize, max_id: usize) {
    let n = sa.len();
    let sa_tmp_len = n - 2 * num_lms;
    let prefer_sa = old_tmp.len() < sa_tmp_len;
    if prefer_sa && sa_tmp_len >= num_lms {
        let (left, text) = sa.split_at_mut(n - num_lms);
        let (dst, sa_tmp) = left.split_at_mut(num_lms);
        dst.fill(0);
        sais_32(text, max_id, dst, sa_tmp);
        return;
    }
    if !prefer_sa && old_tmp.len() >= num_lms {
        let (left, text) = sa.split_at_mut(n - num_lms);
        let (dst, _) = left.split_at_mut(num_lms);
        dst.fill(0);
        sais_32(text, max_id, dst, old_tmp);
        return;
    }
    let mut tmp_len = max_id;
    if tmp_len < num_lms / 2 {
        tmp_len = num_lms / 2;
    }
    let mut tmp = vec![0i32; tmp_len];
    let (left, text) = sa.split_at_mut(n - num_lms);
    let (dst, _) = left.split_at_mut(num_lms);
    dst.fill(0);
    sais_32(text, max_id, dst, &mut tmp);
}

fn unmap_8_32(text: &[u8], sa: &mut [i32], num_lms: usize) {
    let n = sa.len();
    let mut j = num_lms;
    let mut c0 = 0u8;
    let mut c1 = 0u8;
    let mut is_type_s = false;
    for i in (0..text.len()).rev() {
        c1 = c0;
        c0 = text[i];
        if c0 < c1 {
            is_type_s = true;
        } else if c0 > c1 && is_type_s {
            is_type_s = false;
            j -= 1;
            sa[n - num_lms + j] = (i + 1) as i32;
        }
    }
    for i in 0..num_lms {
        sa[i] = sa[n - num_lms + sa[i] as usize];
    }
}

fn expand_8_32(text: &[u8], freq: Option<&mut [i32]>, bucket: &mut [i32], sa: &mut [i32], num_lms: usize) {
    bucket_max_8_32(text, freq, bucket);
    let mut x = num_lms - 1;
    let mut sa_x = sa[x];
    let mut c = text[sa_x as usize];
    let mut b = bucket[c as usize] - 1;
    bucket[c as usize] = b;
    for i in (0..sa.len()).rev() {
        if i != b as usize {
            sa[i] = 0;
            continue;
        }
        sa[i] = sa_x;
        if x > 0 {
            x -= 1;
            sa_x = sa[x];
            c = text[sa_x as usize];
            b = bucket[c as usize] - 1;
            bucket[c as usize] = b;
        }
    }
}

fn induce_l_8_32(text: &[u8], sa: &mut [i32], freq: Option<&mut [i32]>, bucket: &mut [i32]) {
    bucket_min_8_32(text, freq, bucket);
    let mut k = (text.len() - 1) as isize;
    let c0 = text[k as usize - 1];
    let c1 = text[k as usize];
    if c0 < c1 {
        k = -k;
    }
    let mut c_b = c1;
    let mut b = bucket[c_b as usize];
    sa[b as usize] = k as i32;
    b += 1;
    for i in 0..sa.len() {
        let j = sa[i] as isize;
        if j <= 0 {
            continue;
        }
        let mut k = j - 1;
        let c1 = text[k as usize];
        if k > 0 {
            let c0 = text[k as usize - 1];
            if c0 < c1 {
                k = -k;
            }
        }
        if c_b != c1 {
            bucket[c_b as usize] = b;
            c_b = c1;
            b = bucket[c_b as usize];
        }
        sa[b as usize] = k as i32;
        b += 1;
    }
}

fn induce_s_8_32(text: &[u8], sa: &mut [i32], freq: Option<&mut [i32]>, bucket: &mut [i32]) {
    bucket_max_8_32(text, freq, bucket);
    let mut c_b = 0u8;
    let mut b = bucket[c_b as usize];
    for i in (0..sa.len()).rev() {
        let mut j = sa[i] as isize;
        if j >= 0 {
            continue;
        }
        j = -j;
        sa[i] = j as i32;
        let mut k = j - 1;
        let c1 = text[k as usize];
        if k > 0 {
            let c0 = text[k as usize - 1];
            if c0 <= c1 {
                k = -k;
            }
        }
        if c_b != c1 {
            bucket[c_b as usize] = b;
            c_b = c1;
            b = bucket[c_b as usize];
        }
        b -= 1;
        sa[b as usize] = k as i32;
    }
}

fn sais_32(text: &[i32], text_max: usize, sa: &mut [i32], tmp: &mut [i32]) {
    assert_eq!(sa.len(), text.len());
    assert!(tmp.len() >= text_max);
    if text.is_empty() {
        return;
    }
    if text.len() == 1 {
        sa[0] = 0;
        return;
    }
    let two = tmp.len() >= 2 * text_max;
    if two {
        tmp[0] = -1;
    }
    let num_lms = {
        let (freq, bucket) = split_freq_bucket(tmp, text_max, two);
        place_lms_32(text, sa, freq, bucket)
    };
    if num_lms > 1 {
        {
            let (freq, bucket) = split_freq_bucket(tmp, text_max, two);
            induce_sub_l_32(text, sa, freq, bucket);
        }
        {
            let (freq, bucket) = split_freq_bucket(tmp, text_max, two);
            induce_sub_s_32(text, sa, freq, bucket);
        }
        length_32(text, sa);
        let max_id = assign_id_32(text, sa, num_lms);
        if max_id < num_lms {
            map_32(sa, num_lms);
            recurse_32(sa, tmp, num_lms, max_id);
            unmap_32(text, sa, num_lms);
        } else {
            let n = sa.len();
            sa.copy_within(n - num_lms..n, 0);
        }
        {
            let (freq, bucket) = split_freq_bucket(tmp, text_max, two);
            expand_32(text, freq, bucket, sa, num_lms);
        }
    }
    {
        let (freq, bucket) = split_freq_bucket(tmp, text_max, two);
        induce_l_32(text, sa, freq, bucket);
    }
    {
        let (freq, bucket) = split_freq_bucket(tmp, text_max, two);
        induce_s_32(text, sa, freq, bucket);
    }
    tmp[0] = -1;
}

fn freq_32(text: &[i32], freq: Option<&mut [i32]>, bucket: &mut [i32]) {
    if let Some(freq) = freq {
        if freq[0] >= 0 {
            return;
        }
        freq.fill(0);
        for &c in text {
            freq[c as usize] += 1;
        }
    } else {
        bucket.fill(0);
        for &c in text {
            bucket[c as usize] += 1;
        }
    }
}

fn bucket_min_32(text: &[i32], freq: Option<&mut [i32]>, bucket: &mut [i32]) {
    if let Some(freq) = freq {
        freq_32(text, Some(freq), bucket);
        let mut total = 0i32;
        for i in 0..freq.len() {
            bucket[i] = total;
            total += freq[i];
        }
    } else {
        freq_32(text, None, bucket);
        let mut total = 0i32;
        for i in 0..bucket.len() {
            let n = bucket[i];
            bucket[i] = total;
            total += n;
        }
    }
}

fn bucket_max_32(text: &[i32], freq: Option<&mut [i32]>, bucket: &mut [i32]) {
    if let Some(freq) = freq {
        freq_32(text, Some(freq), bucket);
        let mut total = 0i32;
        for i in 0..freq.len() {
            total += freq[i];
            bucket[i] = total;
        }
    } else {
        freq_32(text, None, bucket);
        let mut total = 0i32;
        for i in 0..bucket.len() {
            total += bucket[i];
            bucket[i] = total;
        }
    }
}

fn place_lms_32(text: &[i32], sa: &mut [i32], freq: Option<&mut [i32]>, bucket: &mut [i32]) -> usize {
    bucket_max_32(text, freq, bucket);
    let mut num_lms = 0usize;
    let mut last_b = -1i32;
    let mut c0 = 0i32;
    let mut c1 = 0i32;
    let mut is_type_s = false;
    for i in (0..text.len()).rev() {
        c1 = c0;
        c0 = text[i];
        if c0 < c1 {
            is_type_s = true;
        } else if c0 > c1 && is_type_s {
            is_type_s = false;
            let b = bucket[c1 as usize] - 1;
            bucket[c1 as usize] = b;
            sa[b as usize] = (i + 1) as i32;
            last_b = b;
            num_lms += 1;
        }
    }
    if num_lms > 1 {
        sa[last_b as usize] = 0;
    }
    num_lms
}

fn induce_sub_l_32(text: &[i32], sa: &mut [i32], freq: Option<&mut [i32]>, bucket: &mut [i32]) {
    bucket_min_32(text, freq, bucket);
    let mut k = (text.len() - 1) as isize;
    let c0 = text[k as usize - 1];
    let c1 = text[k as usize];
    if c0 < c1 {
        k = -k;
    }
    let mut c_b = c1;
    let mut b = bucket[c_b as usize];
    sa[b as usize] = k as i32;
    b += 1;
    for i in 0..sa.len() {
        let j = sa[i] as isize;
        if j == 0 {
            continue;
        }
        if j < 0 {
            sa[i] = (-j) as i32;
            continue;
        }
        sa[i] = 0;
        let mut k = j - 1;
        let c1 = text[k as usize];
        let c0 = text[k as usize - 1];
        if c0 < c1 {
            k = -k;
        }
        if c_b != c1 {
            bucket[c_b as usize] = b;
            c_b = c1;
            b = bucket[c_b as usize];
        }
        sa[b as usize] = k as i32;
        b += 1;
    }
}

fn induce_sub_s_32(text: &[i32], sa: &mut [i32], freq: Option<&mut [i32]>, bucket: &mut [i32]) {
    bucket_max_32(text, freq, bucket);
    let mut c_b = 0i32;
    let mut b = bucket[c_b as usize];
    let mut top = sa.len();
    for i in (0..sa.len()).rev() {
        let j = sa[i] as isize;
        if j == 0 {
            continue;
        }
        sa[i] = 0;
        if j < 0 {
            top -= 1;
            sa[top] = (-j) as i32;
            continue;
        }
        let mut k = j - 1;
        let c1 = text[k as usize];
        let c0 = text[k as usize - 1];
        if c0 > c1 {
            k = -k;
        }
        if c_b != c1 {
            bucket[c_b as usize] = b;
            c_b = c1;
            b = bucket[c_b as usize];
        }
        b -= 1;
        sa[b as usize] = k as i32;
    }
}

fn length_32(text: &[i32], sa: &mut [i32]) {
    let mut end = 0usize;
    let mut c0 = 0i32;
    let mut c1 = 0i32;
    let mut is_type_s = false;
    for i in (0..text.len()).rev() {
        c1 = c0;
        c0 = text[i];
        if c0 < c1 {
            is_type_s = true;
        } else if c0 > c1 && is_type_s {
            is_type_s = false;
            let j = i + 1;
            sa[j >> 1] = if end == 0 { 0 } else { (end - j) as i32 };
            end = j + 1;
        }
    }
}

fn assign_id_32(text: &[i32], sa: &mut [i32], num_lms: usize) -> usize {
    let mut id = 0i32;
    let mut last_len = -1i32;
    let mut last_pos = 0i32;
    let start = sa.len() - num_lms;
    for idx in start..sa.len() {
        let j = sa[idx];
        let n = sa[(j as usize) / 2];
        let mut is_new = n != last_len;
        if !is_new {
            if (n as u32) >= text.len() as u32 {
                is_new = false;
            } else {
                let nn = n as usize;
                let ju = j as usize;
                let lu = last_pos as usize;
                is_new = text[ju..ju + nn] != text[lu..lu + nn];
            }
        }
        if is_new {
            id += 1;
            last_pos = j;
            last_len = n;
        }
        sa[(j as usize) / 2] = id;
    }
    id as usize
}

fn unmap_32(text: &[i32], sa: &mut [i32], num_lms: usize) {
    let n = sa.len();
    let mut j = num_lms;
    let mut c0 = 0i32;
    let mut c1 = 0i32;
    let mut is_type_s = false;
    for i in (0..text.len()).rev() {
        c1 = c0;
        c0 = text[i];
        if c0 < c1 {
            is_type_s = true;
        } else if c0 > c1 && is_type_s {
            is_type_s = false;
            j -= 1;
            sa[n - num_lms + j] = (i + 1) as i32;
        }
    }
    for i in 0..num_lms {
        sa[i] = sa[n - num_lms + sa[i] as usize];
    }
}

fn expand_32(text: &[i32], freq: Option<&mut [i32]>, bucket: &mut [i32], sa: &mut [i32], num_lms: usize) {
    bucket_max_32(text, freq, bucket);
    let mut x = num_lms - 1;
    let mut sa_x = sa[x];
    let mut c = text[sa_x as usize];
    let mut b = bucket[c as usize] - 1;
    bucket[c as usize] = b;
    for i in (0..sa.len()).rev() {
        if i != b as usize {
            sa[i] = 0;
            continue;
        }
        sa[i] = sa_x;
        if x > 0 {
            x -= 1;
            sa_x = sa[x];
            c = text[sa_x as usize];
            b = bucket[c as usize] - 1;
            bucket[c as usize] = b;
        }
    }
}

fn induce_l_32(text: &[i32], sa: &mut [i32], freq: Option<&mut [i32]>, bucket: &mut [i32]) {
    bucket_min_32(text, freq, bucket);
    let mut k = (text.len() - 1) as isize;
    let c0 = text[k as usize - 1];
    let c1 = text[k as usize];
    if c0 < c1 {
        k = -k;
    }
    let mut c_b = c1;
    let mut b = bucket[c_b as usize];
    sa[b as usize] = k as i32;
    b += 1;
    for i in 0..sa.len() {
        let j = sa[i] as isize;
        if j <= 0 {
            continue;
        }
        let mut k = j - 1;
        let c1 = text[k as usize];
        if k > 0 {
            let c0 = text[k as usize - 1];
            if c0 < c1 {
                k = -k;
            }
        }
        if c_b != c1 {
            bucket[c_b as usize] = b;
            c_b = c1;
            b = bucket[c_b as usize];
        }
        sa[b as usize] = k as i32;
        b += 1;
    }
}

fn induce_s_32(text: &[i32], sa: &mut [i32], freq: Option<&mut [i32]>, bucket: &mut [i32]) {
    bucket_max_32(text, freq, bucket);
    let mut c_b = 0i32;
    let mut b = bucket[c_b as usize];
    for i in (0..sa.len()).rev() {
        let mut j = sa[i] as isize;
        if j >= 0 {
            continue;
        }
        j = -j;
        sa[i] = j as i32;
        let mut k = j - 1;
        let c1 = text[k as usize];
        if k > 0 {
            let c0 = text[k as usize - 1];
            if c0 <= c1 {
                k = -k;
            }
        }
        if c_b != c1 {
            bucket[c_b as usize] = b;
            c_b = c1;
            b = bucket[c_b as usize];
        }
        b -= 1;
        sa[b as usize] = k as i32;
    }
}

pub fn lookup(data: &[u8], sa: &[i32], s: &[u8], n: i32) -> Vec<u32> {
    if s.is_empty() || n == 0 {
        return Vec::new();
    }
    let i = search(sa.len(), |i| suffix(data, sa, i) >= s);
    let j = i + search(sa.len() - i, |k| !suffix(data, sa, k + i).starts_with(s));
    let mut count = j - i;
    if n >= 0 && count > n as usize {
        count = n as usize;
    }
    sa[i..i + count].iter().map(|v| *v as u32).collect()
}

fn suffix<'a>(data: &'a [u8], sa: &[i32], i: usize) -> &'a [u8] {
    &data[sa[i] as usize..]
}

fn search(n: usize, mut f: impl FnMut(usize) -> bool) -> usize {
    let mut i = 0usize;
    let mut j = n;
    while i < j {
        let h = i + (j - i) / 2;
        if !f(h) {
            i = h + 1;
        } else {
            j = h;
        }
    }
    i
}
