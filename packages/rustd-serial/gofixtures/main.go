// Go 1.24 reference for rustd-serial CSV (encoding/csv).
package main

import (
	"bytes"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

type ReadOpts struct {
	Comma            string `json:"comma"`
	Comment          string `json:"comment,omitempty"`
	FieldsPerRecord  int    `json:"fieldsPerRecord"`
	LazyQuotes       bool   `json:"lazyQuotes,omitempty"`
	TrimLeadingSpace bool   `json:"trimLeadingSpace,omitempty"`
}

type ParseErr struct {
	StartLine int    `json:"startLine"`
	Line      int    `json:"line"`
	Column    int    `json:"column"`
	Err       string `json:"err"`
}

type Step struct {
	FieldsHex []string  `json:"fieldsHex,omitempty"`
	Error     *ParseErr `json:"error"`
	Positions [][2]int  `json:"positions,omitempty"`
	Offset    int64     `json:"offset"`
}

type ReadCase struct {
	ID       string   `json:"id"`
	InputHex string   `json:"inputHex"`
	Opts     ReadOpts `json:"opts"`
	Steps    []Step   `json:"steps"`
	DelimErr bool     `json:"delimErr,omitempty"`
}

type WriteCase struct {
	ID        string     `json:"id"`
	Records   [][]string `json:"records"`
	OutputHex string     `json:"outputHex"`
	UseCRLF   bool       `json:"useCRLF,omitempty"`
	Comma     string     `json:"comma,omitempty"`
	Error     string     `json:"error,omitempty"`
}

type Packet struct {
	Schema  int         `json:"schema"`
	Package string      `json:"package"`
	Reads   []ReadCase  `json:"reads"`
	Writes  []WriteCase `json:"writes"`
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func hx(b []byte) string { return hex.EncodeToString(b) }

func runeStr(r rune) string {
	if r == 0 {
		return ""
	}
	return string(r)
}

func applyReader(r *csv.Reader, opts ReadOpts) {
	if opts.Comma != "" {
		r.Comma = []rune(opts.Comma)[0]
	}
	if opts.Comment != "" {
		r.Comment = []rune(opts.Comment)[0]
	}
	r.FieldsPerRecord = opts.FieldsPerRecord
	r.LazyQuotes = opts.LazyQuotes
	r.TrimLeadingSpace = opts.TrimLeadingSpace
}

func parseSteps(input []byte, opts ReadOpts) (steps []Step, delimErr bool) {
	steps = []Step{}
	r := csv.NewReader(bytes.NewReader(input))
	applyReader(r, opts)
	for {
		rec, err := r.Read()
		step := Step{Offset: r.InputOffset()}
		if err == io.EOF {
			return steps, false
		}
		if err != nil && err.Error() == "csv: invalid field or comment delimiter" {
			return nil, true
		}
		var pe *csv.ParseError
		if errors.As(err, &pe) {
			step.Error = &ParseErr{StartLine: pe.StartLine, Line: pe.Line, Column: pe.Column, Err: pe.Err.Error()}
		} else if err != nil {
			fail(fmt.Errorf("unexpected %v", err))
		}
		if rec != nil {
			step.FieldsHex = make([]string, len(rec))
			step.Positions = make([][2]int, len(rec))
			for i, f := range rec {
				step.FieldsHex[i] = hx([]byte(f))
				line, col := r.FieldPos(i)
				step.Positions[i] = [2]int{line, col}
			}
		}
		steps = append(steps, step)
		if err != nil {
			return steps, false
		}
	}
}

type spec struct {
	id               string
	input            string
	comma            rune
	comment          rune
	fieldsPerRecord  int
	lazy             bool
	trim             bool
	useFieldsDefault bool
}

func readSpecs() []spec {
	// Mirror encoding/csv reader_test.go; FieldsPerRecord defaults to -1 like the Go tests.
	s := func(id, input string) spec {
		return spec{id: id, input: input, fieldsPerRecord: -1, useFieldsDefault: true}
	}
	out := []spec{
		s("Simple", "a,b,c\n"),
		s("CRLF", "a,b\r\nc,d\r\n"),
		s("BareCR", "a,b\rc,d\r\n"),
		s("RFC4180test", "#field1,field2,field3\n\"aaa\",\"bb\nb\",\"ccc\"\n\"a,a\",\"b\"\"bb\",\"ccc\"\nzzz,yyy,xxx\n"),
		s("NoEOLTest", "a,b,c"),
		{id: "Semicolon", input: "a;b;c\n", comma: ';', fieldsPerRecord: -1, useFieldsDefault: true},
		s("MultiLine", "\"two\nline\",\"one line\",\"three\nline\nfield\""),
		s("BlankLine", "a,b,c\n\nd,e,f\n\n"),
		{id: "TrimSpace", input: " a,  b,   c\n", trim: true, fieldsPerRecord: -1, useFieldsDefault: true},
		s("LeadingSpace", " a,  b,   c\n"),
		{id: "Comment", input: "#1,2,3\na,b,c\n#comment", comment: '#', fieldsPerRecord: -1, useFieldsDefault: true},
		s("NoComment", "#1,2,3\na,b,c"),
		{id: "LazyQuotes", input: `a "word","1"2",a","b`, lazy: true, fieldsPerRecord: -1, useFieldsDefault: true},
		{id: "BareQuotes", input: `a "word","1"2",a"`, lazy: true, fieldsPerRecord: -1, useFieldsDefault: true},
		{id: "BareDoubleQuotes", input: `a""b,c`, lazy: true, fieldsPerRecord: -1, useFieldsDefault: true},
		s("BadDoubleQuotes", `a""b,c`),
		{id: "TrimQuote", input: ` "a"," b",c`, trim: true, fieldsPerRecord: -1, useFieldsDefault: true},
		s("BadBareQuote", `a "word","b"`),
		s("BadTrailingQuote", `"a word",b"`),
		s("ExtraneousQuote", `"a "word","b"`),
		{id: "BadFieldCount", input: "a,b,c\nd,e", fieldsPerRecord: 0},
		{id: "BadFieldCount1", input: `a,b,c`, fieldsPerRecord: 2},
		s("FieldCount", "a,b,c\nd,e"),
		s("TrailingCommaEOF", "a,b,c,"),
		s("TrailingCommaEOL", "a,b,c,\n"),
		{id: "TrailingCommaSpaceEOF", input: "a,b,c, ", trim: true, fieldsPerRecord: -1, useFieldsDefault: true},
		s("NotTrailingComma3", "a,b,c, \n"),
		s("CommaFieldTest", "x,y,z,w\nx,y,z,\nx,y,,\nx,,,\n,,,\n\"x\",\"y\",\"z\",\"w\"\n\"x\",\"y\",\"z\",\"\"\n\"x\",\"y\",\"\",\"\"\n\"x\",\"\",\"\",\"\"\n\"\",\"\",\"\",\"\"\n"),
		s("StartLine1", "a,\"b\nc\"d,e"),
		s("StartLine2", "a,b\n\"d\n\n,e"),
		s("CRLFInQuotedField", "A,\"Hello\r\nHi\",B\r\n"),
		s("BinaryBlobField", "x09\x41\xb4\x1c,aktau"),
		s("TrailingCR", "field1,field2\r"),
		s("QuotedTrailingCR", "\"field\"\r"),
		s("QuotedTrailingCRCR", "\"field\"\r\r"),
		s("FieldCR", "field\rfield\r"),
		s("FieldCRCRLF", "field\r\r\nfield\r\r\n"),
		s("QuotedFieldMultipleLF", "\"\n\n\n\n\""),
		s("MultipleCRLF", "\r\n\r\n\r\n\r\n"),
		{id: "HugeLines", input: strings.Repeat("#ignore\n", 200) + strings.Repeat("@", 5000) + "," + strings.Repeat("*", 5000), comment: '#', fieldsPerRecord: -1, useFieldsDefault: true},
		s("QuoteWithTrailingCRLF", "\"foo\"bar\"\r\n"),
		{id: "LazyQuoteWithTrailingCRLF", input: "\"foo\"bar\"\r\n", lazy: true, fieldsPerRecord: -1, useFieldsDefault: true},
		s("DoubleQuoteWithTrailingCRLF", "\"foo\"\"bar\"\r\n"),
		s("EvenQuotes", `""""""""`),
		s("OddQuotes", `"""""""`),
		{id: "LazyOddQuotes", input: `"""""""`, lazy: true, fieldsPerRecord: -1, useFieldsDefault: true},
		{id: "NonASCIICommaAndComment", input: "a£b,c£ \td,e\n€ comment\n", comma: '£', comment: '€', trim: true, fieldsPerRecord: -1, useFieldsDefault: true},
		{id: "NonASCIICommaAndCommentWithQuotes", input: "a€\"  b,\"€ c\nλ comment\n", comma: '€', comment: 'λ', fieldsPerRecord: -1, useFieldsDefault: true},
		{id: "Empty", input: "", fieldsPerRecord: -1, useFieldsDefault: true},
		s("OnlyNL", "\n\n"),
		s("NUL", "a\x00b,c\n"),
		{id: "RFC4180fields0", input: "#field1,field2,field3\n\"aaa\",\"bb\nb\",\"ccc\"\n\"a,a\",\"b\"\"bb\",\"ccc\"\nzzz,yyy,xxx\n", fieldsPerRecord: 0},
		{id: "BadComma1", input: "a,b", comma: '\n', fieldsPerRecord: -1, useFieldsDefault: true},
		{id: "BadComma2", input: "a,b", comma: '"', fieldsPerRecord: -1, useFieldsDefault: true},
		{id: "BadComment1", input: "a,b", comment: '\n', fieldsPerRecord: -1, useFieldsDefault: true},
		{id: "BadCommaComment", input: "a,b", comma: 'X', comment: 'X', fieldsPerRecord: -1, useFieldsDefault: true},
	}
	return out
}

func generateReads() []ReadCase {
	var cases []ReadCase
	for _, sp := range readSpecs() {
		opts := ReadOpts{Comma: ",", FieldsPerRecord: sp.fieldsPerRecord, LazyQuotes: sp.lazy, TrimLeadingSpace: sp.trim}
		if sp.comma != 0 {
			opts.Comma = runeStr(sp.comma)
		}
		if sp.comment != 0 {
			opts.Comment = runeStr(sp.comment)
		}
		steps, delim := parseSteps([]byte(sp.input), opts)
		cases = append(cases, ReadCase{ID: sp.id, InputHex: hx([]byte(sp.input)), Opts: opts, Steps: steps, DelimErr: delim})
	}
	return cases
}

func generateWrites() []WriteCase {
	type wt struct {
		id      string
		input   [][]string
		useCRLF bool
		comma   rune
	}
	tests := []wt{
		{"abc", [][]string{{"abc"}}, false, 0},
		{"abc-crlf", [][]string{{"abc"}}, true, 0},
		{"quoted-quotes", [][]string{{`"abc"`}}, false, 0},
		{"inner-quote", [][]string{{`a"b`}}, false, 0},
		{"leading-space", [][]string{{" abc"}}, false, 0},
		{"comma-field", [][]string{{"abc,def"}}, false, 0},
		{"two-fields", [][]string{{"abc", "def"}}, false, 0},
		{"two-records", [][]string{{"abc"}, {"def"}}, false, 0},
		{"newline-field", [][]string{{"abc\ndef"}}, false, 0},
		{"newline-crlf", [][]string{{"abc\ndef"}}, true, 0},
		{"cr-crlf", [][]string{{"abc\rdef"}}, true, 0},
		{"cr-lf", [][]string{{"abc\rdef"}}, false, 0},
		{"empty-record", [][]string{{""}}, false, 0},
		{"empty-fields", [][]string{{"", ""}}, false, 0},
		{"dot-slash", [][]string{{`\.`}}, false, 0},
		{"pipe", [][]string{{"a", "a", ""}}, false, '|'},
		{"bad-comma", [][]string{{"foo"}}, false, '"'},
	}
	var cases []WriteCase
	for _, tt := range tests {
		b := &strings.Builder{}
		w := csv.NewWriter(b)
		w.UseCRLF = tt.useCRLF
		if tt.comma != 0 {
			w.Comma = tt.comma
		}
		err := w.WriteAll(tt.input)
		c := WriteCase{ID: tt.id, Records: tt.input, UseCRLF: tt.useCRLF, OutputHex: hx([]byte(b.String()))}
		if tt.comma != 0 {
			c.Comma = runeStr(tt.comma)
		}
		if err != nil {
			c.Error = err.Error()
		}
		cases = append(cases, c)
	}
	return cases
}

func verify(pkg string, packet Packet) {
	if packet.Schema != 1 || packet.Package != pkg {
		fail(fmt.Errorf("invalid packet header"))
	}
	if len(packet.Writes) == 0 {
		fail(fmt.Errorf("empty writes"))
	}
	for _, c := range packet.Writes {
		b := &strings.Builder{}
		w := csv.NewWriter(b)
		w.UseCRLF = c.UseCRLF
		if c.Comma != "" {
			w.Comma = []rune(c.Comma)[0]
		}
		err := w.WriteAll(c.Records)
		if c.Error != "" {
			if err == nil || err.Error() != c.Error {
				fail(fmt.Errorf("%s: error want %q got %v", c.ID, c.Error, err))
			}
			continue
		}
		if err != nil {
			fail(fmt.Errorf("%s: %v", c.ID, err))
		}
		if hx([]byte(b.String())) != c.OutputHex {
			fail(fmt.Errorf("%s: write bytes differ", c.ID))
		}
		r := csv.NewReader(strings.NewReader(b.String()))
		if c.Comma != "" {
			r.Comma = []rune(c.Comma)[0]
		}
		r.FieldsPerRecord = -1
		r.LazyQuotes = true
		got, err := r.ReadAll()
		if err != nil {
			fail(fmt.Errorf("%s: go read back: %v", c.ID, err))
		}
		if len(got) != len(c.Records) {
			fail(fmt.Errorf("%s: record count", c.ID))
		}
	}
	fmt.Printf("Go verified %d serial-csv write cases\n", len(packet.Writes))
}

func main() {
	pkg := flag.String("pkg", "serial-csv", "package name")
	out := flag.String("out", "", "output JSON file; stdout by default")
	verifyFlag := flag.Bool("verify", false, "verify a packet from stdin")
	flag.Parse()
	switch *pkg {
	case "serial-csv":
		if *verifyFlag {
			var packet Packet
			dec := json.NewDecoder(io.LimitReader(os.Stdin, 32<<20))
			if err := dec.Decode(&packet); err != nil {
				fail(err)
			}
			verify(*pkg, packet)
			return
		}
		writeJSON(*out, Packet{Schema: 1, Package: *pkg, Reads: generateReads(), Writes: generateWrites()})
	case "serial-pem":
		if *verifyFlag {
			var packet PemPacket
			dec := json.NewDecoder(io.LimitReader(os.Stdin, 32<<20))
			if err := dec.Decode(&packet); err != nil {
				fail(err)
			}
			verifyPem(packet)
			return
		}
		writeJSON(*out, generatePem())
	case "serial-asn1":
		if *verifyFlag {
			var packet Asn1VerifyPacket
			dec := json.NewDecoder(io.LimitReader(os.Stdin, 32<<20))
			if err := dec.Decode(&packet); err != nil {
				fail(err)
			}
			verifyAsn1(packet)
			return
		}
		writeJSON(*out, generateAsn1())
	default:
		fail(fmt.Errorf("unsupported package %q", *pkg))
	}
}

func writeJSON(path string, value any) {
	var writer io.Writer = os.Stdout
	if path != "" {
		f, err := os.Create(path)
		if err != nil {
			fail(err)
		}
		defer f.Close()
		writer = f
	}
	enc := json.NewEncoder(writer)
	if err := enc.Encode(value); err != nil {
		fail(err)
	}
}
