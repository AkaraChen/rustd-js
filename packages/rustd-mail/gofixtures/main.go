package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/mail"
	"os"
	"sort"
	"strings"
	"time"
)

type HeaderKV struct {
	Key    string   `json:"key"`
	Values []string `json:"values"`
}

type MessageCase struct {
	ID       string     `json:"id"`
	InputHex string     `json:"inputHex"`
	Error    string     `json:"error,omitempty"`
	Headers  []HeaderKV `json:"headers,omitempty"`
	BodyHex  string     `json:"bodyHex,omitempty"`
	BodySHA  string     `json:"bodySha256,omitempty"`
}

type AddressOne struct {
	Name    string `json:"name"`
	Address string `json:"address"`
	String  string `json:"string"`
}

type AddressCase struct {
	ID      string       `json:"id"`
	Input   string       `json:"input"`
	List    bool         `json:"list,omitempty"`
	Error   string       `json:"error,omitempty"`
	Results []AddressOne `json:"results,omitempty"`
}

type DateCase struct {
	ID     string `json:"id"`
	Input  string `json:"input"`
	Error  string `json:"error,omitempty"`
	UnixMs int64  `json:"unixMs,omitempty"`
	RFC3339 string `json:"rfc3339,omitempty"`
}

type Packet struct {
	Schema    int           `json:"schema"`
	Package   string        `json:"package"`
	Messages  []MessageCase `json:"messages"`
	Addresses []AddressCase `json:"addresses"`
	Dates     []DateCase    `json:"dates"`
}

func hx(b []byte) string { return hex.EncodeToString(b) }

func headerKVs(h mail.Header) []HeaderKV {
	// Preserve a stable order: first-seen keys from a synthetic walk is not
	// available on Go's map; sort by canonical name for the committed dump,
	// but also include every value in Go's stored order.
	keys := make([]string, 0, len(h))
	for k := range h {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]HeaderKV, 0, len(keys))
	for _, k := range keys {
		cp := append([]string(nil), h[k]...)
		out = append(out, HeaderKV{Key: k, Values: cp})
	}
	return out
}

func msgCase(id, in string) MessageCase {
	msg, err := mail.ReadMessage(strings.NewReader(in))
	c := MessageCase{ID: id, InputHex: hx([]byte(in))}
	if err != nil {
		c.Error = err.Error()
		return c
	}
	body, _ := io.ReadAll(msg.Body)
	sum := sha256.Sum256(body)
	c.Headers = headerKVs(msg.Header)
	c.BodyHex = hx(body)
	c.BodySHA = hex.EncodeToString(sum[:])
	return c
}

func addrCase(id, in string, list bool) AddressCase {
	c := AddressCase{ID: id, Input: in, List: list}
	var (
		addrs []*mail.Address
		err   error
	)
	if list {
		addrs, err = mail.ParseAddressList(in)
	} else {
		var a *mail.Address
		a, err = mail.ParseAddress(in)
		if err == nil {
			addrs = []*mail.Address{a}
		}
	}
	if err != nil {
		c.Error = err.Error()
		return c
	}
	for _, a := range addrs {
		c.Results = append(c.Results, AddressOne{Name: a.Name, Address: a.Address, String: a.String()})
	}
	return c
}

func dateCase(id, in string) DateCase {
	c := DateCase{ID: id, Input: in}
	t, err := mail.ParseDate(in)
	if err != nil {
		c.Error = err.Error()
		return c
	}
	c.UnixMs = t.UnixMilli()
	c.RFC3339 = t.UTC().Format(time.RFC3339)
	return c
}

func main() {
	p := Packet{Schema: 1, Package: "mail"}
	p.Messages = []MessageCase{
		msgCase("rfc5322-hello", "From: John Doe <jdoe@machine.example>\r\nTo: Mary Smith <mary@example.net>\r\nSubject: Saying Hello\r\nDate: Fri, 21 Nov 1997 09:55:06 -0600\r\nMessage-ID: <1234@local.machine.example>\r\n\r\nThis is a message just to say hello.\r\nSo, \"Hello\".\r\n"),
		msgCase("lf-only", "From: John Doe <jdoe@machine.example>\nTo: Mary Smith <mary@example.net>\nSubject: Saying Hello\nDate: Fri, 21 Nov 1997 09:55:06 -0600\n\nHello\n"),
		msgCase("obs-fold", "Subject: This\r\n is a\r\n\tfolded subject\r\nFrom: a@b.com\r\n\r\nBody\r\n"),
		msgCase("tab-fold", "Subject: one\n\ttwo\nFrom: a@b.com\n\nZ\n"),
		msgCase("long-header", "Subject: "+strings.Repeat("x", 1200)+"\nFrom: a@b.com\n\nB\n"),
		msgCase("mixed-crlf", "From: a@b.com\r\nTo: c@d.com\n\nBody"),
		msgCase("nul-header", "From: a@b.com\nX-Nul: bef\x00ore\n\nBody\n"),
		msgCase("no-colon", "From a@b.com\n\nBody\n"),
		msgCase("header-only", "From: a@b.com\nSubject: hi\n"),
		msgCase("empty", ""),
		msgCase("mbox-from", "From iant@golang.org Mon Jun 19 00:00:00 2023\nFrom: iant@golang.org\n\nHello, gophers!\n"),
		msgCase("custom-slash", "From: iant@golang.org\nCustom/Header: v\n\nBody\n"),
		msgCase("dup-received", "Received: a\nReceived: b\nFrom: x@y.z\n\nZ\n"),
		msgCase("header-only-no-body-blank", "From: a@b.com\nSubject: hi"),
		msgCase("leading-space", " Subject: x\n\nB\n"),
	}
	p.Addresses = []AddressCase{
		addrCase("bare", "jdoe@machine.example", false),
		addrCase("name-addr", "John Doe <jdoe@machine.example>", false),
		addrCase("quoted-name", `"Joe Q. Public" <john.q.public@example.com>`, false),
		addrCase("comment-name", "John (middle) Doe <jdoe@machine.example>", false),
		addrCase("quoted-comment", `"John (middle) Doe" <jdoe@machine.example>`, false),
		addrCase("angle-bare", "<boss@nil.test>", false),
		addrCase("group-one", "group1: groupaddr1@example.com;", false),
		addrCase("empty-group", "empty group: ;", false),
		addrCase("list-basic", `Mary Smith <mary@x.test>, jdoe@example.org, Who? <one@y.test>`, true),
		addrCase("list-group", `A Group:Ed Jones <c@a.test>,joe@where.test,John <jdoe@one.test>;`, true),
		addrCase("obs-list", ` , joe@where.test,,John <jdoe@one.test>,`, true),
		addrCase("q-iso", "=?iso-8859-1?q?J=F6rg_Doe?= <joerg@example.com>", false),
		addrCase("q-ascii", "=?us-ascii?q?J=6Frg_Doe?= <joerg@example.com>", false),
		addrCase("b-utf8", "=?utf-8?B?SsO2cmc=?= <joerg@example.com>", false),
		addrCase("comma-name", `"Smith, John" <john@example.com>`, false),
		addrCase("esc-quote", `"Giant; \"Big\" Box" <sysservices@example.net>`, false),
		addrCase("bad-iso2", "=?iso-8859-2?Q?Bogl=E1rka_Tak=E1cs?= <unknown@gmail.com>", false),
		addrCase("two-addr", "a@gmail.com b@gmail.com", false),
		addrCase("no-angle", "John Doe", false),
		addrCase("missing-at", `<jdoe#machine.example>`, false),
		addrCase("empty-angle", "<>", false),
		addrCase("unclosed", "<a@b", false),
		addrCase("extra-gt", "a@b>", false),
		addrCase("double-at", "a@@b", false),
		addrCase("john.doe", "john.doe", false),
		addrCase("empty-group-single", "empty group: ;", false),
		addrCase("multi-group-single", "group: first@example.com, second@example.com;", false),
		addrCase("cfws-open", "cfws@example.com (", false),
		addrCase("display-comment", `jdoe@machine.example (John Doe)`, false),
		addrCase("ip-literal", "user@[127.0.0.1]", false),
		addrCase("quoted-local", `"foo bar"@example.com`, false),
	}
	p.Dates = []DateCase{
		dateCase("rfc5322", "Fri, 21 Nov 1997 09:55:06 -0600"),
		dateCase("obs", "21 Nov 97 09:55:06 GMT"),
		dateCase("comment-zone", "Fri, 21 Nov 1997 09:55:06 -0600 (MDT)"),
		dateCase("gmt-comment", "Thu, 20 Nov 1997 09:55:06 GMT (GMT)"),
		dateCase("plus1300", "Fri, 21 Nov 1997 09:55:06 +1300 (TOT)"),
		dateCase("lead-fws", "   Fri, 21 Nov 1997 09:55:06 -0600"),
		dateCase("no-dow", "21 Nov 1997 09:55:06 -0600"),
		dateCase("missing-comma", "Fri 21 Nov 1997 09:55:06 -0600"),
		dateCase("spaces", "Fri,        21 Nov 1997 09:55:06 -0600"),
		dateCase("year-spaces", "Fri, 21 Nov       1997     09:55:06 -0600"),
		dateCase("cst", "Fri, 21 Nov 1997 09:55:06           CST"),
		dateCase("gmt", "Tue, 26 May 2020 14:04:40 GMT"),
		dateCase("ut", "Tue, 26 May 2020 14:04:40 UT"),
		dateCase("utc", "Thu, 21 May 2020 14:04:40 UTC"),
		dateCase("xt", "Tue, 26 May 2020 14:04:40 XT"),
		dateCase("minus0000", "Fri, 21 Nov 1997 09:55:06 -0000"),
		dateCase("plus0000", "Fri, 21 Nov 1997 09:55:06 +0000"),
		dateCase("pdt", "Fri, 21 Nov 1997 09:55:06 PDT"),
		dateCase("est", "Fri, 21 Nov 1997 09:55:06 EST"),
		dateCase("military-z", "Fri, 21 Nov 1997 09:55:06 Z"),
		dateCase("two-digit-69", "21 Nov 69 09:55:06 GMT"),
		dateCase("two-digit-68", "21 Nov 68 09:55:06 GMT"),
		dateCase("no-seconds", "Fri, 21 Nov 1997 09:55 -0600"),
		dateCase("cr-only", "Fri, 21 Nov 1997 \r 09:55:06 -0600"),
		dateCase("bad", "not a date"),
		dateCase("empty", "   "),
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(p); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
