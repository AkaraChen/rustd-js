package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/scanner"
	"go/token"
	"io"
)

type ParseErr struct {
	Filename string `json:"filename"`
	Offset   int    `json:"offset"`
	Line     int    `json:"line"`
	Column   int    `json:"column"`
	Msg      string `json:"msg"`
}

type ParseCase struct {
	ID       string     `json:"id"`
	Filename string     `json:"filename"`
	SrcB64   string     `json:"srcB64"`
	Mode     uint       `json:"mode"`
	Fprint   string     `json:"fprint"`
	Errors   []ParseErr `json:"errors"`
	Kind     string     `json:"kind"`
}

type ParsePacket struct {
	Schema  int         `json:"schema"`
	Package string      `json:"package"`
	Go      string      `json:"go"`
	Cases   []ParseCase `json:"cases"`
}

func parseModes() parser.Mode {
	return parser.ParseComments | parser.SkipObjectResolution
}

func errorList(err error) []ParseErr {
	if err == nil {
		return []ParseErr{}
	}
	if el, ok := err.(scanner.ErrorList); ok {
		out := make([]ParseErr, 0, len(el))
		for _, e := range el {
			out = append(out, ParseErr{
				Filename: e.Pos.Filename,
				Offset:   e.Pos.Offset,
				Line:     e.Pos.Line,
				Column:   e.Pos.Column,
				Msg:      e.Msg,
			})
		}
		return out
	}
	return []ParseErr{{Msg: err.Error()}}
}

func dumpParseCase(id, filename, kind string, src []byte, mode parser.Mode) ParseCase {
	fset := token.NewFileSet()
	var buf bytes.Buffer
	var errs []ParseErr
	if kind == "expr" {
		e, err := parser.ParseExprFrom(fset, filename, src, mode)
		errs = errorList(err)
		if e != nil {
			_ = ast.Fprint(&buf, fset, e, nil)
		}
	} else {
		f, err := parser.ParseFile(fset, filename, src, mode)
		errs = errorList(err)
		if f != nil {
			_ = ast.Fprint(&buf, fset, f, nil)
		}
	}
	return ParseCase{
		ID:       id,
		Filename: filename,
		SrcB64:   base64.StdEncoding.EncodeToString(src),
		Mode:     uint(mode),
		Fprint:   buf.String(),
		Errors:   errs,
		Kind:     kind,
	}
}

func parseCorpus() []ParseCase {
	mode := parseModes()
	var out []ParseCase
	add := func(id, name, kind, src string) {
		out = append(out, dumpParseCase(id, name, kind, []byte(src), mode))
	}
	add("package-only", "p.go", "file", "package p\n")
	add("hello", "hello.go", "file", "package main\nfunc main() {}\n")
	add("imports", "imp.go", "file", "package p\nimport \"fmt\"\nimport f \"fmt\"\nimport . \"fmt\"\nfunc F() { fmt.Println(1) }\n")
	add("const-var", "cv.go", "file", "package p\nconst a = 1\nvar b int = 2\n")
	add("types", "t.go", "file", "package p\ntype T struct{ X int `json:\"x\"` }\ntype U []byte\ntype M map[string]int\ntype C chan int\ntype R <-chan string\n")
	add("func", "f.go", "file", "package p\nfunc Add(a, b int) int { return a + b }\nfunc (T) M() {}\ntype T struct{}\n")
	add("control", "c.go", "file", "package p\nfunc F(x int) {\n\tif x > 0 {\n\t\tx++\n\t} else {\n\t\tx--\n\t}\n\tfor i := 0; i < x; i++ {\n\t\t_ = i\n\t}\n\tfor range x {\n\t}\n\tswitch x {\n\tcase 1:\n\tdefault:\n\t}\n}\n")
	add("generic", "g.go", "file", "package p\nfunc Id[T any](v T) T { return v }\ntype Pair[A, B any] struct{ A A; B B }\n")
	add("interface", "i.go", "file", "package p\ntype I interface {\n\tM()\n\t~int | string\n}\n")
	add("complit", "cl.go", "file", "package p\nvar s = []int{1, 2, 3}\nvar m = map[string]int{\"a\": 1}\n")
	add("comments", "cm.go", "file", "// pkg doc\npackage p\n\n// F docs\nfunc F() {\n\t// inner\n}\n")
	add("expr-bin", "", "expr", "1+2*3")
	add("expr-call", "", "expr", "fmt.Sprintf(\"%d\", 1)")
	add("expr-slice", "", "expr", "a[1:2:3]")
	add("expr-index", "", "expr", "T[int, string]")
	return out
}

func dumpParse(writer io.Writer) {
	packet := ParsePacket{Schema: 1, Package: "gotool-parse", Go: "go1.24.13", Cases: parseCorpus()}
	enc := json.NewEncoder(writer)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

type ParseErrorCase struct {
	ID        string     `json:"id"`
	Filename  string     `json:"filename"`
	SrcB64    string     `json:"srcB64"`
	Mode      uint       `json:"mode"`
	Errors    []ParseErr `json:"errors"`
	DeclCount int        `json:"declCount"`
	NilFile   bool       `json:"nilFile"`
}

type ParseErrorPacket struct {
	Schema  int              `json:"schema"`
	Package string           `json:"package"`
	Go      string           `json:"go"`
	Cases   []ParseErrorCase `json:"cases"`
}

func dumpParseErrorCase(id, filename string, src []byte, mode parser.Mode) ParseErrorCase {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, filename, src, mode)
	declCount := 0
	if f != nil {
		declCount = len(f.Decls)
	}
	return ParseErrorCase{
		ID:        id,
		Filename:  filename,
		SrcB64:    base64.StdEncoding.EncodeToString(src),
		Mode:      uint(mode),
		Errors:    errorList(err),
		DeclCount: declCount,
		NilFile:   f == nil,
	}
}

func parseErrorCorpus() []ParseErrorCase {
	base := parser.ParseComments | parser.SkipObjectResolution
	all := base | parser.AllErrors
	srcs := []struct{ id, src string }{
		{"missing-rparen", "package p\nfunc F( {\n}\nfunc G() {}\n"},
		{"missing-rbrace", "package p\nfunc F() {\nfunc G() {}\n"},
		{"bad-for", "package p\nfunc F() {\n\tfor x y {\n\t}\n}\nfunc G() {}\n"},
		{"missing-semi-expr", "package p\nfunc F() {\n\t1 2\n}\n"},
		{"bad-type", "package p\ntype T struct {\n\tX int\nfunc G() {}\n"},
		{"extra-rparen", "package p\nfunc F()) {}\nfunc G() {}\n"},
		{"missing-package-ident", "package \nfunc F() {}\n"},
		{"empty-func-sig", "package p\nfunc () {}\nfunc G() {}\n"},
		{"unclosed-paren-call", "package p\nfunc F() { println(1 }\nfunc G() {}\n"},
		{"import-after", "package p\nfunc F() {}\nimport \"fmt\"\n"},
	}
	var out []ParseErrorCase
	for _, c := range srcs {
		out = append(out, dumpParseErrorCase(c.id, c.id+".go", []byte(c.src), base))
		out = append(out, dumpParseErrorCase(c.id+"-all", c.id+"-all.go", []byte(c.src), all))
	}
	return out
}

func dumpParseErrors(writer io.Writer) {
	packet := ParseErrorPacket{Schema: 1, Package: "gotool-parse-errors", Go: "go1.24.13", Cases: parseErrorCorpus()}
	enc := json.NewEncoder(writer)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func sameParseErrPos(a, b ParseErr) bool {
	return a.Filename == b.Filename && a.Offset == b.Offset && a.Line == b.Line && a.Column == b.Column
}

func verifyParseErrors(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 64<<20))
	dec.DisallowUnknownFields()
	var packet ParseErrorPacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool-parse-errors" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid parse-error packet header or empty cases"))
	}
	for i, c := range packet.Cases {
		src, err := base64.StdEncoding.DecodeString(c.SrcB64)
		if err != nil {
			fail(fmt.Errorf("case %d id=%s src: %w", i, c.ID, err))
		}
		got := dumpParseErrorCase(c.ID, c.Filename, src, parser.Mode(c.Mode))
		if got.DeclCount != c.DeclCount || got.NilFile != c.NilFile || len(got.Errors) != len(c.Errors) {
			fail(fmt.Errorf("mismatch case %d id=%s decls/nil/count go=(%d,%v,%d) packet=(%d,%v,%d)",
				i, c.ID, got.DeclCount, got.NilFile, len(got.Errors), c.DeclCount, c.NilFile, len(c.Errors)))
		}
		for j := range got.Errors {
			if !sameParseErrPos(got.Errors[j], c.Errors[j]) {
				fail(fmt.Errorf("mismatch case %d id=%s error[%d] pos go=%+v packet=%+v", i, c.ID, j, got.Errors[j], c.Errors[j]))
			}
		}
	}
	fmt.Printf("Go verified %d gotool-parse-errors cases\n", len(packet.Cases))
}

type ParseEdgeCase struct {
	ID        string     `json:"id"`
	Filename  string     `json:"filename"`
	SrcB64    string     `json:"srcB64"`
	Mode      uint       `json:"mode"`
	Kind      string     `json:"kind"`
	Fprint    string     `json:"fprint"`
	Errors    []ParseErr `json:"errors"`
	DeclCount int        `json:"declCount"`
	NilFile   bool       `json:"nilFile"`
}

type ParseEdgePacket struct {
	Schema  int             `json:"schema"`
	Package string          `json:"package"`
	Go      string          `json:"go"`
	Cases   []ParseEdgeCase `json:"cases"`
}

func nestParens(n int) []byte {
	src := []byte("package p\nvar x = ")
	for i := 0; i < n; i++ {
		src = append(src, '(')
	}
	src = append(src, '1')
	for i := 0; i < n; i++ {
		src = append(src, ')')
	}
	src = append(src, '\n')
	return src
}

func dumpParseEdgeCase(id, filename, kind string, src []byte, mode parser.Mode) ParseEdgeCase {
	c := dumpParseCase(id, filename, kind, src, mode)
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, filename, src, mode)
	declCount := 0
	if f != nil {
		declCount = len(f.Decls)
	}
	return ParseEdgeCase{
		ID:        c.ID,
		Filename:  c.Filename,
		SrcB64:    c.SrcB64,
		Mode:      c.Mode,
		Kind:      c.Kind,
		Fprint:    c.Fprint,
		Errors:    errorList(err),
		DeclCount: declCount,
		NilFile:   f == nil,
	}
}

func parseEdgeCorpus() []ParseEdgeCase {
	mode := parseModes()
	illegal := append([]byte("package p\n"), 0xff, 0xfe)
	illegalIdent := append([]byte("package p\nvar "), 0xff)
	illegalIdent = append(illegalIdent, []byte("x int\n")...)
	return []ParseEdgeCase{
		dumpParseEdgeCase("empty", "empty.go", "file", []byte(""), mode),
		dumpParseEdgeCase("comments-only", "comments-only.go", "file", []byte("// only\n/* still only */\n"), mode),
		dumpParseEdgeCase("illegal-utf8", "illegal-utf8.go", "file", illegal, mode),
		dumpParseEdgeCase("illegal-utf8-ident", "illegal-utf8-ident.go", "file", illegalIdent, mode),
		dumpParseEdgeCase("unclosed-comment", "unclosed-comment.go", "file", []byte("package p\n/* unclosed\n"), mode),
		dumpParseEdgeCase("unclosed-string", "unclosed-string.go", "file", []byte("package p\nvar s = \"hi\n"), mode),
		dumpParseEdgeCase("underscore-tparam", "underscore-tparam.go", "file", []byte("package p\nfunc F[_ any]() {}\n"), mode),
		dumpParseEdgeCase("deep-nest-32", "deep-nest-32.go", "file", nestParens(32), mode),
	}
}

func dumpParseEdges(writer io.Writer) {
	packet := ParseEdgePacket{Schema: 1, Package: "gotool-parse-edges", Go: "go1.24.13", Cases: parseEdgeCorpus()}
	enc := json.NewEncoder(writer)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func verifyParseEdges(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 64<<20))
	dec.DisallowUnknownFields()
	var packet ParseEdgePacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool-parse-edges" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid parse-edge packet header or empty cases"))
	}
	for i, c := range packet.Cases {
		src, err := base64.StdEncoding.DecodeString(c.SrcB64)
		if err != nil {
			fail(fmt.Errorf("case %d id=%s src: %w", i, c.ID, err))
		}
		got := dumpParseEdgeCase(c.ID, c.Filename, c.Kind, src, parser.Mode(c.Mode))
		// Synthetic empty *ast.File (package-clause failure) includes a Scope
		// that SkipObjectResolution success paths leave nil. Error cases compare
		// positions and decl counts, not Fprint.
		if len(got.Errors) == 0 && got.Fprint != c.Fprint {
			fail(fmt.Errorf("mismatch case %d id=%s fprint\n-- go --\n%s\n-- packet --\n%s", i, c.ID, got.Fprint, c.Fprint))
		}
		if got.DeclCount != c.DeclCount || got.NilFile != c.NilFile || len(got.Errors) != len(c.Errors) {
			fail(fmt.Errorf("mismatch case %d id=%s decls/nil/count go=(%d,%v,%d) packet=(%d,%v,%d)",
				i, c.ID, got.DeclCount, got.NilFile, len(got.Errors), c.DeclCount, c.NilFile, len(c.Errors)))
		}
		for j := range got.Errors {
			if !sameParseErrPos(got.Errors[j], c.Errors[j]) {
				fail(fmt.Errorf("mismatch case %d id=%s error[%d] pos go=%+v packet=%+v", i, c.ID, j, got.Errors[j], c.Errors[j]))
			}
		}
	}
	fmt.Printf("Go verified %d gotool-parse-edges cases\n", len(packet.Cases))
}

func verifyParse(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 64<<20))
	dec.DisallowUnknownFields()
	var packet ParsePacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool-parse" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid parse packet header or empty cases"))
	}
	for i, c := range packet.Cases {
		src, err := base64.StdEncoding.DecodeString(c.SrcB64)
		if err != nil {
			fail(fmt.Errorf("case %d id=%s src: %w", i, c.ID, err))
		}
		got := dumpParseCase(c.ID, c.Filename, c.Kind, src, parser.Mode(c.Mode))
		if got.Fprint != c.Fprint {
			fail(fmt.Errorf("mismatch case %d id=%s fprint\n-- go --\n%s\n-- got --\n%s", i, c.ID, got.Fprint, c.Fprint))
		}
	}
	fmt.Printf("Go verified %d gotool-parse cases\n", len(packet.Cases))
}
