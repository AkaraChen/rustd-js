package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"mime"
	"mime/quotedprintable"
	"os"
	"sort"
)

type ParseCase struct {
	In         string            `json:"in"`
	MediaType  string            `json:"mediaType"`
	Params     map[string]string `json:"params"`
	Error      string            `json:"error"`
	Formatted  string            `json:"formatted,omitempty"`
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
	Charset string `json:"charset"`
	Src     string `json:"src"`
	Enc     string `json:"enc"`
	Encoded string `json:"encoded"`
	Decoded string `json:"decoded"`
	Header  string `json:"header,omitempty"`
	HeaderOut string `json:"headerOut,omitempty"`
}

type ExtCase struct {
	Ext  string   `json:"ext"`
	Type string   `json:"type"`
	Exts []string `json:"exts"`
}

type Packet struct {
	Schema int         `json:"schema"`
	Package string     `json:"package"`
	Parse  []ParseCase `json:"parse"`
	QpEnc  []QpCase    `json:"qpEnc"`
	QpDec  []QpCase    `json:"qpDec"`
	Words  []WordCase  `json:"words"`
	Ext    []ExtCase   `json:"ext"`
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
		`form-data; key=value;  blah="value";name="foo" `,
		`foo; key=val1; key=the-key-appears-again-which-is-bogus`,
		`application/x-stuff; title*=us-ascii'en-us'This%20is%20%2A%2A%2Afun%2A%2A%2A`,
		`message/external-body; access-type=URL; URL*0="ftp://";URL*1="cs.utk.edu/pub/moore/bulk-mailer/bulk-mailer.tar"`,
		`application/x-stuff; title*0*=us-ascii'en'This%20is%20even%20more%20; title*1*=%2A%2A%2Afun%2A%2A%2A%20; title*2="isn't it!"`,
		`attachment`,
		`ATTACHMENT`,
		`attachment; filename="foo.html"`,
		`attachment; filename="f\oo.html"`,
		`attachment; filename="\"quoting\" tested.html"`,
		`attachment; filename="Here's a semicolon;.html"`,
		`attachment; foo="bar"; filename="foo.html"`,
		`attachment; filename=foo.html`,
		`attachment; filename=foo.html ;`,
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
		[]byte("foo bar\n"),
		[]byte("foo bar\r\n"),
		[]byte("foo bar "),
		[]byte("foo bar\t"),
		[]byte("¡Hola Señor!"),
		bytes.Repeat([]byte("a"), 75),
		bytes.Repeat([]byte("a"), 76),
		bytes.Repeat([]byte("a"), 73),
		append(bytes.Repeat([]byte("a"), 72), '='),
		[]byte("foo bar  \n "),
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

func extCases() []ExtCase {
	exts := []string{".txt", ".html", ".HTML", ".json", ".wasm", ".png", ".unknownext", ".tar.gz", ".js"}
	var out []ExtCase
	for _, ext := range exts {
		typ := mime.TypeByExtension(ext)
		got, _ := mime.ExtensionsByType(typ)
		if got == nil {
			got = []string{}
		}
		sort.Strings(got)
		out = append(out, ExtCase{Ext: ext, Type: typ, Exts: got})
	}
	return out
}

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }

func main() {
	out := flag.String("out", "", "output JSON file")
	verify := flag.Bool("verify", false, "verify packet from stdin")
	flag.Parse()
	if *verify {
		var packet Packet
		dec := json.NewDecoder(io.LimitReader(os.Stdin, 32<<20))
		if err := dec.Decode(&packet); err != nil {
			fail(err)
		}
		if packet.Schema != 1 || packet.Package != "mime" {
			fail(fmt.Errorf("invalid packet"))
		}
		if len(packet.Parse)+len(packet.QpEnc)+len(packet.QpDec)+len(packet.Words) == 0 {
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
		fmt.Printf("Go verified %d mime cases\n", len(packet.Parse)+len(packet.QpEnc)+len(packet.QpDec)+len(packet.Words))
		return
	}
	packet := Packet{Schema: 1, Package: "mime", Parse: parseCases(), QpEnc: qpEncCases(), QpDec: qpDecCases(), Words: wordCases(), Ext: extCases()}
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
