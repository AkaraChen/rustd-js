package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp/syntax"
	"strings"
	"unicode"
)

type InstJSON struct {
	Op   uint8   `json:"op"`
	Out  uint32  `json:"out"`
	Arg  uint32  `json:"arg"`
	Rune []int32 `json:"rune"`
}

type Case struct {
	ID      string     `json:"id"`
	Pattern string     `json:"pattern"`
	Flags   uint16     `json:"flags"`
	Dump    string     `json:"dump,omitempty"`
	Printed string     `json:"printed,omitempty"`
	Start   int        `json:"start,omitempty"`
	NumCap  int        `json:"numCap,omitempty"`
	Inst    []InstJSON `json:"inst,omitempty"`
	Error   string     `json:"error,omitempty"`
	Expr    string     `json:"expr,omitempty"`
}

type Packet struct {
	Schema  int    `json:"schema"`
	Package string `json:"package"`
	Cases   []Case `json:"cases"`
}

type parseTest struct {
	Regexp string
	Dump   string
	Flags  syntax.Flags
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func tests() []parseTest {
	testFlags := syntax.MatchNL | syntax.PerlX | syntax.UnicodeGroups
	out := []parseTest{}
	add := func(p, d string, f syntax.Flags) {
		out = append(out, parseTest{p, d, f})
	}
	for _, tt := range []struct{ p, d string }{
		{`a`, `lit{a}`},
		{`a.`, `cat{lit{a}dot{}}`},
		{`a.b`, `cat{lit{a}dot{}lit{b}}`},
		{`ab`, `str{ab}`},
		{`a.b.c`, `cat{lit{a}dot{}lit{b}dot{}lit{c}}`},
		{`abc`, `str{abc}`},
		{`a|^`, `alt{lit{a}bol{}}`},
		{`a|b`, `cc{0x61-0x62}`},
		{`(a)`, `cap{lit{a}}`},
		{`(a)|b`, `alt{cap{lit{a}}lit{b}}`},
		{`a*`, `star{lit{a}}`},
		{`a+`, `plus{lit{a}}`},
		{`a?`, `que{lit{a}}`},
		{`a{2}`, `rep{2,2 lit{a}}`},
		{`a{2,3}`, `rep{2,3 lit{a}}`},
		{`a{2,}`, `rep{2,-1 lit{a}}`},
		{`a*?`, `nstar{lit{a}}`},
		{`a+?`, `nplus{lit{a}}`},
		{`a??`, `nque{lit{a}}`},
		{`a{2}?`, `nrep{2,2 lit{a}}`},
		{`a{2,3}?`, `nrep{2,3 lit{a}}`},
		{`a{2,}?`, `nrep{2,-1 lit{a}}`},
		{`x{1001`, `str{x{1001}`},
		{`x{9876543210`, `str{x{9876543210}`},
		{`x{9876543210,`, `str{x{9876543210,}`},
		{`x{2,1`, `str{x{2,1}`},
		{`x{1,9876543210`, `str{x{1,9876543210}`},
		{``, `emp{}`},
		{`|`, `emp{}`},
		{`|x|`, `alt{emp{}lit{x}emp{}}`},
		{`.`, `dot{}`},
		{`^`, `bol{}`},
		{`$`, `eol{}`},
		{`\|`, `lit{|}`},
		{`\(`, `lit{(}`},
		{`\)`, `lit{)}`},
		{`\*`, `lit{*}`},
		{`\+`, `lit{+}`},
		{`\?`, `lit{?}`},
		{`{`, `lit{{}`},
		{`}`, `lit{}}`},
		{`\.`, `lit{.}`},
		{`\^`, `lit{^}`},
		{`\$`, `lit{$}`},
		{`\\`, `lit{\}`},
		{`[ace]`, `cc{0x61 0x63 0x65}`},
		{`[abc]`, `cc{0x61-0x63}`},
		{`[a-z]`, `cc{0x61-0x7a}`},
		{`[a]`, `lit{a}`},
		{`\-`, `lit{-}`},
		{`-`, `lit{-}`},
		{`\_`, `lit{_}`},
		{`abc|def`, `alt{str{abc}str{def}}`},
		{`abc|def|ghi`, `alt{str{abc}str{def}str{ghi}}`},
		{`[[:lower:]]`, `cc{0x61-0x7a}`},
		{`[^[:lower:]]`, `cc{0x0-0x60 0x7b-0x10ffff}`},
		{`[[:^lower:]]`, `cc{0x0-0x60 0x7b-0x10ffff}`},
		{`(?i)[[:lower:]]`, `cc{0x41-0x5a 0x61-0x7a 0x17f 0x212a}`},
		{`(?i)[a-z]`, `cc{0x41-0x5a 0x61-0x7a 0x17f 0x212a}`},
		{`\d`, `cc{0x30-0x39}`},
		{`\D`, `cc{0x0-0x2f 0x3a-0x10ffff}`},
		{`\s`, `cc{0x9-0xa 0xc-0xd 0x20}`},
		{`\S`, `cc{0x0-0x8 0xb 0xe-0x1f 0x21-0x10ffff}`},
		{`\w`, `cc{0x30-0x39 0x41-0x5a 0x5f 0x61-0x7a}`},
		{`\W`, `cc{0x0-0x2f 0x3a-0x40 0x5b-0x5e 0x60 0x7b-0x10ffff}`},
		{`(?i)\w`, `cc{0x30-0x39 0x41-0x5a 0x5f 0x61-0x7a 0x17f 0x212a}`},
		{`(?i)\W`, `cc{0x0-0x2f 0x3a-0x40 0x5b-0x5e 0x60 0x7b-0x17e 0x180-0x2129 0x212b-0x10ffff}`},
		{`[^\\]`, `cc{0x0-0x5b 0x5d-0x10ffff}`},
		{`\p{Braille}`, `cc{0x2800-0x28ff}`},
		{`\P{Braille}`, `cc{0x0-0x27ff 0x2900-0x10ffff}`},
		{`\p{^Braille}`, `cc{0x0-0x27ff 0x2900-0x10ffff}`},
		{`\P{^Braille}`, `cc{0x2800-0x28ff}`},
		{`\pZ`, `cc{0x20 0xa0 0x1680 0x2000-0x200a 0x2028-0x2029 0x202f 0x205f 0x3000}`},
		{`[\p{Braille}]`, `cc{0x2800-0x28ff}`},
		{`[\P{Braille}]`, `cc{0x0-0x27ff 0x2900-0x10ffff}`},
		{`[\p{^Braille}]`, `cc{0x0-0x27ff 0x2900-0x10ffff}`},
		{`[\P{^Braille}]`, `cc{0x2800-0x28ff}`},
		{`[\pZ]`, `cc{0x20 0xa0 0x1680 0x2000-0x200a 0x2028-0x2029 0x202f 0x205f 0x3000}`},
		{`\p{Lu}`, ``},
		{`[\p{Lu}]`, ``},
		{`(?i)[\p{Lu}]`, ``},
		{`\p{Any}`, `dot{}`},
		{`\p{^Any}`, `cc{}`},
		{`[\012-\234]\141`, `cat{cc{0xa-0x9c}lit{a}}`},
		{`[\x{41}-\x7a]\x61`, `cat{cc{0x41-0x7a}lit{a}}`},
		{`a{,2}`, `str{a{,2}}`},
		{`\.\^\$\\`, `str{.^$\}`},
		{`[a-zABC]`, `cc{0x41-0x43 0x61-0x7a}`},
		{`[^a]`, `cc{0x0-0x60 0x62-0x10ffff}`},
		{`[α-ε☺]`, `cc{0x3b1-0x3b5 0x263a}`},
		{`a*{`, `cat{star{lit{a}}lit{{}}`},
		{`(?:ab)*`, `star{str{ab}}`},
		{`(ab)*`, `star{cap{str{ab}}}`},
		{`ab|cd`, `alt{str{ab}str{cd}}`},
		{`a(b|c)d`, `cat{lit{a}cap{cc{0x62-0x63}}lit{d}}`},
		{`(?:a)`, `lit{a}`},
		{`(?:ab)(?:cd)`, `str{abcd}`},
		{`(?:a+b+)(?:c+d+)`, `cat{plus{lit{a}}plus{lit{b}}plus{lit{c}}plus{lit{d}}}`},
		{`(?:a+|b+)|(?:c+|d+)`, `alt{plus{lit{a}}plus{lit{b}}plus{lit{c}}plus{lit{d}}}`},
		{`(?:a|b)|(?:c|d)`, `cc{0x61-0x64}`},
		{`a|.`, `dot{}`},
		{`.|a`, `dot{}`},
		{`(?:[abc]|A|Z|hello|world)`, `alt{cc{0x41 0x5a 0x61-0x63}str{hello}str{world}}`},
		{`(?:[abc]|A|Z)`, `cc{0x41 0x5a 0x61-0x63}`},
		{`\Q+|*?{[\E`, `str{+|*?{[}`},
		{`\Q+\E+`, `plus{lit{+}}`},
		{`\Qab\E+`, `cat{lit{a}plus{lit{b}}}`},
		{`\Q\\E`, `lit{\}`},
		{`\Q\\\E`, `str{\\}`},
		{`(?m)^`, `bol{}`},
		{`(?m)$`, `eol{}`},
		{`(?-m)^`, `bot{}`},
		{`(?-m)$`, `eot{}`},
		{`(?m)\A`, `bot{}`},
		{`(?m)\z`, `eot{\z}`},
		{`(?-m)\A`, `bot{}`},
		{`(?-m)\z`, `eot{\z}`},
		{`(?P<name>a)`, `cap{name:lit{a}}`},
		{`(?<name>a)`, `cap{name:lit{a}}`},
		{`[Aa]`, `litfold{A}`},
		{`[\x{100}\x{101}]`, `litfold{Ā}`},
		{`[Δδ]`, `litfold{Δ}`},
		{`abcde`, `str{abcde}`},
		{`[Aa][Bb]cd`, `cat{strfold{AB}str{cd}}`},
		{`abc|abd|aef|bcx|bcy`, `alt{cat{lit{a}alt{cat{lit{b}cc{0x63-0x64}}str{ef}}}cat{str{bc}cc{0x78-0x79}}}`},
		{`ax+y|ax+z|ay+w`, `cat{lit{a}alt{cat{plus{lit{x}}lit{y}}cat{plus{lit{x}}lit{z}}cat{plus{lit{y}}lit{w}}}}`},
		{`(?:.)`, `dot{}`},
		{`(?:x|(?:xa))`, `cat{lit{x}alt{emp{}lit{a}}}`},
		{`(?:.|(?:.a))`, `cat{dot{}alt{emp{}lit{a}}}`},
		{`(?:A(?:A|a))`, `cat{lit{A}litfold{A}}`},
		{`(?:A|a)`, `litfold{A}`},
		{`A|(?:A|a)`, `litfold{A}`},
		{`(?s).`, `dot{}`},
		{`(?-s).`, `dnl{}`},
		{`(?:(?:^).)`, `cat{bol{}dot{}}`},
		{`(?-s)(?:(?:^).)`, `cat{bol{}dnl{}}`},
		{`[\s\S]a`, `cat{cc{0x0-0x10ffff}lit{a}}`},
		{`abc|abd`, `cat{str{ab}cc{0x63-0x64}}`},
		{`a(?:b)c|abd`, `cat{str{ab}cc{0x63-0x64}}`},
		{`abc|x|abd`, `alt{str{abc}lit{x}str{abd}}`},
		{`(?i)abc|ABD`, `cat{strfold{AB}cc{0x43-0x44 0x63-0x64}}`},
		{`[ab]c|[ab]d`, `cat{cc{0x61-0x62}cc{0x63-0x64}}`},
		{`.c|.d`, `cat{dot{}cc{0x63-0x64}}`},
		{`x{2}|x{2}[0-9]`, `cat{rep{2,2 lit{x}}alt{emp{}cc{0x30-0x39}}}`},
		{`x{2}y|x{2}[0-9]y`, `cat{rep{2,2 lit{x}}alt{lit{y}cat{cc{0x30-0x39}lit{y}}}}`},
		{`a.*?c|a.*?b`, `cat{lit{a}alt{cat{nstar{dot{}}lit{c}}cat{nstar{dot{}}lit{b}}}}`},
	} {
		add(tt.p, tt.d, testFlags)
	}
	for _, tt := range []struct{ p, d string }{
		{`AbCdE`, `strfold{ABCDE}`},
		{`[Aa]`, `litfold{A}`},
		{`a`, `litfold{A}`},
		{`A[F-g]`, `cat{litfold{A}cc{0x41-0x7a 0x17f 0x212a}}`},
		{`[[:upper:]]`, `cc{0x41-0x5a 0x61-0x7a 0x17f 0x212a}`},
		{`[[:lower:]]`, `cc{0x41-0x5a 0x61-0x7a 0x17f 0x212a}`},
	} {
		add(tt.p, tt.d, syntax.FoldCase)
	}
	add(`(|)^$.[*+?]{5,10},\\`, `str{(|)^$.[*+?]{5,10},\\}`, syntax.Literal)
	add(`.`, `dot{}`, syntax.MatchNL)
	add("\n", "lit{\n}", syntax.MatchNL)
	add(`[^a]`, `cc{0x0-0x60 0x62-0x10ffff}`, syntax.MatchNL)
	add(`.`, `dnl{}`, 0)
	add("\n", "lit{\n}", 0)
	add(`[^a]`, `cc{0x0-0x9 0xb-0x60 0x62-0x10ffff}`, 0)
	return out
}

func simplifyTests() []struct{ Regexp, Simple string } {
	return []struct{ Regexp, Simple string }{
		{`a`, `a`},
		{`ab`, `ab`},
		{`a|b`, `[ab]`},
		{`ab|cd`, `ab|cd`},
		{`(ab)*`, `(ab)*`},
		{`(ab)+`, `(ab)+`},
		{`(ab)?`, `(ab)?`},
		{`.`, `(?s:.)`},
		{`^`, `(?m:^)`},
		{`$`, `(?m:$)`},
		{`[ac]`, `[ac]`},
		{`[^ac]`, `[^ac]`},
		{`[[:alnum:]]`, `[0-9A-Za-z]`},
		{`[[:alpha:]]`, `[A-Za-z]`},
		{`[[:blank:]]`, `[\t ]`},
		{`[[:cntrl:]]`, `[\x00-\x1f\x7f]`},
		{`[[:digit:]]`, `[0-9]`},
		{`[[:graph:]]`, `[!-~]`},
		{`[[:lower:]]`, `[a-z]`},
		{`[[:print:]]`, `[ -~]`},
		{`[[:punct:]]`, "[!-/:-@\\[-`\\{-~]"},
		{`[[:space:]]`, `[\t-\r ]`},
		{`[[:upper:]]`, `[A-Z]`},
		{`[[:xdigit:]]`, `[0-9A-Fa-f]`},
		{`\d`, `[0-9]`},
		{`\s`, `[\t\n\f\r ]`},
		{`\w`, `[0-9A-Z_a-z]`},
		{`\D`, `[^0-9]`},
		{`\S`, `[^\t\n\f\r ]`},
		{`\W`, `[^0-9A-Z_a-z]`},
		{`[\d]`, `[0-9]`},
		{`[\s]`, `[\t\n\f\r ]`},
		{`[\w]`, `[0-9A-Z_a-z]`},
		{`[\D]`, `[^0-9]`},
		{`[\S]`, `[^\t\n\f\r ]`},
		{`[\W]`, `[^0-9A-Z_a-z]`},
		{`a{1}`, `a`},
		{`a{2}`, `aa`},
		{`a{5}`, `aaaaa`},
		{`a{0,1}`, `a?`},
		{`(a){0,2}`, `(?:(a)(a)?)?`},
		{`(a){0,4}`, `(?:(a)(?:(a)(?:(a)(a)?)?)?)?`},
		{`(a){2,6}`, `(a)(a)(?:(a)(?:(a)(?:(a)(a)?)?)?)?`},
		{`a{0,2}`, `(?:aa?)?`},
		{`a{0,4}`, `(?:a(?:a(?:aa?)?)?)?`},
		{`a{2,6}`, `aa(?:a(?:a(?:aa?)?)?)?`},
		{`a{0,}`, `a*`},
		{`a{1,}`, `a+`},
		{`a{2,}`, `aa+`},
		{`a{5,}`, `aaaaa+`},
		{`(?:a{1,}){1,}`, `a+`},
		{`(a{1,}b{1,})`, `(a+b+)`},
		{`a{1,}|b{1,}`, `a+|b+`},
		{`(?:a{1,})*`, `(?:a+)*`},
		{`(?:a{1,})+`, `a+`},
		{`(?:a{1,})?`, `(?:a+)?`},
		{``, `(?:)`},
		{`a{0}`, `(?:)`},
		{`[ab]`, `[ab]`},
		{`[abc]`, `[a-c]`},
		{`[a-za-za-z]`, `[a-z]`},
		{`[A-Za-zA-Za-z]`, `[A-Za-z]`},
		{`[ABCDEFGH]`, `[A-H]`},
		{`[AB-CD-EF-GH]`, `[A-H]`},
		{`[W-ZP-XE-R]`, `[E-Z]`},
		{`[a-ee-gg-m]`, `[a-m]`},
		{`[a-ea-ha-m]`, `[a-m]`},
		{`[a-ma-ha-e]`, `[a-m]`},
		{`[a-zA-Z0-9 -~]`, `[ -~]`},
		{`[^[:cntrl:][:^cntrl:]]`, `[^\x00-\x{10FFFF}]`},
		{`[[:cntrl:][:^cntrl:]]`, `(?s:.)`},
		{`(?i)A`, `(?i:A)`},
		{`(?i)a`, `(?i:A)`},
		{`(?i)[A]`, `(?i:A)`},
		{`(?i)[a]`, `(?i:A)`},
		{`(?i)K`, `(?i:K)`},
		{`(?i)k`, `(?i:K)`},
		{`(?i)\x{212a}`, "(?i:K)"},
		{`(?i)[K]`, "[Kk\u212A]"},
		{`(?i)[k]`, "[Kk\u212A]"},
		{`(?i)[\x{212a}]`, "[Kk\u212A]"},
		{`(?i)[a-z]`, "[A-Za-z\u017F\u212A]"},
		{`(?i)[\x00-\x{FFFD}]`, "[\\x00-\uFFFD]"},
		{`(?i)[\x00-\x{10FFFF}]`, `(?s:.)`},
		{`(a|b|c|)`, `([a-c]|(?:))`},
		{`(a|b|)`, `([ab]|(?:))`},
		{`(|)`, `()`},
		{`a()`, `a()`},
		{`(()|())`, `(()|())`},
		{`(a|)`, `(a|(?:))`},
		{`ab()cd()`, `ab()cd()`},
		{`()`, `()`},
		{`()*`, `()*`},
		{`()+`, `()+`},
		{`()?`, `()?`},
		{`(){0}`, `(?:)`},
		{`(){1}`, `()`},
		{`(){1,}`, `()+`},
		{`(){0,2}`, `(?:()()?)?`},
	}
}

func dump(re *syntax.Regexp) string {
	var b strings.Builder
	dumpRegexp(&b, re)
	return b.String()
}

var opNames = []string{
	syntax.OpNoMatch:        "no",
	syntax.OpEmptyMatch:     "emp",
	syntax.OpLiteral:        "lit",
	syntax.OpCharClass:      "cc",
	syntax.OpAnyCharNotNL:   "dnl",
	syntax.OpAnyChar:        "dot",
	syntax.OpBeginLine:      "bol",
	syntax.OpEndLine:        "eol",
	syntax.OpBeginText:      "bot",
	syntax.OpEndText:        "eot",
	syntax.OpWordBoundary:   "wb",
	syntax.OpNoWordBoundary: "nwb",
	syntax.OpCapture:        "cap",
	syntax.OpStar:           "star",
	syntax.OpPlus:           "plus",
	syntax.OpQuest:          "que",
	syntax.OpRepeat:         "rep",
	syntax.OpConcat:         "cat",
	syntax.OpAlternate:      "alt",
}

func dumpRegexp(b *strings.Builder, re *syntax.Regexp) {
	if int(re.Op) >= len(opNames) || opNames[re.Op] == "" {
		fmt.Fprintf(b, "op%d", re.Op)
	} else {
		switch re.Op {
		default:
			b.WriteString(opNames[re.Op])
		case syntax.OpStar, syntax.OpPlus, syntax.OpQuest, syntax.OpRepeat:
			if re.Flags&syntax.NonGreedy != 0 {
				b.WriteByte('n')
			}
			b.WriteString(opNames[re.Op])
		case syntax.OpLiteral:
			if len(re.Rune) > 1 {
				b.WriteString("str")
			} else {
				b.WriteString("lit")
			}
			if re.Flags&syntax.FoldCase != 0 {
				for _, r := range re.Rune {
					if unicode.SimpleFold(r) != r {
						b.WriteString("fold")
						break
					}
				}
			}
		}
	}
	b.WriteByte('{')
	switch re.Op {
	case syntax.OpEndText:
		if re.Flags&syntax.WasDollar == 0 {
			b.WriteString(`\z`)
		}
	case syntax.OpLiteral:
		for _, r := range re.Rune {
			b.WriteRune(r)
		}
	case syntax.OpConcat, syntax.OpAlternate:
		for _, sub := range re.Sub {
			dumpRegexp(b, sub)
		}
	case syntax.OpStar, syntax.OpPlus, syntax.OpQuest:
		dumpRegexp(b, re.Sub[0])
	case syntax.OpRepeat:
		fmt.Fprintf(b, "%d,%d ", re.Min, re.Max)
		dumpRegexp(b, re.Sub[0])
	case syntax.OpCapture:
		if re.Name != "" {
			b.WriteString(re.Name)
			b.WriteByte(':')
		}
		dumpRegexp(b, re.Sub[0])
	case syntax.OpCharClass:
		sep := ""
		for i := 0; i < len(re.Rune); i += 2 {
			b.WriteString(sep)
			sep = " "
			lo, hi := re.Rune[i], re.Rune[i+1]
			if lo == hi {
				fmt.Fprintf(b, "%#x", lo)
			} else {
				fmt.Fprintf(b, "%#x-%#x", lo, hi)
			}
		}
	}
	b.WriteByte('}')
}

func generate() Packet {
	var cases []Case
	for i, tt := range tests() {
		re, err := syntax.Parse(tt.Regexp, tt.Flags)
		c := Case{ID: fmt.Sprintf("c%d", i), Pattern: tt.Regexp, Flags: uint16(tt.Flags)}
		if err != nil {
			if se, ok := err.(*syntax.Error); ok {
				c.Error = string(se.Code)
				c.Expr = se.Expr
			} else {
				c.Error = err.Error()
			}
		} else {
			c.Dump = dump(re)
			c.Printed = re.String()
		}
		cases = append(cases, c)
	}
	return Packet{Schema: 1, Package: "regexsyntax", Cases: cases}
}

func generateSimplify() Packet {
	flags := syntax.MatchNL | syntax.Perl&^syntax.OneLine
	var cases []Case
	for i, tt := range simplifyTests() {
		re, err := syntax.Parse(tt.Regexp, flags)
		c := Case{ID: fmt.Sprintf("s%d", i), Pattern: tt.Regexp, Flags: uint16(flags)}
		if err != nil {
			if se, ok := err.(*syntax.Error); ok {
				c.Error = string(se.Code)
				c.Expr = se.Expr
			} else {
				c.Error = err.Error()
			}
		} else {
			simple := re.Simplify()
			c.Dump = dump(simple)
			c.Printed = simple.String()
			if c.Printed != tt.Simple {
				fail(fmt.Errorf("%s: Go Simplify(%q)=%q want %q", c.ID, tt.Regexp, c.Printed, tt.Simple))
			}
		}
		cases = append(cases, c)
	}
	return Packet{Schema: 1, Package: "regexsyntax-simplify", Cases: cases}
}

func compileTests() []struct{ Regexp, Prog string } {
	// Copied from Go 1.24.13 src/regexp/syntax/prog_test.go compileTests.
	return []struct{ Regexp, Prog string }{
		{"a", `  0	fail
  1*	rune1 "a" -> 2
  2	match
`},
		{"[A-M][n-z]", `  0	fail
  1*	rune "AM" -> 2
  2	rune "nz" -> 3
  3	match
`},
		{"", `  0	fail
  1*	nop -> 2
  2	match
`},
		{"a?", `  0	fail
  1	rune1 "a" -> 3
  2*	alt -> 1, 3
  3	match
`},
		{"a??", `  0	fail
  1	rune1 "a" -> 3
  2*	alt -> 3, 1
  3	match
`},
		{"a+", `  0	fail
  1*	rune1 "a" -> 2
  2	alt -> 1, 3
  3	match
`},
		{"a+?", `  0	fail
  1*	rune1 "a" -> 2
  2	alt -> 3, 1
  3	match
`},
		{"a*", `  0	fail
  1	rune1 "a" -> 2
  2*	alt -> 1, 3
  3	match
`},
		{"a*?", `  0	fail
  1	rune1 "a" -> 2
  2*	alt -> 3, 1
  3	match
`},
		{"a+b+", `  0	fail
  1*	rune1 "a" -> 2
  2	alt -> 1, 3
  3	rune1 "b" -> 4
  4	alt -> 3, 5
  5	match
`},
		{"(a+)(b+)", `  0	fail
  1*	cap 2 -> 2
  2	rune1 "a" -> 3
  3	alt -> 2, 4
  4	cap 3 -> 5
  5	cap 4 -> 6
  6	rune1 "b" -> 7
  7	alt -> 6, 8
  8	cap 5 -> 9
  9	match
`},
		{"a+|b+", `  0	fail
  1	rune1 "a" -> 2
  2	alt -> 1, 6
  3	rune1 "b" -> 4
  4	alt -> 3, 6
  5*	alt -> 1, 3
  6	match
`},
		{"A[Aa]", `  0	fail
  1*	rune1 "A" -> 2
  2	rune "A"/i -> 3
  3	match
`},
		{"(?:(?:^).)", `  0	fail
  1*	empty 4 -> 2
  2	anynotnl -> 3
  3	match
`},
		{"(?:|a)+", `  0	fail
  1	nop -> 4
  2	rune1 "a" -> 4
  3*	alt -> 1, 2
  4	alt -> 3, 5
  5	match
`},
		{"(?:|a)*", `  0	fail
  1	nop -> 4
  2	rune1 "a" -> 4
  3	alt -> 1, 2
  4	alt -> 3, 6
  5*	alt -> 3, 6
  6	match
`},
	}
}

func instJSON(p *syntax.Prog) []InstJSON {
	out := make([]InstJSON, len(p.Inst))
	for i, inst := range p.Inst {
		runes := make([]int32, len(inst.Rune))
		for j, r := range inst.Rune {
			runes[j] = int32(r)
		}
		out[i] = InstJSON{Op: uint8(inst.Op), Out: inst.Out, Arg: inst.Arg, Rune: runes}
	}
	return out
}

func generateCompile() Packet {
	flags := syntax.Perl
	var cases []Case
	for i, tt := range compileTests() {
		re, err := syntax.Parse(tt.Regexp, flags)
		c := Case{ID: fmt.Sprintf("p%d", i), Pattern: tt.Regexp, Flags: uint16(flags)}
		if err != nil {
			if se, ok := err.(*syntax.Error); ok {
				c.Error = string(se.Code)
				c.Expr = se.Expr
			} else {
				c.Error = err.Error()
			}
			cases = append(cases, c)
			continue
		}
		p, err := syntax.Compile(re)
		if err != nil {
			c.Error = err.Error()
			cases = append(cases, c)
			continue
		}
		c.Dump = p.String()
		if c.Dump != tt.Prog {
			fail(fmt.Errorf("%s: Go Compile(%q)=\n%q\nwant\n%q", c.ID, tt.Regexp, c.Dump, tt.Prog))
		}
		c.Start = p.Start
		c.NumCap = p.NumCap
		c.Inst = instJSON(p)
		cases = append(cases, c)
	}
	return Packet{Schema: 1, Package: "regexsyntax-compile", Cases: cases}
}

func verify(packet Packet) {
	if packet.Schema != 1 || (packet.Package != "regexsyntax" && packet.Package != "regexsyntax-simplify" && packet.Package != "regexsyntax-compile") {
		fail(fmt.Errorf("invalid packet"))
	}
	if len(packet.Cases) == 0 {
		fail(fmt.Errorf("empty cases"))
	}
	simplify := packet.Package == "regexsyntax-simplify"
	compilePkg := packet.Package == "regexsyntax-compile"
	for _, c := range packet.Cases {
		re, err := syntax.Parse(c.Pattern, syntax.Flags(c.Flags))
		if c.Error != "" {
			if err == nil {
				fail(fmt.Errorf("%s: expected error", c.ID))
			}
			continue
		}
		if err != nil {
			fail(fmt.Errorf("%s: %v", c.ID, err))
		}
		if compilePkg {
			p, err := syntax.Compile(re)
			if err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
			if p.String() != c.Dump {
				fail(fmt.Errorf("%s: dump mismatch want %s got %s", c.ID, c.Dump, p.String()))
			}
			if p.Start != c.Start {
				fail(fmt.Errorf("%s: start want %d got %d", c.ID, c.Start, p.Start))
			}
			if p.NumCap != c.NumCap {
				fail(fmt.Errorf("%s: numCap want %d got %d", c.ID, c.NumCap, p.NumCap))
			}
			got := instJSON(p)
			if len(got) != len(c.Inst) {
				fail(fmt.Errorf("%s: inst len want %d got %d", c.ID, len(c.Inst), len(got)))
			}
			for i := range got {
				if got[i].Op != c.Inst[i].Op || got[i].Out != c.Inst[i].Out || got[i].Arg != c.Inst[i].Arg {
					fail(fmt.Errorf("%s: inst[%d] mismatch", c.ID, i))
				}
				if len(got[i].Rune) != len(c.Inst[i].Rune) {
					fail(fmt.Errorf("%s: inst[%d] rune mismatch", c.ID, i))
				}
				for j := range got[i].Rune {
					if got[i].Rune[j] != c.Inst[i].Rune[j] {
						fail(fmt.Errorf("%s: inst[%d].rune[%d] mismatch", c.ID, i, j))
					}
				}
			}
			continue
		}
		if simplify {
			re = re.Simplify()
		}
		if dump(re) != c.Dump {
			fail(fmt.Errorf("%s: dump mismatch want %s got %s", c.ID, c.Dump, dump(re)))
		}
		if re.String() != c.Printed {
			fail(fmt.Errorf("%s: string mismatch want %s got %s", c.ID, c.Printed, re.String()))
		}
	}
	fmt.Printf("Go verified %d %s cases\n", len(packet.Cases), packet.Package)
}

func main() {
	pkg := flag.String("pkg", "regexsyntax", "package name")
	out := flag.String("out", "", "output JSON file")
	verifyFlag := flag.Bool("verify", false, "verify stdin packet")
	flag.Parse()
	if *pkg != "regexsyntax" && *pkg != "regexsyntax-simplify" && *pkg != "regexsyntax-compile" {
		fail(fmt.Errorf("unsupported package %q", *pkg))
	}
	if *verifyFlag {
		var packet Packet
		if err := json.NewDecoder(io.LimitReader(os.Stdin, 32<<20)).Decode(&packet); err != nil {
			fail(err)
		}
		verify(packet)
		return
	}
	enc := json.NewEncoder(os.Stdout)
	if *out != "" {
		f, err := os.Create(*out)
		if err != nil {
			fail(err)
		}
		defer f.Close()
		enc = json.NewEncoder(f)
	}
	packet := generate()
	if *pkg == "regexsyntax-simplify" {
		packet = generateSimplify()
	}
	if *pkg == "regexsyntax-compile" {
		packet = generateCompile()
	}
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}
