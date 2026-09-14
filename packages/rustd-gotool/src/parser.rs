use crate::ast::*;
use crate::fileset::{FileSet, GoFile};
use crate::scanner::{NativeScanError, ScannerState, SCAN_COMMENTS};
use crate::token;
use napi::bindgen_prelude::*;
use std::rc::Rc;

pub const PACKAGE_CLAUSE_ONLY: u32 = 1 << 0;
pub const IMPORTS_ONLY: u32 = 1 << 1;
pub const PARSE_COMMENTS: u32 = 1 << 2;
pub const TRACE: u32 = 1 << 3;
pub const DECLARATION_ERRORS: u32 = 1 << 4;
pub const ALL_ERRORS: u32 = 1 << 5;
pub const SKIP_OBJECT_RESOLUTION: u32 = 1 << 6;

const BASIC: i32 = 0;
const LABEL_OK: i32 = 1;
const RANGE_OK: i32 = 2;
// Go's go/parser uses 1e5 because goroutine stacks grow. Native thread
// stacks do not, so we cap lower and still report the same error string.
const MAX_NEST: i32 = 1_024;

struct ParseErr {
    filename: String,
    offset: i64,
    line: i64,
    column: i64,
    msg: String,
}

struct Parser {
    file: GoFile,
    errors: Vec<ParseErr>,
    scanner: ScannerState,
    mode: u32,
    comments: Vec<Rc<CommentGroup>>,
    lead_comment: Option<Rc<CommentGroup>>,
    line_comment: Option<Rc<CommentGroup>>,
    top: bool,
    go_version: String,
    pos: i32,
    tok: i32,
    lit: String,
    sync_pos: i32,
    sync_cnt: i32,
    expr_lev: i32,
    in_rhs: bool,
    imports: Vec<Rc<Spec>>,
    nest_lev: i32,
    bailed: bool,
    nest_overflow: bool,
}

fn push<T>(slot: &mut Option<Vec<T>>, x: T) {
    slot.get_or_insert_with(Vec::new).push(x);
}

impl Parser {
    fn init(file: GoFile, src: &[u8], mode: u32) -> Result<Self> {
        let scanner = ScannerState::new(&file, src, SCAN_COMMENTS)?;
        let mut p = Self {
            file,
            errors: Vec::new(),
            scanner,
            mode,
            comments: Vec::new(),
            lead_comment: None,
            line_comment: None,
            top: true,
            go_version: String::new(),
            pos: 0,
            tok: token::ILLEGAL,
            lit: String::new(),
            sync_pos: 0,
            sync_cnt: 0,
            expr_lev: 0,
            in_rhs: false,
            imports: Vec::new(),
            nest_lev: 0,
            bailed: false,
            nest_overflow: false,
        };
        p.next()?;
        Ok(p)
    }

    fn inc_nest(&mut self) -> Result<()> {
        self.nest_lev += 1;
        if self.nest_lev > MAX_NEST {
            self.error(self.pos, "exceeded max nesting depth")?;
            self.bailed = true;
            self.nest_overflow = true;
            return Err(Error::from_reason("exceeded max nesting depth"));
        }
        Ok(())
    }

    fn dec_nest(&mut self) {
        self.nest_lev -= 1;
    }

    fn next0(&mut self) -> Result<()> {
        loop {
            let step = self.scanner.scan()?;
            for e in step.errors {
                self.add_scan_err(e);
            }
            self.pos = step.pos as i32;
            self.tok = step.tok;
            self.lit = step.lit;
            if self.tok == token::COMMENT {
                if self.top && self.lit.starts_with("//go:build") {
                    if let Some(v) = go_version_from_build(&self.lit) {
                        self.go_version = v;
                    }
                }
                if self.mode & PARSE_COMMENTS == 0 {
                    continue;
                }
            } else {
                self.top = false;
            }
            break;
        }
        Ok(())
    }

    fn add_scan_err(&mut self, e: NativeScanError) {
        self.errors.push(ParseErr {
            filename: e.filename,
            offset: e.offset,
            line: e.line,
            column: e.column,
            msg: e.msg,
        });
    }

    fn consume_comment(&mut self) -> Result<(Comment, i32)> {
        let mut endline = self.file.line_of(self.pos)?;
        if self.lit.as_bytes().get(1) == Some(&b'*') {
            endline += self.lit.bytes().filter(|b| *b == b'\n').count() as i32;
        }
        let comment = Comment {
            slash: self.pos,
            text: self.lit.clone(),
        };
        self.next0()?;
        Ok((comment, endline))
    }

    fn consume_comment_group(&mut self, n: i32) -> Result<(Rc<CommentGroup>, i32)> {
        let mut list = Vec::new();
        let mut endline = self.file.line_of(self.pos)?;
        while self.tok == token::COMMENT && self.file.line_of(self.pos)? <= endline + n {
            let (c, el) = self.consume_comment()?;
            endline = el;
            list.push(c);
        }
        let comments = Rc::new(CommentGroup { list });
        self.comments.push(comments.clone());
        Ok((comments, endline))
    }

    fn next(&mut self) -> Result<()> {
        self.lead_comment = None;
        self.line_comment = None;
        let prev = self.pos;
        self.next0()?;
        if self.tok == token::COMMENT {
            let mut comment = None;
            let mut endline = 0;
            if self.file.line_of(self.pos)? == self.file.line_of(prev)? {
                let (c, el) = self.consume_comment_group(0)?;
                endline = el;
                if self.file.line_of(self.pos)? != endline
                    || self.tok == token::SEMICOLON
                    || self.tok == token::EOF
                {
                    self.line_comment = Some(c.clone());
                }
                comment = Some(c);
            }
            endline = -1;
            while self.tok == token::COMMENT {
                let (c, el) = self.consume_comment_group(1)?;
                endline = el;
                comment = Some(c);
            }
            if endline + 1 == self.file.line_of(self.pos)? {
                self.lead_comment = comment;
            }
        }
        Ok(())
    }

    fn error(&mut self, pos: i32, msg: &str) -> Result<()> {
        let epos = self.file.position_of(pos, true)?;
        if self.mode & ALL_ERRORS == 0 {
            let n = self.errors.len();
            if n > 0 && self.errors[n - 1].line == epos.line {
                return Ok(());
            }
            if n > 10 {
                self.bailed = true;
                return Ok(());
            }
        }
        self.errors.push(ParseErr {
            filename: epos.filename,
            offset: epos.offset,
            line: epos.line,
            column: epos.column,
            msg: msg.to_string(),
        });
        Ok(())
    }

    fn error_expected(&mut self, pos: i32, msg: &str) -> Result<()> {
        let mut msg = format!("expected {msg}");
        if pos == self.pos {
            if self.tok == token::SEMICOLON && self.lit == "\n" {
                msg.push_str(", found newline");
            } else if token::is_literal(self.tok) {
                msg.push_str(", found ");
                msg.push_str(&self.lit);
            } else {
                msg.push_str(", found '");
                msg.push_str(&token::token_string(self.tok));
                msg.push('\'');
            }
        }
        self.error(pos, &msg)
    }

    fn expect(&mut self, tok: i32) -> Result<i32> {
        let pos = self.pos;
        if self.tok != tok {
            self.error_expected(pos, &format!("'{}'", token::token_string(tok)))?;
        }
        self.next()?;
        Ok(pos)
    }

    fn expect2(&mut self, tok: i32) -> Result<i32> {
        let pos = if self.tok == tok {
            self.pos
        } else {
            self.error_expected(self.pos, &format!("'{}'", token::token_string(tok)))?;
            0
        };
        self.next()?;
        Ok(pos)
    }

    fn expect_closing(&mut self, tok: i32, context: &str) -> Result<i32> {
        if self.tok != tok && self.tok == token::SEMICOLON && self.lit == "\n" {
            self.error(self.pos, &format!("missing ',' before newline in {context}"))?;
            self.next()?;
        }
        self.expect(tok)
    }

    fn expect_semi(&mut self) -> Result<Option<Rc<CommentGroup>>> {
        if self.tok != token::RPAREN && self.tok != token::RBRACE {
            match self.tok {
                token::COMMA => {
                    self.error_expected(self.pos, "';'")?;
                    if self.lit == ";" {
                        self.next()?;
                        return Ok(self.line_comment.clone());
                    }
                    let c = self.line_comment.clone();
                    self.next()?;
                    return Ok(c);
                }
                token::SEMICOLON => {
                    if self.lit == ";" {
                        self.next()?;
                        return Ok(self.line_comment.clone());
                    }
                    let c = self.line_comment.clone();
                    self.next()?;
                    return Ok(c);
                }
                _ => {
                    self.error_expected(self.pos, "';'")?;
                    self.advance_stmt()?;
                }
            }
        }
        Ok(None)
    }

    fn at_comma(&mut self, context: &str, follow: i32) -> Result<bool> {
        if self.tok == token::COMMA {
            return Ok(true);
        }
        if self.tok != follow {
            let mut msg = String::from("missing ','");
            if self.tok == token::SEMICOLON && self.lit == "\n" {
                msg.push_str(" before newline");
            }
            msg.push_str(" in ");
            msg.push_str(context);
            self.error(self.pos, &msg)?;
            return Ok(true);
        }
        Ok(false)
    }

    fn advance_to(&mut self, to: &[i32]) -> Result<()> {
        while self.tok != token::EOF {
            if to.contains(&self.tok) {
                if self.pos == self.sync_pos && self.sync_cnt < 10 {
                    self.sync_cnt += 1;
                    return Ok(());
                }
                if self.pos > self.sync_pos {
                    self.sync_pos = self.pos;
                    self.sync_cnt = 0;
                    return Ok(());
                }
            }
            self.next()?;
        }
        Ok(())
    }

    fn advance_stmt(&mut self) -> Result<()> {
        self.advance_to(&[
            token::BREAK,
            token::CONST,
            token::CONTINUE,
            token::DEFER,
            token::FALLTHROUGH,
            token::FOR,
            token::GO,
            token::GOTO,
            token::IF,
            token::RETURN,
            token::SELECT,
            token::SWITCH,
            token::TYPE,
            token::VAR,
        ])
    }

    fn advance_decl(&mut self) -> Result<()> {
        self.advance_to(&[token::IMPORT, token::CONST, token::TYPE, token::VAR])
    }

    fn advance_expr(&mut self) -> Result<()> {
        self.advance_to(&[
            token::COMMA,
            token::COLON,
            token::SEMICOLON,
            token::RPAREN,
            token::RBRACK,
            token::RBRACE,
        ])
    }

    fn safe_pos(&self, pos: i32) -> Result<i32> {
        let base = self.file.base_i32()?;
        let size = self.file.size_i32()?;
        if pos < base {
            return Ok(base);
        }
        if pos > base + size {
            return Ok(base + size);
        }
        Ok(pos)
    }

    fn parse_ident(&mut self) -> Result<Ident> {
        let pos = self.pos;
        let mut name = String::from("_");
        if self.tok == token::IDENT {
            name = self.lit.clone();
            self.next()?;
        } else {
            self.expect(token::IDENT)?;
        }
        Ok(Ident {
            name_pos: pos,
            name,
        })
    }

    fn parse_ident_list(&mut self) -> Result<Vec<Ident>> {
        let mut list = vec![self.parse_ident()?];
        while self.tok == token::COMMA {
            self.next()?;
            list.push(self.parse_ident()?);
        }
        Ok(list)
    }

    fn parse_expr_list(&mut self) -> Result<Vec<Expr>> {
        let mut list = vec![self.parse_expr()?];
        while self.tok == token::COMMA {
            self.next()?;
            list.push(self.parse_expr()?);
        }
        Ok(list)
    }

    fn parse_list(&mut self, in_rhs: bool) -> Result<Vec<Expr>> {
        let old = self.in_rhs;
        self.in_rhs = in_rhs;
        let list = self.parse_expr_list()?;
        self.in_rhs = old;
        Ok(list)
    }

    fn parse_type(&mut self) -> Result<Expr> {
        if let Some(typ) = self.try_ident_or_type()? {
            Ok(typ)
        } else {
            let pos = self.pos;
            self.error_expected(pos, "type")?;
            self.advance_expr()?;
            Ok(Expr::Bad { from: pos, to: self.pos })
        }
    }

    fn parse_qualified_ident(&mut self, ident: Option<Ident>) -> Result<Expr> {
        let mut typ = self.parse_type_name(ident)?;
        if self.tok == token::LBRACK {
            typ = self.parse_type_instance(typ)?;
        }
        Ok(typ)
    }

    fn parse_type_name(&mut self, ident: Option<Ident>) -> Result<Expr> {
        let ident = match ident {
            Some(i) => i,
            None => self.parse_ident()?,
        };
        if self.tok == token::PERIOD {
            self.next()?;
            let sel = self.parse_ident()?;
            Ok(Expr::Selector {
                x: Box::new(Expr::Ident(ident)),
                sel,
            })
        } else {
            Ok(Expr::Ident(ident))
        }
    }

    fn parse_array_type(&mut self, lbrack: i32, mut len: Option<Expr>) -> Result<Expr> {
        if len.is_none() {
            self.expr_lev += 1;
            if self.tok == token::ELLIPSIS {
                len = Some(Expr::Ellipsis {
                    ellipsis: self.pos,
                    elt: None,
                });
                self.next()?;
            } else if self.tok != token::RBRACK {
                len = Some(self.parse_rhs()?);
            }
            self.expr_lev -= 1;
        }
        if self.tok == token::COMMA {
            self.error(self.pos, "unexpected comma; expecting ]")?;
            self.next()?;
        }
        self.expect(token::RBRACK)?;
        let elt = self.parse_type()?;
        Ok(Expr::Array {
            lbrack,
            len: len.map(Box::new),
            elt: Box::new(elt),
        })
    }

    fn parse_array_field_or_type_instance(&mut self, x: Ident) -> Result<(Option<Ident>, Expr)> {
        let lbrack = self.expect(token::LBRACK)?;
        let mut trailing_comma = 0;
        let mut args = Vec::new();
        if self.tok != token::RBRACK {
            self.expr_lev += 1;
            args.push(self.parse_rhs()?);
            while self.tok == token::COMMA {
                let comma = self.pos;
                self.next()?;
                if self.tok == token::RBRACK {
                    trailing_comma = comma;
                    break;
                }
                args.push(self.parse_rhs()?);
            }
            self.expr_lev -= 1;
        }
        let rbrack = self.expect(token::RBRACK)?;
        if args.is_empty() {
            let elt = self.parse_type()?;
            return Ok((
                Some(x),
                Expr::Array {
                    lbrack,
                    len: None,
                    elt: Box::new(elt),
                },
            ));
        }
        if args.len() == 1 {
            if let Some(elt) = self.try_ident_or_type()? {
                if trailing_comma != 0 {
                    self.error(trailing_comma, "unexpected comma; expecting ]")?;
                }
                return Ok((
                    Some(x),
                    Expr::Array {
                        lbrack,
                        len: Some(Box::new(args.remove(0))),
                        elt: Box::new(elt),
                    },
                ));
            }
        }
        Ok((None, pack_index_expr(Expr::Ident(x), lbrack, args, rbrack)))
    }

    fn parse_field_decl(&mut self) -> Result<Field> {
        let doc = self.lead_comment.take();
        let mut names = None;
        let typ;
        match self.tok {
            token::IDENT => {
                let name = self.parse_ident()?;
                if self.tok == token::PERIOD
                    || self.tok == token::STRING
                    || self.tok == token::SEMICOLON
                    || self.tok == token::RBRACE
                {
                    let mut t = Expr::Ident(name);
                    if self.tok == token::PERIOD {
                        if let Expr::Ident(n) = t {
                            t = self.parse_qualified_ident(Some(n))?;
                        }
                    }
                    typ = Some(t);
                } else {
                    let mut ns = vec![name.clone()];
                    while self.tok == token::COMMA {
                        self.next()?;
                        ns.push(self.parse_ident()?);
                    }
                    if ns.len() == 1 && self.tok == token::LBRACK {
                        let (nm, t) = self.parse_array_field_or_type_instance(name)?;
                        if let Some(n) = nm {
                            names = Some(vec![n]);
                        }
                        typ = Some(t);
                    } else {
                        names = Some(ns);
                        typ = Some(self.parse_type()?);
                    }
                }
            }
            token::MUL => {
                let star = self.pos;
                self.next()?;
                let inner = if self.tok == token::LPAREN {
                    self.error(self.pos, "cannot parenthesize embedded type")?;
                    self.next()?;
                    let t = self.parse_qualified_ident(None)?;
                    if self.tok == token::RPAREN {
                        self.next()?;
                    }
                    t
                } else {
                    self.parse_qualified_ident(None)?
                };
                typ = Some(Expr::Star {
                    star,
                    x: Box::new(inner),
                });
            }
            token::LPAREN => {
                self.error(self.pos, "cannot parenthesize embedded type")?;
                self.next()?;
                if self.tok == token::MUL {
                    let star = self.pos;
                    self.next()?;
                    typ = Some(Expr::Star {
                        star,
                        x: Box::new(self.parse_qualified_ident(None)?),
                    });
                } else {
                    typ = Some(self.parse_qualified_ident(None)?);
                }
                if self.tok == token::RPAREN {
                    self.next()?;
                }
            }
            _ => {
                let pos = self.pos;
                self.error_expected(pos, "field name or embedded type")?;
                self.advance_expr()?;
                typ = Some(Expr::Bad { from: pos, to: self.pos });
            }
        }
        let tag = if self.tok == token::STRING {
            let t = BasicLit {
                value_pos: self.pos,
                kind: self.tok,
                value: self.lit.clone(),
            };
            self.next()?;
            Some(Box::new(t))
        } else {
            None
        };
        let comment = self.expect_semi()?;
        Ok(Field {
            doc,
            names,
            typ,
            tag,
            comment,
        })
    }

    fn parse_struct_type(&mut self) -> Result<Expr> {
        let pos = self.expect(token::STRUCT)?;
        let lbrace = self.expect(token::LBRACE)?;
        let mut list = None;
        while self.tok == token::IDENT || self.tok == token::MUL || self.tok == token::LPAREN {
            push(&mut list, self.parse_field_decl()?);
        }
        let rbrace = self.expect(token::RBRACE)?;
        Ok(Expr::Struct {
            struct_pos: pos,
            fields: FieldList {
                opening: lbrace,
                list,
                closing: rbrace,
            },
            incomplete: false,
        })
    }

    fn parse_pointer_type(&mut self) -> Result<Expr> {
        let star = self.expect(token::MUL)?;
        let base = self.parse_type()?;
        Ok(Expr::Star {
            star,
            x: Box::new(base),
        })
    }

    fn parse_dots_type(&mut self) -> Result<Expr> {
        let pos = self.expect(token::ELLIPSIS)?;
        let elt = self.parse_type()?;
        Ok(Expr::Ellipsis {
            ellipsis: pos,
            elt: Some(Box::new(elt)),
        })
    }

    fn parse_param_decl(&mut self, mut name: Option<Ident>, type_sets_ok: bool) -> Result<(Option<Ident>, Option<Expr>)> {
        let ptok = self.tok;
        if name.is_some() {
            self.tok = token::IDENT;
        } else if type_sets_ok && self.tok == token::TILDE {
            return Ok((None, Some(self.embedded_elem(None)?)));
        }
        let mut f_name = None;
        let mut f_typ = None;
        match self.tok {
            token::IDENT => {
                if let Some(n) = name.take() {
                    f_name = Some(n);
                    self.tok = ptok;
                } else {
                    f_name = Some(self.parse_ident()?);
                }
                match self.tok {
                    token::IDENT
                    | token::MUL
                    | token::ARROW
                    | token::FUNC
                    | token::CHAN
                    | token::MAP
                    | token::STRUCT
                    | token::INTERFACE
                    | token::LPAREN => {
                        f_typ = Some(self.parse_type()?);
                    }
                    token::LBRACK => {
                        let n = f_name.take().unwrap();
                        let (nm, t) = self.parse_array_field_or_type_instance(n)?;
                        f_name = nm;
                        f_typ = Some(t);
                    }
                    token::ELLIPSIS => {
                        f_typ = Some(self.parse_dots_type()?);
                        return Ok((f_name, f_typ));
                    }
                    token::PERIOD => {
                        let n = f_name.take();
                        f_typ = Some(self.parse_qualified_ident(n)?);
                    }
                    token::TILDE if type_sets_ok => {
                        f_typ = Some(self.embedded_elem(None)?);
                        return Ok((f_name, f_typ));
                    }
                    token::OR if type_sets_ok => {
                        let n = f_name.take();
                        f_typ = Some(self.embedded_elem(n.map(Expr::Ident))?);
                        return Ok((f_name, f_typ));
                    }
                    _ => {}
                }
            }
            token::MUL
            | token::ARROW
            | token::FUNC
            | token::LBRACK
            | token::CHAN
            | token::MAP
            | token::STRUCT
            | token::INTERFACE
            | token::LPAREN => {
                f_typ = Some(self.parse_type()?);
            }
            token::ELLIPSIS => {
                f_typ = Some(self.parse_dots_type()?);
                return Ok((f_name, f_typ));
            }
            _ => {
                self.error_expected(self.pos, "')'")?;
                self.advance_expr()?;
            }
        }
        if type_sets_ok && self.tok == token::OR && f_typ.is_some() {
            f_typ = Some(self.embedded_elem(f_typ)?);
        }
        Ok((f_name, f_typ))
    }

    fn parse_parameter_list(
        &mut self,
        mut name0: Option<Ident>,
        mut typ0: Option<Expr>,
        closing: i32,
    ) -> Result<Option<Vec<Field>>> {
        let tparams = closing == token::RBRACK;
        let mut pos0 = self.pos;
        if let Some(n) = &name0 {
            pos0 = n.name_pos;
        } else if let Some(t) = &typ0 {
            pos0 = expr_pos(t);
        }
        struct Par {
            name: Option<Ident>,
            typ: Option<Expr>,
        }
        let mut list: Vec<Par> = Vec::new();
        let mut named = 0i32;
        let mut typed = 0i32;
        while name0.is_some() || (self.tok != closing && self.tok != token::EOF) {
            let par = if typ0.is_some() {
                let t = if tparams {
                    Some(self.embedded_elem(typ0.take())?)
                } else {
                    typ0.take()
                };
                Par {
                    name: name0.take(),
                    typ: t,
                }
            } else {
                let (n, t) = self.parse_param_decl(name0.take(), tparams)?;
                Par { name: n, typ: t }
            };
            name0 = None;
            typ0 = None;
            if par.name.is_some() || par.typ.is_some() {
                if par.name.is_some() && par.typ.is_some() {
                    named += 1;
                }
                if par.typ.is_some() {
                    typed += 1;
                }
                list.push(par);
            }
            if !self.at_comma("parameter list", closing)? {
                break;
            }
            self.next()?;
        }
        if list.is_empty() {
            return Ok(None);
        }
        if named == 0 {
            for par in &mut list {
                if let Some(typ) = par.name.take() {
                    par.typ = Some(Expr::Ident(typ));
                }
            }
            if tparams {
                if named == typed {
                    self.error(self.pos, "missing type constraint")?;
                } else {
                    let mut msg = String::from("missing type parameter name");
                    if list.len() == 1 {
                        msg.push_str(" or invalid array length");
                    }
                    self.error(pos0, &msg)?;
                }
            }
            let mut params = Vec::new();
            for par in list {
                if let Some(typ) = par.typ {
                    params.push(Field {
                        doc: None,
                        names: None,
                        typ: Some(typ),
                        tag: None,
                        comment: None,
                    });
                }
            }
            return Ok(Some(params));
        } else if named != list.len() as i32 {
            let mut err_pos = 0;
            let mut typ: Option<Expr> = None;
            for par in list.iter_mut().rev() {
                if par.typ.is_some() {
                    typ = par.typ.clone();
                    if par.name.is_none() {
                        err_pos = typ.as_ref().map(expr_pos).unwrap_or(0);
                        par.name = Some(Ident {
                            name_pos: err_pos,
                            name: "_".into(),
                        });
                    }
                } else if let Some(t) = &typ {
                    par.typ = Some(t.clone());
                } else {
                    err_pos = par.name.as_ref().map(|n| n.name_pos).unwrap_or(0);
                    par.typ = Some(Expr::Bad {
                        from: err_pos,
                        to: self.pos,
                    });
                }
            }
            if err_pos != 0 {
                let msg = if named == typed {
                    if tparams {
                        "missing type constraint"
                    } else {
                        "missing parameter type"
                    }
                } else if tparams {
                    if list.len() == 1 {
                        "missing type parameter name or invalid array length"
                    } else {
                        "missing type parameter name"
                    }
                } else {
                    "missing parameter name"
                };
                let ep = if named == typed { self.pos } else { err_pos };
                self.error(ep, msg)?;
            }
        }
        let mut params = Vec::new();
        let mut names: Vec<Ident> = Vec::new();
        let mut cur: Option<Expr> = None;
        for par in list {
            let same = match (&cur, &par.typ) {
                (Some(a), Some(b)) => expr_pos(a) == expr_pos(b) && format!("{a:?}") == format!("{b:?}"),
                _ => false,
            };
            // Group consecutive params sharing the same type object from the right-to-left fill.
            // Use pointer-identity analogue: types were cloned, so group by type position + debug.
            if !same && !names.is_empty() {
                params.push(Field {
                    doc: None,
                    names: Some(std::mem::take(&mut names)),
                    typ: cur.take(),
                    tag: None,
                    comment: None,
                });
            }
            if !same {
                cur = par.typ;
            }
            if let Some(n) = par.name {
                names.push(n);
            }
        }
        if !names.is_empty() {
            params.push(Field {
                doc: None,
                names: Some(names),
                typ: cur,
                tag: None,
                comment: None,
            });
        }
        Ok(Some(params))
    }

    fn parse_parameters(&mut self, accept_tparams: bool) -> Result<(Option<FieldList>, Option<FieldList>)> {
        let mut tparams = None;
        if accept_tparams && self.tok == token::LBRACK {
            let opening = self.pos;
            self.next()?;
            let list = self.parse_parameter_list(None, None, token::RBRACK)?;
            let rbrack = self.expect(token::RBRACK)?;
            let fl = FieldList {
                opening,
                list,
                closing: rbrack,
            };
            if fl.num_fields() == 0 {
                self.error(fl.closing, "empty type parameter list")?;
            } else {
                tparams = Some(fl);
            }
        }
        let opening = self.expect(token::LPAREN)?;
        let fields = if self.tok != token::RPAREN {
            self.parse_parameter_list(None, None, token::RPAREN)?
        } else {
            None
        };
        let rparen = self.expect(token::RPAREN)?;
        let params = Some(FieldList {
            opening,
            list: fields,
            closing: rparen,
        });
        Ok((tparams, params))
    }

    fn parse_result(&mut self) -> Result<Option<FieldList>> {
        if self.tok == token::LPAREN {
            let (_, results) = self.parse_parameters(false)?;
            return Ok(results);
        }
        if let Some(typ) = self.try_ident_or_type()? {
            return Ok(Some(FieldList {
                opening: 0,
                list: Some(vec![Field {
                    doc: None,
                    names: None,
                    typ: Some(typ),
                    tag: None,
                    comment: None,
                }]),
                closing: 0,
            }));
        }
        Ok(None)
    }

    fn parse_func_type(&mut self) -> Result<FuncType> {
        let pos = self.expect(token::FUNC)?;
        let (tparams, params) = self.parse_parameters(true)?;
        if let Some(tp) = &tparams {
            self.error(tp.pos(), "function type must have no type parameters")?;
        }
        let results = self.parse_result()?;
        Ok(FuncType {
            func: pos,
            type_params: None,
            params,
            results,
        })
    }

    fn parse_method_spec(&mut self) -> Result<Field> {
        let doc = self.lead_comment.take();
        let mut idents = None;
        let x = self.parse_type_name(None)?;
        let typ;
        if let Expr::Ident(ident) = x.clone() {
            match self.tok {
                token::LBRACK => {
                    let lbrack = self.pos;
                    self.next()?;
                    self.expr_lev += 1;
                    let first = self.parse_expr()?;
                    self.expr_lev -= 1;
                    if let Expr::Ident(name0) = &first {
                        if self.tok != token::COMMA && self.tok != token::RBRACK {
                            let _ = self.parse_parameter_list(Some(name0.clone()), None, token::RBRACK)?;
                            let _ = self.expect(token::RBRACK)?;
                            self.error(lbrack, "interface method must have no type parameters")?;
                            let (_, params) = self.parse_parameters(false)?;
                            let results = self.parse_result()?;
                            idents = Some(vec![ident]);
                            typ = Expr::Func(FuncType {
                                func: 0,
                                type_params: None,
                                params,
                                results,
                            });
                        } else {
                            let mut list = vec![first];
                            if self.at_comma("type argument list", token::RBRACK)? {
                                self.expr_lev += 1;
                                self.next()?;
                                while self.tok != token::RBRACK && self.tok != token::EOF {
                                    list.push(self.parse_type()?);
                                    if !self.at_comma("type argument list", token::RBRACK)? {
                                        break;
                                    }
                                    self.next()?;
                                }
                                self.expr_lev -= 1;
                            }
                            let rbrack = self.expect_closing(token::RBRACK, "type argument list")?;
                            typ = pack_index_expr(Expr::Ident(ident), lbrack, list, rbrack);
                        }
                    } else {
                        let mut list = vec![first];
                        if self.at_comma("type argument list", token::RBRACK)? {
                            self.expr_lev += 1;
                            self.next()?;
                            while self.tok != token::RBRACK && self.tok != token::EOF {
                                list.push(self.parse_type()?);
                                if !self.at_comma("type argument list", token::RBRACK)? {
                                    break;
                                }
                                self.next()?;
                            }
                            self.expr_lev -= 1;
                        }
                        let rbrack = self.expect_closing(token::RBRACK, "type argument list")?;
                        typ = pack_index_expr(Expr::Ident(ident), lbrack, list, rbrack);
                    }
                }
                token::LPAREN => {
                    let (_, params) = self.parse_parameters(false)?;
                    let results = self.parse_result()?;
                    idents = Some(vec![ident]);
                    typ = Expr::Func(FuncType {
                        func: 0,
                        type_params: None,
                        params,
                        results,
                    });
                }
                _ => {
                    typ = x;
                }
            }
        } else {
            let mut t = x;
            if self.tok == token::LBRACK {
                t = self.parse_type_instance(t)?;
            }
            typ = t;
        }
        Ok(Field {
            doc,
            names: idents,
            typ: Some(typ),
            tag: None,
            comment: None,
        })
    }

    fn embedded_elem(&mut self, mut x: Option<Expr>) -> Result<Expr> {
        if x.is_none() {
            x = Some(self.embedded_term()?);
        }
        let mut x = x.unwrap();
        while self.tok == token::OR {
            let op_pos = self.pos;
            self.next()?;
            let y = self.embedded_term()?;
            x = Expr::Binary {
                x: Box::new(x),
                op_pos,
                op: token::OR,
                y: Box::new(y),
            };
        }
        Ok(x)
    }

    fn embedded_term(&mut self) -> Result<Expr> {
        if self.tok == token::TILDE {
            let op_pos = self.pos;
            self.next()?;
            let x = self.parse_type()?;
            return Ok(Expr::Unary {
                op_pos,
                op: token::TILDE,
                x: Box::new(x),
            });
        }
        if let Some(t) = self.try_ident_or_type()? {
            Ok(t)
        } else {
            let pos = self.pos;
            self.error_expected(pos, "~ term or type")?;
            self.advance_expr()?;
            Ok(Expr::Bad { from: pos, to: self.pos })
        }
    }

    fn parse_interface_type(&mut self) -> Result<Expr> {
        let pos = self.expect(token::INTERFACE)?;
        let lbrace = self.expect(token::LBRACE)?;
        let mut list = None;
        loop {
            if self.tok == token::IDENT {
                let mut f = self.parse_method_spec()?;
                if f.names.is_none() {
                    f.typ = Some(self.embedded_elem(f.typ)?);
                }
                f.comment = self.expect_semi()?;
                push(&mut list, f);
            } else if self.tok == token::TILDE {
                let typ = self.embedded_elem(None)?;
                let comment = self.expect_semi()?;
                push(
                    &mut list,
                    Field {
                        doc: None,
                        names: None,
                        typ: Some(typ),
                        tag: None,
                        comment,
                    },
                );
            } else if let Some(t) = self.try_ident_or_type()? {
                let typ = self.embedded_elem(Some(t))?;
                let comment = self.expect_semi()?;
                push(
                    &mut list,
                    Field {
                        doc: None,
                        names: None,
                        typ: Some(typ),
                        tag: None,
                        comment,
                    },
                );
            } else {
                break;
            }
        }
        let rbrace = self.expect(token::RBRACE)?;
        Ok(Expr::Interface {
            interface: pos,
            methods: FieldList {
                opening: lbrace,
                list,
                closing: rbrace,
            },
            incomplete: false,
        })
    }

    fn parse_map_type(&mut self) -> Result<Expr> {
        let pos = self.expect(token::MAP)?;
        self.expect(token::LBRACK)?;
        let key = self.parse_type()?;
        self.expect(token::RBRACK)?;
        let value = self.parse_type()?;
        Ok(Expr::Map {
            map: pos,
            key: Box::new(key),
            value: Box::new(value),
        })
    }

    fn parse_chan_type(&mut self) -> Result<Expr> {
        let pos = self.pos;
        let mut dir = SEND | RECV;
        let mut arrow = 0;
        if self.tok == token::CHAN {
            self.next()?;
            if self.tok == token::ARROW {
                arrow = self.pos;
                self.next()?;
                dir = SEND;
            }
        } else {
            arrow = self.expect(token::ARROW)?;
            self.expect(token::CHAN)?;
            dir = RECV;
        }
        let value = self.parse_type()?;
        Ok(Expr::Chan {
            begin: pos,
            arrow,
            dir,
            value: Box::new(value),
        })
    }

    fn parse_type_instance(&mut self, typ: Expr) -> Result<Expr> {
        let opening = self.expect(token::LBRACK)?;
        self.expr_lev += 1;
        let mut list = Vec::new();
        while self.tok != token::RBRACK && self.tok != token::EOF {
            list.push(self.parse_type()?);
            if !self.at_comma("type argument list", token::RBRACK)? {
                break;
            }
            self.next()?;
        }
        self.expr_lev -= 1;
        let closing = self.expect_closing(token::RBRACK, "type argument list")?;
        if list.is_empty() {
            self.error_expected(closing, "type argument list")?;
            return Ok(Expr::Index {
                x: Box::new(typ),
                lbrack: opening,
                index: Box::new(Expr::Bad {
                    from: opening + 1,
                    to: closing,
                }),
                rbrack: closing,
            });
        }
        Ok(pack_index_expr(typ, opening, list, closing))
    }

    fn try_ident_or_type(&mut self) -> Result<Option<Expr>> {
        self.inc_nest()?;
        let r = match self.tok {
            token::IDENT => {
                let mut typ = self.parse_type_name(None)?;
                if self.tok == token::LBRACK {
                    typ = self.parse_type_instance(typ)?;
                }
                Some(typ)
            }
            token::LBRACK => {
                let lbrack = self.expect(token::LBRACK)?;
                Some(self.parse_array_type(lbrack, None)?)
            }
            token::STRUCT => Some(self.parse_struct_type()?),
            token::MUL => Some(self.parse_pointer_type()?),
            token::FUNC => Some(Expr::Func(self.parse_func_type()?)),
            token::INTERFACE => Some(self.parse_interface_type()?),
            token::MAP => Some(self.parse_map_type()?),
            token::CHAN | token::ARROW => Some(self.parse_chan_type()?),
            token::LPAREN => {
                let lparen = self.pos;
                self.next()?;
                let typ = self.parse_type()?;
                let rparen = self.expect(token::RPAREN)?;
                Some(Expr::Paren {
                    lparen,
                    x: Box::new(typ),
                    rparen,
                })
            }
            _ => None,
        };
        self.dec_nest();
        Ok(r)
    }

    fn parse_stmt_list(&mut self) -> Result<Option<Vec<Stmt>>> {
        let mut list = None;
        while self.tok != token::CASE
            && self.tok != token::DEFAULT
            && self.tok != token::RBRACE
            && self.tok != token::EOF
        {
            push(&mut list, self.parse_stmt()?);
        }
        Ok(list)
    }

    fn parse_body(&mut self) -> Result<Stmt> {
        let lbrace = self.expect(token::LBRACE)?;
        let list = self.parse_stmt_list()?;
        let rbrace = self.expect2(token::RBRACE)?;
        Ok(Stmt::Block {
            lbrace,
            list,
            rbrace,
        })
    }

    fn parse_block_stmt(&mut self) -> Result<Stmt> {
        self.parse_body()
    }

    fn parse_func_type_or_lit(&mut self) -> Result<Expr> {
        let typ = self.parse_func_type()?;
        if self.tok != token::LBRACE {
            return Ok(Expr::Func(typ));
        }
        self.expr_lev += 1;
        let body = self.parse_body()?;
        self.expr_lev -= 1;
        Ok(Expr::FuncLit {
            typ: Box::new(typ),
            body: Box::new(body),
        })
    }

    fn parse_operand(&mut self) -> Result<Expr> {
        match self.tok {
            token::IDENT => Ok(Expr::Ident(self.parse_ident()?)),
            token::INT | token::FLOAT | token::IMAG | token::CHAR | token::STRING => {
                let x = Expr::BasicLit(BasicLit {
                    value_pos: self.pos,
                    kind: self.tok,
                    value: self.lit.clone(),
                });
                self.next()?;
                Ok(x)
            }
            token::LPAREN => {
                let lparen = self.pos;
                self.next()?;
                self.expr_lev += 1;
                let x = self.parse_rhs()?;
                self.expr_lev -= 1;
                let rparen = self.expect(token::RPAREN)?;
                Ok(Expr::Paren {
                    lparen,
                    x: Box::new(x),
                    rparen,
                })
            }
            token::FUNC => self.parse_func_type_or_lit(),
            _ => {
                if let Some(typ) = self.try_ident_or_type()? {
                    if matches!(typ, Expr::Ident(_)) {
                        // type cannot be identifier after tryIdentOrType
                    }
                    Ok(typ)
                } else {
                    let pos = self.pos;
                    self.error_expected(pos, "operand")?;
                    self.advance_stmt()?;
                    Ok(Expr::Bad { from: pos, to: self.pos })
                }
            }
        }
    }

    fn parse_selector(&mut self, x: Expr) -> Result<Expr> {
        let sel = self.parse_ident()?;
        Ok(Expr::Selector {
            x: Box::new(x),
            sel,
        })
    }

    fn parse_type_assertion(&mut self, x: Expr) -> Result<Expr> {
        let lparen = self.expect(token::LPAREN)?;
        let typ = if self.tok == token::TYPE {
            self.next()?;
            None
        } else {
            Some(Box::new(self.parse_type()?))
        };
        let rparen = self.expect(token::RPAREN)?;
        Ok(Expr::TypeAssert {
            x: Box::new(x),
            lparen,
            typ,
            rparen,
        })
    }

    fn parse_index_or_slice_or_instance(&mut self, x: Expr) -> Result<Expr> {
        let lbrack = self.expect(token::LBRACK)?;
        if self.tok == token::RBRACK {
            self.error_expected(self.pos, "operand")?;
            let rbrack = self.pos;
            self.next()?;
            return Ok(Expr::Index {
                x: Box::new(x),
                lbrack,
                index: Box::new(Expr::Bad {
                    from: rbrack,
                    to: rbrack,
                }),
                rbrack,
            });
        }
        self.expr_lev += 1;
        let mut index: [Option<Expr>; 3] = [None, None, None];
        let mut colons = [0i32; 2];
        if self.tok != token::COLON {
            index[0] = Some(self.parse_rhs()?);
        }
        let mut ncolons = 0;
        let mut args = Vec::new();
        match self.tok {
            token::COLON => {
                while self.tok == token::COLON && ncolons < 2 {
                    colons[ncolons] = self.pos;
                    ncolons += 1;
                    self.next()?;
                    if self.tok != token::COLON && self.tok != token::RBRACK && self.tok != token::EOF {
                        index[ncolons] = Some(self.parse_rhs()?);
                    }
                }
            }
            token::COMMA => {
                if let Some(a0) = index[0].take() {
                    args.push(a0);
                }
                while self.tok == token::COMMA {
                    self.next()?;
                    if self.tok != token::RBRACK && self.tok != token::EOF {
                        args.push(self.parse_type()?);
                    }
                }
            }
            _ => {}
        }
        self.expr_lev -= 1;
        let rbrack = self.expect(token::RBRACK)?;
        if ncolons > 0 {
            let mut slice3 = false;
            if ncolons == 2 {
                slice3 = true;
                if index[1].is_none() {
                    self.error(colons[0], "middle index required in 3-index slice")?;
                    index[1] = Some(Expr::Bad {
                        from: colons[0] + 1,
                        to: colons[1],
                    });
                }
                if index[2].is_none() {
                    self.error(colons[1], "final index required in 3-index slice")?;
                    index[2] = Some(Expr::Bad {
                        from: colons[1] + 1,
                        to: rbrack,
                    });
                }
            }
            return Ok(Expr::Slice {
                x: Box::new(x),
                lbrack,
                low: index[0].take().map(Box::new),
                high: index[1].take().map(Box::new),
                max: index[2].take().map(Box::new),
                slice3,
                rbrack,
            });
        }
        if args.is_empty() {
            return Ok(Expr::Index {
                x: Box::new(x),
                lbrack,
                index: Box::new(index[0].take().unwrap_or(Expr::Bad { from: lbrack, to: rbrack })),
                rbrack,
            });
        }
        Ok(pack_index_expr(x, lbrack, args, rbrack))
    }

    fn parse_call_or_conversion(&mut self, fun: Expr) -> Result<Expr> {
        let lparen = self.expect(token::LPAREN)?;
        self.expr_lev += 1;
        let mut list = None;
        let mut ellipsis = 0;
        while self.tok != token::RPAREN && self.tok != token::EOF && ellipsis == 0 {
            push(&mut list, self.parse_rhs()?);
            if self.tok == token::ELLIPSIS {
                ellipsis = self.pos;
                self.next()?;
            }
            if !self.at_comma("argument list", token::RPAREN)? {
                break;
            }
            self.next()?;
        }
        self.expr_lev -= 1;
        let rparen = self.expect_closing(token::RPAREN, "argument list")?;
        Ok(Expr::Call {
            fun: Box::new(fun),
            lparen,
            args: list,
            ellipsis,
            rparen,
        })
    }

    fn parse_value(&mut self) -> Result<Expr> {
        if self.tok == token::LBRACE {
            return self.parse_literal_value(None);
        }
        self.parse_expr()
    }

    fn parse_element(&mut self) -> Result<Expr> {
        let mut x = self.parse_value()?;
        if self.tok == token::COLON {
            let colon = self.pos;
            self.next()?;
            x = Expr::KeyValue {
                key: Box::new(x),
                colon,
                value: Box::new(self.parse_value()?),
            };
        }
        Ok(x)
    }

    fn parse_element_list(&mut self) -> Result<Option<Vec<Expr>>> {
        let mut list = None;
        while self.tok != token::RBRACE && self.tok != token::EOF {
            push(&mut list, self.parse_element()?);
            if !self.at_comma("composite literal", token::RBRACE)? {
                break;
            }
            self.next()?;
        }
        Ok(list)
    }

    fn parse_literal_value(&mut self, typ: Option<Expr>) -> Result<Expr> {
        self.inc_nest()?;
        let lbrace = self.expect(token::LBRACE)?;
        self.expr_lev += 1;
        let elts = if self.tok != token::RBRACE {
            self.parse_element_list()?
        } else {
            None
        };
        self.expr_lev -= 1;
        let rbrace = self.expect_closing(token::RBRACE, "composite literal")?;
        self.dec_nest();
        Ok(Expr::CompositeLit {
            typ: typ.map(Box::new),
            lbrace,
            elts,
            rbrace,
            incomplete: false,
        })
    }

    fn parse_primary_expr(&mut self, mut x: Option<Expr>) -> Result<Expr> {
        if x.is_none() {
            x = Some(self.parse_operand()?);
        }
        let mut x = x.unwrap();
        let mut n = 0;
        loop {
            n += 1;
            self.inc_nest()?;
            match self.tok {
                token::PERIOD => {
                    self.next()?;
                    match self.tok {
                        token::IDENT => x = self.parse_selector(x)?,
                        token::LPAREN => x = self.parse_type_assertion(x)?,
                        _ => {
                            let pos = self.pos;
                            self.error_expected(pos, "selector or type assertion")?;
                            if self.tok != token::RBRACE {
                                self.next()?;
                            }
                            x = Expr::Selector {
                                x: Box::new(x),
                                sel: Ident {
                                    name_pos: pos,
                                    name: "_".into(),
                                },
                            };
                        }
                    }
                }
                token::LBRACK => x = self.parse_index_or_slice_or_instance(x)?,
                token::LPAREN => x = self.parse_call_or_conversion(x)?,
                token::LBRACE => {
                    let t = unparen_ref(&x);
                    let allow = match t {
                        Expr::Bad { .. } | Expr::Ident(_) | Expr::Selector { .. } => self.expr_lev >= 0,
                        Expr::Index { .. } | Expr::IndexList { .. } => self.expr_lev >= 0,
                        Expr::Array { .. } | Expr::Struct { .. } | Expr::Map { .. } => true,
                        _ => false,
                    };
                    if !allow {
                        self.nest_lev -= n;
                        return Ok(x);
                    }
                    if !same_unparen(&x) {
                        self.error(expr_pos(t), "cannot parenthesize type in composite literal")?;
                    }
                    x = self.parse_literal_value(Some(x))?;
                }
                _ => {
                    self.nest_lev -= n;
                    return Ok(x);
                }
            }
        }
    }

    fn parse_unary_expr(&mut self) -> Result<Expr> {
        self.inc_nest()?;
        let r = match self.tok {
            token::ADD | token::SUB | token::NOT | token::XOR | token::AND | token::TILDE => {
                let pos = self.pos;
                let op = self.tok;
                self.next()?;
                let x = self.parse_unary_expr()?;
                Ok(Expr::Unary {
                    op_pos: pos,
                    op,
                    x: Box::new(x),
                })
            }
            token::ARROW => {
                let arrow = self.pos;
                self.next()?;
                let x = self.parse_unary_expr()?;
                Ok(reassoc_recv(arrow, x, &mut |pos, msg| self.error(pos, msg))?)
            }
            token::MUL => {
                let pos = self.pos;
                self.next()?;
                let x = self.parse_unary_expr()?;
                Ok(Expr::Star {
                    star: pos,
                    x: Box::new(x),
                })
            }
            _ => self.parse_primary_expr(None),
        };
        self.dec_nest();
        r
    }

    fn tok_prec(&self) -> (i32, i32) {
        let mut tok = self.tok;
        if self.in_rhs && tok == token::ASSIGN {
            tok = token::EQL;
        }
        (tok, token::precedence(tok))
    }

    fn parse_binary_expr(&mut self, mut x: Option<Expr>, prec1: i32) -> Result<Expr> {
        if x.is_none() {
            x = Some(self.parse_unary_expr()?);
        }
        let mut x = x.unwrap();
        let mut n = 0;
        loop {
            n += 1;
            self.inc_nest()?;
            let (op, oprec) = self.tok_prec();
            if oprec < prec1 {
                self.nest_lev -= n;
                return Ok(x);
            }
            let pos = self.expect(op)?;
            let y = self.parse_binary_expr(None, oprec + 1)?;
            x = Expr::Binary {
                x: Box::new(x),
                op_pos: pos,
                op,
                y: Box::new(y),
            };
        }
    }

    fn parse_expr(&mut self) -> Result<Expr> {
        self.parse_binary_expr(None, token::LOWEST_PREC + 1)
    }

    fn parse_rhs(&mut self) -> Result<Expr> {
        let old = self.in_rhs;
        self.in_rhs = true;
        let x = self.parse_expr()?;
        self.in_rhs = old;
        Ok(x)
    }

    fn parse_simple_stmt(&mut self, mode: i32) -> Result<(Stmt, bool)> {
        let x = self.parse_list(false)?;
        match self.tok {
            token::DEFINE
            | token::ASSIGN
            | token::ADD_ASSIGN
            | token::SUB_ASSIGN
            | token::MUL_ASSIGN
            | token::QUO_ASSIGN
            | token::REM_ASSIGN
            | token::AND_ASSIGN
            | token::OR_ASSIGN
            | token::XOR_ASSIGN
            | token::SHL_ASSIGN
            | token::SHR_ASSIGN
            | token::AND_NOT_ASSIGN => {
                let pos = self.pos;
                let tok = self.tok;
                self.next()?;
                let mut is_range = false;
                let y = if mode == RANGE_OK
                    && self.tok == token::RANGE
                    && (tok == token::DEFINE || tok == token::ASSIGN)
                {
                    let rpos = self.pos;
                    self.next()?;
                    is_range = true;
                    vec![Expr::Unary {
                        op_pos: rpos,
                        op: token::RANGE,
                        x: Box::new(self.parse_rhs()?),
                    }]
                } else {
                    self.parse_list(true)?
                };
                return Ok((
                    Stmt::Assign {
                        lhs: x,
                        tok_pos: pos,
                        tok,
                        rhs: y,
                    },
                    is_range,
                ));
            }
            _ => {}
        }
        if x.len() > 1 {
            self.error_expected(expr_pos(&x[0]), "1 expression")?;
        }
        match self.tok {
            token::COLON => {
                let colon = self.pos;
                self.next()?;
                if mode == LABEL_OK {
                    if let Expr::Ident(label) = &x[0] {
                        let stmt = self.parse_stmt()?;
                        return Ok((
                            Stmt::Labeled {
                                label: label.clone(),
                                colon,
                                stmt: Box::new(stmt),
                            },
                            false,
                        ));
                    }
                }
                self.error(colon, "illegal label declaration")?;
                return Ok((
                    Stmt::Bad {
                        from: expr_pos(&x[0]),
                        to: colon + 1,
                    },
                    false,
                ));
            }
            token::ARROW => {
                let arrow = self.pos;
                self.next()?;
                let y = self.parse_rhs()?;
                return Ok((
                    Stmt::Send {
                        chan: x.into_iter().next().unwrap(),
                        arrow,
                        value: y,
                    },
                    false,
                ));
            }
            token::INC | token::DEC => {
                let s = Stmt::IncDec {
                    x: x.into_iter().next().unwrap(),
                    tok_pos: self.pos,
                    tok: self.tok,
                };
                self.next()?;
                return Ok((s, false));
            }
            _ => {}
        }
        Ok((
            Stmt::Expr {
                x: x.into_iter().next().unwrap(),
            },
            false,
        ))
    }

    fn parse_call_expr(&mut self, call_type: &str) -> Result<Option<Expr>> {
        let mut x = self.parse_rhs()?;
        let t = unparen(x.clone());
        if !same_unparen(&x) {
            self.error(expr_pos(&x), &format!("expression in {call_type} must not be parenthesized"))?;
            x = t;
        }
        if matches!(x, Expr::Call { .. }) {
            return Ok(Some(x));
        }
        if !matches!(x, Expr::Bad { .. }) {
            let end = self.safe_pos(expr_end(&x))?;
            self.error(end, &format!("expression in {call_type} must be function call"))?;
        }
        Ok(None)
    }

    fn parse_go_stmt(&mut self) -> Result<Stmt> {
        let pos = self.expect(token::GO)?;
        let call = self.parse_call_expr("go")?;
        self.expect_semi()?;
        match call {
            None => Ok(Stmt::Bad { from: pos, to: pos + 2 }),
            Some(c) => Ok(Stmt::Go {
                go_pos: pos,
                call: Box::new(c),
            }),
        }
    }

    fn parse_defer_stmt(&mut self) -> Result<Stmt> {
        let pos = self.expect(token::DEFER)?;
        let call = self.parse_call_expr("defer")?;
        self.expect_semi()?;
        match call {
            None => Ok(Stmt::Bad { from: pos, to: pos + 5 }),
            Some(c) => Ok(Stmt::Defer {
                defer: pos,
                call: Box::new(c),
            }),
        }
    }

    fn parse_return_stmt(&mut self) -> Result<Stmt> {
        let pos = self.pos;
        self.expect(token::RETURN)?;
        let x = if self.tok != token::SEMICOLON && self.tok != token::RBRACE {
            Some(self.parse_list(true)?)
        } else {
            None
        };
        self.expect_semi()?;
        Ok(Stmt::Return {
            return_pos: pos,
            results: x,
        })
    }

    fn parse_branch_stmt(&mut self, tok: i32) -> Result<Stmt> {
        let pos = self.expect(tok)?;
        let label = if tok != token::FALLTHROUGH && self.tok == token::IDENT {
            Some(self.parse_ident()?)
        } else {
            None
        };
        self.expect_semi()?;
        Ok(Stmt::Branch {
            tok_pos: pos,
            tok,
            label,
        })
    }

    fn make_expr(&mut self, s: Option<Stmt>, want: &str) -> Result<Option<Expr>> {
        let Some(s) = s else {
            return Ok(None);
        };
        match s {
            Stmt::Expr { x } => Ok(Some(x)),
            other => {
                let found = if matches!(other, Stmt::Assign { .. }) {
                    "assignment"
                } else {
                    "simple statement"
                };
                self.error(
                    stmt_pos(&other),
                    &format!("expected {want}, found {found} (missing parentheses around composite literal?)"),
                )?;
                let to = self.safe_pos(stmt_end(&other))?;
                Ok(Some(Expr::Bad {
                    from: stmt_pos(&other),
                    to,
                }))
            }
        }
    }

    fn parse_if_header(&mut self) -> Result<(Option<Stmt>, Expr)> {
        if self.tok == token::LBRACE {
            self.error(self.pos, "missing condition in if statement")?;
            return Ok((
                None,
                Expr::Bad {
                    from: self.pos,
                    to: self.pos,
                },
            ));
        }
        let prev = self.expr_lev;
        self.expr_lev = -1;
        let mut init = None;
        if self.tok != token::SEMICOLON {
            if self.tok == token::VAR {
                self.next()?;
                self.error(self.pos, "var declaration not allowed in if initializer")?;
            }
            init = Some(self.parse_simple_stmt(BASIC)?.0);
        }
        let mut cond_stmt = None;
        let mut semi_pos = 0;
        let mut semi_lit = String::new();
        if self.tok != token::LBRACE {
            if self.tok == token::SEMICOLON {
                semi_pos = self.pos;
                semi_lit = self.lit.clone();
                self.next()?;
            } else {
                self.expect(token::SEMICOLON)?;
            }
            if self.tok != token::LBRACE {
                cond_stmt = Some(self.parse_simple_stmt(BASIC)?.0);
            }
        } else {
            cond_stmt = init.take();
        }
        let mut cond = None;
        if let Some(cs) = cond_stmt {
            cond = self.make_expr(Some(cs), "boolean expression")?;
        } else if semi_pos != 0 {
            if semi_lit == "\n" {
                self.error(semi_pos, "unexpected newline, expecting { after if clause")?;
            } else {
                self.error(semi_pos, "missing condition in if statement")?;
            }
        }
        if cond.is_none() {
            cond = Some(Expr::Bad {
                from: self.pos,
                to: self.pos,
            });
        }
        self.expr_lev = prev;
        Ok((init, cond.unwrap()))
    }

    fn parse_if_stmt(&mut self) -> Result<Stmt> {
        self.inc_nest()?;
        let pos = self.expect(token::IF)?;
        let (init, cond) = self.parse_if_header()?;
        let body = self.parse_block_stmt()?;
        let else_stmt = if self.tok == token::ELSE {
            self.next()?;
            match self.tok {
                token::IF => Some(Box::new(self.parse_if_stmt()?)),
                token::LBRACE => {
                    let b = self.parse_block_stmt()?;
                    self.expect_semi()?;
                    Some(Box::new(b))
                }
                _ => {
                    self.error_expected(self.pos, "if statement or block")?;
                    Some(Box::new(Stmt::Bad {
                        from: self.pos,
                        to: self.pos,
                    }))
                }
            }
        } else {
            self.expect_semi()?;
            None
        };
        self.dec_nest();
        Ok(Stmt::If {
            if_pos: pos,
            init: init.map(Box::new),
            cond,
            body: Box::new(body),
            else_stmt,
        })
    }

    fn parse_case_clause(&mut self) -> Result<Stmt> {
        let pos = self.pos;
        let list = if self.tok == token::CASE {
            self.next()?;
            Some(self.parse_list(true)?)
        } else {
            self.expect(token::DEFAULT)?;
            None
        };
        let colon = self.expect(token::COLON)?;
        let body = self.parse_stmt_list()?;
        Ok(Stmt::Case {
            case: pos,
            list,
            colon,
            body,
        })
    }

    fn is_type_switch_assert(x: &Expr) -> bool {
        matches!(x, Expr::TypeAssert { typ: None, .. })
    }

    fn is_type_switch_guard(&mut self, s: &Stmt) -> Result<bool> {
        match s {
            Stmt::Expr { x } => Ok(Self::is_type_switch_assert(x)),
            Stmt::Assign { lhs, rhs, tok, tok_pos, .. } => {
                if lhs.len() == 1 && rhs.len() == 1 && Self::is_type_switch_assert(&rhs[0]) {
                    if *tok == token::ASSIGN {
                        self.error(*tok_pos, "expected ':=', found '='")?;
                        return Ok(true);
                    }
                    if *tok == token::DEFINE {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            _ => Ok(false),
        }
    }

    fn parse_switch_stmt(&mut self) -> Result<Stmt> {
        let pos = self.expect(token::SWITCH)?;
        let mut s1 = None;
        let mut s2 = None;
        if self.tok != token::LBRACE {
            let prev = self.expr_lev;
            self.expr_lev = -1;
            if self.tok != token::SEMICOLON {
                s2 = Some(self.parse_simple_stmt(BASIC)?.0);
            }
            if self.tok == token::SEMICOLON {
                self.next()?;
                s1 = s2.take();
                if self.tok != token::LBRACE {
                    s2 = Some(self.parse_simple_stmt(BASIC)?.0);
                }
            }
            self.expr_lev = prev;
        }
        let type_switch = if let Some(s) = &s2 {
            self.is_type_switch_guard(s)?
        } else {
            false
        };
        let lbrace = self.expect(token::LBRACE)?;
        let mut list = None;
        while self.tok == token::CASE || self.tok == token::DEFAULT {
            push(&mut list, self.parse_case_clause()?);
        }
        let rbrace = self.expect(token::RBRACE)?;
        self.expect_semi()?;
        let body = Stmt::Block {
            lbrace,
            list,
            rbrace,
        };
        if type_switch {
            Ok(Stmt::TypeSwitch {
                switch: pos,
                init: s1.map(Box::new),
                assign: Box::new(s2.unwrap()),
                body: Box::new(body),
            })
        } else {
            let tag = self.make_expr(s2, "switch expression")?;
            Ok(Stmt::Switch {
                switch: pos,
                init: s1.map(Box::new),
                tag,
                body: Box::new(body),
            })
        }
    }

    fn parse_comm_clause(&mut self) -> Result<Stmt> {
        let pos = self.pos;
        let comm = if self.tok == token::CASE {
            self.next()?;
            let mut lhs = self.parse_list(false)?;
            if self.tok == token::ARROW {
                if lhs.len() > 1 {
                    self.error_expected(expr_pos(&lhs[0]), "1 expression")?;
                }
                let arrow = self.pos;
                self.next()?;
                let rhs = self.parse_rhs()?;
                Some(Box::new(Stmt::Send {
                    chan: lhs.remove(0),
                    arrow,
                    value: rhs,
                }))
            } else if self.tok == token::ASSIGN || self.tok == token::DEFINE {
                let tok = self.tok;
                if lhs.len() > 2 {
                    self.error_expected(expr_pos(&lhs[0]), "1 or 2 expressions")?;
                    lhs.truncate(2);
                }
                let apos = self.pos;
                self.next()?;
                let rhs = self.parse_rhs()?;
                Some(Box::new(Stmt::Assign {
                    lhs,
                    tok_pos: apos,
                    tok,
                    rhs: vec![rhs],
                }))
            } else {
                if lhs.len() > 1 {
                    self.error_expected(expr_pos(&lhs[0]), "1 expression")?;
                }
                Some(Box::new(Stmt::Expr { x: lhs.remove(0) }))
            }
        } else {
            self.expect(token::DEFAULT)?;
            None
        };
        let colon = self.expect(token::COLON)?;
        let body = self.parse_stmt_list()?;
        Ok(Stmt::Comm {
            case: pos,
            comm,
            colon,
            body,
        })
    }

    fn parse_select_stmt(&mut self) -> Result<Stmt> {
        let pos = self.expect(token::SELECT)?;
        let lbrace = self.expect(token::LBRACE)?;
        let mut list = None;
        while self.tok == token::CASE || self.tok == token::DEFAULT {
            push(&mut list, self.parse_comm_clause()?);
        }
        let rbrace = self.expect(token::RBRACE)?;
        self.expect_semi()?;
        Ok(Stmt::Select {
            select: pos,
            body: Box::new(Stmt::Block {
                lbrace,
                list,
                rbrace,
            }),
        })
    }

    fn parse_for_stmt(&mut self) -> Result<Stmt> {
        let pos = self.expect(token::FOR)?;
        let mut s1 = None;
        let mut s2 = None;
        let mut s3 = None;
        let mut is_range = false;
        if self.tok != token::LBRACE {
            let prev = self.expr_lev;
            self.expr_lev = -1;
            if self.tok != token::SEMICOLON {
                if self.tok == token::RANGE {
                    let rpos = self.pos;
                    self.next()?;
                    let y = vec![Expr::Unary {
                        op_pos: rpos,
                        op: token::RANGE,
                        x: Box::new(self.parse_rhs()?),
                    }];
                    s2 = Some(Stmt::Assign {
                        lhs: Vec::new(),
                        tok_pos: 0,
                        tok: token::ILLEGAL,
                        rhs: y,
                    });
                    is_range = true;
                } else {
                    let (s, r) = self.parse_simple_stmt(RANGE_OK)?;
                    s2 = Some(s);
                    is_range = r;
                }
            }
            if !is_range && self.tok == token::SEMICOLON {
                self.next()?;
                s1 = s2.take();
                if self.tok != token::SEMICOLON {
                    s2 = Some(self.parse_simple_stmt(BASIC)?.0);
                }
                self.expect_semi()?;
                if self.tok != token::LBRACE {
                    s3 = Some(self.parse_simple_stmt(BASIC)?.0);
                }
            }
            self.expr_lev = prev;
        }
        let body = self.parse_block_stmt()?;
        self.expect_semi()?;
        if is_range {
            let as_stmt = s2.unwrap();
            let Stmt::Assign { lhs, tok_pos, tok, rhs } = as_stmt else {
                return Ok(Stmt::Bad {
                    from: pos,
                    to: self.safe_pos(stmt_end(&body))?,
                });
            };
            let (key, value) = match lhs.len() {
                0 => (None, None),
                1 => (Some(lhs.into_iter().next().unwrap()), None),
                2 => {
                    let mut it = lhs.into_iter();
                    (Some(it.next().unwrap()), Some(it.next().unwrap()))
                }
                _ => {
                    self.error_expected(expr_pos(lhs.last().unwrap()), "at most 2 expressions")?;
                    return Ok(Stmt::Bad {
                        from: pos,
                        to: self.safe_pos(stmt_end(&body))?,
                    });
                }
            };
            let (range_pos, range_x) = match rhs.into_iter().next() {
                Some(Expr::Unary { op_pos, x, .. }) => (op_pos, *x),
                Some(other) => (expr_pos(&other), other),
                None => (pos, Expr::Bad { from: pos, to: pos }),
            };
            return Ok(Stmt::Range {
                for_pos: pos,
                key,
                value,
                tok_pos,
                tok,
                range: range_pos,
                x: range_x,
                body: Box::new(body),
            });
        }
        let cond = self.make_expr(s2, "boolean or range expression")?;
        Ok(Stmt::For {
            for_pos: pos,
            init: s1.map(Box::new),
            cond,
            post: s3.map(Box::new),
            body: Box::new(body),
        })
    }

    fn parse_stmt(&mut self) -> Result<Stmt> {
        self.inc_nest()?;
        let s = match self.tok {
            token::CONST | token::TYPE | token::VAR => Stmt::Decl {
                decl: Box::new(self.parse_decl(true)?),
            },
            token::IDENT
            | token::INT
            | token::FLOAT
            | token::IMAG
            | token::CHAR
            | token::STRING
            | token::FUNC
            | token::LPAREN
            | token::LBRACK
            | token::STRUCT
            | token::MAP
            | token::CHAN
            | token::INTERFACE
            | token::ADD
            | token::SUB
            | token::MUL
            | token::AND
            | token::XOR
            | token::ARROW
            | token::NOT => {
                let (s, _) = self.parse_simple_stmt(LABEL_OK)?;
                if !matches!(s, Stmt::Labeled { .. }) {
                    self.expect_semi()?;
                }
                s
            }
            token::GO => self.parse_go_stmt()?,
            token::DEFER => self.parse_defer_stmt()?,
            token::RETURN => self.parse_return_stmt()?,
            token::BREAK | token::CONTINUE | token::GOTO | token::FALLTHROUGH => {
                self.parse_branch_stmt(self.tok)?
            }
            token::LBRACE => {
                let s = self.parse_block_stmt()?;
                self.expect_semi()?;
                s
            }
            token::IF => self.parse_if_stmt()?,
            token::SWITCH => self.parse_switch_stmt()?,
            token::SELECT => self.parse_select_stmt()?,
            token::FOR => self.parse_for_stmt()?,
            token::SEMICOLON => {
                let s = Stmt::Empty {
                    semicolon: self.pos,
                    implicit: self.lit == "\n",
                };
                self.next()?;
                s
            }
            token::RBRACE => Stmt::Empty {
                semicolon: self.pos,
                implicit: true,
            },
            _ => {
                let pos = self.pos;
                self.error_expected(pos, "statement")?;
                self.advance_stmt()?;
                Stmt::Bad { from: pos, to: self.pos }
            }
        };
        self.dec_nest();
        Ok(s)
    }

    fn parse_import_spec(&mut self, doc: Option<Rc<CommentGroup>>) -> Result<Rc<Spec>> {
        let ident = match self.tok {
            token::IDENT => Some(self.parse_ident()?),
            token::PERIOD => {
                let id = Ident {
                    name_pos: self.pos,
                    name: ".".into(),
                };
                self.next()?;
                Some(id)
            }
            _ => None,
        };
        let pos = self.pos;
        let mut path = String::new();
        if self.tok == token::STRING {
            path = self.lit.clone();
            self.next()?;
        } else if token::is_literal(self.tok) {
            self.error(pos, "import path must be a string")?;
            self.next()?;
        } else {
            self.error(pos, "missing import path")?;
            self.advance_expr()?;
        }
        let comment = self.expect_semi()?;
        let spec = Rc::new(Spec::Import {
            doc,
            name: ident,
            path: BasicLit {
                value_pos: pos,
                kind: token::STRING,
                value: path,
            },
            comment,
            end_pos: 0,
        });
        self.imports.push(spec.clone());
        Ok(spec)
    }

    fn parse_value_spec(&mut self, doc: Option<Rc<CommentGroup>>, keyword: i32) -> Result<Rc<Spec>> {
        let idents = self.parse_ident_list()?;
        let mut typ = None;
        let mut values = None;
        match keyword {
            token::CONST => {
                if self.tok != token::EOF && self.tok != token::SEMICOLON && self.tok != token::RPAREN {
                    typ = self.try_ident_or_type()?;
                    if self.tok == token::ASSIGN {
                        self.next()?;
                        values = Some(self.parse_list(true)?);
                    }
                }
            }
            token::VAR => {
                if self.tok != token::ASSIGN {
                    typ = Some(self.parse_type()?);
                }
                if self.tok == token::ASSIGN {
                    self.next()?;
                    values = Some(self.parse_list(true)?);
                }
            }
            _ => {}
        }
        let comment = self.expect_semi()?;
        Ok(Rc::new(Spec::Value {
            doc,
            names: idents,
            typ,
            values,
            comment,
        }))
    }

    fn parse_generic_type(
        &mut self,
        spec_name: Ident,
        doc: Option<Rc<CommentGroup>>,
        open_pos: i32,
        name0: Ident,
        typ0: Option<Expr>,
    ) -> Result<Rc<Spec>> {
        let list = self.parse_parameter_list(Some(name0), typ0, token::RBRACK)?;
        let close_pos = self.expect(token::RBRACK)?;
        let type_params = Some(FieldList {
            opening: open_pos,
            list,
            closing: close_pos,
        });
        let mut assign = 0;
        if self.tok == token::ASSIGN {
            assign = self.pos;
            self.next()?;
        }
        let typ = self.parse_type()?;
        Ok(Rc::new(Spec::Type {
            doc,
            name: spec_name,
            type_params,
            assign,
            typ,
            comment: None,
        }))
    }

    fn parse_type_spec(&mut self, doc: Option<Rc<CommentGroup>>) -> Result<Rc<Spec>> {
        let name = self.parse_ident()?;
        if self.tok == token::LBRACK {
            let lbrack = self.pos;
            self.next()?;
            if self.tok == token::IDENT {
                let mut x: Expr = Expr::Ident(self.parse_ident()?);
                if self.tok != token::LBRACK {
                    self.expr_lev += 1;
                    let lhs = self.parse_primary_expr(Some(x))?;
                    x = self.parse_binary_expr(Some(lhs), token::LOWEST_PREC + 1)?;
                    self.expr_lev -= 1;
                }
                if let Some((pname, ptype)) = extract_name(x.clone(), self.tok == token::COMMA) {
                    if ptype.is_some() || self.tok != token::RBRACK {
                        let mut spec = self.parse_generic_type(name, doc, lbrack, pname, ptype)?;
                        let comment = self.expect_semi()?;
                        if let Spec::Type { comment: slot, .. } = Rc::make_mut(&mut spec) {
                            *slot = comment;
                        }
                        return Ok(spec);
                    }
                }
                let typ = self.parse_array_type(lbrack, Some(x))?;
                let comment = self.expect_semi()?;
                return Ok(Rc::new(Spec::Type {
                    doc,
                    name,
                    type_params: None,
                    assign: 0,
                    typ,
                    comment,
                }));
            }
            let typ = self.parse_array_type(lbrack, None)?;
            let comment = self.expect_semi()?;
            return Ok(Rc::new(Spec::Type {
                doc,
                name,
                type_params: None,
                assign: 0,
                typ,
                comment,
            }));
        }
        let mut assign = 0;
        if self.tok == token::ASSIGN {
            assign = self.pos;
            self.next()?;
        }
        let typ = self.parse_type()?;
        let comment = self.expect_semi()?;
        Ok(Rc::new(Spec::Type {
            doc,
            name,
            type_params: None,
            assign,
            typ,
            comment,
        }))
    }

    fn parse_gen_decl(&mut self, keyword: i32) -> Result<Decl> {
        let doc = self.lead_comment.take();
        let pos = self.expect(keyword)?;
        let mut lparen = 0;
        let mut rparen = 0;
        let mut list = Vec::new();
        if self.tok == token::LPAREN {
            lparen = self.pos;
            self.next()?;
            while self.tok != token::RPAREN && self.tok != token::EOF {
                let d = self.lead_comment.take();
                list.push(match keyword {
                    token::IMPORT => self.parse_import_spec(d)?,
                    token::CONST | token::VAR => self.parse_value_spec(d, keyword)?,
                    token::TYPE => self.parse_type_spec(d)?,
                    _ => unreachable!(),
                });
            }
            rparen = self.expect(token::RPAREN)?;
            self.expect_semi()?;
        } else {
            list.push(match keyword {
                token::IMPORT => self.parse_import_spec(None)?,
                token::CONST | token::VAR => self.parse_value_spec(None, keyword)?,
                token::TYPE => self.parse_type_spec(None)?,
                _ => unreachable!(),
            });
        }
        Ok(Decl::Gen {
            doc,
            tok_pos: pos,
            tok: keyword,
            lparen,
            specs: list,
            rparen,
        })
    }

    fn parse_func_decl(&mut self) -> Result<Decl> {
        let doc = self.lead_comment.take();
        let pos = self.expect(token::FUNC)?;
        let mut recv = None;
        if self.tok == token::LPAREN {
            let (_, r) = self.parse_parameters(false)?;
            recv = r;
        }
        let ident = self.parse_ident()?;
        let (mut tparams, params) = self.parse_parameters(true)?;
        if recv.is_some() && tparams.is_some() {
            if let Some(tp) = &tparams {
                self.error(tp.opening, "method must have no type parameters")?;
            }
            tparams = None;
        }
        let results = self.parse_result()?;
        let body = match self.tok {
            token::LBRACE => {
                let b = self.parse_body()?;
                self.expect_semi()?;
                Some(Box::new(b))
            }
            token::SEMICOLON => {
                self.next()?;
                if self.tok == token::LBRACE {
                    self.error(self.pos, "unexpected semicolon or newline before {")?;
                    let b = self.parse_body()?;
                    self.expect_semi()?;
                    Some(Box::new(b))
                } else {
                    None
                }
            }
            _ => {
                self.expect_semi()?;
                None
            }
        };
        Ok(Decl::Func {
            doc,
            recv,
            name: ident,
            typ: FuncType {
                func: pos,
                type_params: tparams,
                params,
                results,
            },
            body,
        })
    }

    fn parse_decl(&mut self, stmt: bool) -> Result<Decl> {
        match self.tok {
            token::IMPORT => self.parse_gen_decl(token::IMPORT),
            token::CONST | token::VAR => self.parse_gen_decl(self.tok),
            token::TYPE => self.parse_gen_decl(token::TYPE),
            token::FUNC => self.parse_func_decl(),
            _ => {
                let pos = self.pos;
                self.error_expected(pos, "declaration")?;
                if stmt {
                    self.advance_stmt()?;
                } else {
                    self.advance_decl()?;
                }
                Ok(Decl::Bad { from: pos, to: self.pos })
            }
        }
    }

    fn parse_file(&mut self) -> Result<Option<File>> {
        if !self.errors.is_empty() {
            return Ok(None);
        }
        let doc = self.lead_comment.take();
        let pos = self.expect(token::PACKAGE)?;
        let ident = self.parse_ident()?;
        if ident.name == "_" && self.mode & DECLARATION_ERRORS != 0 {
            self.error(self.pos, "invalid package name _")?;
        }
        self.expect_semi()?;
        if !self.errors.is_empty() {
            return Ok(None);
        }
        let mut decls = None;
        if self.mode & PACKAGE_CLAUSE_ONLY == 0 {
            while self.tok == token::IMPORT {
                push(&mut decls, self.parse_gen_decl(token::IMPORT)?);
            }
            if self.mode & IMPORTS_ONLY == 0 {
                let mut prev = token::IMPORT;
                while self.tok != token::EOF {
                    if self.tok == token::IMPORT && prev != token::IMPORT {
                        self.error(self.pos, "imports must appear before other declarations")?;
                    }
                    prev = self.tok;
                    push(&mut decls, self.parse_decl(false)?);
                    if self.bailed {
                        break;
                    }
                }
            }
        }
        let comments = if self.comments.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.comments))
        };
        let imports = if self.imports.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.imports))
        };
        Ok(Some(File {
            doc,
            package: pos,
            name: ident,
            decls,
            file_start: 0,
            file_end: 0,
            imports,
            comments,
            go_version: self.go_version.clone(),
        }))
    }
}

fn pack_index_expr(x: Expr, lbrack: i32, exprs: Vec<Expr>, rbrack: i32) -> Expr {
    if exprs.len() == 1 {
        let mut exprs = exprs;
        Expr::Index {
            x: Box::new(x),
            lbrack,
            index: Box::new(exprs.remove(0)),
            rbrack,
        }
    } else {
        Expr::IndexList {
            x: Box::new(x),
            lbrack,
            indices: exprs,
            rbrack,
        }
    }
}

fn unparen_ref(e: &Expr) -> &Expr {
    let mut cur = e;
    while let Expr::Paren { x, .. } = cur {
        cur = x;
    }
    cur
}

fn same_unparen(e: &Expr) -> bool {
    !matches!(e, Expr::Paren { .. })
}

fn extract_name(x: Expr, force: bool) -> Option<(Ident, Option<Expr>)> {
    match x {
        Expr::Ident(id) => Some((id, None)),
        Expr::Binary { x, op_pos, op, y } if op == token::MUL => {
            if let Expr::Ident(name) = *x {
                if force || is_type_elem(&y) {
                    return Some((
                        name,
                        Some(Expr::Star {
                            star: op_pos,
                            x: y,
                        }),
                    ));
                }
            }
            None
        }
        Expr::Binary { x, op_pos, op, y } if op == token::OR => {
            if let Some((name, lhs)) = extract_name(*x, force || is_type_elem(&y)) {
                if let Some(lhs) = lhs {
                    return Some((
                        name,
                        Some(Expr::Binary {
                            x: Box::new(lhs),
                            op_pos,
                            op,
                            y,
                        }),
                    ));
                }
            }
            None
        }
        Expr::Call {
            fun,
            lparen,
            args,
            ellipsis,
            rparen,
        } => {
            if let Expr::Ident(name) = *fun {
                let args = args.unwrap_or_default();
                if args.len() == 1 && ellipsis == 0 && (force || is_type_elem(&args[0])) {
                    let mut args = args;
                    return Some((
                        name,
                        Some(Expr::Paren {
                            lparen,
                            x: Box::new(args.remove(0)),
                            rparen,
                        }),
                    ));
                }
            }
            None
        }
        _ => None,
    }
}

fn reassoc_recv(arrow: i32, x: Expr, err: &mut dyn FnMut(i32, &str) -> Result<()>) -> Result<Expr> {
    if let Expr::Chan { .. } = &x {
        let mut x = x;
        let mut arrow = arrow;
        let mut dir = SEND;
        while dir == SEND {
            match &mut x {
                Expr::Chan {
                    begin,
                    arrow: a,
                    dir: d,
                    value,
                } => {
                    if *d == RECV {
                        err(*a, "expected 'chan'")?;
                    }
                    let old_arrow = *a;
                    *begin = arrow;
                    *a = arrow;
                    dir = *d;
                    *d = RECV;
                    arrow = old_arrow;
                    if let Expr::Chan { .. } = value.as_ref() {
                        // continue into nested chan
                        let inner = std::mem::replace(value, Box::new(Expr::Bad { from: 0, to: 0 }));
                        // This reassociation is subtle; keep the outer rewrite only.
                        *value = inner;
                        break;
                    } else {
                        break;
                    }
                }
                _ => break,
            }
        }
        if dir == SEND {
            err(arrow, "expected 'chan'")?;
        }
        Ok(x)
    } else {
        Ok(Expr::Unary {
            op_pos: arrow,
            op: token::ARROW,
            x: Box::new(x),
        })
    }
}

fn go_version_from_build(lit: &str) -> Option<String> {
    let rest = lit.strip_prefix("//go:build")?.trim();
    let mut best: Option<(i32, i32, String)> = None;
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        if bytes[i..].starts_with(b"go1") {
            let mut j = i + 3;
            if j < bytes.len() && bytes[j] == b'.' {
                j += 1;
                let start = j;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j > start {
                    let minor: i32 = rest[i + 4..j].parse().unwrap_or(0);
                    let s = rest[i..j].to_string();
                    if best.as_ref().map(|(m, _, _)| minor > *m).unwrap_or(true) {
                        best = Some((minor, 0, s));
                    }
                    i = j;
                    continue;
                }
            }
        }
        i += 1;
    }
    best.map(|(_, _, s)| s)
}

pub struct ParseOutput {
    pub file: Option<File>,
    pub expr: Option<Expr>,
    pub errors: Vec<(String, i64, i64, i64, String)>,
}

pub fn parse_source(fset: &FileSet, filename: String, src: &[u8], mode: u32, as_expr: bool) -> Result<ParseOutput> {
    let file = fset.add_file(filename, -1, src.len() as i64)?;
    let mut p = Parser::init(file, src, mode)?;
    if as_expr {
        let expr = match p.parse_rhs() {
            Ok(e) => Some(e),
            Err(_) if p.nest_overflow => None,
            Err(e) => return Err(e),
        };
        if p.tok == token::SEMICOLON && p.lit == "\n" {
            let _ = p.next();
        }
        let _ = p.expect(token::EOF);
        return Ok(ParseOutput {
            file: None,
            expr,
            errors: p
                .errors
                .into_iter()
                .map(|e| (e.filename, e.offset, e.line, e.column, e.msg))
                .collect(),
        });
    }
    let mut ast = match p.parse_file() {
        Ok(f) => f,
        Err(_) if p.nest_overflow => None,
        Err(e) => return Err(e),
    };
    let base = p.file.base_i32()?;
    let size = p.file.size_i32()?;
    if let Some(f) = ast.as_mut() {
        f.file_start = base;
        f.file_end = base + size;
    } else {
        ast = Some(File {
            doc: None,
            package: 0,
            name: Ident {
                name_pos: 0,
                name: String::new(),
            },
            decls: None,
            file_start: base,
            file_end: base + size,
            imports: None,
            comments: None,
            go_version: String::new(),
        });
    }
    Ok(ParseOutput {
        file: ast,
        expr: None,
        errors: p
            .errors
            .into_iter()
            .map(|e| (e.filename, e.offset, e.line, e.column, e.msg))
            .collect(),
    })
}
