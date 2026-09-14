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
