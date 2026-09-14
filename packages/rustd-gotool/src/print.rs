use crate::ast::*;
use crate::fileset::FileSet;
use crate::token;
use napi::bindgen_prelude::Result;
use std::collections::HashMap;
use std::rc::Rc;

struct Printer<'a> {
    out: String,
    fset: &'a FileSet,
    indent: i32,
    last: u8,
    line: i32,
    ptrmap: HashMap<usize, i32>,
}

impl<'a> Printer<'a> {
    fn write(&mut self, data: &str) -> Result<()> {
        let bytes = data.as_bytes();
        let mut n = 0usize;
        for (i, &b) in bytes.iter().enumerate() {
            if b == b'\n' {
                self.out.push_str(std::str::from_utf8(&bytes[n..=i]).unwrap_or(""));
                n = i + 1;
                self.line += 1;
            } else if self.last == b'\n' {
                self.out.push_str(&format!("{:6}  ", self.line));
                for _ in 0..self.indent {
                    self.out.push_str(".  ");
                }
            }
            self.last = b;
        }
        if n < bytes.len() {
            self.out.push_str(std::str::from_utf8(&bytes[n..]).unwrap_or(""));
        }
        Ok(())
    }

    fn printf(&mut self, s: &str) -> Result<()> {
        self.write(s)
    }

    fn print_nil(&mut self) -> Result<()> {
        self.printf("nil")
    }

    fn pos(&mut self, p: i32) -> Result<()> {
        self.printf(&self.fset.format_pos(p)?)
    }

    fn quoted(&mut self, s: &str) -> Result<()> {
        self.printf(&go_quote(s))
    }

    fn tok(&mut self, t: i32) -> Result<()> {
        self.printf(&token::token_string(t))
    }

    fn bool(&mut self, v: bool) -> Result<()> {
        self.printf(if v { "true" } else { "false" })
    }

    fn int(&mut self, v: i32) -> Result<()> {
        self.printf(&v.to_string())
    }

    fn begin_ptr(&mut self, ty: &str) -> Result<()> {
        self.begin_ptr_key(ty, None)?;
        Ok(())
    }

    fn begin_ptr_key(&mut self, ty: &str, key: Option<usize>) -> Result<bool> {
        self.printf("*")?;
        if let Some(k) = key {
            if let Some(line) = self.ptrmap.get(&k).copied() {
                self.printf(&format!("(obj @ {line})"))?;
                return Ok(false);
            }
            self.ptrmap.insert(k, self.line);
        }
        self.printf(&format!("{ty} {{"))?;
        self.indent += 1;
        Ok(true)
    }

    fn field_name(&mut self, name: &str) -> Result<()> {
        self.printf("\n")?;
        self.printf(name)?;
        self.printf(": ")
    }

    fn end_struct(&mut self) -> Result<()> {
        self.indent -= 1;
        self.printf("\n")?;
        self.printf("}")
    }

    fn slice_header(&mut self, ty: &str, len: usize) -> Result<()> {
        self.printf(&format!("{ty} (len = {len}) {{"))
    }

    fn print_expr_slice(&mut self, ty: &str, list: Option<&[Expr]>) -> Result<()> {
        match list {
            None => self.print_nil(),
            Some(list) => {
                self.slice_header(ty, list.len())?;
                if !list.is_empty() {
                    self.indent += 1;
                    self.printf("\n")?;
                    for (i, e) in list.iter().enumerate() {
                        self.printf(&format!("{i}: "))?;
                        self.print_expr(e)?;
                        self.printf("\n")?;
                    }
                    self.indent -= 1;
                }
                self.printf("}")
            }
        }
    }

    fn print_stmt_slice(&mut self, ty: &str, list: Option<&[Stmt]>) -> Result<()> {
        match list {
            None => self.print_nil(),
            Some(list) => {
                self.slice_header(ty, list.len())?;
                if !list.is_empty() {
                    self.indent += 1;
                    self.printf("\n")?;
                    for (i, e) in list.iter().enumerate() {
                        self.printf(&format!("{i}: "))?;
                        self.print_stmt(e)?;
                        self.printf("\n")?;
                    }
                    self.indent -= 1;
                }
                self.printf("}")
            }
        }
    }

    fn print_ident_slice(&mut self, list: Option<&[Ident]>) -> Result<()> {
        match list {
            None => self.print_nil(),
            Some(list) => {
                self.slice_header("[]*ast.Ident", list.len())?;
                if !list.is_empty() {
                    self.indent += 1;
                    self.printf("\n")?;
                    for (i, e) in list.iter().enumerate() {
                        self.printf(&format!("{i}: "))?;
                        self.print_ident(e)?;
                        self.printf("\n")?;
                    }
                    self.indent -= 1;
                }
                self.printf("}")
            }
        }
    }

    fn print_ident(&mut self, id: &Ident) -> Result<()> {
        self.begin_ptr("ast.Ident")?;
        self.field_name("NamePos")?;
        self.pos(id.name_pos)?;
        self.field_name("Name")?;
        self.quoted(&id.name)?;
        self.field_name("Obj")?;
        self.print_nil()?;
        self.end_struct()
    }

    fn print_comment(&mut self, c: &Comment) -> Result<()> {
        self.begin_ptr("ast.Comment")?;
        self.field_name("Slash")?;
        self.pos(c.slash)?;
        self.field_name("Text")?;
        self.quoted(&c.text)?;
        self.end_struct()
    }

    fn print_group_rc(&mut self, g: &Rc<CommentGroup>) -> Result<()> {
        if !self.begin_ptr_key("ast.CommentGroup", Some(Rc::as_ptr(g) as usize))? {
            return Ok(());
        }
        self.print_group_body(g)
    }

    fn print_group(&mut self, g: &CommentGroup) -> Result<()> {
        self.begin_ptr("ast.CommentGroup")?;
        self.print_group_body(g)
    }

    fn print_group_body(&mut self, g: &CommentGroup) -> Result<()> {
        self.field_name("List")?;
        self.slice_header("[]*ast.Comment", g.list.len())?;
        if !g.list.is_empty() {
            self.indent += 1;
            self.printf("\n")?;
            for (i, c) in g.list.iter().enumerate() {
                self.printf(&format!("{i}: "))?;
                self.print_comment(c)?;
                self.printf("\n")?;
            }
            self.indent -= 1;
        }
        self.printf("}")?;
        self.end_struct()
    }

    fn opt_group(&mut self, g: &Option<Rc<CommentGroup>>) -> Result<()> {
        match g {
            None => self.print_nil(),
            Some(g) => self.print_group_rc(g),
        }
    }

    fn print_basic(&mut self, l: &BasicLit) -> Result<()> {
        self.begin_ptr("ast.BasicLit")?;
        self.field_name("ValuePos")?;
        self.pos(l.value_pos)?;
        self.field_name("Kind")?;
        self.tok(l.kind)?;
        self.field_name("Value")?;
        self.quoted(&l.value)?;
        self.end_struct()
    }

    fn print_field(&mut self, f: &Field) -> Result<()> {
        self.begin_ptr("ast.Field")?;
        self.field_name("Doc")?;
        self.opt_group(&f.doc)?;
        self.field_name("Names")?;
        self.print_ident_slice(f.names.as_deref())?;
        self.field_name("Type")?;
        match &f.typ {
            None => self.print_nil()?,
            Some(t) => self.print_expr(t)?,
        }
        self.field_name("Tag")?;
        match &f.tag {
            None => self.print_nil()?,
            Some(t) => self.print_basic(t)?,
        }
        self.field_name("Comment")?;
        self.opt_group(&f.comment)?;
        self.end_struct()
    }

    fn print_fields(&mut self, fl: &FieldList) -> Result<()> {
        self.begin_ptr("ast.FieldList")?;
        self.field_name("Opening")?;
        self.pos(fl.opening)?;
        self.field_name("List")?;
        match &fl.list {
            None => self.print_nil()?,
            Some(list) => {
                self.slice_header("[]*ast.Field", list.len())?;
                if !list.is_empty() {
                    self.indent += 1;
                    self.printf("\n")?;
                    for (i, f) in list.iter().enumerate() {
                        self.printf(&format!("{i}: "))?;
                        self.print_field(f)?;
                        self.printf("\n")?;
                    }
                    self.indent -= 1;
                }
                self.printf("}")?;
            }
        }
        self.field_name("Closing")?;
        self.pos(fl.closing)?;
        self.end_struct()
    }

    fn opt_fields(&mut self, fl: &Option<FieldList>) -> Result<()> {
        match fl {
            None => self.print_nil(),
            Some(fl) => self.print_fields(fl),
        }
    }

    fn print_func_type(&mut self, t: &FuncType) -> Result<()> {
        self.begin_ptr("ast.FuncType")?;
        self.field_name("Func")?;
        self.pos(t.func)?;
        self.field_name("TypeParams")?;
        self.opt_fields(&t.type_params)?;
        self.field_name("Params")?;
        self.opt_fields(&t.params)?;
        self.field_name("Results")?;
        self.opt_fields(&t.results)?;
        self.end_struct()
    }

    fn print_expr(&mut self, e: &Expr) -> Result<()> {
        match e {
            Expr::Bad { from, to } => {
                self.begin_ptr("ast.BadExpr")?;
                self.field_name("From")?;
                self.pos(*from)?;
                self.field_name("To")?;
                self.pos(*to)?;
                self.end_struct()
            }
            Expr::Ident(id) => self.print_ident(id),
            Expr::Ellipsis { ellipsis, elt } => {
                self.begin_ptr("ast.Ellipsis")?;
                self.field_name("Ellipsis")?;
                self.pos(*ellipsis)?;
                self.field_name("Elt")?;
                match elt {
                    None => self.print_nil()?,
                    Some(x) => self.print_expr(x)?,
                }
                self.end_struct()
            }
            Expr::BasicLit(l) => self.print_basic(l),
            Expr::FuncLit { typ, body } => {
                self.begin_ptr("ast.FuncLit")?;
                self.field_name("Type")?;
                self.print_func_type(typ)?;
                self.field_name("Body")?;
                self.print_stmt(body)?;
                self.end_struct()
            }
            Expr::CompositeLit {
                typ,
                lbrace,
                elts,
                rbrace,
                incomplete,
            } => {
                self.begin_ptr("ast.CompositeLit")?;
                self.field_name("Type")?;
                match typ {
                    None => self.print_nil()?,
                    Some(t) => self.print_expr(t)?,
                }
                self.field_name("Lbrace")?;
                self.pos(*lbrace)?;
                self.field_name("Elts")?;
                self.print_expr_slice("[]ast.Expr", elts.as_deref())?;
                self.field_name("Rbrace")?;
                self.pos(*rbrace)?;
                self.field_name("Incomplete")?;
                self.bool(*incomplete)?;
                self.end_struct()
            }
            Expr::Paren { lparen, x, rparen } => {
                self.begin_ptr("ast.ParenExpr")?;
                self.field_name("Lparen")?;
                self.pos(*lparen)?;
                self.field_name("X")?;
                self.print_expr(x)?;
                self.field_name("Rparen")?;
                self.pos(*rparen)?;
                self.end_struct()
            }
            Expr::Selector { x, sel } => {
                self.begin_ptr("ast.SelectorExpr")?;
                self.field_name("X")?;
                self.print_expr(x)?;
                self.field_name("Sel")?;
                self.print_ident(sel)?;
                self.end_struct()
            }
            Expr::Index {
                x,
                lbrack,
                index,
                rbrack,
            } => {
                self.begin_ptr("ast.IndexExpr")?;
                self.field_name("X")?;
                self.print_expr(x)?;
                self.field_name("Lbrack")?;
                self.pos(*lbrack)?;
                self.field_name("Index")?;
                self.print_expr(index)?;
                self.field_name("Rbrack")?;
                self.pos(*rbrack)?;
                self.end_struct()
            }
            Expr::IndexList {
                x,
                lbrack,
                indices,
                rbrack,
            } => {
                self.begin_ptr("ast.IndexListExpr")?;
                self.field_name("X")?;
                self.print_expr(x)?;
                self.field_name("Lbrack")?;
                self.pos(*lbrack)?;
                self.field_name("Indices")?;
                self.print_expr_slice("[]ast.Expr", Some(indices))?;
                self.field_name("Rbrack")?;
                self.pos(*rbrack)?;
                self.end_struct()
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
                self.begin_ptr("ast.SliceExpr")?;
                self.field_name("X")?;
                self.print_expr(x)?;
                self.field_name("Lbrack")?;
                self.pos(*lbrack)?;
                self.field_name("Low")?;
                match low {
                    None => self.print_nil()?,
                    Some(v) => self.print_expr(v)?,
                }
                self.field_name("High")?;
                match high {
                    None => self.print_nil()?,
                    Some(v) => self.print_expr(v)?,
                }
                self.field_name("Max")?;
                match max {
                    None => self.print_nil()?,
                    Some(v) => self.print_expr(v)?,
                }
                self.field_name("Slice3")?;
                self.bool(*slice3)?;
                self.field_name("Rbrack")?;
                self.pos(*rbrack)?;
                self.end_struct()
            }
            Expr::TypeAssert {
                x,
                lparen,
                typ,
                rparen,
            } => {
                self.begin_ptr("ast.TypeAssertExpr")?;
                self.field_name("X")?;
                self.print_expr(x)?;
                self.field_name("Lparen")?;
                self.pos(*lparen)?;
                self.field_name("Type")?;
                match typ {
                    None => self.print_nil()?,
                    Some(t) => self.print_expr(t)?,
                }
                self.field_name("Rparen")?;
                self.pos(*rparen)?;
                self.end_struct()
            }
            Expr::Call {
                fun,
                lparen,
                args,
                ellipsis,
                rparen,
            } => {
                self.begin_ptr("ast.CallExpr")?;
                self.field_name("Fun")?;
                self.print_expr(fun)?;
                self.field_name("Lparen")?;
                self.pos(*lparen)?;
                self.field_name("Args")?;
                self.print_expr_slice("[]ast.Expr", args.as_deref())?;
                self.field_name("Ellipsis")?;
                self.pos(*ellipsis)?;
                self.field_name("Rparen")?;
                self.pos(*rparen)?;
                self.end_struct()
            }
            Expr::Star { star, x } => {
                self.begin_ptr("ast.StarExpr")?;
                self.field_name("Star")?;
                self.pos(*star)?;
                self.field_name("X")?;
                self.print_expr(x)?;
                self.end_struct()
            }
            Expr::Unary { op_pos, op, x } => {
                self.begin_ptr("ast.UnaryExpr")?;
                self.field_name("OpPos")?;
                self.pos(*op_pos)?;
                self.field_name("Op")?;
                self.tok(*op)?;
                self.field_name("X")?;
                self.print_expr(x)?;
                self.end_struct()
            }
            Expr::Binary { x, op_pos, op, y } => {
                self.begin_ptr("ast.BinaryExpr")?;
                self.field_name("X")?;
                self.print_expr(x)?;
                self.field_name("OpPos")?;
                self.pos(*op_pos)?;
                self.field_name("Op")?;
                self.tok(*op)?;
                self.field_name("Y")?;
                self.print_expr(y)?;
                self.end_struct()
            }
            Expr::KeyValue { key, colon, value } => {
                self.begin_ptr("ast.KeyValueExpr")?;
                self.field_name("Key")?;
                self.print_expr(key)?;
                self.field_name("Colon")?;
                self.pos(*colon)?;
                self.field_name("Value")?;
                self.print_expr(value)?;
                self.end_struct()
            }
            Expr::Array { lbrack, len, elt } => {
                self.begin_ptr("ast.ArrayType")?;
                self.field_name("Lbrack")?;
                self.pos(*lbrack)?;
                self.field_name("Len")?;
                match len {
                    None => self.print_nil()?,
                    Some(v) => self.print_expr(v)?,
                }
                self.field_name("Elt")?;
                self.print_expr(elt)?;
                self.end_struct()
            }
            Expr::Struct {
                struct_pos,
                fields,
                incomplete,
            } => {
                self.begin_ptr("ast.StructType")?;
                self.field_name("Struct")?;
                self.pos(*struct_pos)?;
                self.field_name("Fields")?;
                self.print_fields(fields)?;
                self.field_name("Incomplete")?;
                self.bool(*incomplete)?;
                self.end_struct()
            }
            Expr::Func(t) => self.print_func_type(t),
            Expr::Interface {
                interface,
                methods,
                incomplete,
            } => {
                self.begin_ptr("ast.InterfaceType")?;
                self.field_name("Interface")?;
                self.pos(*interface)?;
                self.field_name("Methods")?;
                self.print_fields(methods)?;
                self.field_name("Incomplete")?;
                self.bool(*incomplete)?;
                self.end_struct()
            }
            Expr::Map { map, key, value } => {
                self.begin_ptr("ast.MapType")?;
                self.field_name("Map")?;
                self.pos(*map)?;
                self.field_name("Key")?;
                self.print_expr(key)?;
                self.field_name("Value")?;
                self.print_expr(value)?;
                self.end_struct()
            }
            Expr::Chan {
                begin,
                arrow,
                dir,
                value,
            } => {
                self.begin_ptr("ast.ChanType")?;
                self.field_name("Begin")?;
                self.pos(*begin)?;
                self.field_name("Arrow")?;
                self.pos(*arrow)?;
                self.field_name("Dir")?;
                self.int(*dir)?;
                self.field_name("Value")?;
                self.print_expr(value)?;
                self.end_struct()
            }
        }
    }

    fn print_stmt(&mut self, s: &Stmt) -> Result<()> {
        match s {
            Stmt::Bad { from, to } => {
                self.begin_ptr("ast.BadStmt")?;
                self.field_name("From")?;
                self.pos(*from)?;
                self.field_name("To")?;
                self.pos(*to)?;
                self.end_struct()
            }
            Stmt::Decl { decl } => {
                self.begin_ptr("ast.DeclStmt")?;
                self.field_name("Decl")?;
                self.print_decl(decl)?;
                self.end_struct()
            }
            Stmt::Empty {
                semicolon,
                implicit,
            } => {
                self.begin_ptr("ast.EmptyStmt")?;
                self.field_name("Semicolon")?;
                self.pos(*semicolon)?;
                self.field_name("Implicit")?;
                self.bool(*implicit)?;
                self.end_struct()
            }
            Stmt::Labeled { label, colon, stmt } => {
                self.begin_ptr("ast.LabeledStmt")?;
                self.field_name("Label")?;
                self.print_ident(label)?;
                self.field_name("Colon")?;
                self.pos(*colon)?;
                self.field_name("Stmt")?;
                self.print_stmt(stmt)?;
                self.end_struct()
            }
            Stmt::Expr { x } => {
                self.begin_ptr("ast.ExprStmt")?;
                self.field_name("X")?;
                self.print_expr(x)?;
                self.end_struct()
            }
            Stmt::Send { chan, arrow, value } => {
                self.begin_ptr("ast.SendStmt")?;
                self.field_name("Chan")?;
                self.print_expr(chan)?;
                self.field_name("Arrow")?;
                self.pos(*arrow)?;
                self.field_name("Value")?;
                self.print_expr(value)?;
                self.end_struct()
            }
            Stmt::IncDec { x, tok_pos, tok } => {
                self.begin_ptr("ast.IncDecStmt")?;
                self.field_name("X")?;
                self.print_expr(x)?;
                self.field_name("TokPos")?;
                self.pos(*tok_pos)?;
                self.field_name("Tok")?;
                self.tok(*tok)?;
                self.end_struct()
            }
            Stmt::Assign {
                lhs,
                tok_pos,
                tok,
                rhs,
            } => {
                self.begin_ptr("ast.AssignStmt")?;
                self.field_name("Lhs")?;
                self.print_expr_slice("[]ast.Expr", Some(lhs))?;
                self.field_name("TokPos")?;
                self.pos(*tok_pos)?;
                self.field_name("Tok")?;
                self.tok(*tok)?;
                self.field_name("Rhs")?;
                self.print_expr_slice("[]ast.Expr", Some(rhs))?;
                self.end_struct()
            }
            Stmt::Go { go_pos, call } => {
                self.begin_ptr("ast.GoStmt")?;
                self.field_name("Go")?;
                self.pos(*go_pos)?;
                self.field_name("Call")?;
                self.print_expr(call)?;
                self.end_struct()
            }
            Stmt::Defer { defer, call } => {
                self.begin_ptr("ast.DeferStmt")?;
                self.field_name("Defer")?;
                self.pos(*defer)?;
                self.field_name("Call")?;
                self.print_expr(call)?;
                self.end_struct()
            }
            Stmt::Return {
                return_pos,
                results,
            } => {
                self.begin_ptr("ast.ReturnStmt")?;
                self.field_name("Return")?;
                self.pos(*return_pos)?;
                self.field_name("Results")?;
                self.print_expr_slice("[]ast.Expr", results.as_deref())?;
                self.end_struct()
            }
            Stmt::Branch {
                tok_pos,
                tok,
                label,
            } => {
                self.begin_ptr("ast.BranchStmt")?;
                self.field_name("TokPos")?;
                self.pos(*tok_pos)?;
                self.field_name("Tok")?;
                self.tok(*tok)?;
                self.field_name("Label")?;
                match label {
                    None => self.print_nil()?,
                    Some(l) => self.print_ident(l)?,
                }
                self.end_struct()
            }
            Stmt::Block {
                lbrace,
                list,
                rbrace,
            } => {
                self.begin_ptr("ast.BlockStmt")?;
                self.field_name("Lbrace")?;
                self.pos(*lbrace)?;
                self.field_name("List")?;
                self.print_stmt_slice("[]ast.Stmt", list.as_deref())?;
                self.field_name("Rbrace")?;
                self.pos(*rbrace)?;
                self.end_struct()
            }
            Stmt::If {
                if_pos,
                init,
                cond,
                body,
                else_stmt,
            } => {
                self.begin_ptr("ast.IfStmt")?;
                self.field_name("If")?;
                self.pos(*if_pos)?;
                self.field_name("Init")?;
                match init {
                    None => self.print_nil()?,
                    Some(i) => self.print_stmt(i)?,
                }
                self.field_name("Cond")?;
                self.print_expr(cond)?;
                self.field_name("Body")?;
                self.print_stmt(body)?;
                self.field_name("Else")?;
                match else_stmt {
                    None => self.print_nil()?,
                    Some(e) => self.print_stmt(e)?,
                }
                self.end_struct()
            }
            Stmt::Case {
                case,
                list,
                colon,
                body,
            } => {
                self.begin_ptr("ast.CaseClause")?;
                self.field_name("Case")?;
                self.pos(*case)?;
                self.field_name("List")?;
                self.print_expr_slice("[]ast.Expr", list.as_deref())?;
                self.field_name("Colon")?;
                self.pos(*colon)?;
                self.field_name("Body")?;
                self.print_stmt_slice("[]ast.Stmt", body.as_deref())?;
                self.end_struct()
            }
            Stmt::Switch {
                switch,
                init,
                tag,
                body,
            } => {
                self.begin_ptr("ast.SwitchStmt")?;
                self.field_name("Switch")?;
                self.pos(*switch)?;
                self.field_name("Init")?;
                match init {
                    None => self.print_nil()?,
                    Some(i) => self.print_stmt(i)?,
                }
                self.field_name("Tag")?;
                match tag {
                    None => self.print_nil()?,
                    Some(t) => self.print_expr(t)?,
                }
                self.field_name("Body")?;
                self.print_stmt(body)?;
                self.end_struct()
            }
            Stmt::TypeSwitch {
                switch,
                init,
                assign,
                body,
            } => {
                self.begin_ptr("ast.TypeSwitchStmt")?;
                self.field_name("Switch")?;
                self.pos(*switch)?;
                self.field_name("Init")?;
                match init {
                    None => self.print_nil()?,
                    Some(i) => self.print_stmt(i)?,
                }
                self.field_name("Assign")?;
                self.print_stmt(assign)?;
                self.field_name("Body")?;
                self.print_stmt(body)?;
                self.end_struct()
            }
            Stmt::Comm {
                case,
                comm,
                colon,
                body,
            } => {
                self.begin_ptr("ast.CommClause")?;
                self.field_name("Case")?;
                self.pos(*case)?;
                self.field_name("Comm")?;
                match comm {
                    None => self.print_nil()?,
                    Some(c) => self.print_stmt(c)?,
                }
                self.field_name("Colon")?;
                self.pos(*colon)?;
                self.field_name("Body")?;
                self.print_stmt_slice("[]ast.Stmt", body.as_deref())?;
                self.end_struct()
            }
            Stmt::Select { select, body } => {
                self.begin_ptr("ast.SelectStmt")?;
                self.field_name("Select")?;
                self.pos(*select)?;
                self.field_name("Body")?;
                self.print_stmt(body)?;
                self.end_struct()
            }
            Stmt::For {
                for_pos,
                init,
                cond,
                post,
                body,
            } => {
                self.begin_ptr("ast.ForStmt")?;
                self.field_name("For")?;
                self.pos(*for_pos)?;
                self.field_name("Init")?;
                match init {
                    None => self.print_nil()?,
                    Some(i) => self.print_stmt(i)?,
                }
                self.field_name("Cond")?;
                match cond {
                    None => self.print_nil()?,
                    Some(c) => self.print_expr(c)?,
                }
                self.field_name("Post")?;
                match post {
                    None => self.print_nil()?,
                    Some(p) => self.print_stmt(p)?,
                }
                self.field_name("Body")?;
                self.print_stmt(body)?;
                self.end_struct()
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
                self.begin_ptr("ast.RangeStmt")?;
                self.field_name("For")?;
                self.pos(*for_pos)?;
                self.field_name("Key")?;
                match key {
                    None => self.print_nil()?,
                    Some(k) => self.print_expr(k)?,
                }
                self.field_name("Value")?;
                match value {
                    None => self.print_nil()?,
                    Some(v) => self.print_expr(v)?,
                }
                self.field_name("TokPos")?;
                self.pos(*tok_pos)?;
                self.field_name("Tok")?;
                self.tok(*tok)?;
                self.field_name("Range")?;
                self.pos(*range)?;
                self.field_name("X")?;
                self.print_expr(x)?;
                self.field_name("Body")?;
                self.print_stmt(body)?;
                self.end_struct()
            }
        }
    }

    fn print_spec_rc(&mut self, s: &Rc<Spec>) -> Result<()> {
        if matches!(s.as_ref(), Spec::Import { .. }) {
            if !self.begin_ptr_key("ast.ImportSpec", Some(Rc::as_ptr(s) as usize))? {
                return Ok(());
            }
            self.print_import_body(s)?;
            return self.end_struct();
        }
        self.print_spec(s)
    }

    fn print_import_body(&mut self, s: &Spec) -> Result<()> {
        let Spec::Import {
            doc,
            name,
            path,
            comment,
            end_pos,
        } = s
        else {
            return Ok(());
        };
        self.field_name("Doc")?;
        self.opt_group(doc)?;
        self.field_name("Name")?;
        match name {
            None => self.print_nil()?,
            Some(n) => self.print_ident(n)?,
        }
        self.field_name("Path")?;
        self.print_basic(path)?;
        self.field_name("Comment")?;
        self.opt_group(comment)?;
        self.field_name("EndPos")?;
        self.pos(*end_pos)
    }

    fn print_spec(&mut self, s: &Spec) -> Result<()> {
        match s {
            Spec::Import {
                doc,
                name,
                path,
                comment,
                end_pos,
            } => {
                self.begin_ptr("ast.ImportSpec")?;
                self.field_name("Doc")?;
                self.opt_group(doc)?;
                self.field_name("Name")?;
                match name {
                    None => self.print_nil()?,
                    Some(n) => self.print_ident(n)?,
                }
                self.field_name("Path")?;
                self.print_basic(path)?;
                self.field_name("Comment")?;
                self.opt_group(comment)?;
                self.field_name("EndPos")?;
                self.pos(*end_pos)?;
                self.end_struct()
            }
            Spec::Value {
                doc,
                names,
                typ,
                values,
                comment,
            } => {
                self.begin_ptr("ast.ValueSpec")?;
                self.field_name("Doc")?;
                self.opt_group(doc)?;
                self.field_name("Names")?;
                self.print_ident_slice(Some(names))?;
                self.field_name("Type")?;
                match typ {
                    None => self.print_nil()?,
                    Some(t) => self.print_expr(t)?,
                }
                self.field_name("Values")?;
                self.print_expr_slice("[]ast.Expr", values.as_deref())?;
                self.field_name("Comment")?;
                self.opt_group(comment)?;
                self.end_struct()
            }
            Spec::Type {
                doc,
                name,
                type_params,
                assign,
                typ,
                comment,
            } => {
                self.begin_ptr("ast.TypeSpec")?;
                self.field_name("Doc")?;
                self.opt_group(doc)?;
                self.field_name("Name")?;
                self.print_ident(name)?;
                self.field_name("TypeParams")?;
                self.opt_fields(type_params)?;
                self.field_name("Assign")?;
                self.pos(*assign)?;
                self.field_name("Type")?;
                self.print_expr(typ)?;
                self.field_name("Comment")?;
                self.opt_group(comment)?;
                self.end_struct()
            }
        }
    }

    fn print_decl(&mut self, d: &Decl) -> Result<()> {
        match d {
            Decl::Bad { from, to } => {
                self.begin_ptr("ast.BadDecl")?;
                self.field_name("From")?;
                self.pos(*from)?;
                self.field_name("To")?;
                self.pos(*to)?;
                self.end_struct()
            }
            Decl::Gen {
                doc,
                tok_pos,
                tok,
                lparen,
                specs,
                rparen,
            } => {
                self.begin_ptr("ast.GenDecl")?;
                self.field_name("Doc")?;
                self.opt_group(doc)?;
                self.field_name("TokPos")?;
                self.pos(*tok_pos)?;
                self.field_name("Tok")?;
                self.tok(*tok)?;
                self.field_name("Lparen")?;
                self.pos(*lparen)?;
                self.field_name("Specs")?;
                self.slice_header("[]ast.Spec", specs.len())?;
                if !specs.is_empty() {
                    self.indent += 1;
                    self.printf("\n")?;
                    for (i, s) in specs.iter().enumerate() {
                        self.printf(&format!("{i}: "))?;
                        self.print_spec_rc(s)?;
                        self.printf("\n")?;
                    }
                    self.indent -= 1;
                }
                self.printf("}")?;
                self.field_name("Rparen")?;
                self.pos(*rparen)?;
                self.end_struct()
            }
            Decl::Func {
                doc,
                recv,
                name,
                typ,
                body,
            } => {
                self.begin_ptr("ast.FuncDecl")?;
                self.field_name("Doc")?;
                self.opt_group(doc)?;
                self.field_name("Recv")?;
                self.opt_fields(recv)?;
                self.field_name("Name")?;
                self.print_ident(name)?;
                self.field_name("Type")?;
                self.print_func_type(typ)?;
                self.field_name("Body")?;
                match body {
                    None => self.print_nil()?,
                    Some(b) => self.print_stmt(b)?,
                }
                self.end_struct()
            }
        }
    }

    fn print_file(&mut self, f: &File) -> Result<()> {
        self.begin_ptr("ast.File")?;
        self.field_name("Doc")?;
        self.opt_group(&f.doc)?;
        self.field_name("Package")?;
        self.pos(f.package)?;
        self.field_name("Name")?;
        self.print_ident(&f.name)?;
        self.field_name("Decls")?;
        match &f.decls {
            None => self.print_nil()?,
            Some(list) => {
                self.slice_header("[]ast.Decl", list.len())?;
                if !list.is_empty() {
                    self.indent += 1;
                    self.printf("\n")?;
                    for (i, d) in list.iter().enumerate() {
                        self.printf(&format!("{i}: "))?;
                        self.print_decl(d)?;
                        self.printf("\n")?;
                    }
                    self.indent -= 1;
                }
                self.printf("}")?;
            }
        }
        self.field_name("FileStart")?;
        self.pos(f.file_start)?;
        self.field_name("FileEnd")?;
        self.pos(f.file_end)?;
        self.field_name("Scope")?;
        self.print_nil()?;
        self.field_name("Imports")?;
        match &f.imports {
            None => self.print_nil()?,
            Some(list) => {
                self.slice_header("[]*ast.ImportSpec", list.len())?;
                if !list.is_empty() {
                    self.indent += 1;
                    self.printf("\n")?;
                    for (i, s) in list.iter().enumerate() {
                        self.printf(&format!("{i}: "))?;
                        self.print_spec_rc(s)?;
                        self.printf("\n")?;
                    }
                    self.indent -= 1;
                }
                self.printf("}")?;
            }
        }
        self.field_name("Unresolved")?;
        self.print_nil()?;
        self.field_name("Comments")?;
        match &f.comments {
            None => self.print_nil()?,
            Some(list) => {
                self.slice_header("[]*ast.CommentGroup", list.len())?;
                if !list.is_empty() {
                    self.indent += 1;
                    self.printf("\n")?;
                    for (i, g) in list.iter().enumerate() {
                        self.printf(&format!("{i}: "))?;
                        self.print_group_rc(g)?;
                        self.printf("\n")?;
                    }
                    self.indent -= 1;
                }
                self.printf("}")?;
            }
        }
        self.field_name("GoVersion")?;
        self.quoted(&f.go_version)?;
        self.end_struct()
    }
}

fn go_quote(s: &str) -> String {
    let mut out = String::from("\"");
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{7f}' => {
                out.push_str(&format!("\\x{:02x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn fprint_file(fset: &FileSet, file: &File) -> Result<String> {
    let mut p = Printer {
        out: String::new(),
        fset,
        indent: 0,
        last: b'\n',
        line: 0,
        ptrmap: HashMap::new(),
    };
    p.print_file(file)?;
    p.printf("\n")?;
    Ok(p.out)
}

pub fn fprint_expr(fset: &FileSet, expr: &Expr) -> Result<String> {
    let mut p = Printer {
        out: String::new(),
        fset,
        indent: 0,
        last: b'\n',
        line: 0,
        ptrmap: HashMap::new(),
    };
    p.print_expr(expr)?;
    p.printf("\n")?;
    Ok(p.out)
}
