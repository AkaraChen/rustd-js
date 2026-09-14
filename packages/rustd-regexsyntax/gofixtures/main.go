package main

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"regexp/syntax"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

type InstJSON struct {
	Op   uint8   `json:"op"`
	Out  uint32  `json:"out"`
	Arg  uint32  `json:"arg"`
	Rune []int32 `json:"rune"`
}

type Case struct {
	ID          string     `json:"id"`
	Pattern     string     `json:"pattern"`
	PatternHex  string     `json:"patternHex,omitempty"`
	Flags       uint16     `json:"flags"`
	Dump        string     `json:"dump,omitempty"`
	Printed     string     `json:"printed,omitempty"`
	Start       int        `json:"start,omitempty"`
	NumCap      int        `json:"numCap,omitempty"`
	Inst        []InstJSON `json:"inst,omitempty"`
	Error       string     `json:"error,omitempty"`
	Expr        string     `json:"expr,omitempty"`
	ExprHex     string     `json:"exprHex,omitempty"`
	NativeParse bool       `json:"nativeParse,omitempty"`
}

type ErrorCodeRow struct {
	Name string `json:"name"`
	Code string `json:"code"`
	Used bool   `json:"used"`
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

type parseSeed struct {
	Pattern    string
	PatternHex string
	Flags      syntax.Flags
}

// remainderSeeds is issue #30 §4.1 remainder: POSIX/Perl dual-mode, named
// captures, extra \p, word boundaries, TestString, and 40+ illegal samples
// copied from Go 1.24.13 parse_test.go. Huge ErrLarge/ErrNestingDepth
// patterns stay in the errors package (checkpoint 7).
func remainderSeeds() []parseSeed {
	perl := syntax.Perl
	posix := syntax.POSIX
	testFlags := syntax.MatchNL | syntax.PerlX | syntax.UnicodeGroups
	var out []parseSeed
	add := func(p string, f syntax.Flags) {
		out = append(out, parseSeed{Pattern: p, Flags: f})
	}
	addHex := func(h string, f syntax.Flags) {
		out = append(out, parseSeed{PatternHex: h, Flags: f})
	}

	add(`(?i)[^[:lower:]]`, testFlags)
	add(`(?i)[[:^lower:]]`, testFlags)
	add("[a\n]", syntax.MatchNL)
	add("[a\n]", 0)

	for _, p := range []string{
		`x(?i:ab*c|d?e)1`,
		`x(?i:ab*cd?e)1`,
		`0(?i:ab*c|d?e)1`,
		`0(?i:ab*cd?e)1`,
		`x(?i:ab*c|d?e)`,
		`x(?i:ab*cd?e)`,
		`0(?i:ab*c|d?e)`,
		`0(?i:ab*cd?e)`,
		`(?i:ab*c|d?e)1`,
		`(?i:ab*cd?e)1`,
		`(?i:ab)[123](?i:cd)`,
		`(?i:ab*c|d?e)`,
		`[Aa][Bb]`,
		`[Aa][Bb]*[Cc]`,
		`A(?:[Bb][Cc]|[Dd])[Zz]`,
		`[Aa](?:[Bb][Cc]|[Dd])Z`,
	} {
		add(p, perl)
	}

	for _, p := range []string{
		`[[:alnum:]]`, `[[:alpha:]]`, `[[:ascii:]]`, `[[:blank:]]`, `[[:cntrl:]]`,
		`[[:digit:]]`, `[[:graph:]]`, `[[:print:]]`, `[[:punct:]]`, `[[:space:]]`,
		`[[:upper:]]`, `[[:xdigit:]]`, `[[:^digit:]]`, `[^[:digit:]]`,
	} {
		add(p, testFlags)
		add(p, posix)
	}

	for _, p := range []string{
		`\b`, `\B`, `a\b`, `\ba`, `a\bb`, `\bword\b`, `a\B`, `\Bfoo\B`, `^\b$`, `\A\b\z`,
	} {
		add(p, perl)
		add(p, posix)
	}

	for _, p := range []string{
		`\p{Greek}`, `\P{Greek}`, `\p{^Greek}`, `[\p{Greek}]`, `\p{Nd}`, `\p{Lm}`,
		`\p{Hiragana}`, `\p{Cyrillic}`, `\p{Katakana}`, `\pM`,
	} {
		add(p, testFlags)
	}

	for _, p := range []string{
		`a`, `ab`, `abc`, `a|b`, `(a)`, `a*`, `[a-z]`, `^`, `$`, `.`, `[[:lower:]]`,
		`[ace]`, `a{2}`, `a{2,3}`, `(ab)*`, `abc|def`, `[a]`, `-`, `{`, `}`, `a.b`,
		`(a|b)`, `ab|cd`, `a(b)c`, `[[:digit:]]`, `[^a]`, `[a-c]`, `a{2,}`, `abc`,
		`[α-ε☺]`, `a*{`,
	} {
		add(p, perl)
		add(p, posix)
	}

	for _, p := range []string{
		`(`, `)`, `(a`, `a)`, `(a))`, `(a|b|`, `a|b|)`, `(a|b|))`, `(a|b`, `a|b)`,
		`(a|b))`, `[a-z`, `([a-z)`, `[a-z)`, `([a-z]))`, `x{1001}`, `x{9876543210}`,
		`x{2,1}`, `x{1,9876543210}`, `(?P<name>a`, `(?P<name>`, `(?P<name`,
		`(?P<x y>a)`, `(?P<>a)`, `(?<name>a`, `(?<name>`, `(?<name`, `(?<x y>a)`,
		`(?<>a)`, `[a-Z]`, `(?i)[a-Z]`, `\Q\E*`, `a{100000}`, `a{100000,}`,
		`((((((((((x{2}){2}){2}){2}){2}){2}){2}){2}){2}){2})`,
		`\c`, `(?z)`, `a++`, `*`, `+`, `?`, `{2}`,
	} {
		add(p, perl)
		add(p, posix)
	}
	for _, h := range []string{"ff", "5bff5d", "5b5cff5d", "5cff"} {
		addHex(h, perl)
		addHex(h, posix)
	}

	for _, p := range []string{
		`[a-b-c]`, `\Qabc\E`, `\Q*+?{[\E`, `\Q\\E`, `\Q\\\E`, `\Q\\\\E`, `\Q\\\\\E`,
		`(?:a)`, `(?P<name>a)`,
	} {
		add(p, perl)
		add(p, posix)
	}
	for _, p := range []string{
		`a++`, `a**`, `a?*`, `a+*`, `a{1}*`, `.{1}{2}.{3}`,
	} {
		add(p, perl)
		add(p, posix)
	}

	add(`(?P<foo>ab)`, perl)
	add(`(?<bar>x+)`, perl)
	add(`(?P<foo>ab)`, posix)
	add(`(?P<name>a)(?P<name>b)`, perl)
	add(`a{1}{2}`, posix)
	add(`\d`, posix)
	add(`\w`, posix)
	add(`\s`, posix)
	add(`\p{Greek}`, posix)
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

func emitParseCase(id int, seed parseSeed) Case {
	c := Case{ID: fmt.Sprintf("c%d", id), Pattern: seed.Pattern, Flags: uint16(seed.Flags)}
	pat := seed.Pattern
	if seed.PatternHex != "" {
		raw, err := hex.DecodeString(seed.PatternHex)
		if err != nil {
			fail(fmt.Errorf("%s: patternHex: %w", c.ID, err))
		}
		pat = string(raw)
		c.PatternHex = seed.PatternHex
		c.Pattern = ""
	}
	re, err := syntax.Parse(pat, seed.Flags)
	if err != nil {
		if se, ok := err.(*syntax.Error); ok {
			c.Error = string(se.Code)
			if utf8Valid(se.Expr) {
				c.Expr = se.Expr
			} else {
				c.ExprHex = hex.EncodeToString([]byte(se.Expr))
			}
		} else {
			c.Error = err.Error()
		}
		return c
	}
	c.Dump = dump(re)
	c.Printed = re.String()
	return c
}

func generate() Packet {
	var cases []Case
	for i, tt := range tests() {
		cases = append(cases, emitParseCase(i, parseSeed{Pattern: tt.Regexp, Flags: tt.Flags}))
	}
	base := len(cases)
	for i, seed := range remainderSeeds() {
		cases = append(cases, emitParseCase(base+i, seed))
	}
	return Packet{Schema: 1, Package: "regexsyntax", Cases: cases}
}

func goErrorCodes() []ErrorCodeRow {
	return []ErrorCodeRow{
		{Name: "InternalError", Code: string(syntax.ErrInternalError), Used: false},
		{Name: "InvalidCharClass", Code: string(syntax.ErrInvalidCharClass), Used: false},
		{Name: "InvalidCharRange", Code: string(syntax.ErrInvalidCharRange), Used: true},
		{Name: "InvalidEscape", Code: string(syntax.ErrInvalidEscape), Used: true},
		{Name: "InvalidNamedCapture", Code: string(syntax.ErrInvalidNamedCapture), Used: true},
		{Name: "InvalidPerlOp", Code: string(syntax.ErrInvalidPerlOp), Used: true},
		{Name: "InvalidRepeatOp", Code: string(syntax.ErrInvalidRepeatOp), Used: true},
		{Name: "InvalidRepeatSize", Code: string(syntax.ErrInvalidRepeatSize), Used: true},
		{Name: "InvalidUTF8", Code: string(syntax.ErrInvalidUTF8), Used: true},
		{Name: "MissingBracket", Code: string(syntax.ErrMissingBracket), Used: true},
		{Name: "MissingParen", Code: string(syntax.ErrMissingParen), Used: true},
		{Name: "MissingRepeatArgument", Code: string(syntax.ErrMissingRepeatArgument), Used: true},
		{Name: "TrailingBackslash", Code: string(syntax.ErrTrailingBackslash), Used: true},
		{Name: "UnexpectedParen", Code: string(syntax.ErrUnexpectedParen), Used: true},
		{Name: "NestingDepth", Code: string(syntax.ErrNestingDepth), Used: true},
		{Name: "Large", Code: string(syntax.ErrLarge), Used: true},
	}
}

func utf8Valid(s string) bool {
	return utf8.ValidString(s)
}

func parsePattern(c Case) (string, error) {
	if c.PatternHex != "" {
		raw, err := hex.DecodeString(c.PatternHex)
		if err != nil {
			return "", fmt.Errorf("%s: patternHex: %w", c.ID, err)
		}
		return string(raw), nil
	}
	return c.Pattern, nil
}

func errorTests() []Case {
	perl := uint16(syntax.Perl)
	return []Case{
		{ID: "invalid-char-range", Pattern: `[a-Z]`, Flags: perl, NativeParse: true},
		{ID: "invalid-escape", Pattern: `\c`, Flags: perl, NativeParse: true},
		{ID: "invalid-named-capture", Pattern: `(?P<x y>a)`, Flags: perl, NativeParse: true},
		{ID: "invalid-perl-op", Pattern: `(?z)`, Flags: perl, NativeParse: true},
		{ID: "invalid-repeat-op", Pattern: `a++`, Flags: perl, NativeParse: true},
		{ID: "invalid-repeat-size", Pattern: `a{2,1}`, Flags: perl, NativeParse: true},
		{ID: "invalid-utf8", PatternHex: "ff", Flags: perl, NativeParse: false},
		{ID: "missing-bracket", Pattern: `[a-z`, Flags: perl, NativeParse: true},
		{ID: "missing-paren", Pattern: `(`, Flags: perl, NativeParse: true},
		{ID: "missing-repeat-argument", Pattern: `*`, Flags: perl, NativeParse: true},
		{ID: "trailing-backslash", Pattern: `\`, Flags: perl, NativeParse: true},
		{ID: "unexpected-paren", Pattern: `)`, Flags: perl, NativeParse: true},
		{ID: "posix-named-class-colon", Pattern: `[[:foo:]]`, Flags: perl, NativeParse: true},
		{ID: "nest-1000", Pattern: strings.Repeat("(", 1000) + strings.Repeat(")", 1000), Flags: perl, NativeParse: true},
		{ID: "large", Pattern: "(" + strings.Repeat("(xx?)", 1000) + "){1000}", Flags: perl, NativeParse: true},
	}
}

type ErrorPacket struct {
	Schema  int            `json:"schema"`
	Package string         `json:"package"`
	Codes   []ErrorCodeRow `json:"codes"`
	Cases   []Case         `json:"cases"`
}

func generateErrors() ErrorPacket {
	cases := errorTests()
	out := make([]Case, 0, len(cases))
	for _, c := range cases {
		pat, err := parsePattern(c)
		if err != nil {
			fail(err)
		}
		_, perr := syntax.Parse(pat, syntax.Flags(c.Flags))
		if perr == nil {
			fail(fmt.Errorf("%s: expected parse error", c.ID))
		}
		se, ok := perr.(*syntax.Error)
		if !ok {
			fail(fmt.Errorf("%s: %v", c.ID, perr))
		}
		c.Error = string(se.Code)
		if utf8Valid(se.Expr) {
			c.Expr = se.Expr
		} else {
			c.ExprHex = hex.EncodeToString([]byte(se.Expr))
		}
		if c.PatternHex != "" {
			c.Pattern = ""
		}
		out = append(out, c)
	}
	return ErrorPacket{Schema: 1, Package: "regexsyntax-errors", Codes: goErrorCodes(), Cases: out}
}

func verifyErrors(packet ErrorPacket) {
	if packet.Schema != 1 || packet.Package != "regexsyntax-errors" {
		fail(fmt.Errorf("invalid errors packet"))
	}
	want := goErrorCodes()
	if len(packet.Codes) != len(want) {
		fail(fmt.Errorf("codes len want %d got %d", len(want), len(packet.Codes)))
	}
	for i, row := range want {
		if packet.Codes[i].Name != row.Name || packet.Codes[i].Code != row.Code {
			fail(fmt.Errorf("codes[%d] want %s=%q got %s=%q", i, row.Name, row.Code, packet.Codes[i].Name, packet.Codes[i].Code))
		}
	}
	seen := map[string]bool{}
	for _, c := range packet.Cases {
		pat, err := parsePattern(c)
		if err != nil {
			fail(err)
		}
		_, perr := syntax.Parse(pat, syntax.Flags(c.Flags))
		if perr == nil {
			fail(fmt.Errorf("%s: expected error", c.ID))
		}
		se, ok := perr.(*syntax.Error)
		if !ok {
			fail(fmt.Errorf("%s: %v", c.ID, perr))
		}
		if string(se.Code) != c.Error {
			fail(fmt.Errorf("%s: code want %q got %q", c.ID, c.Error, se.Code))
		}
		gotExpr := se.Expr
		if c.ExprHex != "" {
			raw, err := hex.DecodeString(c.ExprHex)
			if err != nil {
				fail(fmt.Errorf("%s: exprHex: %w", c.ID, err))
			}
			if gotExpr != string(raw) {
				fail(fmt.Errorf("%s: expr hex want %s got %s", c.ID, c.ExprHex, hex.EncodeToString([]byte(gotExpr))))
			}
		} else if gotExpr != c.Expr {
			fail(fmt.Errorf("%s: expr want %q got %q", c.ID, c.Expr, se.Expr))
		}
		seen[c.Error] = true
	}
	for _, row := range want {
		if row.Used && !seen[row.Code] {
			fail(fmt.Errorf("missing trigger for %s (%q)", row.Name, row.Code))
		}
	}
	fmt.Printf("Go verified %d regexsyntax error codes + %d cases\n", len(packet.Codes), len(packet.Cases))
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

type EmptyOpCase struct {
	ID      string `json:"id"`
	R1      int32  `json:"r1"`
	R2      int32  `json:"r2"`
	Context uint8  `json:"context"`
	Word1   bool   `json:"word1"`
	Word2   bool   `json:"word2"`
}

type WordCase struct {
	ID   string `json:"id"`
	R    int32  `json:"r"`
	Word bool   `json:"word"`
}

type EmptyOpPacket struct {
	Schema  int           `json:"schema"`
	Package string        `json:"package"`
	Pairs   []EmptyOpCase `json:"pairs"`
	Word    []WordCase    `json:"word"`
}

func uniqueRunes(runes []int32) []int32 {
	seen := map[int32]bool{}
	out := make([]int32, 0, len(runes))
	for _, r := range runes {
		if seen[r] {
			continue
		}
		seen[r] = true
		out = append(out, r)
	}
	return out
}

func emptyOpPairRunes() []int32 {
	return uniqueRunes([]int32{
		-1, -2, 0, '\t', '\n', '\r', ' ', '/', '0', '9', ':', '@', 'A', 'Z', '[',
		'_', '`', 'a', 'z', '{', 0x7f, 0xe9, 0xff, 0x17f, 0x4e2d, 0x1f600, 0x10ffff,
	})
}

func emptyOpWordRunes() []int32 {
	runes := []int32{-1, -2, 0xe9, 0xff, 0x17f, 0x4e2d, 0x1f600, 0x10ffff}
	for r := int32(0); r < 128; r++ {
		runes = append(runes, r)
	}
	return uniqueRunes(runes)
}

func generateEmptyOp() EmptyOpPacket {
	wordRunes := emptyOpWordRunes()
	word := make([]WordCase, 0, len(wordRunes))
	for _, r := range wordRunes {
		word = append(word, WordCase{
			ID:   fmt.Sprintf("w_%d", r),
			R:    r,
			Word: syntax.IsWordChar(r),
		})
	}
	pairRunes := emptyOpPairRunes()
	pairs := make([]EmptyOpCase, 0, len(pairRunes)*len(pairRunes))
	for _, r1 := range pairRunes {
		for _, r2 := range pairRunes {
			pairs = append(pairs, EmptyOpCase{
				ID:      fmt.Sprintf("p_%d_%d", r1, r2),
				R1:      r1,
				R2:      r2,
				Context: uint8(syntax.EmptyOpContext(r1, r2)),
				Word1:   syntax.IsWordChar(r1),
				Word2:   syntax.IsWordChar(r2),
			})
		}
	}
	return EmptyOpPacket{Schema: 1, Package: "regexsyntax-emptyop", Pairs: pairs, Word: word}
}

func verifyEmptyOp(packet EmptyOpPacket) {
	if packet.Schema != 1 || packet.Package != "regexsyntax-emptyop" {
		fail(fmt.Errorf("invalid emptyop packet"))
	}
	if len(packet.Word) == 0 || len(packet.Pairs) == 0 {
		fail(fmt.Errorf("empty emptyop cases"))
	}
	for _, c := range packet.Word {
		got := syntax.IsWordChar(c.R)
		if got != c.Word {
			fail(fmt.Errorf("%s: IsWordChar(%d)=%v want %v", c.ID, c.R, got, c.Word))
		}
	}
	for _, c := range packet.Pairs {
		got := uint8(syntax.EmptyOpContext(c.R1, c.R2))
		if got != c.Context {
			fail(fmt.Errorf("%s: EmptyOpContext(%d,%d)=%d want %d", c.ID, c.R1, c.R2, got, c.Context))
		}
		if syntax.IsWordChar(c.R1) != c.Word1 || syntax.IsWordChar(c.R2) != c.Word2 {
			fail(fmt.Errorf("%s: word flags mismatch", c.ID))
		}
	}
	fmt.Printf("Go verified %d emptyop pairs + %d word cases\n", len(packet.Pairs), len(packet.Word))
}

type MatchCase struct {
	ID        string   `json:"id"`
	Pattern   string   `json:"pattern"`
	Flags     uint16   `json:"flags"`
	Printed   string   `json:"printed"`
	Haystacks []string `json:"haystacks"`
}

type MatchPacket struct {
	Schema  int         `json:"schema"`
	Package string      `json:"package"`
	Cases   []MatchCase `json:"cases"`
}

func verifyMatch(packet MatchPacket) {
	if packet.Schema != 1 || packet.Package != "regexsyntax-match" {
		fail(fmt.Errorf("invalid match packet"))
	}
	if len(packet.Cases) < 50 {
		fail(fmt.Errorf("match cases %d want >= 50", len(packet.Cases)))
	}
	comparisons := 0
	for _, c := range packet.Cases {
		if c.Printed == "" {
			fail(fmt.Errorf("%s: missing printed restring", c.ID))
		}
		if len(c.Haystacks) == 0 {
			fail(fmt.Errorf("%s: missing haystacks", c.ID))
		}
		orig, err := regexp.Compile(c.Pattern)
		if err != nil {
			fail(fmt.Errorf("%s: regexp.Compile(pattern=%q): %v", c.ID, c.Pattern, err))
		}
		got, err := regexp.Compile(c.Printed)
		if err != nil {
			fail(fmt.Errorf("%s: regexp.Compile(printed=%q) pattern=%q flags=%d: %v", c.ID, c.Printed, c.Pattern, c.Flags, err))
		}
		if !slices.Equal(orig.SubexpNames(), got.SubexpNames()) {
			fail(fmt.Errorf("%s: SubexpNames original=%q printed=%q (pattern=%q printed=%q flags=%d)",
				c.ID, orig.SubexpNames(), got.SubexpNames(), c.Pattern, c.Printed, c.Flags))
		}
		for i, h := range c.Haystacks {
			path := fmt.Sprintf("%s.haystacks[%d]", c.ID, i)
			om, gm := orig.MatchString(h), got.MatchString(h)
			if om != gm {
				fail(fmt.Errorf("%s: MatchString(%q) original=%v printed=%v (pattern=%q printed=%q flags=%d)",
					path, h, om, gm, c.Pattern, c.Printed, c.Flags))
			}
			of, gf := orig.FindString(h), got.FindString(h)
			if of != gf {
				fail(fmt.Errorf("%s: FindString(%q) original=%q printed=%q (pattern=%q printed=%q flags=%d)",
					path, h, of, gf, c.Pattern, c.Printed, c.Flags))
			}
			osub, gsub := orig.FindStringSubmatch(h), got.FindStringSubmatch(h)
			if !slices.Equal(osub, gsub) {
				fail(fmt.Errorf("%s: FindStringSubmatch(%q) original=%q printed=%q (pattern=%q printed=%q flags=%d)",
					path, h, osub, gsub, c.Pattern, c.Printed, c.Flags))
			}
			comparisons++
		}
	}
	fmt.Printf("Go verified %d regexsyntax-match cases (%d haystack comparisons)\n", len(packet.Cases), comparisons)
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
		pat, perr := parsePattern(c)
		if perr != nil {
			fail(perr)
		}
		re, err := syntax.Parse(pat, syntax.Flags(c.Flags))
		if c.Error != "" {
			if err == nil {
				fail(fmt.Errorf("%s: expected error", c.ID))
			}
			if se, ok := err.(*syntax.Error); ok && string(se.Code) != c.Error {
				fail(fmt.Errorf("%s: code want %q got %q", c.ID, c.Error, se.Code))
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
	if *pkg != "regexsyntax" && *pkg != "regexsyntax-simplify" && *pkg != "regexsyntax-compile" && *pkg != "regexsyntax-emptyop" && *pkg != "regexsyntax-errors" && *pkg != "regexsyntax-match" {
		fail(fmt.Errorf("unsupported package %q", *pkg))
	}
	if *pkg == "regexsyntax-match" && !*verifyFlag {
		fail(fmt.Errorf("regexsyntax-match requires -verify"))
	}
	if *verifyFlag {
		raw, err := io.ReadAll(io.LimitReader(os.Stdin, 32<<20))
		if err != nil {
			fail(err)
		}
		if *pkg == "regexsyntax-emptyop" {
			var packet EmptyOpPacket
			if err := json.Unmarshal(raw, &packet); err != nil {
				fail(err)
			}
			verifyEmptyOp(packet)
			return
		}
		if *pkg == "regexsyntax-errors" {
			var packet ErrorPacket
			if err := json.Unmarshal(raw, &packet); err != nil {
				fail(err)
			}
			verifyErrors(packet)
			return
		}
		if *pkg == "regexsyntax-match" {
			var packet MatchPacket
			if err := json.Unmarshal(raw, &packet); err != nil {
				fail(err)
			}
			verifyMatch(packet)
			return
		}
		var packet Packet
		if err := json.Unmarshal(raw, &packet); err != nil {
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
	if *pkg == "regexsyntax-emptyop" {
		if err := enc.Encode(generateEmptyOp()); err != nil {
			fail(err)
		}
		return
	}
	if *pkg == "regexsyntax-errors" {
		if err := enc.Encode(generateErrors()); err != nil {
			fail(err)
		}
		return
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
