package main

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"strings"
)

type XmlTok struct {
	Type   string    `json:"type"`
	Name   *XmlName  `json:"name,omitempty"`
	Attr   []XmlAttr `json:"attr,omitempty"`
	Text   string    `json:"text,omitempty"`
	Target string    `json:"target,omitempty"`
	InstHex string   `json:"instHex,omitempty"`
}

type XmlName struct {
	Space string `json:"space"`
	Local string `json:"local"`
}

type XmlAttr struct {
	Name  XmlName `json:"name"`
	Value string  `json:"value"`
}

type XmlTokenCase struct {
	ID           string            `json:"id"`
	InputHex     string            `json:"inputHex"`
	Strict       bool              `json:"strict"`
	AutoClose    []string          `json:"autoClose,omitempty"`
	Entity       map[string]string `json:"entity,omitempty"`
	DefaultSpace string            `json:"defaultSpace,omitempty"`
	Raw          bool              `json:"raw,omitempty"`
	Tokens       []XmlTok          `json:"tokens"`
	Error        string            `json:"error,omitempty"`
	ErrorLine    int               `json:"errorLine,omitempty"`
}

type XmlEscapeCase struct {
	ID        string `json:"id"`
	InputHex  string `json:"inputHex"`
	OutputHex string `json:"outputHex"`
}

type XmlMarshalCase struct {
	ID        string `json:"id"`
	XMLHex    string `json:"xmlHex"`
	Name      string `json:"name"`
	Id        int    `json:"idAttr"`
	ItemName  string `json:"itemName"`
	Age       int    `json:"age"`
}

type XmlDecodeCase struct {
	ID     string          `json:"id"`
	Kind   string          `json:"kind"`
	XMLHex string          `json:"xmlHex"`
	Value  json.RawMessage `json:"value"`
}

type XmlPacket struct {
	Schema  int              `json:"schema"`
	Package string           `json:"package"`
	Tokens  []XmlTokenCase   `json:"tokens"`
	Escapes []XmlEscapeCase  `json:"escapes"`
	Marshal []XmlMarshalCase `json:"marshal"`
	Decodes []XmlDecodeCase  `json:"decodes"`
}

type Person struct {
	XMLName xml.Name `xml:"person"`
	Id      int      `xml:"id,attr"`
	Name    string   `xml:"name"`
	Age     int      `xml:"age"`
}

func xmlName(n xml.Name) *XmlName {
	return &XmlName{Space: n.Space, Local: n.Local}
}

func convToken(t xml.Token) XmlTok {
	switch v := t.(type) {
	case xml.StartElement:
		attrs := make([]XmlAttr, 0, len(v.Attr))
		for _, a := range v.Attr {
			attrs = append(attrs, XmlAttr{Name: XmlName{Space: a.Name.Space, Local: a.Name.Local}, Value: a.Value})
		}
		return XmlTok{Type: "start", Name: xmlName(v.Name), Attr: attrs}
	case xml.EndElement:
		return XmlTok{Type: "end", Name: xmlName(v.Name)}
	case xml.CharData:
		return XmlTok{Type: "chardata", Text: string([]byte(v))}
	case xml.Comment:
		return XmlTok{Type: "comment", Text: string([]byte(v))}
	case xml.ProcInst:
		return XmlTok{Type: "procinst", Target: v.Target, InstHex: hx(v.Inst)}
	case xml.Directive:
		return XmlTok{Type: "directive", Text: string([]byte(v))}
	default:
		return XmlTok{Type: "unknown"}
	}
}

func collectTokens(input []byte, strict bool, autoClose []string, entity map[string]string, defaultSpace string, raw bool) XmlTokenCase {
	d := xml.NewDecoder(bytes.NewReader(input))
	d.Strict = strict
	d.AutoClose = autoClose
	d.Entity = entity
	d.DefaultSpace = defaultSpace
	var tokens []XmlTok
	var errLine int
	var errMsg string
	for {
		var t xml.Token
		var err error
		if raw {
			t, err = d.RawToken()
		} else {
			t, err = d.Token()
		}
		if t != nil {
			tokens = append(tokens, convToken(xml.CopyToken(t)))
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			if se, ok := err.(*xml.SyntaxError); ok {
				errLine = se.Line
				errMsg = se.Msg
			} else {
				errMsg = err.Error()
			}
			break
		}
	}
	return XmlTokenCase{
		Tokens:    tokens,
		Error:     errMsg,
		ErrorLine: errLine,
	}
}

func generateXml() XmlPacket {
	type spec struct {
		id           string
		input        string
		strict       bool
		autoClose    []string
		entity       map[string]string
		defaultSpace string
		raw          bool
	}
	s := func(id, input string) spec { return spec{id: id, input: input, strict: true} }
	specs := []spec{
		s("Simple", `<a>x</a>`),
		s("Nested", `<a><b>1</b><c>2</c></a>`),
		s("Attrs", `<a href="x" id='y'>z</a>`),
		s("SelfClose", `<br/>`),
		s("NS", `<p:a xmlns:p="urn:p"><p:b/></p:a>`),
		s("DefaultNS", `<a xmlns="urn:x"><b/></a>`),
		s("Comment", `<a><!-- hi --></a>`),
		s("PI", `<?xml version="1.0"?><a/>`),
		s("Directive", `<!DOCTYPE a><a/>`),
		s("CDATA", `<a><![CDATA[1<2&>]]></a>`),
		s("Entity", `<a>&lt;&amp;&gt;&apos;&quot;</a>`),
		s("Numeric", `<a>&#65;&#x42;</a>`),
		s("CRLF", "<a>\r\n</a>"),
		s("Mixed", `<a>x<b>y</b>z</a>`),
		s("Empty", `<a></a>`),
		s("UTF8", `<a>café</a>`),
		s("XMLNSAttr", `<a xmlns:p="urn:p" p:x="1"/>`),
		s("ProcInstTarget", `<?target data?><a/>`),
		s("NestedNS", `<a xmlns="urn:1"><b xmlns="urn:2"/></a>`),
		s("SpaceInText", `<a>  x  </a>`),
		s("QuoteInAttr", `<a v="a&quot;b"/>`),
		s("AposInAttr", `<a v='a&apos;b'/>`),
		s("CommentInRoot", `<!--c--><a/>`),
		s("TwoRoots", `<a/><b/>`),
		s("Deep", `<a><b><c><d>z</d></c></b></a>`),
		s("Boolish", `<a>true</a>`),
		s("Number", `<n>42</n>`),
		s("EmptyAttr", `<a v=""/>`),
		s("MultiAttrOrder", `<a z="1" a="2" m="3"/>`),
		s("XMLPrefix", `<a xml:lang="en"/>`),
		s("InnerComment", `<a>x<!--y-->z</a>`),
		s("DirectiveENTITY", `<!ENTITY a "x"><a/>`),
		s("PIThenElem", `<?xml version="1.0" encoding="UTF-8"?><root/>`),
		s("TabNL", "<a>\t\n</a>"),
		s("GTInText", `<a>a>b</a>`),
		s("AmpOK", `<a>&amp;</a>`),
		s("NestedSame", `<a><a>1</a><a>2</a></a>`),
		s("NSDefaultChild", `<r xmlns="urn:r"><c/></r>`),
		s("AttrNS", `<a xmlns:x="urn:x" x:y="z"/>`),
		s("EmptyNS", `<a xmlns=""><b/></a>`),
		{id: "HTMLBr", input: `<div><br>x</div>`, strict: false, autoClose: xml.HTMLAutoClose},
		{id: "HTMLImg", input: `<p><img src="a">z</p>`, strict: false, autoClose: xml.HTMLAutoClose},
		{id: "HTMLEntityNbsp", input: `<a>&nbsp;</a>`, strict: false, entity: xml.HTMLEntity},
		{id: "NonStrictUnquoted", input: `<a v=foo>`, strict: false},
		{id: "NonStrictUnknownEnt", input: `<a>&foo;</a>`, strict: false},
		{id: "DefaultSpace", input: `<a><b/></a>`, strict: true, defaultSpace: "urn:def"},
		{id: "RawNS", input: `<p:a xmlns:p="urn:p"/>`, strict: true, raw: true},
		s("Mismatch", `<a></b>`),
		s("Unclosed", `<a>`),
		s("BadEntity", `<a>&unknown;</a>`),
		s("Truncated", `<a`),
		s("BadComment", `<!-- -- -->`),
		s("UnescapedLT", `<a>1<2</a>`),
		s("CDATATrunc", `<a><![CDATA[x`),
		s("IllegalChar", "<a>\x01</a>"),
		s("BadName", `<1a/>`),
		s("NoEndGT", `<a`),
		s("AttrNoEq", `<a x y="1"/>`),
		s("UnquotedStrict", `<a v=foo/>`),
		s("TrailingJunkEnd", `<a></a`),
		s("CommentDoubleDash", `<!-- a -- b -->`),
		s("PINoTarget", `<? ?>`),
	}
	var cases []XmlTokenCase
	for _, sp := range specs {
		c := collectTokens([]byte(sp.input), sp.strict, sp.autoClose, sp.entity, sp.defaultSpace, sp.raw)
		c.ID = sp.id
		c.InputHex = hx([]byte(sp.input))
		c.Strict = sp.strict
		c.AutoClose = sp.autoClose
		c.Entity = sp.entity
		c.DefaultSpace = sp.defaultSpace
		c.Raw = sp.raw
		cases = append(cases, c)
	}

	escapes := []XmlEscapeCase{}
	for _, in := range []string{`a<b>`, `a&b`, `"hi"`, `'x'`, "a\tb\nc\r", "ok", `<tag/>`, "\x00"} {
		var buf bytes.Buffer
		_ = xml.EscapeText(&buf, []byte(in))
		escapes = append(escapes, XmlEscapeCase{ID: "esc-" + hx([]byte(in)), InputHex: hx([]byte(in)), OutputHex: hx(buf.Bytes())})
	}

	people := []Person{
		{Id: 1, Name: "Ann", Age: 3},
		{Id: 2, Name: "Bo", Age: 0},
		{Id: 7, Name: "café", Age: 40},
	}
	var marshals []XmlMarshalCase
	for i, p := range people {
		b, err := xml.Marshal(p)
		if err != nil {
			fail(err)
		}
		marshals = append(marshals, XmlMarshalCase{
			ID: fmt.Sprintf("person-%d", i), XMLHex: hx(b), Name: p.Name, Id: p.Id, ItemName: p.Name, Age: p.Age,
		})
	}
	return XmlPacket{
		Schema:  1,
		Package: "serial-xml",
		Tokens:  cases,
		Escapes: escapes,
		Marshal: marshals,
		Decodes: generateXmlDecodes(),
	}
}

type xmlBook struct {
	XMLName xml.Name `xml:"book"`
	ISBN    string   `xml:"isbn,attr"`
	Title   string   `xml:"title"`
	Pages   int      `xml:"pages"`
}

type xmlNote struct {
	XMLName xml.Name `xml:"note"`
	Body    string   `xml:",chardata"`
}

type xmlCmt struct {
	XMLName xml.Name `xml:"c"`
	Msg     string   `xml:",comment"`
}

type xmlWrap struct {
	XMLName xml.Name `xml:"wrap"`
	Inner   string   `xml:",innerxml"`
}

type xmlPathDoc struct {
	XMLName xml.Name `xml:"doc"`
	City    string   `xml:"a>b>c"`
}

type xmlItems struct {
	XMLName xml.Name `xml:"items"`
	Item    []string `xml:"item"`
}

type xmlOmit struct {
	XMLName xml.Name `xml:"omit"`
	A       string   `xml:"a,omitempty"`
	B       int      `xml:"b,omitempty"`
	C       string   `xml:"c"`
}

type xmlFlags struct {
	XMLName xml.Name `xml:"flags"`
	On      bool     `xml:"on"`
	N       uint     `xml:"n"`
	F       float64  `xml:"f"`
}

func decodeCase(id, kind string, xmlBytes []byte, value any) XmlDecodeCase {
	raw, err := json.Marshal(value)
	if err != nil {
		fail(err)
	}
	return XmlDecodeCase{ID: id, Kind: kind, XMLHex: hx(xmlBytes), Value: raw}
}

func mustXML(v any) []byte {
	b, err := xml.Marshal(v)
	if err != nil {
		fail(err)
	}
	return b
}

func generateXmlDecodes() []XmlDecodeCase {
	bookXML := mustXML(xmlBook{ISBN: "978", Title: "Go", Pages: 12})
	var book xmlBook
	if err := xml.Unmarshal(bookXML, &book); err != nil {
		fail(err)
	}
	noteXML := []byte(`<note>hello &amp; café</note>`)
	var note xmlNote
	if err := xml.Unmarshal(noteXML, &note); err != nil {
		fail(err)
	}
	cmtXML := []byte(`<c><!--hi--></c>`)
	var cmt xmlCmt
	if err := xml.Unmarshal(cmtXML, &cmt); err != nil {
		fail(err)
	}
	wrapXML := []byte(`<wrap><x>1</x><y>2</y></wrap>`)
	var wrap xmlWrap
	if err := xml.Unmarshal(wrapXML, &wrap); err != nil {
		fail(err)
	}
	pathXML := []byte(`<doc><a><b><c>Paris</c></b></a></doc>`)
	var path xmlPathDoc
	if err := xml.Unmarshal(pathXML, &path); err != nil {
		fail(err)
	}
	itemsXML := []byte(`<items><item>a</item><item>b</item><item>c</item></items>`)
	var items xmlItems
	if err := xml.Unmarshal(itemsXML, &items); err != nil {
		fail(err)
	}
	omitXML := mustXML(xmlOmit{A: "", B: 0, C: "x"})
	flagsXML := mustXML(xmlFlags{On: true, N: 7, F: 1.5})
	var flags xmlFlags
	if err := xml.Unmarshal(flagsXML, &flags); err != nil {
		fail(err)
	}
	return []XmlDecodeCase{
		decodeCase("book-attr", "book", bookXML, map[string]any{"isbn": book.ISBN, "title": book.Title, "pages": book.Pages}),
		decodeCase("note-chardata", "note", noteXML, map[string]any{"body": note.Body}),
		decodeCase("comment", "comment", cmtXML, map[string]any{"msg": cmt.Msg}),
		decodeCase("innerxml", "inner", wrapXML, map[string]any{"inner": wrap.Inner}),
		decodeCase("path-abc", "path", pathXML, map[string]any{"city": path.City}),
		decodeCase("items-slice", "items", itemsXML, map[string]any{"item": items.Item}),
		decodeCase("omitempty-marshal", "omit", omitXML, map[string]any{"xmlHex": hx(omitXML)}),
		decodeCase("flags-scalars", "flags", flagsXML, map[string]any{"on": flags.On, "n": flags.N, "f": flags.F}),
	}
}

type XmlVerifyPacket struct {
	Schema  int              `json:"schema"`
	Package string           `json:"package"`
	People  []XmlPersonEnc   `json:"people"`
	XML     []string         `json:"xml,omitempty"`
	Decodes []XmlDecodeCase  `json:"decodes,omitempty"`
}

type XmlPersonEnc struct {
	ID     string `json:"id"`
	XMLHex string `json:"xmlHex"`
}

func verifyXml(packet XmlVerifyPacket) {
	if packet.Package != "serial-xml" {
		fail(fmt.Errorf("bad package"))
	}
	n := 0
	for _, p := range packet.People {
		var person Person
		if err := xml.Unmarshal(mustHex(p.XMLHex), &person); err != nil {
			fail(fmt.Errorf("%s: %v", p.ID, err))
		}
		if person.Name == "" {
			fail(fmt.Errorf("%s: empty name", p.ID))
		}
		n++
	}
	for _, c := range packet.Decodes {
		raw := mustHex(c.XMLHex)
		switch c.Kind {
		case "book":
			var v xmlBook
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
			if v.ISBN == "" || v.Title == "" {
				fail(fmt.Errorf("%s: empty book", c.ID))
			}
		case "note":
			var v xmlNote
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
		case "comment":
			var v xmlCmt
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
		case "inner":
			var v xmlWrap
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
		case "path":
			var v xmlPathDoc
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
			if v.City == "" {
				fail(fmt.Errorf("%s: empty city", c.ID))
			}
		case "items":
			var v xmlItems
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
			if len(v.Item) < 2 {
				fail(fmt.Errorf("%s: want >=2 items", c.ID))
			}
		case "omit":
			var v xmlOmit
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
			if v.A != "" || v.B != 0 || v.C == "" {
				fail(fmt.Errorf("%s: omitempty fields leaked: %+v", c.ID, v))
			}
		case "flags":
			var v xmlFlags
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
		default:
			fail(fmt.Errorf("%s: unknown kind %s", c.ID, c.Kind))
		}
		n++
	}
	for i, s := range packet.XML {
		if err := xml.Unmarshal([]byte(s), new(Person)); err != nil && !strings.Contains(s, "not-person") {
			fail(fmt.Errorf("xml %d: %v", i, err))
		}
	}
	fmt.Printf("Go verified %d serial-xml encode cases\n", n)
}

func mustHex(s string) []byte {
	b, err := hexDecode(s)
	if err != nil {
		fail(err)
	}
	return b
}
