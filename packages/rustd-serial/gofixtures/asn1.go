package main

import (
	"encoding/asn1"
	"encoding/json"
	"fmt"
	"math/big"
	"time"
)

type Asn1Case struct {
	ID        string          `json:"id"`
	Schema    json.RawMessage `json:"schema"`
	Params    string          `json:"params,omitempty"`
	Value     json.RawMessage `json:"value,omitempty"`
	DerHex    string          `json:"derHex,omitempty"`
	RestHex   string          `json:"restHex,omitempty"`
	Error     string          `json:"error,omitempty"`
	RoundTrip bool            `json:"roundTrip,omitempty"`
}

type Asn1Packet struct {
	Schema int        `json:"schema"`
	Package string    `json:"package"`
	Cases  []Asn1Case `json:"cases"`
}

type Asn1VerifyPacket struct {
	Schema  int            `json:"schema"`
	Package string         `json:"package"`
	Encodes []Asn1Encode   `json:"encodes"`
}

type Asn1Encode struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	DerHex string `json:"derHex"`
	Params string `json:"params,omitempty"`
}

func schemaJSON(v string) json.RawMessage { return json.RawMessage(v) }

func valueJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		fail(err)
	}
	return b
}

func marshalCase(id, schema string, val any, params string, ir any) Asn1Case {
	b, err := asn1.MarshalWithParams(val, params)
	if err != nil {
		fail(fmt.Errorf("%s: %v", id, err))
	}
	return Asn1Case{
		ID:        id,
		Schema:    schemaJSON(schema),
		Params:    params,
		Value:     valueJSON(ir),
		DerHex:    hx(b),
		RestHex:   "",
		RoundTrip: true,
	}
}

func extraCase(id, schema string, val any, extra []byte, ir any) Asn1Case {
	b, err := asn1.Marshal(val)
	if err != nil {
		fail(err)
	}
	der := append(append([]byte{}, b...), extra...)
	return Asn1Case{
		ID:     id,
		Schema: schemaJSON(schema),
		Value:  valueJSON(ir),
		DerHex: hx(der),
		RestHex: hx(extra),
		RoundTrip: false,
	}
}

func invalidCase(id, schema, derHex, class string) Asn1Case {
	return Asn1Case{ID: id, Schema: schemaJSON(schema), DerHex: derHex, Error: class}
}

type SeqAB struct {
	A int
	B string `asn1:"utf8"`
}

type SeqOpt struct {
	A int
	B int `asn1:"optional"`
}

type SeqExp struct {
	A int `asn1:"explicit,tag:0"`
}

type SeqImp struct {
	A int `asn1:"tag:1"`
}

type SeqNested struct {
	Inner SeqAB
}

func generateAsn1() Asn1Packet {
	t := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	tOld := time.Date(1999, 12, 31, 23, 59, 59, 0, time.UTC)
	tGen := time.Date(2051, 6, 7, 8, 9, 10, 0, time.UTC)
	bigN := new(big.Int).Exp(big.NewInt(2), big.NewInt(100), nil)
	oid := asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 1}
	bits := asn1.BitString{Bytes: []byte{0x80, 0x00}, BitLength: 9}

	cases := []Asn1Case{
		marshalCase("bool-true", `{"kind":"bool"}`, true, "", true),
		marshalCase("bool-false", `{"kind":"bool"}`, false, "", false),
		marshalCase("int-0", `{"kind":"int"}`, 0, "", 0),
		marshalCase("int-1", `{"kind":"int"}`, 1, "", 1),
		marshalCase("int-neg1", `{"kind":"int"}`, -1, "", -1),
		marshalCase("int-127", `{"kind":"int"}`, 127, "", 127),
		marshalCase("int-128", `{"kind":"int"}`, 128, "", 128),
		marshalCase("int-256", `{"kind":"int"}`, 256, "", 256),
		marshalCase("int-neg128", `{"kind":"int"}`, -128, "", -128),
		marshalCase("int-neg129", `{"kind":"int"}`, -129, "", -129),
		marshalCase("int-65535", `{"kind":"int"}`, 65535, "", 65535),
		marshalCase("bigint-2pow100", `{"kind":"bigint"}`, bigN, "", map[string]any{"$i": bigN.String()}),
		marshalCase("bitstring-9", `{"kind":"bitstring"}`, bits, "", map[string]any{"$bits": hx(bits.Bytes), "bitLength": bits.BitLength}),
		marshalCase("octet-hello", `{"kind":"octetstring"}`, []byte("hello"), "", map[string]any{"$b": hx([]byte("hello"))}),
		marshalCase("octet-empty", `{"kind":"octetstring"}`, []byte{}, "", map[string]any{"$b": ""}),
		marshalCase("oid-rsa", `{"kind":"oid"}`, oid, "", []int(oid)),
		marshalCase("null", `{"kind":"null"}`, asn1.RawValue{Tag: asn1.TagNull, Class: 0, Bytes: []byte{}}, "", nil),
		marshalCase("enum-7", `{"kind":"enumerated"}`, asn1.Enumerated(7), "", 7),
		marshalCase("utf8-hi", `{"kind":"utf8"}`, "hi", "utf8", "hi"),
		marshalCase("ia5-abc", `{"kind":"ia5"}`, "abc", "ia5", "abc"),
		marshalCase("printable-OK", `{"kind":"printable"}`, "OK", "printable", "OK"),
		marshalCase("numeric-42", `{"kind":"numeric"}`, "42", "numeric", "42"),
		marshalCase("utctime-2020", `{"kind":"utctime"}`, t, "utc", map[string]any{"$t": t.UnixMilli()}),
		marshalCase("utctime-1999", `{"kind":"utctime"}`, tOld, "utc", map[string]any{"$t": tOld.UnixMilli()}),
		marshalCase("gentime-2051", `{"kind":"generalizedtime"}`, tGen, "generalized", map[string]any{"$t": tGen.UnixMilli()}),
		marshalCase("seq-ab", `{"kind":"sequence","fields":[{"name":"A","schema":{"kind":"int"}},{"name":"B","schema":{"kind":"utf8"}}]}`, SeqAB{A: 9, B: "z"}, "", map[string]any{"A": 9, "B": "z"}),
		marshalCase("seq-opt-present", `{"kind":"sequence","fields":[{"name":"A","schema":{"kind":"int"}},{"name":"B","schema":{"kind":"int"},"optional":true}]}`, SeqOpt{A: 1, B: 2}, "", map[string]any{"A": 1, "B": 2}),
		marshalCase("seq-opt-absent", `{"kind":"sequence","fields":[{"name":"A","schema":{"kind":"int"}},{"name":"B","schema":{"kind":"int"},"optional":true}]}`, SeqOpt{A: 1}, "", map[string]any{"A": 1, "B": nil}),
		marshalCase("seq-explicit", `{"kind":"sequence","fields":[{"name":"A","schema":{"kind":"explicit","tag":0,"inner":{"kind":"int"}}}]}`, SeqExp{A: 5}, "", map[string]any{"A": 5}),
		marshalCase("seq-implicit", `{"kind":"sequence","fields":[{"name":"A","schema":{"kind":"implicit","tag":1,"inner":{"kind":"int"}}}]}`, SeqImp{A: 6}, "", map[string]any{"A": 6}),
		marshalCase("seqof-ints", `{"kind":"sequenceof","inner":{"kind":"int"}}`, []int{1, 2, 3}, "", []int{1, 2, 3}),
		marshalCase("setof-ints", `{"kind":"setof","inner":{"kind":"int"}}`, []int{3, 1, 2}, "set", []int{1, 2, 3}),
		marshalCase("nested-seq", `{"kind":"sequence","fields":[{"name":"Inner","schema":{"kind":"sequence","fields":[{"name":"A","schema":{"kind":"int"}},{"name":"B","schema":{"kind":"utf8"}}]}}]}`, SeqNested{Inner: SeqAB{A: 1, B: "n"}}, "", map[string]any{"Inner": map[string]any{"A": 1, "B": "n"}}),
		marshalCase("params-explicit-int", `{"kind":"int"}`, 4, "explicit,tag:2", 4),
		marshalCase("raw-int", `{"kind":"raw"}`, 11, "", nil),
		extraCase("int-with-rest", `{"kind":"int"}`, 3, []byte{0x05, 0x00}, 3),
	}

	// raw-int needs IR from actual DER
	rawDER, err := asn1.Marshal(11)
	if err != nil {
		fail(err)
	}
	for i := range cases {
		if cases[i].ID == "raw-int" {
			cases[i].Value = valueJSON(map[string]any{
				"$raw": map[string]any{
					"class":      0,
					"tag":        2,
					"isCompound": false,
					"bytes":      hx(rawDER[2:]),
					"fullBytes":  hx(rawDER),
				},
			})
		}
	}

	invalid := []Asn1Case{
		invalidCase("ber-indefinite", `{"kind":"sequence","fields":[]}`, "30800000", "syntax"),
		invalidCase("non-minimal-length", `{"kind":"int"}`, "02810101", "structural"),
		invalidCase("non-minimal-int", `{"kind":"int"}`, "02020001", "structural"),
		invalidCase("bad-bool", `{"kind":"bool"}`, "010101", "syntax"),
		invalidCase("empty-int", `{"kind":"int"}`, "0200", "structural"),
		invalidCase("truncated", `{"kind":"sequence","fields":[{"schema":{"kind":"int"}}]}`, "300502", "syntax"),
		invalidCase("empty-bitstring", `{"kind":"bitstring"}`, "0300", "syntax"),
		invalidCase("empty-oid", `{"kind":"oid"}`, "0600", "syntax"),
		invalidCase("huge-length", `{"kind":"octetstring"}`, "048501000000000a0b0c0d0e", "structural"),
		invalidCase("non-minimal-tag", `{"kind":"int"}`, "1f030101", "syntax"),
		invalidCase("truncated-oid", `{"kind":"oid"}`, "060280", "syntax"),
		invalidCase("bitstring-bad-pad", `{"kind":"bitstring"}`, "03020101", "syntax"),
		invalidCase("leading-zero-length", `{"kind":"int"}`, "02820001", "structural"),
		invalidCase("int-truncated-body", `{"kind":"int"}`, "020201", "syntax"),
		invalidCase("bool-truncated", `{"kind":"bool"}`, "0101", "syntax"),
	}
	cases = append(cases, invalid...)

	// 1000-deep SEQUENCE wrapping INTEGER 0
	deep := []byte{0x02, 0x01, 0x00}
	for i := 0; i < 1000; i++ {
		deep = encodeSeq(deep)
	}
	cases = append(cases, Asn1Case{
		ID:     "nest-1000",
		Schema: schemaJSON(`{"kind":"raw"}`),
		DerHex: hx(deep),
		Error:  "syntax",
	})

	if len(cases) < 45 {
		fail(fmt.Errorf("need 30+ valid and 15+ invalid, got %d", len(cases)))
	}
	return Asn1Packet{Schema: 1, Package: "serial-asn1", Cases: cases}
}

func encodeSeq(inner []byte) []byte {
	n := len(inner)
	if n < 128 {
		out := make([]byte, 0, n+2)
		out = append(out, 0x30, byte(n))
		return append(out, inner...)
	}
	if n < 256 {
		out := make([]byte, 0, n+3)
		out = append(out, 0x30, 0x81, byte(n))
		return append(out, inner...)
	}
	out := make([]byte, 0, n+4)
	out = append(out, 0x30, 0x82, byte(n>>8), byte(n))
	return append(out, inner...)
}

func verifyAsn1(packet Asn1VerifyPacket) {
	if packet.Schema != 1 || packet.Package != "serial-asn1" {
		fail(fmt.Errorf("invalid asn1 packet header"))
	}
	if len(packet.Encodes) == 0 {
		fail(fmt.Errorf("empty asn1 encodes"))
	}
	for _, c := range packet.Encodes {
		der, err := hexDecode(c.DerHex)
		if err != nil {
			fail(err)
		}
		rest, err := unmarshalKind(c.Kind, der, c.Params)
		if err != nil {
			fail(fmt.Errorf("%s: go cannot read JS DER: %v", c.ID, err))
		}
		if len(rest) != 0 {
			fail(fmt.Errorf("%s: leftover rest %x", c.ID, rest))
		}
	}
	fmt.Printf("Go verified %d serial-asn1 encode cases\n", len(packet.Encodes))
}

func hexDecode(s string) ([]byte, error) {
	if len(s)%2 != 0 {
		return nil, fmt.Errorf("odd hex")
	}
	out := make([]byte, len(s)/2)
	for i := 0; i < len(out); i++ {
		a := unhex(s[2*i])
		b := unhex(s[2*i+1])
		if a < 0 || b < 0 {
			return nil, fmt.Errorf("bad hex")
		}
		out[i] = byte(a<<4 | b)
	}
	return out, nil
}

func unhex(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c - 'a' + 10)
	case c >= 'A' && c <= 'F':
		return int(c - 'A' + 10)
	}
	return -1
}

func unmarshalKind(kind string, der []byte, params string) ([]byte, error) {
	switch kind {
	case "bool":
		var v bool
		return asn1.UnmarshalWithParams(der, &v, params)
	case "int":
		var v int
		return asn1.UnmarshalWithParams(der, &v, params)
	case "bigint":
		v := new(big.Int)
		return asn1.UnmarshalWithParams(der, &v, params)
	case "oid":
		var v asn1.ObjectIdentifier
		return asn1.UnmarshalWithParams(der, &v, params)
	case "octetstring":
		var v []byte
		return asn1.UnmarshalWithParams(der, &v, params)
	case "utf8":
		var v string
		return asn1.UnmarshalWithParams(der, &v, params)
	case "sequenceof":
		var v []int
		return asn1.UnmarshalWithParams(der, &v, params)
	case "setof":
		var v []int
		return asn1.UnmarshalWithParams(der, &v, "set")
	case "seq-ab":
		var v SeqAB
		return asn1.Unmarshal(der, &v)
	case "seq-explicit":
		var v SeqExp
		return asn1.Unmarshal(der, &v)
	case "utctime":
		var v time.Time
		return asn1.UnmarshalWithParams(der, &v, "utc")
	default:
		return nil, fmt.Errorf("unknown kind %s", kind)
	}
}
