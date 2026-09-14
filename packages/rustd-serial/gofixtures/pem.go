package main

import (
	"bytes"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"strings"
)

type PemDecodeCase struct {
	ID       string            `json:"id"`
	InputHex string            `json:"inputHex"`
	Found    bool              `json:"found"`
	Type     string            `json:"type,omitempty"`
	Headers  map[string]string `json:"headers,omitempty"`
	BytesHex string            `json:"bytesHex,omitempty"`
	RestHex  string            `json:"restHex"`
}

type PemEncodeCase struct {
	ID        string            `json:"id"`
	Type      string            `json:"type"`
	Headers   map[string]string `json:"headers,omitempty"`
	BytesHex  string            `json:"bytesHex"`
	OutputHex string            `json:"outputHex,omitempty"`
	Error     string            `json:"error,omitempty"`
}

type PemPacket struct {
	Schema  int             `json:"schema"`
	Package string          `json:"package"`
	Decodes []PemDecodeCase `json:"decodes"`
	Encodes []PemEncodeCase `json:"encodes"`
}

func testingKey(s string) string { return strings.ReplaceAll(s, "TESTING KEY", "PRIVATE KEY") }

func decodeOne(id, input string) PemDecodeCase {
	block, rest := pem.Decode([]byte(input))
	c := PemDecodeCase{ID: id, InputHex: hx([]byte(input)), RestHex: hx(rest)}
	if block == nil {
		return c
	}
	c.Found = true
	c.Type = block.Type
	if len(block.Headers) > 0 {
		c.Headers = block.Headers
	}
	c.BytesHex = hx(block.Bytes)
	return c
}

func encodeOne(id, typ string, headers map[string]string, payload []byte) PemEncodeCase {
	b := &pem.Block{Type: typ, Headers: headers, Bytes: payload}
	var buf bytes.Buffer
	err := pem.Encode(&buf, b)
	c := PemEncodeCase{ID: id, Type: typ, Headers: headers, BytesHex: hx(payload)}
	if err != nil {
		c.Error = err.Error()
		return c
	}
	c.OutputHex = hx(buf.Bytes())
	return c
}

func generatePem() PemPacket {
	empty := pem.EncodeToMemory(&pem.Block{Type: "EMPTY", Headers: map[string]string{}, Bytes: []byte{}})
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte{0x30, 0x82, 0x00, 0x05, 0x02, 0x01, 0x00}})
	keyHeaders := map[string]string{
		"Proc-Type":      "4,ENCRYPTED",
		"DEK-Info":       "AES-128-CBC,BFCD243FEDBB40A4AA6DDAA1335473A4",
		"Content-Domain": "RFC822",
	}
	keyBytes := []byte{
		0xa8, 0x35, 0xcc, 0x2b, 0xb9, 0xcb, 0x21, 0xab, 0xc0, 0x9d, 0x76, 0x61, 0x00, 0xf4, 0x81, 0xad,
		0x69, 0xd2, 0xc0, 0x42, 0x41, 0x3b, 0xe4, 0x3c, 0xaf, 0x59, 0x5e, 0x6d, 0x2a, 0x3c, 0x9c, 0xa1,
	}
	keyPem := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Headers: keyHeaders, Bytes: keyBytes})
	hello := pem.EncodeToMemory(&pem.Block{Type: "FOO", Bytes: []byte("hello")})
	spaced := bytes.ReplaceAll(hello, []byte("aGVsbG8="), []byte("aG Vs\tbG8="))
	crlf := bytes.ReplaceAll(hello, []byte("\n"), []byte("\r\n"))
	concat := append(append([]byte{}, cert...), keyPem...)
	noise := append(append([]byte("verify return:0\n---\n"), cert...), []byte("trailing noise\n")...)
	noNL := bytes.TrimRight(hello, "\n")
	garbage := "-----BEGIN FOO-----\n" + strings.Repeat("x", 10000) + "\n-----END FOO-----\n"
	missingEnd := "-----BEGIN FOO-----\n" + strings.Repeat("AAAA", 50)
	tenKBegin := strings.Repeat("-----BEGIN \n", 10000)

	decodes := []PemDecodeCase{
		decodeOne("empty-input", ""),
		decodeOne("noise-only", "not a pem at all\n"),
		decodeOne("empty-block", string(empty)),
		decodeOne("empty-block-blank-line", "-----BEGIN EMPTY-----\n\n-----END EMPTY-----\n"),
		decodeOne("empty-block-two-blanks", "-----BEGIN EMPTY-----\n\n\n-----END EMPTY-----\n"),
		decodeOne("cert-der", string(cert)),
		decodeOne("headers-key", string(keyPem)),
		decodeOne("hello", string(hello)),
		decodeOne("spaces-tabs-in-b64", string(spaced)),
		decodeOne("crlf", string(crlf)),
		decodeOne("concat-first", string(concat)),
		decodeOne("noise-before-after", string(noise)),
		decodeOne("no-trailing-nl", string(noNL)),
		decodeOne("valid-headers", "-----BEGIN VALID HEADERS-----\nHeader: 1\n\n-----END VALID HEADERS-----\n"),
		decodeOne("invalid-headers-no-nl", "-----BEGIN INVALID HEADERS-----\nHeader: 1\n-----END INVALID HEADERS-----\n"),
		decodeOne("too-few-dashes", "\n-----BEGIN FOO-----\ndGVzdA==\n-----END FOO----"),
		decodeOne("too-many-dashes", "\n-----BEGIN FOO-----\ndGVzdA==\n-----END FOO------\n"),
		decodeOne("trailing-non-ws", "\n-----BEGIN FOO-----\ndGVzdA==\n-----END FOO----- .\n"),
		decodeOne("wrong-end-type", "\n-----BEGIN FOO-----\ndGVzdA==\n-----END BAR-----\n"),
		decodeOne("missing-end-space", "\n-----BEGIN FOO-----\ndGVzdA==\n-----ENDBAR-----\n"),
		decodeOne("repeating-begin", strings.Repeat("-----BEGIN \n", 10)),
		decodeOne("missing-end-line", "\n-----BEGIN FOO-----\nHeader: 1"),
		decodeOne("begin-without-end", missingEnd),
		decodeOne("tenk-begin", tenKBegin),
		decodeOne("garbage-body-still-b64", garbage),
		decodeOne("nested-begin", "-----BEGIN OUTER-----\n-----BEGIN INNER-----\ndGVzdA==\n-----END INNER-----\n-----END OUTER-----\n"),
		decodeOne("proc-type-first", testingKey(`-----BEGIN RSA TESTING KEY-----
Proc-Type: 4,ENCRYPTED
Content-Domain: RFC822
DEK-Info: AES-128-CBC,BFCD243FEDBB40A4AA6DDAA1335473A4

qDXMK7nLIavAnXZhAPSBrWnSwEJBO+Q8r1lebSo8nKGkXmg3xIxwHKkY5sIripHc
-----END RSA TESTING KEY-----
`)),
		decodeOne("bad-base64", "-----BEGIN FOO-----\n!!!!\n-----END FOO-----\n"),
		decodeOne("leading-nl-begin", "\n-----BEGIN FOO-----\ndGVzdA==\n-----END FOO-----\n"),
	}
	// second block of concat
	_, rest := pem.Decode(concat)
	decodes = append(decodes, decodeOne("concat-second", string(rest)))

	encodes := []PemEncodeCase{
		encodeOne("empty", "EMPTY", map[string]string{}, []byte{}),
		encodeOne("hello", "FOO", nil, []byte("hello")),
		encodeOne("binary", "DATA", nil, []byte{0, 1, 2, 255, 10, 13}),
		encodeOne("headers-sorted", "RSA PRIVATE KEY", keyHeaders, keyBytes),
		encodeOne("colon-key", "BAD", map[string]string{"X:Y": "Z"}, []byte("x")),
		encodeOne("64-bytes", "B64", nil, bytes.Repeat([]byte("A"), 48)),
		encodeOne("65-bytes", "B64", nil, bytes.Repeat([]byte("A"), 49)),
		encodeOne("proc-type-only", "X", map[string]string{"Proc-Type": "4,ENCRYPTED"}, []byte("ab")),
	}

	if len(decodes) < 20 {
		fail(fmt.Errorf("need 20+ pem decode cases, got %d", len(decodes)))
	}
	return PemPacket{Schema: 1, Package: "serial-pem", Decodes: decodes, Encodes: encodes}
}

func verifyPem(packet PemPacket) {
	if packet.Schema != 1 || packet.Package != "serial-pem" {
		fail(fmt.Errorf("invalid pem packet header"))
	}
	if len(packet.Encodes) == 0 {
		fail(fmt.Errorf("empty pem encodes"))
	}
	for _, c := range packet.Encodes {
		payload, err := hex.DecodeString(c.BytesHex)
		if err != nil {
			fail(err)
		}
		var buf bytes.Buffer
		err = pem.Encode(&buf, &pem.Block{Type: c.Type, Headers: c.Headers, Bytes: payload})
		if c.Error != "" {
			if err == nil || err.Error() != c.Error {
				fail(fmt.Errorf("%s: error want %q got %v", c.ID, c.Error, err))
			}
			continue
		}
		if err != nil {
			fail(fmt.Errorf("%s: %v", c.ID, err))
		}
		if hx(buf.Bytes()) != c.OutputHex {
			fail(fmt.Errorf("%s: encode bytes differ", c.ID))
		}
		block, rest := pem.Decode(buf.Bytes())
		if block == nil {
			fail(fmt.Errorf("%s: go cannot read JS/native PEM", c.ID))
		}
		if len(rest) != 0 || block.Type != c.Type {
			fail(fmt.Errorf("%s: go round-trip type/rest", c.ID))
		}
	}
	fmt.Printf("Go verified %d serial-pem encode cases\n", len(packet.Encodes))
}
