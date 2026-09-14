// AST node shapes follow go/ast (Go 1.24). Field names in Fprint stay Go-cased.

use crate::token;
use std::rc::Rc;

pub const SEND: i32 = 1;
pub const RECV: i32 = 2;

#[derive(Clone, Debug)]
pub struct Comment {
    pub slash: i32,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct CommentGroup {
    pub list: Vec<Comment>,
}

#[derive(Clone, Debug)]
pub struct Ident {
    pub name_pos: i32,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct Field {
    pub doc: Option<Rc<CommentGroup>>,
    pub names: Option<Vec<Ident>>,
    pub typ: Option<Expr>,
    pub tag: Option<Box<BasicLit>>,
    pub comment: Option<Rc<CommentGroup>>,
}

#[derive(Clone, Debug)]
pub struct FieldList {
    pub opening: i32,
    pub list: Option<Vec<Field>>,
    pub closing: i32,
}

impl FieldList {
    pub fn num_fields(&self) -> usize {
        let mut n = 0usize;
        if let Some(list) = &self.list {
            for g in list {
                let m = g.names.as_ref().map(|v| v.len()).unwrap_or(0);
                n += if m == 0 { 1 } else { m };
            }
        }
        n
    }

    pub fn pos(&self) -> i32 {
        if self.opening != 0 {
            self.opening
        } else if let Some(list) = &self.list {
            if let Some(f) = list.first() {
                return field_pos(f);
            }
            0
        } else {
            0
        }
    }

    pub fn end(&self) -> i32 {
        if self.closing != 0 {
            self.closing + 1
        } else if let Some(list) = &self.list {
            if let Some(f) = list.last() {
                return field_end(f);
            }
            0
        } else {
            0
        }
    }
}

#[derive(Clone, Debug)]
pub struct BasicLit {
    pub value_pos: i32,
    pub kind: i32,
    pub value: String,
}

#[derive(Clone, Debug)]
pub enum Expr {
    Bad { from: i32, to: i32 },
    Ident(Ident),
    Ellipsis { ellipsis: i32, elt: Option<Box<Expr>> },
    BasicLit(BasicLit),
    FuncLit { typ: Box<FuncType>, body: Box<Stmt> },
    CompositeLit {
        typ: Option<Box<Expr>>,
        lbrace: i32,
        elts: Option<Vec<Expr>>,
        rbrace: i32,
        incomplete: bool,
    },
    Paren { lparen: i32, x: Box<Expr>, rparen: i32 },
    Selector { x: Box<Expr>, sel: Ident },
    Index { x: Box<Expr>, lbrack: i32, index: Box<Expr>, rbrack: i32 },
    IndexList { x: Box<Expr>, lbrack: i32, indices: Vec<Expr>, rbrack: i32 },
    Slice {
        x: Box<Expr>,
        lbrack: i32,
        low: Option<Box<Expr>>,
        high: Option<Box<Expr>>,
        max: Option<Box<Expr>>,
        slice3: bool,
        rbrack: i32,
    },
    TypeAssert { x: Box<Expr>, lparen: i32, typ: Option<Box<Expr>>, rparen: i32 },
    Call {
        fun: Box<Expr>,
        lparen: i32,
        args: Option<Vec<Expr>>,
        ellipsis: i32,
        rparen: i32,
    },
    Star { star: i32, x: Box<Expr> },
    Unary { op_pos: i32, op: i32, x: Box<Expr> },
    Binary { x: Box<Expr>, op_pos: i32, op: i32, y: Box<Expr> },
    KeyValue { key: Box<Expr>, colon: i32, value: Box<Expr> },
    Array { lbrack: i32, len: Option<Box<Expr>>, elt: Box<Expr> },
    Struct { struct_pos: i32, fields: FieldList, incomplete: bool },
    Func(FuncType),
    Interface { interface: i32, methods: FieldList, incomplete: bool },
    Map { map: i32, key: Box<Expr>, value: Box<Expr> },
    Chan { begin: i32, arrow: i32, dir: i32, value: Box<Expr> },
}

#[derive(Clone, Debug)]
pub struct FuncType {
    pub func: i32,
    pub type_params: Option<FieldList>,
    pub params: Option<FieldList>,
    pub results: Option<FieldList>,
}

#[derive(Clone, Debug)]
pub enum Stmt {
    Bad { from: i32, to: i32 },
    Decl { decl: Box<Decl> },
    Empty { semicolon: i32, implicit: bool },
    Labeled { label: Ident, colon: i32, stmt: Box<Stmt> },
    Expr { x: Expr },
    Send { chan: Expr, arrow: i32, value: Expr },
    IncDec { x: Expr, tok_pos: i32, tok: i32 },
    Assign { lhs: Vec<Expr>, tok_pos: i32, tok: i32, rhs: Vec<Expr> },
    Go { go_pos: i32, call: Box<Expr> },
    Defer { defer: i32, call: Box<Expr> },
    Return { return_pos: i32, results: Option<Vec<Expr>> },
    Branch { tok_pos: i32, tok: i32, label: Option<Ident> },
    Block { lbrace: i32, list: Option<Vec<Stmt>>, rbrace: i32 },
    If {
        if_pos: i32,
        init: Option<Box<Stmt>>,
        cond: Expr,
        body: Box<Stmt>,
        else_stmt: Option<Box<Stmt>>,
    },
    Case { case: i32, list: Option<Vec<Expr>>, colon: i32, body: Option<Vec<Stmt>> },
    Switch {
        switch: i32,
        init: Option<Box<Stmt>>,
        tag: Option<Expr>,
        body: Box<Stmt>,
    },
    TypeSwitch {
        switch: i32,
        init: Option<Box<Stmt>>,
        assign: Box<Stmt>,
        body: Box<Stmt>,
    },
    Comm { case: i32, comm: Option<Box<Stmt>>, colon: i32, body: Option<Vec<Stmt>> },
    Select { select: i32, body: Box<Stmt> },
    For {
        for_pos: i32,
        init: Option<Box<Stmt>>,
        cond: Option<Expr>,
        post: Option<Box<Stmt>>,
        body: Box<Stmt>,
    },
    Range {
        for_pos: i32,
        key: Option<Expr>,
        value: Option<Expr>,
        tok_pos: i32,
        tok: i32,
        range: i32,
        x: Expr,
        body: Box<Stmt>,
    },
}

#[derive(Clone, Debug)]
pub enum Spec {
    Import {
        doc: Option<Rc<CommentGroup>>,
        name: Option<Ident>,
        path: BasicLit,
        comment: Option<Rc<CommentGroup>>,
        end_pos: i32,
    },
    Value {
        doc: Option<Rc<CommentGroup>>,
        names: Vec<Ident>,
        typ: Option<Expr>,
        values: Option<Vec<Expr>>,
        comment: Option<Rc<CommentGroup>>,
    },
    Type {
        doc: Option<Rc<CommentGroup>>,
        name: Ident,
        type_params: Option<FieldList>,
        assign: i32,
        typ: Expr,
        comment: Option<Rc<CommentGroup>>,
    },
}

#[derive(Clone, Debug)]
pub enum Decl {
    Bad { from: i32, to: i32 },
    Gen {
        doc: Option<Rc<CommentGroup>>,
        tok_pos: i32,
        tok: i32,
        lparen: i32,
        specs: Vec<Rc<Spec>>,
        rparen: i32,
    },
    Func {
        doc: Option<Rc<CommentGroup>>,
        recv: Option<FieldList>,
        name: Ident,
        typ: FuncType,
        body: Option<Box<Stmt>>,
    },
}

#[derive(Clone, Debug)]
pub struct File {
    pub doc: Option<Rc<CommentGroup>>,
    pub package: i32,
    pub name: Ident,
    pub decls: Option<Vec<Decl>>,
    pub file_start: i32,
    pub file_end: i32,
    pub imports: Option<Vec<Rc<Spec>>>,
    pub comments: Option<Vec<Rc<CommentGroup>>>,
    pub go_version: String,
}

pub fn unparen(mut e: Expr) -> Expr {
    loop {
        match e {
            Expr::Paren { x, .. } => e = *x,
            other => return other,
        }
    }
}

pub fn ident_expr(name_pos: i32, name: impl Into<String>) -> Expr {
    Expr::Ident(Ident {
        name_pos,
        name: name.into(),
    })
}

fn field_pos(f: &Field) -> i32 {
    if let Some(names) = &f.names {
        if let Some(n) = names.first() {
            return n.name_pos;
        }
    }
    if let Some(t) = &f.typ {
        return expr_pos(t);
    }
    0
}

fn field_end(f: &Field) -> i32 {
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

pub fn expr_pos(e: &Expr) -> i32 {
    match e {
        Expr::Bad { from, .. } => *from,
        Expr::Ident(id) => id.name_pos,
        Expr::Ellipsis { ellipsis, .. } => *ellipsis,
        Expr::BasicLit(l) => l.value_pos,
        Expr::FuncLit { typ, .. } => func_type_pos(typ),
        Expr::CompositeLit { typ, lbrace, .. } => typ.as_ref().map(|t| expr_pos(t)).unwrap_or(*lbrace),
        Expr::Paren { lparen, .. } => *lparen,
        Expr::Selector { x, .. }
        | Expr::Index { x, .. }
        | Expr::IndexList { x, .. }
        | Expr::Slice { x, .. }
        | Expr::TypeAssert { x, .. } => expr_pos(x),
        Expr::Call { fun, .. } => expr_pos(fun),
        Expr::Star { star, .. } => *star,
        Expr::Unary { op_pos, .. } => *op_pos,
        Expr::Binary { x, .. } => expr_pos(x),
        Expr::KeyValue { key, .. } => expr_pos(key),
        Expr::Array { lbrack, .. } => *lbrack,
        Expr::Struct { struct_pos, .. } => *struct_pos,
        Expr::Func(t) => func_type_pos(t),
        Expr::Interface { interface, .. } => *interface,
        Expr::Map { map, .. } => *map,
        Expr::Chan { begin, .. } => *begin,
    }
}

pub fn expr_end(e: &Expr) -> i32 {
    match e {
        Expr::Bad { to, .. } => *to,
        Expr::Ident(id) => id.name_pos + id.name.len() as i32,
        Expr::Ellipsis { ellipsis, elt } => elt.as_ref().map(|x| expr_end(x)).unwrap_or(*ellipsis + 3),
        Expr::BasicLit(l) => l.value_pos + l.value.len() as i32,
        Expr::FuncLit { body, .. } => stmt_end(body),
        Expr::CompositeLit { rbrace, .. } => *rbrace + 1,
        Expr::Paren { rparen, .. } => *rparen + 1,
        Expr::Selector { sel, .. } => sel.name_pos + sel.name.len() as i32,
        Expr::Index { rbrack, .. } | Expr::IndexList { rbrack, .. } | Expr::Slice { rbrack, .. } => {
            *rbrack + 1
        }
        Expr::TypeAssert { rparen, .. } => *rparen + 1,
        Expr::Call { rparen, .. } => *rparen + 1,
        Expr::Star { x, .. } | Expr::Unary { x, .. } => expr_end(x),
        Expr::Binary { y, .. } => expr_end(y),
        Expr::KeyValue { value, .. } => expr_end(value),
        Expr::Array { elt, .. } => expr_end(elt),
        Expr::Struct { fields, .. } => fields.end(),
        Expr::Func(t) => func_type_end(t),
        Expr::Interface { methods, .. } => methods.end(),
        Expr::Map { value, .. } | Expr::Chan { value, .. } => expr_end(value),
    }
}

pub fn func_type_pos(t: &FuncType) -> i32 {
    if t.func != 0 || t.params.is_none() {
        t.func
    } else {
        t.params.as_ref().map(|p| p.pos()).unwrap_or(t.func)
    }
}

pub fn func_type_end(t: &FuncType) -> i32 {
    if let Some(r) = &t.results {
        r.end()
    } else {
        t.params.as_ref().map(|p| p.end()).unwrap_or(t.func)
    }
}

pub fn stmt_pos(s: &Stmt) -> i32 {
    match s {
        Stmt::Bad { from, .. } => *from,
        Stmt::Decl { decl } => decl_pos(decl),
        Stmt::Empty { semicolon, .. } => *semicolon,
        Stmt::Labeled { label, .. } => label.name_pos,
        Stmt::Expr { x } => expr_pos(x),
        Stmt::Send { chan, .. } => expr_pos(chan),
        Stmt::IncDec { x, .. } => expr_pos(x),
        Stmt::Assign { lhs, .. } => lhs.first().map(expr_pos).unwrap_or(0),
        Stmt::Go { go_pos, .. } => *go_pos,
        Stmt::Defer { defer, .. } => *defer,
        Stmt::Return { return_pos, .. } => *return_pos,
        Stmt::Branch { tok_pos, .. } => *tok_pos,
        Stmt::Block { lbrace, .. } => *lbrace,
        Stmt::If { if_pos, .. } => *if_pos,
        Stmt::Case { case, .. } => *case,
        Stmt::Switch { switch, .. } | Stmt::TypeSwitch { switch, .. } => *switch,
        Stmt::Comm { case, .. } => *case,
        Stmt::Select { select, .. } => *select,
        Stmt::For { for_pos, .. } | Stmt::Range { for_pos, .. } => *for_pos,
    }
}

pub fn stmt_end(s: &Stmt) -> i32 {
    match s {
        Stmt::Bad { to, .. } => *to,
        Stmt::Decl { decl } => decl_end(decl),
        Stmt::Empty { semicolon, implicit } => {
            if *implicit {
                *semicolon
            } else {
                *semicolon + 1
            }
        }
        Stmt::Labeled { stmt, .. } => stmt_end(stmt),
        Stmt::Expr { x } => expr_end(x),
        Stmt::Send { value, .. } => expr_end(value),
        Stmt::IncDec { tok_pos, .. } => *tok_pos + 2,
        Stmt::Assign { rhs, .. } => rhs.last().map(expr_end).unwrap_or(0),
        Stmt::Go { call, .. } | Stmt::Defer { call, .. } => expr_end(call),
        Stmt::Return { return_pos, results } => results
            .as_ref()
            .and_then(|v| v.last())
            .map(expr_end)
            .unwrap_or(*return_pos + 6),
        Stmt::Branch { tok_pos, tok, label } => {
            if let Some(l) = label {
                l.name_pos + l.name.len() as i32
            } else {
                *tok_pos + token::token_string(*tok).len() as i32
            }
        }
        Stmt::Block { list, rbrace, lbrace } => {
            if *rbrace != 0 {
                *rbrace + 1
            } else if let Some(list) = list {
                list.last().map(stmt_end).unwrap_or(*lbrace + 1)
            } else {
                *lbrace + 1
            }
        }
        Stmt::If { else_stmt, body, .. } => else_stmt.as_ref().map(|e| stmt_end(e)).unwrap_or_else(|| stmt_end(body)),
        Stmt::Case { body, colon, .. } | Stmt::Comm { body, colon, .. } => body
            .as_ref()
            .and_then(|v| v.last())
            .map(stmt_end)
            .unwrap_or(*colon + 1),
        Stmt::Switch { body, .. }
        | Stmt::TypeSwitch { body, .. }
        | Stmt::Select { body, .. }
        | Stmt::For { body, .. }
        | Stmt::Range { body, .. } => stmt_end(body),
    }
}

pub fn spec_pos(s: &Spec) -> i32 {
    match s {
        Spec::Import { name, path, .. } => name.as_ref().map(|n| n.name_pos).unwrap_or(path.value_pos),
        Spec::Value { names, .. } => names.first().map(|n| n.name_pos).unwrap_or(0),
        Spec::Type { name, .. } => name.name_pos,
    }
}

pub fn spec_end(s: &Spec) -> i32 {
    match s {
        Spec::Import { end_pos, path, .. } => {
            if *end_pos != 0 {
                *end_pos
            } else {
                path.value_pos + path.value.len() as i32
            }
        }
        Spec::Value { values, typ, names, .. } => {
            if let Some(v) = values.as_ref().and_then(|v| v.last()) {
                expr_end(v)
            } else if let Some(t) = typ {
                expr_end(t)
            } else {
                names.last().map(|n| n.name_pos + n.name.len() as i32).unwrap_or(0)
            }
        }
        Spec::Type { typ, .. } => expr_end(typ),
    }
}

pub fn decl_pos(d: &Decl) -> i32 {
    match d {
        Decl::Bad { from, .. } => *from,
        Decl::Gen { tok_pos, .. } => *tok_pos,
        Decl::Func { typ, .. } => func_type_pos(typ),
    }
}

pub fn decl_end(d: &Decl) -> i32 {
    match d {
        Decl::Bad { to, .. } => *to,
        Decl::Gen { rparen, specs, .. } => {
            if *rparen != 0 {
                *rparen + 1
            } else {
                specs.first().map(|s| spec_end(s)).unwrap_or(0)
            }
        }
        Decl::Func { body, typ, .. } => body.as_ref().map(|b| stmt_end(b)).unwrap_or_else(|| func_type_end(typ)),
    }
}

pub fn file_pos(f: &File) -> i32 {
    f.package
}

pub fn file_end(f: &File) -> i32 {
    f.decls
        .as_ref()
        .and_then(|d| d.last())
        .map(decl_end)
        .unwrap_or(f.name.name_pos + f.name.name.len() as i32)
}

pub fn is_type_elem(x: &Expr) -> bool {
    match x {
        Expr::Array { .. }
        | Expr::Struct { .. }
        | Expr::Func(_)
        | Expr::Interface { .. }
        | Expr::Map { .. }
        | Expr::Chan { .. } => true,
        Expr::Binary { x, y, .. } => is_type_elem(x) || is_type_elem(y),
        Expr::Unary { op, .. } => *op == token::TILDE,
        Expr::Paren { x, .. } => is_type_elem(x),
        _ => false,
    }
}
