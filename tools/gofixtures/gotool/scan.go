package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"go/scanner"
	"go/token"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type ScanTok struct {
	Pos      int    `json:"pos"`
	Tok      int    `json:"tok"`
	LitB64   string `json:"litB64"`
	Line     int    `json:"line"`
	Column   int    `json:"column"`
	Filename string `json:"filename"`
}

type ScanErr struct {
	Filename string `json:"filename"`
	Offset   int    `json:"offset"`
	Line     int    `json:"line"`
	Column   int    `json:"column"`
	Msg      string `json:"msg"`
}

type ScanCase struct {
	ID       string    `json:"id"`
	Filename string    `json:"filename"`
	SrcB64   string    `json:"srcB64"`
	Mode     uint      `json:"mode"`
	Tokens   []ScanTok `json:"tokens"`
	Errors   []ScanErr `json:"errors"`
}

type ScanPacket struct {
	Schema  int            `json:"schema"`
	Package string         `json:"package"`
	Go      string         `json:"go"`
	Tokens  map[string]int `json:"tokens"`
	Cases   []ScanCase     `json:"cases"`
}

func tokenMap() map[string]int {
	names := []token.Token{
		token.ILLEGAL, token.EOF, token.COMMENT, token.IDENT, token.INT, token.FLOAT,
		token.IMAG, token.CHAR, token.STRING, token.ADD, token.SUB, token.MUL, token.QUO,
		token.REM, token.AND, token.OR, token.XOR, token.SHL, token.SHR, token.AND_NOT,
		token.ADD_ASSIGN, token.SUB_ASSIGN, token.MUL_ASSIGN, token.QUO_ASSIGN, token.REM_ASSIGN,
		token.AND_ASSIGN, token.OR_ASSIGN, token.XOR_ASSIGN, token.SHL_ASSIGN, token.SHR_ASSIGN,
		token.AND_NOT_ASSIGN, token.LAND, token.LOR, token.ARROW, token.INC, token.DEC,
		token.EQL, token.LSS, token.GTR, token.ASSIGN, token.NOT, token.NEQ, token.LEQ,
		token.GEQ, token.DEFINE, token.ELLIPSIS, token.LPAREN, token.LBRACK, token.LBRACE,
		token.COMMA, token.PERIOD, token.RPAREN, token.RBRACK, token.RBRACE, token.SEMICOLON,
		token.COLON, token.BREAK, token.CASE, token.CHAN, token.CONST, token.CONTINUE,
		token.DEFAULT, token.DEFER, token.ELSE, token.FALLTHROUGH, token.FOR, token.FUNC,
		token.GO, token.GOTO, token.IF, token.IMPORT, token.INTERFACE, token.MAP, token.PACKAGE,
		token.RANGE, token.RETURN, token.SELECT, token.STRUCT, token.SWITCH, token.TYPE,
		token.VAR, token.TILDE,
	}
	out := make(map[string]int, len(names))
	labels := []string{
		"ILLEGAL", "EOF", "COMMENT", "IDENT", "INT", "FLOAT", "IMAG", "CHAR", "STRING",
		"ADD", "SUB", "MUL", "QUO", "REM", "AND", "OR", "XOR", "SHL", "SHR", "AND_NOT",
		"ADD_ASSIGN", "SUB_ASSIGN", "MUL_ASSIGN", "QUO_ASSIGN", "REM_ASSIGN",
		"AND_ASSIGN", "OR_ASSIGN", "XOR_ASSIGN", "SHL_ASSIGN", "SHR_ASSIGN", "AND_NOT_ASSIGN",
		"LAND", "LOR", "ARROW", "INC", "DEC", "EQL", "LSS", "GTR", "ASSIGN", "NOT", "NEQ",
		"LEQ", "GEQ", "DEFINE", "ELLIPSIS", "LPAREN", "LBRACK", "LBRACE", "COMMA", "PERIOD",
		"RPAREN", "RBRACK", "RBRACE", "SEMICOLON", "COLON", "BREAK", "CASE", "CHAN", "CONST",
		"CONTINUE", "DEFAULT", "DEFER", "ELSE", "FALLTHROUGH", "FOR", "FUNC", "GO", "GOTO",
		"IF", "IMPORT", "INTERFACE", "MAP", "PACKAGE", "RANGE", "RETURN", "SELECT", "STRUCT",
		"SWITCH", "TYPE", "VAR", "TILDE",
	}
	for i, t := range names {
		out[labels[i]] = int(t)
	}
	return out
}

func scanSource(filename string, src []byte, mode scanner.Mode) (ScanCase, error) {
	fset := token.NewFileSet()
	file := fset.AddFile(filename, fset.Base(), len(src))
	var errs []ScanErr
	var s scanner.Scanner
	s.Init(file, src, func(pos token.Position, msg string) {
		errs = append(errs, ScanErr{
			Filename: pos.Filename,
			Offset:   pos.Offset,
			Line:     pos.Line,
			Column:   pos.Column,
			Msg:      msg,
		})
	}, mode)
	var toks []ScanTok
	for {
		pos, tok, lit := s.Scan()
		p := file.Position(pos)
		toks = append(toks, ScanTok{
			Pos:      int(pos),
			Tok:      int(tok),
			LitB64:   base64.StdEncoding.EncodeToString([]byte(lit)),
			Line:     p.Line,
			Column:   p.Column,
			Filename: p.Filename,
		})
		if tok == token.EOF {
			break
		}
		if len(toks) > 1_000_000 {
			return ScanCase{}, fmt.Errorf("token flood in %s", filename)
		}
	}
	if errs == nil {
		errs = []ScanErr{}
	}
	return ScanCase{
		Filename: filename,
		SrcB64:   base64.StdEncoding.EncodeToString(src),
		Mode:     uint(mode),
		Tokens:   toks,
		Errors:   errs,
	}, nil
}

func scanCorpus() []struct {
	id, name string
	src      []byte
	mode     scanner.Mode
} {
	var out []struct {
		id, name string
		src      []byte
		mode     scanner.Mode
	}
	add := func(id, name string, src []byte, mode scanner.Mode) {
		out = append(out, struct {
			id, name string
			src      []byte
			mode     scanner.Mode
		}{id, name, src, mode})
	}

	add("empty", "empty.go", []byte{}, scanner.ScanComments)
	add("package-only", "p.go", []byte("package p\n"), scanner.ScanComments)
	add("comments-only", "c.go", []byte("// hi\n/* block */\n"), scanner.ScanComments)
	add("comments-skip", "c.go", []byte("package p // trail\n"), 0)

	// Official scanner_test token corpus (abbreviated but covering classes).
	add("idents", "id.go", []byte("foobar a۰۱۸ foo६८ ŝ ŝfoo\n"), scanner.ScanComments)
	add("numbers", "num.go", []byte("0 1 123456789012345678890 01234567 0xcafebabe 0. .0 3.14159265 1e0 1e+100 1e-100 0i 1i 0.i .0i 1e0i 0x1p-2 1_2 0b101 0o755\n"), scanner.ScanComments)
	add("runes-strings", "lit.go", []byte("'a' '\\000' '\\xFF' '\\uff16' '\\U0000ff16' `foobar` `foo\r\nbar` \"hi\\n\"\n"), scanner.ScanComments)
	add("ops", "op.go", []byte("+ - * / % & | ^ << >> &^ += -= *= /= %= &= |= ^= <<= >>= &^= && || <- ++ -- == < > = ! != <= >= := ... ( [ { , . ) ] } ; : ~\n"), scanner.ScanComments)
	add("keywords", "kw.go", []byte("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var\n"), scanner.ScanComments)
	add("semi-insert", "semi.go", []byte("x\ny++\nz)\n"), scanner.ScanComments)
	add("block-comment-nl", "bn.go", []byte("x /*\n*/ y\n"), scanner.ScanComments)
	add("cr-comments", "cr.go", []byte("/*\r*/ /**\r/*/ /**\r\r/*/ //\r\npackage p\n"), scanner.ScanComments)
	add("line-directive", "ld.go", []byte("//line other.go:10\npackage p\n"), scanner.ScanComments)
	add("line-directive-col", "ldc.go", []byte("//line foo.go:4:2\npackage p\n"), scanner.ScanComments)
	add("line-directive-block", "ldb.go", []byte("/*line bar.go:3*/package p\n"), scanner.ScanComments)
	add("go-build", "gb.go", []byte("//go:build linux\npackage p\n"), scanner.ScanComments)
	add("generics", "g.go", []byte("package p\nfunc F[T any](x T) T { return x }\n"), scanner.ScanComments)
	add("unterminated-string", "us.go", []byte("package p\nvar s = \"oops\n"), scanner.ScanComments)
	add("unterminated-comment", "uc.go", []byte("package p\n/* oops"), scanner.ScanComments)
	add("unterminated-rune", "ur.go", []byte("package p\nvar r = 'a\n"), scanner.ScanComments)
	add("nul", "nul.go", []byte("package p\n\x00x\n"), scanner.ScanComments)
	add("illegal-utf8", "bad.go", []byte("package p\n\xff\n"), scanner.ScanComments)
	add("mid-bom", "bom.go", append([]byte("package p\n"), 0xEF, 0xBB, 0xBF, '\n'), scanner.ScanComments)
	add("leading-bom", "lbom.go", append([]byte{0xEF, 0xBB, 0xBF}, []byte("package p\n")...), scanner.ScanComments)
	add("curly-quote", "cq.go", []byte("package p\n\u201cfoo\u201d\n"), scanner.ScanComments)
	add("hex-float-bad", "hf.go", []byte("package p\nvar x = 0x1.2\n"), scanner.ScanComments)
	add("underscore-bad", "ub.go", []byte("package p\nvar x = 1__2\n"), scanner.ScanComments)
	add("long-ident", "long.go", []byte("package p\nvar "+strings.Repeat("α", 200)+" int\n"), scanner.ScanComments)
	add("raw-cr", "raw.go", []byte("package p\nvar s = `a\rb`\n"), scanner.ScanComments)
	add("insert-eof", "eof.go", []byte("package p"), scanner.ScanComments)
	add("only-nl", "nl.go", []byte("\n\n"), scanner.ScanComments)
	add("illegal-ident-start-digit", "d.go", []byte("package p\n1x\n"), scanner.ScanComments)

	root := runtime.GOROOT()
	stdlib := []string{
		"src/errors/errors.go",
		"src/errors/wrap.go",
		"src/io/io.go",
	}
	for _, rel := range stdlib {
		path := filepath.Join(root, rel)
		src, err := os.ReadFile(path)
		if err != nil {
			fail(err)
		}
		add("stdlib-"+filepath.Base(rel), path, src, scanner.ScanComments)
		add("stdlib-"+filepath.Base(rel)+"-nocomment", path, src, 0)
	}
	return out
}

func dumpScan(writer io.Writer) {
	packet := ScanPacket{
		Schema:  1,
		Package: "gotool-scan",
		Go:      "go1.24.13",
		Tokens:  tokenMap(),
	}
	for _, c := range scanCorpus() {
		sc, err := scanSource(c.name, c.src, c.mode)
		if err != nil {
			fail(err)
		}
		sc.ID = c.id
		packet.Cases = append(packet.Cases, sc)
	}
	enc := json.NewEncoder(writer)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func verifyScan(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 64<<20))
	dec.DisallowUnknownFields()
	var packet ScanPacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool-scan" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid scan packet header or empty cases"))
	}
	for i, c := range packet.Cases {
		src, err := base64.StdEncoding.DecodeString(c.SrcB64)
		if err != nil {
			fail(fmt.Errorf("case %d id=%s src: %w", i, c.ID, err))
		}
		got, err := scanSource(c.Filename, src, scanner.Mode(c.Mode))
		if err != nil {
			fail(err)
		}
		if len(got.Tokens) != len(c.Tokens) {
			fail(fmt.Errorf("mismatch case %d id=%s token count go=%d got=%d", i, c.ID, len(got.Tokens), len(c.Tokens)))
		}
		for j, tok := range c.Tokens {
			g := got.Tokens[j]
			if g.Pos != tok.Pos || g.Tok != tok.Tok || g.LitB64 != tok.LitB64 || g.Line != tok.Line || g.Column != tok.Column || g.Filename != tok.Filename {
				fail(fmt.Errorf("mismatch case %d id=%s token %d go=%+v got=%+v", i, c.ID, j, g, tok))
			}
		}
	}
	fmt.Printf("Go verified %d gotool-scan cases\n", len(packet.Cases))
}
