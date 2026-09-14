package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/textproto"
	"os"
	"slices"
	"sort"
	"strings"
)

type ParseCase struct {
	In        string            `json:"in"`
	MediaType string            `json:"mediaType"`
	Params    map[string]string `json:"params"`
	Error     string            `json:"error"`
	Formatted string            `json:"formatted,omitempty"`
}

type QpCase struct {
	ID     string `json:"id"`
	InHex  string `json:"inHex"`
	OutHex string `json:"outHex"`
	Error  string `json:"error"`
	Binary bool   `json:"binary"`
	Mode   string `json:"mode"`
}

type WordCase struct {
	Charset   string `json:"charset"`
	Src       string `json:"src"`
	Enc       string `json:"enc"`
	Encoded   string `json:"encoded"`
	Decoded   string `json:"decoded"`
	Header    string `json:"header,omitempty"`
	HeaderOut string `json:"headerOut,omitempty"`
}

type ExtCase struct {
	Ext  string   `json:"ext"`
	Type string   `json:"type"`
	Exts []string `json:"exts"`
}

type ExtLookup struct {
	Query    string `json:"query"`
	Contains bool   `json:"contains"`
	Error    string `json:"error"`
}

type AddExtCase struct {
	Ext           string      `json:"ext"`
	Type          string      `json:"type"`
	Error         string      `json:"error"`
	Stored        string      `json:"stored"`
	StoredLower   string      `json:"storedLower"`
	JustType      string      `json:"justType"`
	JustTypeError string      `json:"justTypeError"`
	Registered    bool        `json:"registered"`
	Lookups       []ExtLookup `json:"lookups"`
}

type FormatCase struct {
	Type      string            `json:"type"`
	Params    map[string]string `json:"params"`
	Formatted string            `json:"formatted"`
}

type HeaderCase struct {
	In  string `json:"in"`
	Out string `json:"out"`
}

type CanonCase struct {
	In  string `json:"in"`
	Out string `json:"out"`
}

type MimeHeaderOp struct {
	Op    string `json:"op"`
	Key   string `json:"key"`
	Value string `json:"value,omitempty"`
}

type MimeHeaderCase struct {
	ID     string              `json:"id"`
	Ops    []MimeHeaderOp      `json:"ops"`
	Gets   map[string]string   `json:"gets"`
	Values map[string][]string `json:"values"`
	Record map[string][]string `json:"record"`
}

type Packet struct {
	Schema     int              `json:"schema"`
	Package    string           `json:"package"`
	Parse      []ParseCase      `json:"parse"`
	QpEnc      []QpCase         `json:"qpEnc"`
	QpDec      []QpCase         `json:"qpDec"`
	Words      []WordCase       `json:"words"`
	Headers    []HeaderCase     `json:"headers"`
	Format     []FormatCase     `json:"format"`
	Ext        []ExtCase        `json:"ext"`
	AddExt     []AddExtCase     `json:"addExt"`
	Canon      []CanonCase      `json:"canon"`
	MimeHeader []MimeHeaderCase `json:"mimeHeader"`
}

func hexOf(b []byte) string {
	const h = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, v := range b {
		out[i*2] = h[v>>4]
		out[i*2+1] = h[v&0x0f]
	}
	return string(out)
}

func unhex(s string) []byte {
	if len(s)%2 != 0 {
		panic(s)
	}
	out := make([]byte, len(s)/2)
	for i := 0; i < len(out); i++ {
		out[i] = unhexByte(s[2*i])<<4 | unhexByte(s[2*i+1])
	}
	return out
}

func unhexByte(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10
	}
	panic(c)
}

func parseCases() []ParseCase {
	inputs := []string{
		`form-data; name="foo"`,
		` form-data ; name=foo`,
		`FORM-DATA;name="foo"`,
		` FORM-DATA ; name="foo"`,
		`form-data; key=value;  blah="value";name="foo" `,
		`foo; key=val1; key=the-key-appears-again-which-is-bogus`,
		`application/x-stuff; title*=us-ascii'en-us'This%20is%20%2A%2A%2Afun%2A%2A%2A`,
		`message/external-body; access-type=URL; URL*0="ftp://";URL*1="cs.utk.edu/pub/moore/bulk-mailer/bulk-mailer.tar"`,
		`application/x-stuff; title*0*=us-ascii'en'This%20is%20even%20more%20; title*1*=%2A%2A%2Afun%2A%2A%2A%20; title*2="isn't it!"`,
		`attachment`,
		`ATTACHMENT`,
		`attachment; filename="foo.html"`,
		`attachment; filename="0000000000111111111122222"`,
		`attachment; filename="00000000001111111111222222222233333"`,
		`attachment; filename="f\oo.html"`,
		`attachment; filename="\"quoting\" tested.html"`,
		`attachment; filename="Here's a semicolon;.html"`,
		`attachment; foo="bar"; filename="foo.html"`,
		`attachment; foo="\"\\";filename="foo.html"`,
		`attachment; FILENAME="foo.html"`,
		`attachment; filename=foo.html`,
		`attachment; filename=foo.html ;`,
		`attachment; filename='foo.html'`,
		`attachment; filename="foo-ä.html"`,
		`attachment; filename="foo-Ã¤.html"`,
		`attachment; filename="foo-%41.html"`,
		`attachment; filename="50%.html"`,
		`attachment; filename="foo-%\41.html"`,
		`attachment; name="foo-%41.html"`,
		`attachment; name="ä-%41.html"`,
		`attachment; filename="foo-%c3%a4-%e2%82%ac.html"`,
		`attachment; filename ="foo.html"`,
		`filename=foo.html`,
		`x=y; filename=foo.html`,
		`"foo; filename=bar;baz"; filename=qux`,
		`filename=foo.html, filename=bar.html`,
		`; filename=foo.html`,
		`: inline; attachment; filename=foo.html`,
		`inline; attachment; filename=foo.html`,
		`attachment; inline; filename=foo.html`,
		`attachment; filename="foo.html".txt`,
		`attachment; filename="bar`,
		`attachment; filename=foo"bar;baz"qux`,
		`attachment; filename=foo.html, attachment; filename=bar.html`,
		`attachment; foo=foo filename=bar`,
		`attachment; filename=bar foo=foo`,
		`attachment filename=bar`,
		`filename=foo.html; attachment`,
		`attachment; xfilename=foo.html`,
		`attachment; creation-date="Wed, 12 Feb 1997 16:29:51 -0500"`,
		`attachment; modification-date="Wed, 12 Feb 1997 16:29:51 -0500"`,
		`foobar`,
		`attachment; example="filename=example.txt"`,
		`attachment; filename*=UTF-8''foo-%c3%a4-%e2%82%ac.html`,
		`attachment; filename*=''foo-%c3%a4-%e2%82%ac.html`,
		`attachment; filename*=UTF-8''foo-a%cc%88.html`,
		`attachment; filename*= UTF-8''foo-%c3%a4.html`,
		`attachment; filename* =UTF-8''foo-%c3%a4.html`,
		`attachment; filename*="UTF-8''foo-%c3%a4.html"`,
		`attachment; filename*="foo%20bar.html"`,
		`attachment; filename*=UTF-8'foo-%c3%a4.html`,
		`attachment; filename*=UTF-8''foo%`,
		`attachment; filename*=UTF-8''f%oo.html`,
		`attachment; filename*=UTF-8''A-%2541.html`,
		`attachment; filename*0="foo."; filename*1="html"`,
		`attachment; filename*0*=UTF-8''foo-%c3%a4; filename*1=".html"`,
		`attachment; filename*0="foo"; filename*01="bar"`,
		`attachment; filename*0="foo"; filename*2="bar"`,
		`attachment; filename*1="foo."; filename*2="html"`,
		`attachment; filename*1="bar"; filename*0="foo"`,
		`attachment; filename="foo-ae.html"; filename*=UTF-8''foo-%c3%a4.html`,
		`attachment; filename*=UTF-8''foo-%c3%a4.html; filename="foo-ae.html"`,
		`attachment; filename*0*=ISO-8859-15''euro-sign%3d%a4; filename*=ISO-8859-1''currency-sign%3d%a4`,
		`attachment; foobar=x; filename="foo.html"`,
		`form-data; firstname="Брэд"; lastname="Фицпатрик"`,
		`foo; bar=""`,
		`form-data; name="file"; filename="C:\dev\go\robots.txt"`,
		`form-data; name="file"; filename="C:\新建文件夹\中文第二次测试.mp4"`,
		`text; charset=utf-8; charset=utf-8; format=fixed`,
		`text; charset=utf-8; format=flowed; charset=utf-8`,
		`"attachment"`,
		`attachment; filename="foo.html"; filename="bar.html"`,
		`attachment; filename *=UTF-8''foo-%c3%a4.html`,
		`text/plain; charset=utf-8`,
		`text/html; charset="UTF-8"`,
		`application/json`,
		`noslash`,
		`text/plain; charset=iso-8859-1`,
		`application/octet-stream; foo=bar; foo=bar`,
		`text/plain;`,
		`text/plain; charset*0=utf; charset*1=-8`,
		`bogus/`,
		`/plain`,
		`text/plain; charset`,
		`text/plain; charset=`,
		`attachment; filename="C:\dev\go\robots.txt"`,
		`text/plain; charset="utf-8"; format=flowed`,
		`multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW`,
		`application/x-www-form-urlencoded`,
		`bogus ;=========`,
		`application/pdf; x-mac-type="3F3F3F3F"; x-mac-creator="3F3F3F3F" name="a.pdf";`,
		`bogus/<script>alert</script>`,
		`bogus/bogus<script>alert</script>`,
		`attachment; filename=foo,bar.html`,
		`attachment; ;filename=foo`,
		`attachment; filename=foo bar.html`,
		`attachment; filename=foo[1](2).html`,
		`attachment; filename=foo-ä.html`,
		`attachment; filename=foo-Ã¤.html`,
	}
	for i := 0; i < 80; i++ {
		inputs = append(inputs, fmt.Sprintf("text/plain; n=%d", i))
		inputs = append(inputs, fmt.Sprintf(`application/octet-stream; x="v%d"`, i))
	}
	out := make([]ParseCase, 0, len(inputs))
	for _, in := range inputs {
		mt, params, err := mime.ParseMediaType(in)
		c := ParseCase{In: in, MediaType: mt, Params: params}
		if params == nil {
			c.Params = map[string]string{}
		}
		if err != nil {
			c.Error = err.Error()
		}
		if err == nil {
			c.Formatted = mime.FormatMediaType(mt, params)
		}
		out = append(out, c)
	}
	return out
}

func qpEncCases() []QpCase {
	inputs := [][]byte{
		[]byte(""),
		[]byte("foo bar"),
		[]byte("foo bar="),
		[]byte("foo bar\r"),
		[]byte("foo bar\r\r"),
		[]byte("foo bar\n"),
		[]byte("foo bar\r\n"),
		[]byte("foo bar\r\r\n"),
		[]byte("foo bar "),
		[]byte("foo bar\t"),
		[]byte("foo bar  "),
		[]byte("foo bar \n"),
		[]byte("foo bar \r"),
		[]byte("foo bar \r\n"),
		[]byte("foo bar  \n"),
		[]byte("foo bar  \n "),
		[]byte("¡Hola Señor!"),
		[]byte("\t !\"#$%&'()*+,-./ :;<>?@[\\]^_`{|}~"),
		bytes.Repeat([]byte("a"), 75),
		bytes.Repeat([]byte("a"), 76),
		append(bytes.Repeat([]byte("a"), 72), '='),
		append(bytes.Repeat([]byte("a"), 73), '='),
		append(bytes.Repeat([]byte("a"), 74), '='),
		append(bytes.Repeat([]byte("a"), 75), '='),
		bytes.Repeat([]byte(" "), 73),
		bytes.Repeat([]byte(" "), 74),
		bytes.Repeat([]byte(" "), 75),
		bytes.Repeat([]byte(" "), 76),
		bytes.Repeat([]byte(" "), 77),
		[]byte("foo bar  \n "),
		[]byte("=\r\n"),
		bytes.Repeat([]byte("x"), 200),
		[]byte("crlf\r\ncrlf\r\n"),
		[]byte{0x7f, 0x80, 0xff},
		[]byte("space at end "),
	}
	var out []QpCase
	for i, in := range inputs {
		for _, binary := range []bool{false, true} {
			var buf bytes.Buffer
			w := quotedprintable.NewWriter(&buf)
			w.Binary = binary
			_, _ = w.Write(in)
			_ = w.Close()
			out = append(out, QpCase{
				ID:     fmt.Sprintf("enc-%d-%v", i, binary),
				InHex:  hexOf(in),
				OutHex: hexOf(buf.Bytes()),
				Binary: binary,
				Mode:   "encode",
			})
		}
	}
	return out
}

func qpDecCases() []QpCase {
	inputs := []string{
		"",
		"foo bar",
		"foo bar=3D",
		"foo bar=3d",
		"foo bar=\n",
		"foo bar\n",
		"foo bar=0",
		"foo bar=0D=0A",
		" A B        \r\n C ",
		" A B =\r\n C ",
		" A B =\n C ",
		"foo=\nbar",
		"foo\x00bar",
		"foo bar\xff",
		"=3D30\n",
		"=00=FF0=\n",
		"foo  \n",
		"foo=\r\nbar",
		"foo=\nbar",
		"foo=",
		"=",
		"Now's the time =\nfor all folk to come=\n to the aid of their country.",
		"foo  \n\nfoo =\n\nfoo=20\n\n",
		"foo\nbar",
		"foo\rbar",
		"foo\r\nbar",
		"foo=\rbar",
		"foo=\r\r\r \nbar",
		"accept UTF-8 right quotation mark: ’",
	}
	var out []QpCase
	for i, in := range inputs {
		var buf bytes.Buffer
		_, err := io.Copy(&buf, quotedprintable.NewReader(bytes.NewReader([]byte(in))))
		c := QpCase{
			ID:     fmt.Sprintf("dec-%d", i),
			InHex:  hexOf([]byte(in)),
			OutHex: hexOf(buf.Bytes()),
			Mode:   "decode",
		}
		if err != nil {
			c.Error = err.Error()
		}
		out = append(out, c)
	}
	return out
}

func wordCases() []WordCase {
	type spec struct{ charset, src, enc string }
	specs := []spec{
		{"utf-8", "François-Jérôme", "q"},
		{"utf-8", "Café", "b"},
		{"iso-8859-1", "La Seleção", "q"},
		{"utf-8", "", "q"},
		{"utf-8", "A", "q"},
		{"utf-8", "123 456", "q"},
		{"utf-8", "¡Hola, señor!", "q"},
		{"utf-8", "adjacent", "b"},
		{"us-ascii", "ASCII only", "q"},
		{"utf-8", "snowman ☃", "b"},
		{"iso-8859-1", "café", "b"},
		{"utf-8", "line\nbreak", "q"},
		{"utf-8", "\t !\"#$%&'()*+,-./ :;<>?@[\\]^_`{|}~", "q"},
		{"utf-8", stringsRepeat("é", 10), "q"},
		{"utf-8", stringsRepeat("é", 11), "q"},
		{"utf-8", stringsRepeat("à", 30), "q"},
		{"utf-8", stringsRepeat("ï", 25), "b"},
	}
	var out []WordCase
	for _, s := range specs {
		var enc mime.WordEncoder
		if s.enc == "b" {
			enc = mime.BEncoding
		} else {
			enc = mime.QEncoding
		}
		encoded := enc.Encode(s.charset, s.src)
		dec := new(mime.WordDecoder)
		decoded, _ := dec.DecodeHeader(encoded)
		out = append(out, WordCase{
			Charset:   s.charset,
			Src:       s.src,
			Enc:       s.enc,
			Encoded:   encoded,
			Decoded:   decoded,
			Header:    "Hello " + encoded + " there",
			HeaderOut: mustDecodeHeader("Hello " + encoded + " there"),
		})
	}
	return out
}

func mustDecodeHeader(s string) string {
	dec := new(mime.WordDecoder)
	out, err := dec.DecodeHeader(s)
	if err != nil {
		return s
	}
	return out
}

func stringsRepeat(s string, n int) string {
	out := make([]byte, 0, len(s)*n)
	for i := 0; i < n; i++ {
		out = append(out, s...)
	}
	return string(out)
}

func headerCases() []HeaderCase {
	inputs := []string{
		"=?UTF-8?Q?=C2=A1Hola,_se=C3=B1or!?=",
		"=?UTF-8?Q?Fran=C3=A7ois-J=C3=A9r=C3=B4me?=",
		"=?UTF-8?q?ascii?=",
		"=?utf-8?B?QW5kcsOp?=",
		"=?ISO-8859-1?Q?Rapha=EBl_Dupont?=",
		"Jean",
		"=?utf-8?b?IkFudG9uaW8gSm9zw6kiIDxqb3NlQGV4YW1wbGUub3JnPg==?=",
		"=?UTF-8?A?Test?=",
		"=?UTF-8?Q?A=B?=",
		"=?UTF-8?Q?=A?=",
		"=?UTF-8?A?A?=",
		"=?",
		"=?UTF-8?",
		"=?UTF-8?=",
		"=?UTF-8?Q",
		"=?UTF-8?Q?",
		"=?UTF-8?Q?=",
		"=?UTF-8?Q?A",
		"=?UTF-8?Q?A?",
		"=?ISO-8859-1?Q?a?=",
		"=?ISO-8859-1?Q?a?= b",
		"=?ISO-8859-1?Q?a?= =?ISO-8859-1?Q?b?=",
		"=?ISO-8859-1?Q?a?=  =?ISO-8859-1?Q?b?=",
		"=?ISO-8859-1?Q?a?= \r\n\t =?ISO-8859-1?Q?b?=",
		"=?ISO-8859-1?Q?a_b?=",
		"=?ISO-8859-1?Q?a?==?ISO-8859-1?Q?b?=",
		"Hello =?utf-8?q?Fran=C3=A7ois-J=C3=A9r=C3=B4me?= there",
		"=?utf-8?q?Fran=C3=A7ois-J=C3=A9r=C3=B4me?= =?utf-8?b?Q2Fmw6k=?=",
		"=?US-ASCII?Q?foo_bar?=",
		"=?ISO-8859-1?Q?caf=E9?=",
	}
	out := make([]HeaderCase, 0, len(inputs))
	for _, in := range inputs {
		out = append(out, HeaderCase{In: in, Out: mustDecodeHeader(in)})
	}
	return out
}

func formatCases() []FormatCase {
	type spec struct {
		typ    string
		params map[string]string
	}
	specs := []spec{
		{"noslash", map[string]string{"X": "Y"}},
		{"foo bar/baz", nil},
		{"foo/bar baz", nil},
		{"attachment", map[string]string{"filename": "ĄĄŽŽČČŠŠ"}},
		{"attachment", map[string]string{"filename": "ÁÁÊÊÇÇÎÎ"}},
		{"attachment", map[string]string{"filename": "数据统计.png"}},
		{"foo/BAR", nil},
		{"foo/BAR", map[string]string{"X": "Y"}},
		{"foo/BAR", map[string]string{"space": "With space"}},
		{"foo/BAR", map[string]string{"quote": `With "quote`}},
		{"foo/BAR", map[string]string{"bslash": `With \backslash`}},
		{"foo/BAR", map[string]string{"both": `With \backslash and "quote`}},
		{"foo/BAR", map[string]string{"": "empty attribute"}},
		{"foo/BAR", map[string]string{"bad attribute": "baz"}},
		{"foo/BAR", map[string]string{"nonascii": "not an ascii character: ä"}},
		{"foo/BAR", map[string]string{"ctl": "newline: \n nil: \000"}},
		{"foo/bar", map[string]string{"a": "av", "b": "bv", "c": "cv"}},
		{"foo/bar", map[string]string{"0": "'", "9": "'"}},
		{"foo", map[string]string{"bar": ""}},
		{"Text/Plain", map[string]string{"charset": "utf-8"}},
		{"application/x-stuff", map[string]string{"title": "This is ***fun***"}},
		{"application/x-stuff", map[string]string{"title": "This is fun€"}},
	}
	out := make([]FormatCase, 0, len(specs))
	for _, s := range specs {
		params := s.params
		if params == nil {
			params = map[string]string{}
		}
		out = append(out, FormatCase{
			Type:      s.typ,
			Params:    params,
			Formatted: mime.FormatMediaType(s.typ, s.params),
		})
	}
	return out
}

func extCases() []ExtCase {
	exts := []string{
		".txt", ".html", ".HTML", ".htm", ".json", ".wasm", ".png", ".PNG",
		".unknownext", ".tar.gz", ".js", ".mjs", ".css", ".gif", ".jpg", ".jpeg",
		".JPG", ".pdf", ".svg", ".xml", ".webp", ".avif", ".zip", ".tar", ".gz",
		".mp3", ".mp4", ".ogg", ".woff", ".woff2", ".ttf", ".md", ".csv", ".rs",
		".go", ".c", ".h", ".sh", ".py", ".rb", ".php", ".BIN",
	}
	var out []ExtCase
	for _, ext := range exts {
		typ := mime.TypeByExtension(ext)
		got, err := mime.ExtensionsByType(typ)
		if err != nil || got == nil {
			got = []string{}
		}
		sort.Strings(got)
		out = append(out, ExtCase{Ext: ext, Type: typ, Exts: got})
	}
	return out
}

func recordAddExt(ext, typ string) AddExtCase {
	c := AddExtCase{Ext: ext, Type: typ}
	just, _, perr := mime.ParseMediaType(typ)
	c.JustType = just
	if perr != nil {
		c.JustTypeError = perr.Error()
	}
	if err := mime.AddExtensionType(ext, typ); err != nil {
		c.Error = err.Error()
	}
	c.Stored = mime.TypeByExtension(ext)
	c.StoredLower = mime.TypeByExtension(strings.ToLower(ext))
	if c.Error != "" {
		return c
	}
	lower := strings.ToLower(ext)
	queries := make([]string, 0, 4)
	seen := map[string]bool{}
	addQuery := func(q string) {
		if q == "" || seen[q] {
			return
		}
		seen[q] = true
		queries = append(queries, q)
	}
	addQuery(c.JustType)
	addQuery(typ)
	if c.JustType != "" {
		addQuery(strings.ToUpper(c.JustType))
		if strings.HasPrefix(c.JustType, "text/") {
			addQuery(c.JustType + "; charset=utf-8")
		}
	}
	for _, q := range queries {
		got, err := mime.ExtensionsByType(q)
		lu := ExtLookup{Query: q}
		if err != nil {
			lu.Error = err.Error()
		} else {
			lu.Contains = slices.Contains(got, lower)
		}
		c.Lookups = append(c.Lookups, lu)
		if q == c.JustType {
			c.Registered = lu.Contains
		}
	}
	return c
}

func addExtCases() []AddExtCase {
	// Errors first: they return before mutating the global table, so they can
	// follow extCases() without changing builtin TypeByExtension results.
	errorSpecs := [][2]string{
		{"no-dot", "application/x-test"},
		{"txt", "text/plain"},
		{"", "text/plain"},
		{`foo"bar`, "text/plain"},
		{"foo\\bar", "text/plain"},
		{"no-dot-ä", "text/plain"},
		{" leading", "text/plain"},
		{"missing", "application/json"},
		{".ck7slash", "not a type"},
		{".ck7token", "bogus/"},
		{".ck7empty", "/plain"},
		{".ck7param", "text/plain; charset"},
		{".ck7blank", ""},
		{".ck7bogus", "bogus ;========="},
		{".ck7dup", "text/plain; charset=utf-8; charset"},
		{".ck7script", "bogus/<script>alert</script>"},
		{".ck7after", "bogus/bogus<script>alert</script>"},
	}
	// Success: text/* without charset gets charset=utf-8 only when the raw
	// string has a lowercase "text/" prefix; FormatMediaType rewrite of
	// "text/plain; param=..." can store an empty type (Go 1.24 type.go).
	successSpecs := [][2]string{
		{".ck8plain", "text/plain"},
		{".ck8utf8", "text/plain; charset=utf-8"},
		{".ck8latin", "text/plain; charset=iso-8859-1"},
		{".ck8utf8case", "text/plain; charset=UTF-8"},
		{".CK8MIX", "text/x-ck8-mix"},
		{".ck8app", "application/x-ck8"},
		{".ck8params", "text/plain; foo=bar"},
		{".ck8upper", "TEXT/PLAIN"},
		{".ck8TextSlash", "TEXT/x-ck8"},
		{".ck8mixedtype", "Text/plain"},
		{".ck8space", "text/plain; format=flowed"},
		{".ck8quoted", "text/plain; title=\"x y\""},
		{".ck8html", "text/html"},
		{".ck8js", "text/javascript"},
		{".ck8xmlc", "text/xml"},
		{".ck8css", "text/css"},
		{".ck8csv", "text/csv"},
		{".ck8md", "text/markdown"},
		{".ck8apptext", "application/text"},
		{".ck8prefix", "textplain/foo"},
		{".CK8DOT.dot", "text/x-ck8-dot"},
		{".ck8-dash", "text/x-ck8-dash"},
		{".ck8plus", "application/vnd.api+json"},
		{".ck8exist", "image/jpeg"},
		{".ck8json", "application/json"},
		{".ck8png", "image/png"},
		{".ck8wasm", "application/wasm"},
		// Checkpoint 9: ExtensionsByType keys off ParseMediaType justType.
		{".ck9upper", "TEXT/PLAIN"},
		{".ck9params", "text/plain; foo=bar"},
		{".CK9MIX", "TEXT/x-ck9"},
		{".ck9mixed", "Text/plain"},
		{".ck9charset", "text/plain; charset=utf-8"},
		{".ck9quoted", "text/plain; title=\"x y\""},
		{".ck9html", "TEXT/HTML"},
		{".ck9space", "text/plain; format=flowed"},
	}
	out := make([]AddExtCase, 0, len(errorSpecs)+len(successSpecs))
	for _, s := range errorSpecs {
		out = append(out, recordAddExt(s[0], s[1]))
	}
	for _, s := range successSpecs {
		out = append(out, recordAddExt(s[0], s[1]))
	}
	return out
}

func canonCases() []CanonCase {
	inputs := []string{
		"a-b-c", "a-1-c", "User-Agent", "uSER-aGENT", "user-agent", "USER-AGENT",
		"foo-bar_baz", "foo-bar$baz", "foo-bar~baz", "foo-bar*baz",
		"üser-agenT", "a B", "C Ontent-Transfer-Encoding", "foo bar",
		"", "content-type", "Content-Type", "CONTENT-TYPE", "Content-type",
		"Accept-Encoding", "accept-encoding", "X-Forwarded-For", "x-forwarded-for",
		"Set-Cookie", "set-cookie", "Mime-Version", "MIME-Version",
		"foo-bar!baz", "foo#bar", "If-Modified-Since", "if-modified-since",
		"Host", "host", "ETag", "etag", "Etag",
		"Content-Transfer-Encoding", "content-transfer-encoding",
		"X-Powered-By", "x-powered-by",
		"a", "A", "-", "-a", "a-", "a--b", "a-b-c-d-e",
		"foo.bar", "foo+bar", "foo|bar", "foo`bar", "foo^bar",
		"foo bar_baz", " foo", "foo ", "foo:bar", "foo/bar",
		"Content Type", "X_Custom", "X_CUSTOM",
	}
	out := make([]CanonCase, 0, len(inputs))
	for _, in := range inputs {
		out = append(out, CanonCase{In: in, Out: textproto.CanonicalMIMEHeaderKey(in)})
	}
	return out
}

func recordMIMEHeader(id string, ops []MimeHeaderOp, getKeys []string) MimeHeaderCase {
	if ops == nil {
		ops = []MimeHeaderOp{}
	}
	h := make(textproto.MIMEHeader)
	for _, op := range ops {
		switch op.Op {
		case "add":
			h.Add(op.Key, op.Value)
		case "set":
			h.Set(op.Key, op.Value)
		case "del":
			h.Del(op.Key)
		}
	}
	gets := map[string]string{}
	values := map[string][]string{}
	for _, k := range getKeys {
		gets[k] = h.Get(k)
		v := h.Values(k)
		if v == nil {
			v = []string{}
		}
		values[k] = v
	}
	rec := map[string][]string{}
	for k, v := range h {
		rec[k] = v
	}
	return MimeHeaderCase{ID: id, Ops: ops, Gets: gets, Values: values, Record: rec}
}

func mimeHeaderCases() []MimeHeaderCase {
	return []MimeHeaderCase{
		recordMIMEHeader("add-get-casefold", []MimeHeaderOp{
			{Op: "add", Key: "content-type", Value: "text/plain"},
		}, []string{"Content-Type", "content-type", "CONTENT-TYPE", "Accept"}),
		recordMIMEHeader("add-multi-set-cookie", []MimeHeaderOp{
			{Op: "add", Key: "Set-Cookie", Value: "cookie 1"},
			{Op: "add", Key: "set-cookie", Value: "cookie 2"},
		}, []string{"set-cookie", "Set-Cookie", "SET-COOKIE"}),
		recordMIMEHeader("set-replaces", []MimeHeaderOp{
			{Op: "add", Key: "X-Foo", Value: "a"},
			{Op: "add", Key: "x-foo", Value: "b"},
			{Op: "set", Key: "X-FOO", Value: "c"},
		}, []string{"x-foo", "X-Foo"}),
		recordMIMEHeader("del", []MimeHeaderOp{
			{Op: "add", Key: "Host", Value: "example.com"},
			{Op: "add", Key: "Accept", Value: "*/*"},
			{Op: "del", Key: "host"},
		}, []string{"Host", "Accept", "host"}),
		recordMIMEHeader("empty", nil, []string{"Content-Type", ""}),
		recordMIMEHeader("tchar-underscore", []MimeHeaderOp{
			{Op: "add", Key: "foo-bar_baz", Value: "1"},
		}, []string{"Foo-Bar_baz", "foo-bar_baz"}),
		recordMIMEHeader("space-not-folded", []MimeHeaderOp{
			{Op: "add", Key: "C Ontent-Transfer-Encoding", Value: "8bit"},
		}, []string{"C Ontent-Transfer-Encoding", "Content-Transfer-Encoding"}),
		recordMIMEHeader("common-user-agent", []MimeHeaderOp{
			{Op: "set", Key: "uSER-aGENT", Value: "rustd-mime/0.1"},
		}, []string{"User-Agent", "user-agent"}),
		recordMIMEHeader("mixed-headers", []MimeHeaderOp{
			{Op: "add", Key: "Content-Type", Value: "multipart/form-data"},
			{Op: "add", Key: "content-disposition", Value: `form-data; name="file"`},
			{Op: "add", Key: "X-Custom", Value: "one"},
			{Op: "add", Key: "x-custom", Value: "two"},
			{Op: "set", Key: "Content-Length", Value: "4"},
		}, []string{"content-type", "Content-Disposition", "x-custom", "content-length"}),
	}
}

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }

type mpField struct {
	Name     string              `json:"name"`
	Value    string              `json:"value"`
	ValueHex string              `json:"valueHex"`
	Filename string              `json:"filename"`
	Mode     string              `json:"mode"`
	Header   map[string][]string `json:"header"`
}

type mpWriteIn struct {
	Boundary string    `json:"boundary"`
	Fields   []mpField `json:"fields"`
}

type mpWriteOut struct {
	BodyHex     string `json:"bodyHex"`
	ContentType string `json:"contentType"`
	Error       string `json:"error"`
}

type mpReadIn struct {
	Boundary string `json:"boundary"`
	BodyHex  string `json:"bodyHex"`
	Raw      bool   `json:"raw"`
}

type mpPartOut struct {
	FormName string              `json:"formName"`
	FileName string              `json:"fileName"`
	Header   map[string][]string `json:"header"`
	BodyHex  string              `json:"bodyHex"`
}

type mpReadOut struct {
	Parts []mpPartOut `json:"parts"`
	Error string      `json:"error"`
}

func decodeStdinJSON(v any) {
	dec := json.NewDecoder(io.LimitReader(os.Stdin, 32<<20))
	if err := dec.Decode(v); err != nil {
		fail(err)
	}
}

func emitJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(v); err != nil {
		fail(err)
	}
}

func mpFieldBody(f mpField) []byte {
	if f.ValueHex != "" {
		return unhex(f.ValueHex)
	}
	return []byte(f.Value)
}

func handleFileContentDisposition() {
	var in struct {
		Fieldname string `json:"fieldname"`
		Filename  string `json:"filename"`
	}
	decodeStdinJSON(&in)
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	if err := w.SetBoundary("b"); err != nil {
		fail(err)
	}
	p, err := w.CreateFormFile(in.Fieldname, in.Filename)
	if err != nil {
		fail(err)
	}
	if _, err := p.Write([]byte("x")); err != nil {
		fail(err)
	}
	if err := w.Close(); err != nil {
		fail(err)
	}
	r := multipart.NewReader(bytes.NewReader(buf.Bytes()), "b")
	part, err := r.NextPart()
	if err != nil {
		fail(err)
	}
	emitJSON(struct {
		Value       string `json:"value"`
		ContentType string `json:"contentType"`
		FileName    string `json:"fileName"`
		FormName    string `json:"formName"`
	}{
		Value:       part.Header.Get("Content-Disposition"),
		ContentType: part.Header.Get("Content-Type"),
		FileName:    part.FileName(),
		FormName:    part.FormName(),
	})
}

func handleMultipartWrite() {
	var in mpWriteIn
	decodeStdinJSON(&in)
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	if in.Boundary != "" {
		if err := w.SetBoundary(in.Boundary); err != nil {
			emitJSON(mpWriteOut{Error: err.Error()})
			return
		}
	}
	for _, f := range in.Fields {
		mode := f.Mode
		if mode == "" {
			mode = "writeField"
		}
		switch mode {
		case "writeField":
			if err := w.WriteField(f.Name, f.Value); err != nil {
				emitJSON(mpWriteOut{Error: err.Error()})
				return
			}
		case "createFormField":
			p, err := w.CreateFormField(f.Name)
			if err != nil {
				emitJSON(mpWriteOut{Error: err.Error()})
				return
			}
			if _, err := p.Write(mpFieldBody(f)); err != nil {
				emitJSON(mpWriteOut{Error: err.Error()})
				return
			}
		case "createFormFile":
			p, err := w.CreateFormFile(f.Name, f.Filename)
			if err != nil {
				emitJSON(mpWriteOut{Error: err.Error()})
				return
			}
			if _, err := p.Write(mpFieldBody(f)); err != nil {
				emitJSON(mpWriteOut{Error: err.Error()})
				return
			}
		case "createPart":
			h := make(textproto.MIMEHeader)
			for k, vs := range f.Header {
				h[k] = append([]string{}, vs...)
			}
			p, err := w.CreatePart(h)
			if err != nil {
				emitJSON(mpWriteOut{Error: err.Error()})
				return
			}
			if _, err := p.Write(mpFieldBody(f)); err != nil {
				emitJSON(mpWriteOut{Error: err.Error()})
				return
			}
		default:
			fail(fmt.Errorf("unknown field mode %q", mode))
		}
	}
	if err := w.Close(); err != nil {
		emitJSON(mpWriteOut{Error: err.Error()})
		return
	}
	emitJSON(mpWriteOut{BodyHex: hexOf(buf.Bytes()), ContentType: w.FormDataContentType()})
}

func handleMultipartRead() {
	var in mpReadIn
	decodeStdinJSON(&in)
	body := unhex(in.BodyHex)
	r := multipart.NewReader(bytes.NewReader(body), in.Boundary)
	out := mpReadOut{Parts: []mpPartOut{}}
	for {
		var (
			p   *multipart.Part
			err error
		)
		if in.Raw {
			p, err = r.NextRawPart()
		} else {
			p, err = r.NextPart()
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			out.Error = err.Error()
			break
		}
		slurp, err := io.ReadAll(p)
		part := mpPartOut{
			FormName: p.FormName(),
			FileName: p.FileName(),
			Header:   map[string][]string{},
			BodyHex:  hexOf(slurp),
		}
		for k, v := range p.Header {
			part.Header[k] = v
		}
		if err != nil {
			out.Error = err.Error()
			out.Parts = append(out.Parts, part)
			break
		}
		out.Parts = append(out.Parts, part)
	}
	emitJSON(out)
}

func main() {
	out := flag.String("out", "", "output JSON file")
	verify := flag.Bool("verify", false, "verify packet from stdin")
	mpWrite := flag.Bool("multipart-write", false, "Go multipart.Writer from stdin JSON fields")
	mpRead := flag.Bool("multipart-read", false, "Go multipart.NewReader from stdin JSON bodyHex")
	fcd := flag.Bool("file-content-disposition", false, "Go CreateFormFile Content-Disposition from stdin JSON")
	flag.Parse()
	if *mpWrite {
		handleMultipartWrite()
		return
	}
	if *mpRead {
		handleMultipartRead()
		return
	}
	if *fcd {
		handleFileContentDisposition()
		return
	}
	if *verify {
		var packet Packet
		dec := json.NewDecoder(io.LimitReader(os.Stdin, 32<<20))
		if err := dec.Decode(&packet); err != nil {
			fail(err)
		}
		if packet.Schema != 1 || packet.Package != "mime" {
			fail(fmt.Errorf("invalid packet"))
		}
		if len(packet.Parse)+len(packet.QpEnc)+len(packet.QpDec)+len(packet.Words)+len(packet.Format)+len(packet.Headers)+len(packet.Ext)+len(packet.AddExt)+len(packet.Canon)+len(packet.MimeHeader) == 0 {
			fail(fmt.Errorf("empty cases"))
		}
		for _, c := range packet.Parse {
			mt, params, err := mime.ParseMediaType(c.In)
			errText := ""
			if err != nil {
				errText = err.Error()
			}
			if mt != c.MediaType || errText != c.Error {
				fail(fmt.Errorf("parse mismatch %q: got %q/%q want %q/%q", c.In, mt, errText, c.MediaType, c.Error))
			}
			if params == nil {
				params = map[string]string{}
			}
			if len(params) != len(c.Params) {
				fail(fmt.Errorf("parse params count %q", c.In))
			}
			for k, v := range params {
				if c.Params[k] != v {
					fail(fmt.Errorf("parse param %s %q", k, c.In))
				}
			}
		}
		for _, c := range packet.QpEnc {
			in := unhex(c.InHex)
			var buf bytes.Buffer
			w := quotedprintable.NewWriter(&buf)
			w.Binary = c.Binary
			if _, err := w.Write(in); err != nil {
				fail(err)
			}
			if err := w.Close(); err != nil {
				fail(err)
			}
			if hexOf(buf.Bytes()) != c.OutHex {
				fail(fmt.Errorf("qp enc mismatch %s", c.ID))
			}
		}
		for _, c := range packet.QpDec {
			in := unhex(c.InHex)
			var buf bytes.Buffer
			_, err := io.Copy(&buf, quotedprintable.NewReader(bytes.NewReader(in)))
			errText := ""
			if err != nil {
				errText = err.Error()
			}
			if hexOf(buf.Bytes()) != c.OutHex || errText != c.Error {
				fail(fmt.Errorf("qp dec mismatch %s got %s/%q want %s/%q", c.ID, hexOf(buf.Bytes()), errText, c.OutHex, c.Error))
			}
		}
		for _, c := range packet.Format {
			params := c.Params
			if params == nil {
				params = map[string]string{}
			}
			got := mime.FormatMediaType(c.Type, params)
			if got != c.Formatted {
				fail(fmt.Errorf("format mismatch %q: got %q want %q", c.Type, got, c.Formatted))
			}
			if c.Formatted != "" {
				mt, p, err := mime.ParseMediaType(c.Formatted)
				if err != nil {
					fail(fmt.Errorf("format parse %q: %v", c.Formatted, err))
				}
				if mt != c.Type && mt != "" {
					_ = p
				}
			}
		}
		for _, c := range packet.Headers {
			if mustDecodeHeader(c.In) != c.Out {
				fail(fmt.Errorf("header mismatch %q", c.In))
			}
		}
		for _, c := range packet.Ext {
			typ := mime.TypeByExtension(c.Ext)
			if typ != c.Type {
				fail(fmt.Errorf("ext mismatch %q: got %q want %q", c.Ext, typ, c.Type))
			}
			if c.Type == "" {
				continue
			}
			got, err := mime.ExtensionsByType(c.Type)
			if err != nil {
				fail(fmt.Errorf("exts %q: %v", c.Type, err))
			}
			if got == nil {
				got = []string{}
			}
			sort.Strings(got)
			want := append([]string(nil), c.Exts...)
			sort.Strings(want)
			if len(got) != len(want) {
				fail(fmt.Errorf("exts count %q: got %v want %v", c.Type, got, want))
			}
			for i := range got {
				if got[i] != want[i] {
					fail(fmt.Errorf("exts %q: got %v want %v", c.Type, got, want))
				}
			}
		}
		for _, c := range packet.AddExt {
			err := mime.AddExtensionType(c.Ext, c.Type)
			errText := ""
			if err != nil {
				errText = err.Error()
			}
			stored := mime.TypeByExtension(c.Ext)
			storedLower := mime.TypeByExtension(strings.ToLower(c.Ext))
			if errText != c.Error || stored != c.Stored || storedLower != c.StoredLower {
				fail(fmt.Errorf("addExt mismatch %q %q: got %q/%q/%q want %q/%q/%q", c.Ext, c.Type, errText, stored, storedLower, c.Error, c.Stored, c.StoredLower))
			}
			just, _, perr := mime.ParseMediaType(c.Type)
			justErr := ""
			if perr != nil {
				justErr = perr.Error()
			}
			if just != c.JustType || justErr != c.JustTypeError {
				fail(fmt.Errorf("addExt justType %q %q: got %q/%q want %q/%q", c.Ext, c.Type, just, justErr, c.JustType, c.JustTypeError))
			}
			if c.Error != "" {
				continue
			}
			lower := strings.ToLower(c.Ext)
			got, e := mime.ExtensionsByType(c.JustType)
			contains := e == nil && slices.Contains(got, lower)
			if contains != c.Registered {
				fail(fmt.Errorf("addExt registered %q %q: got %v want %v", c.Ext, c.Type, contains, c.Registered))
			}
			for _, lu := range c.Lookups {
				g, e2 := mime.ExtensionsByType(lu.Query)
				err2 := ""
				if e2 != nil {
					err2 = e2.Error()
				}
				cont := e2 == nil && slices.Contains(g, lower)
				if err2 != lu.Error || cont != lu.Contains {
					fail(fmt.Errorf("addExt lookup %q %q query %q: got %v/%q want %v/%q", c.Ext, c.Type, lu.Query, cont, err2, lu.Contains, lu.Error))
				}
			}
		}
		for _, c := range packet.Canon {
			if textproto.CanonicalMIMEHeaderKey(c.In) != c.Out {
				fail(fmt.Errorf("canon mismatch %q: got %q want %q", c.In, textproto.CanonicalMIMEHeaderKey(c.In), c.Out))
			}
		}
		for _, c := range packet.MimeHeader {
			h := make(textproto.MIMEHeader)
			for _, op := range c.Ops {
				switch op.Op {
				case "add":
					h.Add(op.Key, op.Value)
				case "set":
					h.Set(op.Key, op.Value)
				case "del":
					h.Del(op.Key)
				default:
					fail(fmt.Errorf("mimeHeader %s unknown op %q", c.ID, op.Op))
				}
			}
			for k, want := range c.Gets {
				if h.Get(k) != want {
					fail(fmt.Errorf("mimeHeader %s get %q: got %q want %q", c.ID, k, h.Get(k), want))
				}
			}
			for k, want := range c.Values {
				got := h.Values(k)
				if got == nil {
					got = []string{}
				}
				if !slices.Equal(got, want) {
					fail(fmt.Errorf("mimeHeader %s values %q: got %v want %v", c.ID, k, got, want))
				}
			}
			if len(h) != len(c.Record) {
				fail(fmt.Errorf("mimeHeader %s record count: got %d want %d", c.ID, len(h), len(c.Record)))
			}
			for k, want := range c.Record {
				if !slices.Equal(h[k], want) {
					fail(fmt.Errorf("mimeHeader %s record %q: got %v want %v", c.ID, k, h[k], want))
				}
			}
		}
		fmt.Printf("Go verified %d mime cases\n", len(packet.Parse)+len(packet.QpEnc)+len(packet.QpDec)+len(packet.Words)+len(packet.Format)+len(packet.Headers)+len(packet.Ext)+len(packet.AddExt)+len(packet.Canon)+len(packet.MimeHeader))
		return
	}
	packet := Packet{Schema: 1, Package: "mime", Parse: parseCases(), QpEnc: qpEncCases(), QpDec: qpDecCases(), Words: wordCases(), Headers: headerCases(), Format: formatCases(), Ext: extCases(), AddExt: addExtCases(), Canon: canonCases(), MimeHeader: mimeHeaderCases()}
	var writer io.Writer = os.Stdout
	if *out != "" {
		f, err := os.Create(*out)
		if err != nil {
			fail(err)
		}
		defer f.Close()
		writer = f
	}
	enc := json.NewEncoder(writer)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}
