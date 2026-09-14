use crate::regexp::*;

pub fn simplify(nodes: &mut Vec<Regexp>, id: u32) -> u32 {
    let op = nodes[id as usize].op;
    match op {
        OP_CAPTURE | OP_CONCAT | OP_ALTERNATE => {
            let subs = nodes[id as usize].sub.clone();
            let mut nre = id;
            for (i, &sub) in subs.iter().enumerate() {
                let nsub = simplify(nodes, sub);
                if nre == id && nsub != sub {
                    let mut copy = nodes[id as usize].clone();
                    copy.rune.clear();
                    copy.sub = subs[..i].to_vec();
                    nre = push(nodes, copy);
                }
                if nre != id {
                    nodes[nre as usize].sub.push(nsub);
                }
            }
            nre
        }
        OP_STAR | OP_PLUS | OP_QUEST => {
            let flags = nodes[id as usize].flags;
            let sub0 = nodes[id as usize].sub[0];
            let sub = simplify(nodes, sub0);
            simplify1(nodes, op, flags, sub, Some(id))
        }
        OP_REPEAT => {
            let min = nodes[id as usize].min;
            let max = nodes[id as usize].max;
            let flags = nodes[id as usize].flags;
            let sub0 = nodes[id as usize].sub[0];
            if min == 0 && max == 0 {
                return push(nodes, Regexp::new(OP_EMPTY_MATCH));
            }
            let sub = simplify(nodes, sub0);
            if max == -1 {
                if min == 0 {
                    return simplify1(nodes, OP_STAR, flags, sub, None);
                }
                if min == 1 {
                    return simplify1(nodes, OP_PLUS, flags, sub, None);
                }
                let mut nre = Regexp::new(OP_CONCAT);
                nre.sub.reserve(min as usize);
                for _ in 0..(min - 1) {
                    nre.sub.push(sub);
                }
                nre.sub.push(simplify1(nodes, OP_PLUS, flags, sub, None));
                return push(nodes, nre);
            }
            if min == 1 && max == 1 {
                return sub;
            }
            let mut prefix = None;
            if min > 0 {
                let mut p = Regexp::new(OP_CONCAT);
                p.sub.reserve(min as usize + 1);
                for _ in 0..min {
                    p.sub.push(sub);
                }
                prefix = Some(push(nodes, p));
            }
            if max > min {
                let mut suffix = simplify1(nodes, OP_QUEST, flags, sub, None);
                let mut i = min + 1;
                while i < max {
                    let mut nre2 = Regexp::new(OP_CONCAT);
                    nre2.sub.push(sub);
                    nre2.sub.push(suffix);
                    let nre2_id = push(nodes, nre2);
                    suffix = simplify1(nodes, OP_QUEST, flags, nre2_id, None);
                    i += 1;
                }
                if prefix.is_none() {
                    return suffix;
                }
                nodes[prefix.unwrap() as usize].sub.push(suffix);
            }
            if let Some(p) = prefix {
                return p;
            }
            push(nodes, Regexp::new(OP_NO_MATCH))
        }
        _ => id,
    }
}

fn push(nodes: &mut Vec<Regexp>, re: Regexp) -> u32 {
    let id = nodes.len() as u32;
    nodes.push(re);
    id
}

fn simplify1(nodes: &mut Vec<Regexp>, op: u8, flags: u16, sub: u32, re: Option<u32>) -> u32 {
    if nodes[sub as usize].op == OP_EMPTY_MATCH {
        return sub;
    }
    if op == nodes[sub as usize].op && flags & NON_GREEDY == nodes[sub as usize].flags & NON_GREEDY {
        return sub;
    }
    if let Some(re_id) = re {
        let re_n = &nodes[re_id as usize];
        if re_n.op == op && re_n.flags & NON_GREEDY == flags & NON_GREEDY && re_n.sub[0] == sub {
            return re_id;
        }
    }
    let mut n = Regexp::new(op);
    n.flags = flags;
    n.sub.push(sub);
    push(nodes, n)
}
