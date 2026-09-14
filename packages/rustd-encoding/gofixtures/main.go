package main

import (
	"bytes"
	"encoding/ascii85"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
)

type Case struct {
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	SrcHex  string `json:"srcHex"`
	EncHex  string `json:"encHex"`
	Flush   *bool  `json:"flush,omitempty"`
	Error   string `json:"error,omitempty"`
	Value   string `json:"value,omitempty"`
	Signed  bool   `json:"signed,omitempty"`
	Dump    string `json:"dump,omitempty"`
	Strict  bool   `json:"strict,omitempty"`
	Padding string `json:"padding,omitempty"`
}

type Packet struct {
	Version int    `json:"version"`
	Cases   []Case `json:"cases"`
}

func lcg(n int, seed uint32) []byte {
	b := make([]byte, n)
	state := seed
	for i := range b {
		state = 1664525*state + 1013904223
		b[i] = byte(state >> 24)
	}
	return b
}

func b64(name string, enc *base64.Encoding) {
	for _, n := range append(seq(0, 17), 1024) {
		src := lcg(n, 42)
		out := enc.EncodeToString(src)
		packet.Cases = append(packet.Cases, Case{
			Kind: "base64", Name: name, SrcHex: hex.EncodeToString(src), EncHex: hex.EncodeToString([]byte(out)),
		})
	}
}

func b32(name string, enc *base32.Encoding) {
	for _, n := range append(seq(0, 17), 1024) {
		src := lcg(n, 7)
		out := enc.EncodeToString(src)
		packet.Cases = append(packet.Cases, Case{
			Kind: "base32", Name: name, SrcHex: hex.EncodeToString(src), EncHex: hex.EncodeToString([]byte(out)),
		})
	}
}

func seq(a, b int) []int {
	out := make([]int, 0, b-a+1)
	for i := a; i <= b; i++ {
		out = append(out, i)
	}
	return out
}

var packet Packet

func main() {
	verify := flag.Bool("verify", false, "verify a packet from stdin")
	flag.Parse()
	if *verify {
		dec := json.NewDecoder(io.LimitReader(os.Stdin, 32<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&packet); err != nil {
			fail(err)
		}
		if packet.Version != 1 || len(packet.Cases) == 0 {
			fail(fmt.Errorf("invalid packet"))
		}
		for i, c := range packet.Cases {
			if err := check(c); err != nil {
				fail(fmt.Errorf("case %d %s/%s: %w", i, c.Kind, c.Name, err))
			}
		}
		fmt.Printf("Go verified %d encoding cases\n", len(packet.Cases))
		return
	}
	packet.Version = 1
	b64("std", base64.StdEncoding)
	b64("url", base64.URLEncoding)
	b64("rawstd", base64.RawStdEncoding)
	b64("rawurl", base64.RawURLEncoding)
	custom := base64.NewEncoding("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/").WithPadding('!')
	b64("pad-bang", custom)
	b64("strict-std", base64.StdEncoding.Strict())
	b32("std", base32.StdEncoding)
	b32("hex", base32.HexEncoding)
	b32("rawstd", base32.StdEncoding.WithPadding(base32.NoPadding))
	b32("rawhex", base32.HexEncoding.WithPadding(base32.NoPadding))
	custom32 := base32.NewEncoding("0123456789abcdefghijklmnopqrstuv").WithPadding('!')
	b32("pad-bang", custom32)

	for _, n := range append(seq(0, 17), 64, 1024) {
		src := lcg(n, 99)
		enc := hex.EncodeToString(src)
		packet.Cases = append(packet.Cases, Case{Kind: "hex", Name: "std", SrcHex: hex.EncodeToString(src), EncHex: hex.EncodeToString([]byte(enc))})
		packet.Cases = append(packet.Cases, Case{Kind: "hexdump", Name: "dump", SrcHex: hex.EncodeToString(src), Dump: hex.Dump(src)})
	}
	packet.Cases = append(packet.Cases,
		Case{Kind: "hex-error", Name: "odd", SrcHex: hex.EncodeToString([]byte("abc")), Error: "length"},
		Case{Kind: "hex-error", Name: "invalid", SrcHex: hex.EncodeToString([]byte("zz")), Error: "byte"},
	)

	for _, flush := range []bool{true, false} {
		for _, n := range append(seq(0, 8), 64) {
			src := lcg(n, 3)
			var buf bytes.Buffer
			enc := ascii85.NewEncoder(&buf)
			if _, err := enc.Write(src); err != nil {
				fail(err)
			}
			if err := enc.Close(); err != nil {
				fail(err)
			}
			fl := flush
			packet.Cases = append(packet.Cases, Case{
				Kind: "ascii85", Name: fmt.Sprintf("n%d-flush%v", n, flush),
				SrcHex: hex.EncodeToString(src), EncHex: hex.EncodeToString(buf.Bytes()), Flush: &fl,
			})
		}
	}
	ws := []byte(" <~!!!!~> \n\t")
	dst := make([]byte, 16)
	_, _, err := ascii85.Decode(dst, ws, true)
	idx := ""
	if ce, ok := err.(ascii85.CorruptInputError); ok {
		idx = fmt.Sprintf("%d", int64(ce))
	} else {
		fail(fmt.Errorf("ascii85-ws: want CorruptInputError, got %v", err))
	}
	packet.Cases = append(packet.Cases, Case{
		Kind: "ascii85-ws", Name: "whitespace-and-wrapper",
		SrcHex: hex.EncodeToString(ws), EncHex: hex.EncodeToString(ws), Flush: boolPtr(true), Error: idx,
	})

	values := []uint64{0, 1, 127, 128, 255, 300, 1<<32 - 1, 1<<53 + 1, 1<<63 - 1, ^uint64(0)}
	for _, v := range values {
		buf := make([]byte, binary.MaxVarintLen64)
		n := binary.PutUvarint(buf, v)
		packet.Cases = append(packet.Cases, Case{Kind: "uvarint", Name: fmt.Sprintf("%d", v), Value: fmt.Sprintf("%d", v), EncHex: hex.EncodeToString(buf[:n])})
	}
	svalues := []int64{0, 1, -1, 127, -128, 1<<31 - 1, -1 << 31, 1<<62, -(1 << 62)}
	for _, v := range svalues {
		buf := make([]byte, binary.MaxVarintLen64)
		n := binary.PutVarint(buf, v)
		packet.Cases = append(packet.Cases, Case{Kind: "varint", Name: fmt.Sprintf("%d", v), Value: fmt.Sprintf("%d", v), EncHex: hex.EncodeToString(buf[:n]), Signed: true})
	}

	if err := json.NewEncoder(os.Stdout).Encode(packet); err != nil {
		fail(err)
	}
}

func boolPtr(v bool) *bool { return &v }

func check(c Case) error {
	src, err := hex.DecodeString(c.SrcHex)
	if err != nil && c.SrcHex != "" {
		return err
	}
	switch c.Kind {
	case "base64":
		enc := encoding64(c.Name)
		got := enc.EncodeToString(src)
		if hex.EncodeToString([]byte(got)) != c.EncHex {
			return fmt.Errorf("mismatch")
		}
		back, err := enc.DecodeString(got)
		if err != nil {
			return err
		}
		if !bytes.Equal(back, src) {
			return fmt.Errorf("roundtrip")
		}
	case "base32":
		enc := encoding32(c.Name)
		got := enc.EncodeToString(src)
		if hex.EncodeToString([]byte(got)) != c.EncHex {
			return fmt.Errorf("mismatch")
		}
		back, err := enc.DecodeString(got)
		if err != nil {
			return err
		}
		if !bytes.Equal(back, src) {
			return fmt.Errorf("roundtrip")
		}
	case "hex":
		got := hex.EncodeToString(src)
		if hex.EncodeToString([]byte(got)) != c.EncHex {
			return fmt.Errorf("mismatch")
		}
	case "hexdump":
		if hex.Dump(src) != c.Dump {
			return fmt.Errorf("dump mismatch")
		}
	case "ascii85":
		var buf bytes.Buffer
		w := ascii85.NewEncoder(&buf)
		if _, err := w.Write(src); err != nil {
			return err
		}
		if err := w.Close(); err != nil {
			return err
		}
		if hex.EncodeToString(buf.Bytes()) != c.EncHex {
			return fmt.Errorf("mismatch")
		}
	case "uvarint":
		var v uint64
		fmt.Sscan(c.Value, &v)
		buf := make([]byte, binary.MaxVarintLen64)
		n := binary.PutUvarint(buf, v)
		if hex.EncodeToString(buf[:n]) != c.EncHex {
			return fmt.Errorf("mismatch")
		}
	case "varint":
		var v int64
		fmt.Sscan(c.Value, &v)
		buf := make([]byte, binary.MaxVarintLen64)
		n := binary.PutVarint(buf, v)
		if hex.EncodeToString(buf[:n]) != c.EncHex {
			return fmt.Errorf("mismatch")
		}
	case "hex-error":
		_, err := hex.Decode(make([]byte, hex.DecodedLen(len(src))), src)
		switch c.Name {
		case "odd":
			if err != hex.ErrLength {
				return fmt.Errorf("want ErrLength, got %v", err)
			}
		case "invalid":
			inv, ok := err.(hex.InvalidByteError)
			if !ok || byte(inv) != 'z' {
				return fmt.Errorf("want InvalidByteError z, got %v", err)
			}
		default:
			return fmt.Errorf("unknown hex-error name")
		}
	case "ascii85-ws":
		flush := true
		if c.Flush != nil {
			flush = *c.Flush
		}
		_, _, err := ascii85.Decode(make([]byte, 16), src, flush)
		ce, ok := err.(ascii85.CorruptInputError)
		if !ok {
			return fmt.Errorf("want CorruptInputError, got %v", err)
		}
		if c.Error != "" && fmt.Sprintf("%d", int64(ce)) != c.Error {
			return fmt.Errorf("byte index %d want %s", int64(ce), c.Error)
		}
		if int64(ce) != 2 {
			return fmt.Errorf("byte index %d want 2", int64(ce))
		}
	default:
		return fmt.Errorf("unknown kind")
	}
	return nil
}

func encoding64(name string) *base64.Encoding {
	switch name {
	case "std", "strict-std":
		if name == "strict-std" {
			return base64.StdEncoding.Strict()
		}
		return base64.StdEncoding
	case "url":
		return base64.URLEncoding
	case "rawstd":
		return base64.RawStdEncoding
	case "rawurl":
		return base64.RawURLEncoding
	case "pad-bang":
		return base64.NewEncoding("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/").WithPadding('!')
	default:
		panic(name)
	}
}

func encoding32(name string) *base32.Encoding {
	switch name {
	case "std":
		return base32.StdEncoding
	case "hex":
		return base32.HexEncoding
	case "rawstd":
		return base32.StdEncoding.WithPadding(base32.NoPadding)
	case "rawhex":
		return base32.HexEncoding.WithPadding(base32.NoPadding)
	case "pad-bang":
		return base32.NewEncoding("0123456789abcdefghijklmnopqrstuv").WithPadding('!')
	default:
		panic(name)
	}
}

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
