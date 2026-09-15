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

type XmlEncodeCase struct {
	ID     string          `json:"id"`
	Kind   string          `json:"kind"`
	XMLHex string          `json:"xmlHex,omitempty"`
	Value  json.RawMessage `json:"value"`
	Error  string          `json:"error,omitempty"`
	Prefix string          `json:"prefix,omitempty"`
	Indent string          `json:"indent,omitempty"`
}

type XmlPacket struct {
	Schema  int              `json:"schema"`
	Package string           `json:"package"`
	Tokens  []XmlTokenCase   `json:"tokens"`
	Escapes []XmlEscapeCase  `json:"escapes"`
	Marshal []XmlMarshalCase `json:"marshal"`
	Decodes []XmlDecodeCase  `json:"decodes"`
	Encodes []XmlEncodeCase  `json:"encodes"`
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
		Encodes: generateXmlEncodes(),
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

type xmlCdata struct {
	XMLName xml.Name `xml:"c"`
	Body    string   `xml:",cdata"`
}

type xmlCdataMix struct {
	XMLName xml.Name `xml:"mixc"`
	A       string   `xml:"a"`
	Body    string   `xml:",cdata"`
	B       string   `xml:"b"`
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

type xmlMix struct {
	XMLName xml.Name `xml:"mix"`
	A       string   `xml:"a"`
	Msg     string   `xml:",comment"`
	Inner   string   `xml:",innerxml"`
	B       string   `xml:"b"`
}

type xmlNSAttr struct {
	XMLName xml.Name `xml:"root"`
	V       string   `xml:"url local,attr"`
}

type xmlNSElem struct {
	XMLName xml.Name `xml:"root"`
	Child   string   `xml:"url local"`
}

type xmlNSBoth struct {
	XMLName xml.Name `xml:"http://e root"`
	V       string   `xml:"url local,attr"`
	Child   string   `xml:"http://c kid"`
}

type xmlNSMulti struct {
	XMLName xml.Name `xml:"root"`
	A       string   `xml:"http://example.com/ns a,attr"`
	B       string   `xml:"http://example.com/ns b,attr"`
	C       string   `xml:"http://other.com/x c,attr"`
}

type xmlNSLang struct {
	XMLName xml.Name `xml:"root"`
	Lang    string   `xml:"http://www.w3.org/XML/1998/namespace lang,attr"`
}

type xmlNSEmpty struct {
	XMLName xml.Name `xml:"root"`
	V       string   `xml:" local,attr"`
}

type xmlNSOnlyURL struct {
	XMLName xml.Name `xml:"root"`
	V       string   `xml:"url,attr"`
}

type xmlNSXmlName struct {
	XMLName xml.Name `xml:"root"`
	V       string   `xml:"http://example.com/xmlname x,attr"`
}

type xmlNSSame struct {
	XMLName xml.Name `xml:"url root"`
	V       string   `xml:"url local,attr"`
}

type xmlNSInner struct {
	XMLName xml.Name `xml:"url inner"`
	V       string   `xml:"url local,attr"`
}

type xmlNSNested struct {
	XMLName xml.Name `xml:"root"`
	Inner   xmlNSInner
}

type xmlNSOmit struct {
	XMLName xml.Name `xml:"root"`
	V       string   `xml:"url local,attr,omitempty"`
}

type xmlNSPath struct {
	XMLName xml.Name `xml:"root"`
	V       string   `xml:"url a>b"`
}

type xmlNSIndent struct {
	XMLName xml.Name `xml:"root"`
	V       string   `xml:"url local,attr"`
	C       string   `xml:"url kid"`
}

type xmlNSBadEmpty struct {
	XMLName xml.Name `xml:"root"`
	V       string   `xml:"url ,attr"`
}

type xmlNSBadElem struct {
	XMLName xml.Name `xml:"root"`
	V       string   `xml:"url "`
}

type xmlNSBadHTTP struct {
	XMLName xml.Name `xml:"root"`
	V       string   `xml:"http://x ,attr"`
}

type xmlNSBadPathAttr struct {
	XMLName xml.Name `xml:"root"`
	V       string   `xml:"url a>b,attr"`
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

func marshalErr(v any) string {
	_, err := xml.Marshal(v)
	if err == nil {
		fail(fmt.Errorf("expected marshal error for %T", v))
	}
	return err.Error()
}

func encodeCase(id, kind string, xmlBytes []byte, value any, errMsg, prefix, indent string) XmlEncodeCase {
	raw, err := json.Marshal(value)
	if err != nil {
		fail(err)
	}
	c := XmlEncodeCase{ID: id, Kind: kind, Value: raw, Error: errMsg, Prefix: prefix, Indent: indent}
	if xmlBytes != nil {
		c.XMLHex = hx(xmlBytes)
	}
	return c
}

func generateXmlEncodes() []XmlEncodeCase {
	indentCmt, err := xml.MarshalIndent(xmlCmt{Msg: "hi"}, "", "  ")
	if err != nil {
		fail(err)
	}
	indentInner, err := xml.MarshalIndent(xmlWrap{Inner: "<x>1</x>"}, "", "  ")
	if err != nil {
		fail(err)
	}
	indentCdata, err := xml.MarshalIndent(xmlCdata{Body: "hi"}, "", "  ")
	if err != nil {
		fail(err)
	}
	indentNS, err := xml.MarshalIndent(xmlNSIndent{V: "x", C: "y"}, "", "  ")
	if err != nil {
		fail(err)
	}
	dashErr := ""
	if _, err := xml.Marshal(xmlCmt{Msg: "a--b"}); err != nil {
		dashErr = err.Error()
	} else {
		fail(fmt.Errorf("expected comment -- error"))
	}
	return []XmlEncodeCase{
		encodeCase("comment-hi", "comment", mustXML(xmlCmt{Msg: "hi"}), map[string]any{"msg": "hi"}, "", "", ""),
		encodeCase("comment-empty", "comment", mustXML(xmlCmt{Msg: ""}), map[string]any{"msg": ""}, "", "", ""),
		encodeCase("comment-spaces", "comment", mustXML(xmlCmt{Msg: " hi "}), map[string]any{"msg": " hi "}, "", "", ""),
		encodeCase("comment-enddash", "comment", mustXML(xmlCmt{Msg: "hi-"}), map[string]any{"msg": "hi-"}, "", "", ""),
		encodeCase("comment-xml", "comment", mustXML(xmlCmt{Msg: "<x>"}), map[string]any{"msg": "<x>"}, "", "", ""),
		encodeCase("comment-amp", "comment", mustXML(xmlCmt{Msg: "a&b"}), map[string]any{"msg": "a&b"}, "", "", ""),
		encodeCase("comment-dash", "comment", nil, map[string]any{"msg": "a--b"}, dashErr, "", ""),
		encodeCase("inner-xy", "inner", mustXML(xmlWrap{Inner: "<x>1</x><y>2</y>"}), map[string]any{"inner": "<x>1</x><y>2</y>"}, "", "", ""),
		encodeCase("inner-empty", "inner", mustXML(xmlWrap{Inner: ""}), map[string]any{"inner": ""}, "", "", ""),
		encodeCase("inner-text", "inner", mustXML(xmlWrap{Inner: "raw & <notag>"}), map[string]any{"inner": "raw & <notag>"}, "", "", ""),
		encodeCase("inner-comment", "inner", mustXML(xmlWrap{Inner: "<!--z-->"}), map[string]any{"inner": "<!--z-->"}, "", "", ""),
		encodeCase("mix-order", "mix", mustXML(xmlMix{A: "1", Msg: "c", Inner: "<z/>", B: "2"}), map[string]any{"a": "1", "msg": "c", "inner": "<z/>", "b": "2"}, "", "", ""),
		encodeCase("comment-indent", "comment", indentCmt, map[string]any{"msg": "hi"}, "", "", "  "),
		encodeCase("inner-indent", "inner", indentInner, map[string]any{"inner": "<x>1</x>"}, "", "", "  "),
		encodeCase("cdata-hi", "cdata", mustXML(xmlCdata{Body: "hi"}), map[string]any{"body": "hi"}, "", "", ""),
		encodeCase("cdata-empty", "cdata", mustXML(xmlCdata{Body: ""}), map[string]any{"body": ""}, "", "", ""),
		encodeCase("cdata-spaces", "cdata", mustXML(xmlCdata{Body: " hi "}), map[string]any{"body": " hi "}, "", "", ""),
		encodeCase("cdata-raw", "cdata", mustXML(xmlCdata{Body: "1<2&3>"}), map[string]any{"body": "1<2&3>"}, "", "", ""),
		encodeCase("cdata-close", "cdata", mustXML(xmlCdata{Body: "a]]>b"}), map[string]any{"body": "a]]>b"}, "", "", ""),
		encodeCase("cdata-nested", "cdata", mustXML(xmlCdata{Body: "Literal <![CDATA[Nested]]>!"}), map[string]any{"body": "Literal <![CDATA[Nested]]>!"}, "", "", ""),
		encodeCase("cdata-nested2", "cdata", mustXML(xmlCdata{Body: "<![CDATA[Nested]]> Literal!"}), map[string]any{"body": "<![CDATA[Nested]]> Literal!"}, "", "", ""),
		encodeCase("cdata-double", "cdata", mustXML(xmlCdata{Body: "<![CDATA[Nested]]> Literal! <![CDATA[Nested]]> Literal!"}), map[string]any{"body": "<![CDATA[Nested]]> Literal! <![CDATA[Nested]]> Literal!"}, "", "", ""),
		encodeCase("cdata-triple", "cdata", mustXML(xmlCdata{Body: "<![CDATA[<![CDATA[Nested]]>]]>"}), map[string]any{"body": "<![CDATA[<![CDATA[Nested]]>]]>"}, "", "", ""),
		encodeCase("cdata-indent", "cdata", indentCdata, map[string]any{"body": "hi"}, "", "", "  "),
		encodeCase("cdata-mix", "cdatamix", mustXML(xmlCdataMix{A: "1", Body: "x<y", B: "2"}), map[string]any{"a": "1", "body": "x<y", "b": "2"}, "", "", ""),
		encodeCase("ns-attr", "nsattr", mustXML(xmlNSAttr{V: "x"}), map[string]any{"v": "x"}, "", "", ""),
		encodeCase("ns-attr-empty", "nsattr", mustXML(xmlNSAttr{V: ""}), map[string]any{"v": ""}, "", "", ""),
		encodeCase("ns-attr-esc", "nsattr", mustXML(xmlNSAttr{V: `a<b&c"`}), map[string]any{"v": `a<b&c"`}, "", "", ""),
		encodeCase("ns-elem", "nselem", mustXML(xmlNSElem{Child: "y"}), map[string]any{"child": "y"}, "", "", ""),
		encodeCase("ns-both", "nsboth", mustXML(xmlNSBoth{V: "x", Child: "z"}), map[string]any{"v": "x", "child": "z"}, "", "", ""),
		encodeCase("ns-multi", "nsmulti", mustXML(xmlNSMulti{A: "1", B: "2", C: "3"}), map[string]any{"a": "1", "b": "2", "c": "3"}, "", "", ""),
		encodeCase("ns-xml", "nsxml", mustXML(xmlNSLang{Lang: "en"}), map[string]any{"lang": "en"}, "", "", ""),
		encodeCase("ns-empty-space", "nsempty", mustXML(xmlNSEmpty{V: "x"}), map[string]any{"v": "x"}, "", "", ""),
		encodeCase("ns-only-url", "nsonlyurl", mustXML(xmlNSOnlyURL{V: "x"}), map[string]any{"v": "x"}, "", "", ""),
		encodeCase("ns-xmlname", "nsxmlname", mustXML(xmlNSXmlName{V: "x"}), map[string]any{"v": "x"}, "", "", ""),
		encodeCase("ns-same", "nssame", mustXML(xmlNSSame{V: "x"}), map[string]any{"v": "x"}, "", "", ""),
		encodeCase("ns-nested", "nsnested", mustXML(xmlNSNested{Inner: xmlNSInner{V: "q"}}), map[string]any{"inner": map[string]any{"v": "q"}}, "", "", ""),
		encodeCase("ns-omit-empty", "nsomit", mustXML(xmlNSOmit{V: ""}), map[string]any{"v": ""}, "", "", ""),
		encodeCase("ns-omit-val", "nsomit", mustXML(xmlNSOmit{V: "x"}), map[string]any{"v": "x"}, "", "", ""),
		encodeCase("ns-path", "nspath", mustXML(xmlNSPath{V: "x"}), map[string]any{"v": "x"}, "", "", ""),
		encodeCase("ns-indent", "nsindent", indentNS, map[string]any{"v": "x", "c": "y"}, "", "", "  "),
		encodeCase("ns-bad-empty", "nsbadempty", nil, map[string]any{"v": "x"}, marshalErr(xmlNSBadEmpty{V: "x"}), "", ""),
		encodeCase("ns-bad-elem", "nsbadelem", nil, map[string]any{"v": "x"}, marshalErr(xmlNSBadElem{V: "x"}), "", ""),
		encodeCase("ns-bad-http", "nsbadhttp", nil, map[string]any{"v": "x"}, marshalErr(xmlNSBadHTTP{V: "x"}), "", ""),
		encodeCase("ns-bad-path-attr", "nsbadpathattr", nil, map[string]any{"v": "x"}, marshalErr(xmlNSBadPathAttr{V: "x"}), "", ""),
	}
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
	cdataXML := []byte(`<c><![CDATA[hello & <café>]]></c>`)
	var cd xmlCdata
	if err := xml.Unmarshal(cdataXML, &cd); err != nil {
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
		decodeCase("cdata", "cdata", cdataXML, map[string]any{"body": cd.Body}),
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
		case "cdata":
			var v xmlCdata
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
		case "cdatamix":
			var v xmlCdataMix
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
		case "mix":
			var v xmlMix
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
		case "nsattr":
			var v xmlNSAttr
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
		case "nselem":
			var v xmlNSElem
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
			if v.Child == "" {
				fail(fmt.Errorf("%s: empty child", c.ID))
			}
		case "nsboth":
			var v xmlNSBoth
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
		case "nsmulti":
			var v xmlNSMulti
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
		case "nsxml":
			var v xmlNSLang
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
		case "nssame":
			var v xmlNSSame
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
		case "nsnested":
			var v xmlNSNested
			if err := xml.Unmarshal(raw, &v); err != nil {
				fail(fmt.Errorf("%s: %v", c.ID, err))
			}
			if v.Inner.V == "" {
				fail(fmt.Errorf("%s: empty inner", c.ID))
			}
		case "nspath":
			var v xmlNSPath
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
