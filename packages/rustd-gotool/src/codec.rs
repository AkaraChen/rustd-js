use crate::ast::*;
use std::rc::Rc;

pub fn file_to_json(f: &File) -> String {
    let mut s = String::new();
    write_file(&mut s, f);
    s
}

pub fn expr_to_json(e: &Expr) -> String {
    let mut s = String::new();
    write_expr(&mut s, e);
    s
}

fn push_str(out: &mut String, v: &str) {
    out.push('"');
    for c in v.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn pos_end(out: &mut String, pos: i32, end: i32) {
    out.push_str(&format!("\"pos\":{pos},\"end\":{end}"));
}

fn write_ident(out: &mut String, id: &Ident) {
    out.push_str("{\"nodeType\":\"Ident\",");
    pos_end(out, id.name_pos, id.name_pos + id.name.len() as i32);
    out.push_str(",\"name\":");
    push_str(out, &id.name);
    out.push('}');
}

fn write_comment(out: &mut String, c: &Comment) {
    out.push_str("{\"nodeType\":\"Comment\",");
    pos_end(out, c.slash, c.slash + c.text.len() as i32);
    out.push_str(",\"slash\":");
    out.push_str(&c.slash.to_string());
    out.push_str(",\"text\":");
    push_str(out, &c.text);
    out.push('}');
}

fn write_group(out: &mut String, g: &CommentGroup) {
    let pos = g.list.first().map(|c| c.slash).unwrap_or(0);
    let end = g
        .list
        .last()
        .map(|c| c.slash + c.text.len() as i32)
        .unwrap_or(0);
    out.push_str("{\"nodeType\":\"CommentGroup\",");
    pos_end(out, pos, end);
    out.push_str(",\"list\":[");
    for (i, c) in g.list.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_comment(out, c);
    }
    out.push_str("]}");
}

fn opt_group(out: &mut String, g: &Option<Rc<CommentGroup>>) {
    match g {
        None => out.push_str("null"),
        Some(g) => write_group(out, g),
    }
}

fn write_basic(out: &mut String, l: &BasicLit) {
    out.push_str("{\"nodeType\":\"BasicLit\",");
    pos_end(out, l.value_pos, l.value_pos + l.value.len() as i32);
    out.push_str(",\"valuePos\":");
    out.push_str(&l.value_pos.to_string());
    out.push_str(",\"kind\":");
    out.push_str(&l.kind.to_string());
    out.push_str(",\"value\":");
    push_str(out, &l.value);
    out.push('}');
}

fn write_field(out: &mut String, f: &Field) {
    out.push_str("{\"nodeType\":\"Field\",");
    pos_end(out, field_pos_json(f), field_end_json(f));
    out.push_str(",\"doc\":");
    opt_group(out, &f.doc);
    out.push_str(",\"names\":");
    match &f.names {
        None => out.push_str("null"),
        Some(names) => {
            out.push('[');
            for (i, n) in names.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_ident(out, n);
            }
            out.push(']');
        }
    }
    out.push_str(",\"type\":");
    match &f.typ {
        None => out.push_str("null"),
        Some(t) => write_expr(out, t),
    }
    out.push_str(",\"tag\":");
    match &f.tag {
        None => out.push_str("null"),
        Some(t) => write_basic(out, t),
    }
    out.push_str(",\"comment\":");
    opt_group(out, &f.comment);
    out.push('}');
}

fn field_pos_json(f: &Field) -> i32 {
    if let Some(names) = &f.names {
        if let Some(n) = names.first() {
            return n.name_pos;
        }
    }
    f.typ.as_ref().map(|t| expr_pos(t)).unwrap_or(0)
}

fn field_end_json(f: &Field) -> i32 {
    if let Some(tag) = &f.tag {
        return tag.value_pos + tag.value.len() as i32;
    }
    if let Some(t) = &f.typ {
        return expr_end(t);
    }
    if let Some(names) = &f.names {
        if let Some(n) = names.last() {
            return n.name_pos + n.name.len() as i32;
        }
    }
    0
}

fn write_fields(out: &mut String, fl: &FieldList) {
    out.push_str("{\"nodeType\":\"FieldList\",");
    pos_end(out, fl.pos(), fl.end());
    out.push_str(",\"opening\":");
    out.push_str(&fl.opening.to_string());
    out.push_str(",\"list\":");
    match &fl.list {
        None => out.push_str("null"),
        Some(list) => {
            out.push('[');
            for (i, f) in list.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_field(out, f);
            }
            out.push(']');
        }
    }
    out.push_str(",\"closing\":");
    out.push_str(&fl.closing.to_string());
    out.push('}');
}

fn opt_fields(out: &mut String, fl: &Option<FieldList>) {
    match fl {
        None => out.push_str("null"),
        Some(fl) => write_fields(out, fl),
    }
}

fn write_func_type(out: &mut String, t: &FuncType) {
    out.push_str("{\"nodeType\":\"FuncType\",");
    pos_end(out, func_type_pos(t), func_type_end(t));
    out.push_str(",\"func\":");
    out.push_str(&t.func.to_string());
    out.push_str(",\"typeParams\":");
    opt_fields(out, &t.type_params);
    out.push_str(",\"params\":");
    opt_fields(out, &t.params);
    out.push_str(",\"results\":");
    opt_fields(out, &t.results);
    out.push('}');
}

fn write_expr_list(out: &mut String, list: Option<&[Expr]>) {
    match list {
        None => out.push_str("null"),
        Some(list) => {
            out.push('[');
            for (i, e) in list.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_expr(out, e);
            }
            out.push(']');
        }
    }
}

fn write_stmt_list(out: &mut String, list: Option<&[Stmt]>) {
    match list {
        None => out.push_str("null"),
        Some(list) => {
            out.push('[');
            for (i, e) in list.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_stmt(out, e);
            }
            out.push(']');
        }
    }
}

pub fn write_expr(out: &mut String, e: &Expr) {
    match e {
        Expr::Bad { from, to } => {
            out.push_str("{\"nodeType\":\"BadExpr\",");
            pos_end(out, *from, *to);
            out.push_str(",\"from\":");
            out.push_str(&from.to_string());
            out.push_str(",\"to\":");
            out.push_str(&to.to_string());
            out.push('}');
        }
        Expr::Ident(id) => write_ident(out, id),
        Expr::Ellipsis { ellipsis, elt } => {
            out.push_str("{\"nodeType\":\"Ellipsis\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"ellipsis\":");
            out.push_str(&ellipsis.to_string());
            out.push_str(",\"elt\":");
            match elt {
                None => out.push_str("null"),
                Some(x) => write_expr(out, x),
            }
            out.push('}');
        }
        Expr::BasicLit(l) => write_basic(out, l),
        Expr::FuncLit { typ, body } => {
            out.push_str("{\"nodeType\":\"FuncLit\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"type\":");
            write_func_type(out, typ);
            out.push_str(",\"body\":");
            write_stmt(out, body);
            out.push('}');
        }
        Expr::CompositeLit {
            typ,
            lbrace,
            elts,
            rbrace,
            incomplete,
        } => {
            out.push_str("{\"nodeType\":\"CompositeLit\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"type\":");
            match typ {
                None => out.push_str("null"),
                Some(t) => write_expr(out, t),
            }
            out.push_str(",\"lbrace\":");
            out.push_str(&lbrace.to_string());
            out.push_str(",\"elts\":");
            write_expr_list(out, elts.as_deref());
            out.push_str(",\"rbrace\":");
            out.push_str(&rbrace.to_string());
            out.push_str(",\"incomplete\":");
            out.push_str(if *incomplete { "true" } else { "false" });
            out.push('}');
        }
        Expr::Paren { lparen, x, rparen } => {
            out.push_str("{\"nodeType\":\"ParenExpr\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"lparen\":");
            out.push_str(&lparen.to_string());
            out.push_str(",\"x\":");
            write_expr(out, x);
            out.push_str(",\"rparen\":");
            out.push_str(&rparen.to_string());
            out.push('}');
        }
        Expr::Selector { x, sel } => {
            out.push_str("{\"nodeType\":\"SelectorExpr\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"x\":");
            write_expr(out, x);
            out.push_str(",\"sel\":");
            write_ident(out, sel);
            out.push('}');
        }
        Expr::Index {
            x,
            lbrack,
            index,
            rbrack,
        } => {
            out.push_str("{\"nodeType\":\"IndexExpr\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"x\":");
            write_expr(out, x);
            out.push_str(",\"lbrack\":");
            out.push_str(&lbrack.to_string());
            out.push_str(",\"index\":");
            write_expr(out, index);
            out.push_str(",\"rbrack\":");
            out.push_str(&rbrack.to_string());
            out.push('}');
        }
        Expr::IndexList {
            x,
            lbrack,
            indices,
            rbrack,
        } => {
            out.push_str("{\"nodeType\":\"IndexListExpr\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"x\":");
            write_expr(out, x);
            out.push_str(",\"lbrack\":");
            out.push_str(&lbrack.to_string());
            out.push_str(",\"indices\":[");
            for (i, n) in indices.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_expr(out, n);
            }
            out.push_str("],\"rbrack\":");
            out.push_str(&rbrack.to_string());
            out.push('}');
        }
        Expr::Slice {
            x,
            lbrack,
            low,
            high,
            max,
            slice3,
            rbrack,
        } => {
            out.push_str("{\"nodeType\":\"SliceExpr\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"x\":");
            write_expr(out, x);
            out.push_str(",\"lbrack\":");
            out.push_str(&lbrack.to_string());
            out.push_str(",\"low\":");
            match low {
                None => out.push_str("null"),
                Some(v) => write_expr(out, v),
            }
            out.push_str(",\"high\":");
            match high {
                None => out.push_str("null"),
                Some(v) => write_expr(out, v),
            }
            out.push_str(",\"max\":");
            match max {
                None => out.push_str("null"),
                Some(v) => write_expr(out, v),
            }
            out.push_str(",\"slice3\":");
            out.push_str(if *slice3 { "true" } else { "false" });
            out.push_str(",\"rbrack\":");
            out.push_str(&rbrack.to_string());
            out.push('}');
        }
        Expr::TypeAssert {
            x,
            lparen,
            typ,
            rparen,
        } => {
            out.push_str("{\"nodeType\":\"TypeAssertExpr\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"x\":");
            write_expr(out, x);
            out.push_str(",\"lparen\":");
            out.push_str(&lparen.to_string());
            out.push_str(",\"type\":");
            match typ {
                None => out.push_str("null"),
                Some(t) => write_expr(out, t),
            }
            out.push_str(",\"rparen\":");
            out.push_str(&rparen.to_string());
            out.push('}');
        }
        Expr::Call {
            fun,
            lparen,
            args,
            ellipsis,
            rparen,
        } => {
            out.push_str("{\"nodeType\":\"CallExpr\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"fun\":");
            write_expr(out, fun);
            out.push_str(",\"lparen\":");
            out.push_str(&lparen.to_string());
            out.push_str(",\"args\":");
            write_expr_list(out, args.as_deref());
            out.push_str(",\"ellipsis\":");
            out.push_str(&ellipsis.to_string());
            out.push_str(",\"rparen\":");
            out.push_str(&rparen.to_string());
            out.push('}');
        }
        Expr::Star { star, x } => {
            out.push_str("{\"nodeType\":\"StarExpr\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"star\":");
            out.push_str(&star.to_string());
            out.push_str(",\"x\":");
            write_expr(out, x);
            out.push('}');
        }
        Expr::Unary { op_pos, op, x } => {
            out.push_str("{\"nodeType\":\"UnaryExpr\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"opPos\":");
            out.push_str(&op_pos.to_string());
            out.push_str(",\"op\":");
            out.push_str(&op.to_string());
            out.push_str(",\"x\":");
            write_expr(out, x);
            out.push('}');
        }
        Expr::Binary { x, op_pos, op, y } => {
            out.push_str("{\"nodeType\":\"BinaryExpr\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"x\":");
            write_expr(out, x);
            out.push_str(",\"opPos\":");
            out.push_str(&op_pos.to_string());
            out.push_str(",\"op\":");
            out.push_str(&op.to_string());
            out.push_str(",\"y\":");
            write_expr(out, y);
            out.push('}');
        }
        Expr::KeyValue { key, colon, value } => {
            out.push_str("{\"nodeType\":\"KeyValueExpr\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"key\":");
            write_expr(out, key);
            out.push_str(",\"colon\":");
            out.push_str(&colon.to_string());
            out.push_str(",\"value\":");
            write_expr(out, value);
            out.push('}');
        }
        Expr::Array { lbrack, len, elt } => {
            out.push_str("{\"nodeType\":\"ArrayType\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"lbrack\":");
            out.push_str(&lbrack.to_string());
            out.push_str(",\"len\":");
            match len {
                None => out.push_str("null"),
                Some(v) => write_expr(out, v),
            }
            out.push_str(",\"elt\":");
            write_expr(out, elt);
            out.push('}');
        }
        Expr::Struct {
            struct_pos,
            fields,
            incomplete,
        } => {
            out.push_str("{\"nodeType\":\"StructType\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"struct\":");
            out.push_str(&struct_pos.to_string());
            out.push_str(",\"fields\":");
            write_fields(out, fields);
            out.push_str(",\"incomplete\":");
            out.push_str(if *incomplete { "true" } else { "false" });
            out.push('}');
        }
        Expr::Func(t) => write_func_type(out, t),
        Expr::Interface {
            interface,
            methods,
            incomplete,
        } => {
            out.push_str("{\"nodeType\":\"InterfaceType\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"interface\":");
            out.push_str(&interface.to_string());
            out.push_str(",\"methods\":");
            write_fields(out, methods);
            out.push_str(",\"incomplete\":");
            out.push_str(if *incomplete { "true" } else { "false" });
            out.push('}');
        }
        Expr::Map { map, key, value } => {
            out.push_str("{\"nodeType\":\"MapType\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"map\":");
            out.push_str(&map.to_string());
            out.push_str(",\"key\":");
            write_expr(out, key);
            out.push_str(",\"value\":");
            write_expr(out, value);
            out.push('}');
        }
        Expr::Chan {
            begin,
            arrow,
            dir,
            value,
        } => {
            out.push_str("{\"nodeType\":\"ChanType\",");
            pos_end(out, expr_pos(e), expr_end(e));
            out.push_str(",\"begin\":");
            out.push_str(&begin.to_string());
            out.push_str(",\"arrow\":");
            out.push_str(&arrow.to_string());
            out.push_str(",\"dir\":");
            out.push_str(&dir.to_string());
            out.push_str(",\"value\":");
            write_expr(out, value);
            out.push('}');
        }
    }
}

pub fn write_stmt(out: &mut String, s: &Stmt) {
    match s {
        Stmt::Bad { from, to } => {
            out.push_str("{\"nodeType\":\"BadStmt\",");
            pos_end(out, *from, *to);
            out.push_str(",\"from\":");
            out.push_str(&from.to_string());
            out.push_str(",\"to\":");
            out.push_str(&to.to_string());
            out.push('}');
        }
        Stmt::Decl { decl } => {
            out.push_str("{\"nodeType\":\"DeclStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"decl\":");
            write_decl(out, decl);
            out.push('}');
        }
        Stmt::Empty {
            semicolon,
            implicit,
        } => {
            out.push_str("{\"nodeType\":\"EmptyStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"semicolon\":");
            out.push_str(&semicolon.to_string());
            out.push_str(",\"implicit\":");
            out.push_str(if *implicit { "true" } else { "false" });
            out.push('}');
        }
        Stmt::Labeled { label, colon, stmt } => {
            out.push_str("{\"nodeType\":\"LabeledStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"label\":");
            write_ident(out, label);
            out.push_str(",\"colon\":");
            out.push_str(&colon.to_string());
            out.push_str(",\"stmt\":");
            write_stmt(out, stmt);
            out.push('}');
        }
        Stmt::Expr { x } => {
            out.push_str("{\"nodeType\":\"ExprStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"x\":");
            write_expr(out, x);
            out.push('}');
        }
        Stmt::Send { chan, arrow, value } => {
            out.push_str("{\"nodeType\":\"SendStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"chan\":");
            write_expr(out, chan);
            out.push_str(",\"arrow\":");
            out.push_str(&arrow.to_string());
            out.push_str(",\"value\":");
            write_expr(out, value);
            out.push('}');
        }
        Stmt::IncDec { x, tok_pos, tok } => {
            out.push_str("{\"nodeType\":\"IncDecStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"x\":");
            write_expr(out, x);
            out.push_str(",\"tokPos\":");
            out.push_str(&tok_pos.to_string());
            out.push_str(",\"tok\":");
            out.push_str(&tok.to_string());
            out.push('}');
        }
        Stmt::Assign {
            lhs,
            tok_pos,
            tok,
            rhs,
        } => {
            out.push_str("{\"nodeType\":\"AssignStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"lhs\":[");
            for (i, e) in lhs.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_expr(out, e);
            }
            out.push_str("],\"tokPos\":");
            out.push_str(&tok_pos.to_string());
            out.push_str(",\"tok\":");
            out.push_str(&tok.to_string());
            out.push_str(",\"rhs\":[");
            for (i, e) in rhs.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_expr(out, e);
            }
            out.push_str("]}");
        }
        Stmt::Go { go_pos, call } => {
            out.push_str("{\"nodeType\":\"GoStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"go\":");
            out.push_str(&go_pos.to_string());
            out.push_str(",\"call\":");
            write_expr(out, call);
            out.push('}');
        }
        Stmt::Defer { defer, call } => {
            out.push_str("{\"nodeType\":\"DeferStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"defer\":");
            out.push_str(&defer.to_string());
            out.push_str(",\"call\":");
            write_expr(out, call);
            out.push('}');
        }
        Stmt::Return {
            return_pos,
            results,
        } => {
            out.push_str("{\"nodeType\":\"ReturnStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"return\":");
            out.push_str(&return_pos.to_string());
            out.push_str(",\"results\":");
            write_expr_list(out, results.as_deref());
            out.push('}');
        }
        Stmt::Branch {
            tok_pos,
            tok,
            label,
        } => {
            out.push_str("{\"nodeType\":\"BranchStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"tokPos\":");
            out.push_str(&tok_pos.to_string());
            out.push_str(",\"tok\":");
            out.push_str(&tok.to_string());
            out.push_str(",\"label\":");
            match label {
                None => out.push_str("null"),
                Some(l) => write_ident(out, l),
            }
            out.push('}');
        }
        Stmt::Block {
            lbrace,
            list,
            rbrace,
        } => {
            out.push_str("{\"nodeType\":\"BlockStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"lbrace\":");
            out.push_str(&lbrace.to_string());
            out.push_str(",\"list\":");
            write_stmt_list(out, list.as_deref());
            out.push_str(",\"rbrace\":");
            out.push_str(&rbrace.to_string());
            out.push('}');
        }
        Stmt::If {
            if_pos,
            init,
            cond,
            body,
            else_stmt,
        } => {
            out.push_str("{\"nodeType\":\"IfStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"if\":");
            out.push_str(&if_pos.to_string());
            out.push_str(",\"init\":");
            match init {
                None => out.push_str("null"),
                Some(i) => write_stmt(out, i),
            }
            out.push_str(",\"cond\":");
            write_expr(out, cond);
            out.push_str(",\"body\":");
            write_stmt(out, body);
            out.push_str(",\"else\":");
            match else_stmt {
                None => out.push_str("null"),
                Some(e) => write_stmt(out, e),
            }
            out.push('}');
        }
        Stmt::Case {
            case,
            list,
            colon,
            body,
        } => {
            out.push_str("{\"nodeType\":\"CaseClause\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"case\":");
            out.push_str(&case.to_string());
            out.push_str(",\"list\":");
            write_expr_list(out, list.as_deref());
            out.push_str(",\"colon\":");
            out.push_str(&colon.to_string());
            out.push_str(",\"body\":");
            write_stmt_list(out, body.as_deref());
            out.push('}');
        }
        Stmt::Switch {
            switch,
            init,
            tag,
            body,
        } => {
            out.push_str("{\"nodeType\":\"SwitchStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"switch\":");
            out.push_str(&switch.to_string());
            out.push_str(",\"init\":");
            match init {
                None => out.push_str("null"),
                Some(i) => write_stmt(out, i),
            }
            out.push_str(",\"tag\":");
            match tag {
                None => out.push_str("null"),
                Some(t) => write_expr(out, t),
            }
            out.push_str(",\"body\":");
            write_stmt(out, body);
            out.push('}');
        }
        Stmt::TypeSwitch {
            switch,
            init,
            assign,
            body,
        } => {
            out.push_str("{\"nodeType\":\"TypeSwitchStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"switch\":");
            out.push_str(&switch.to_string());
            out.push_str(",\"init\":");
            match init {
                None => out.push_str("null"),
                Some(i) => write_stmt(out, i),
            }
            out.push_str(",\"assign\":");
            write_stmt(out, assign);
            out.push_str(",\"body\":");
            write_stmt(out, body);
            out.push('}');
        }
        Stmt::Comm {
            case,
            comm,
            colon,
            body,
        } => {
            out.push_str("{\"nodeType\":\"CommClause\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"case\":");
            out.push_str(&case.to_string());
            out.push_str(",\"comm\":");
            match comm {
                None => out.push_str("null"),
                Some(c) => write_stmt(out, c),
            }
            out.push_str(",\"colon\":");
            out.push_str(&colon.to_string());
            out.push_str(",\"body\":");
            write_stmt_list(out, body.as_deref());
            out.push('}');
        }
        Stmt::Select { select, body } => {
            out.push_str("{\"nodeType\":\"SelectStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"select\":");
            out.push_str(&select.to_string());
            out.push_str(",\"body\":");
            write_stmt(out, body);
            out.push('}');
        }
        Stmt::For {
            for_pos,
            init,
            cond,
            post,
            body,
        } => {
            out.push_str("{\"nodeType\":\"ForStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"for\":");
            out.push_str(&for_pos.to_string());
            out.push_str(",\"init\":");
            match init {
                None => out.push_str("null"),
                Some(i) => write_stmt(out, i),
            }
            out.push_str(",\"cond\":");
            match cond {
                None => out.push_str("null"),
                Some(c) => write_expr(out, c),
            }
            out.push_str(",\"post\":");
            match post {
                None => out.push_str("null"),
                Some(p) => write_stmt(out, p),
            }
            out.push_str(",\"body\":");
            write_stmt(out, body);
            out.push('}');
        }
        Stmt::Range {
            for_pos,
            key,
            value,
            tok_pos,
            tok,
            range,
            x,
            body,
        } => {
            out.push_str("{\"nodeType\":\"RangeStmt\",");
            pos_end(out, stmt_pos(s), stmt_end(s));
            out.push_str(",\"for\":");
            out.push_str(&for_pos.to_string());
            out.push_str(",\"key\":");
            match key {
                None => out.push_str("null"),
                Some(k) => write_expr(out, k),
            }
            out.push_str(",\"value\":");
            match value {
                None => out.push_str("null"),
                Some(v) => write_expr(out, v),
            }
            out.push_str(",\"tokPos\":");
            out.push_str(&tok_pos.to_string());
            out.push_str(",\"tok\":");
            out.push_str(&tok.to_string());
            out.push_str(",\"range\":");
            out.push_str(&range.to_string());
            out.push_str(",\"x\":");
            write_expr(out, x);
            out.push_str(",\"body\":");
            write_stmt(out, body);
            out.push('}');
        }
    }
}

fn write_spec(out: &mut String, s: &Spec) {
    match s {
        Spec::Import {
            doc,
            name,
            path,
            comment,
            end_pos,
        } => {
            out.push_str("{\"nodeType\":\"ImportSpec\",");
            pos_end(out, spec_pos(s), spec_end(s));
            out.push_str(",\"doc\":");
            opt_group(out, doc);
            out.push_str(",\"name\":");
            match name {
                None => out.push_str("null"),
                Some(n) => write_ident(out, n),
            }
            out.push_str(",\"path\":");
            write_basic(out, path);
            out.push_str(",\"comment\":");
            opt_group(out, comment);
            out.push_str(",\"endPos\":");
            out.push_str(&end_pos.to_string());
            out.push('}');
        }
        Spec::Value {
            doc,
            names,
            typ,
            values,
            comment,
        } => {
            out.push_str("{\"nodeType\":\"ValueSpec\",");
            pos_end(out, spec_pos(s), spec_end(s));
            out.push_str(",\"doc\":");
            opt_group(out, doc);
            out.push_str(",\"names\":[");
            for (i, n) in names.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_ident(out, n);
            }
            out.push_str("],\"type\":");
            match typ {
                None => out.push_str("null"),
                Some(t) => write_expr(out, t),
            }
            out.push_str(",\"values\":");
            write_expr_list(out, values.as_deref());
            out.push_str(",\"comment\":");
            opt_group(out, comment);
            out.push('}');
        }
        Spec::Type {
            doc,
            name,
            type_params,
            assign,
            typ,
            comment,
        } => {
            out.push_str("{\"nodeType\":\"TypeSpec\",");
            pos_end(out, spec_pos(s), spec_end(s));
            out.push_str(",\"doc\":");
            opt_group(out, doc);
            out.push_str(",\"name\":");
            write_ident(out, name);
            out.push_str(",\"typeParams\":");
            opt_fields(out, type_params);
            out.push_str(",\"assign\":");
            out.push_str(&assign.to_string());
            out.push_str(",\"type\":");
            write_expr(out, typ);
            out.push_str(",\"comment\":");
            opt_group(out, comment);
            out.push('}');
        }
    }
}

pub fn write_decl(out: &mut String, d: &Decl) {
    match d {
        Decl::Bad { from, to } => {
            out.push_str("{\"nodeType\":\"BadDecl\",");
            pos_end(out, *from, *to);
            out.push_str(",\"from\":");
            out.push_str(&from.to_string());
            out.push_str(",\"to\":");
            out.push_str(&to.to_string());
            out.push('}');
        }
        Decl::Gen {
            doc,
            tok_pos,
            tok,
            lparen,
            specs,
            rparen,
        } => {
            out.push_str("{\"nodeType\":\"GenDecl\",");
            pos_end(out, decl_pos(d), decl_end(d));
            out.push_str(",\"doc\":");
            opt_group(out, doc);
            out.push_str(",\"tokPos\":");
            out.push_str(&tok_pos.to_string());
            out.push_str(",\"tok\":");
            out.push_str(&tok.to_string());
            out.push_str(",\"lparen\":");
            out.push_str(&lparen.to_string());
            out.push_str(",\"specs\":[");
            for (i, s) in specs.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_spec(out, s);
            }
            out.push_str("],\"rparen\":");
            out.push_str(&rparen.to_string());
            out.push('}');
        }
        Decl::Func {
            doc,
            recv,
            name,
            typ,
            body,
        } => {
            out.push_str("{\"nodeType\":\"FuncDecl\",");
            pos_end(out, decl_pos(d), decl_end(d));
            out.push_str(",\"doc\":");
            opt_group(out, doc);
            out.push_str(",\"recv\":");
            opt_fields(out, recv);
            out.push_str(",\"name\":");
            write_ident(out, name);
            out.push_str(",\"type\":");
            write_func_type(out, typ);
            out.push_str(",\"body\":");
            match body {
                None => out.push_str("null"),
                Some(b) => write_stmt(out, b),
            }
            out.push('}');
        }
    }
}

fn write_file(out: &mut String, f: &File) {
    out.push_str("{\"nodeType\":\"File\",");
    pos_end(out, file_pos(f), file_end(f));
    out.push_str(",\"doc\":");
    opt_group(out, &f.doc);
    out.push_str(",\"package\":");
    out.push_str(&f.package.to_string());
    out.push_str(",\"name\":");
    write_ident(out, &f.name);
    out.push_str(",\"decls\":");
    match &f.decls {
        None => out.push_str("null"),
        Some(list) => {
            out.push('[');
            for (i, d) in list.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_decl(out, d);
            }
            out.push(']');
        }
    }
    out.push_str(",\"fileStart\":");
    out.push_str(&f.file_start.to_string());
    out.push_str(",\"fileEnd\":");
    out.push_str(&f.file_end.to_string());
    out.push_str(",\"scope\":null,\"imports\":");
    match &f.imports {
        None => out.push_str("null"),
        Some(list) => {
            out.push('[');
            for (i, d) in list.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_spec(out, d);
            }
            out.push(']');
        }
    }
    out.push_str(",\"unresolved\":null,\"comments\":");
    match &f.comments {
        None => out.push_str("null"),
        Some(list) => {
            out.push('[');
            for (i, g) in list.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_group(out, g);
            }
            out.push(']');
        }
    }
    out.push_str(",\"goVersion\":");
    push_str(out, &f.go_version);
    out.push('}');
}
