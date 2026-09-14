// Go 1.24 reference for rustd-compress (compress/bzip2 + compress/lzw).
package main

import (
	"bytes"
	"compress/bzip2"
	"compress/lzw"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
)

type LzwCase struct {
	ID            string `json:"id"`
	Order         string `json:"order"`
	LitWidth      int    `json:"litWidth"`
	InputHex      string `json:"inputHex"`
	CompressedHex string `json:"compressedHex"`
}

type BzipCase struct {
	ID            string `json:"id"`
	CompressedB64 string `json:"compressedB64"`
	SHA256        string `json:"sha256,omitempty"`
	Error         string `json:"error,omitempty"`
}

type Packet struct {
	Schema  int        `json:"schema"`
	Package string     `json:"package"`
	Lzw     []LzwCase  `json:"lzw,omitempty"`
	Bzip    []BzipCase `json:"bzip,omitempty"`
}

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }

func lcg(n int, seed uint32) []byte {
	data := make([]byte, n)
	state := seed
	for i := range data {
		state = 1664525*state + 1013904223
		data[i] = byte(state >> 24)
	}
	return data
}

func goOrder(name string) lzw.Order {
	if name == "msb" {
		return lzw.MSB
	}
	return lzw.LSB
}

func lzwCompress(data []byte, order string, litWidth int) ([]byte, error) {
	var buf bytes.Buffer
	w := lzw.NewWriter(&buf, goOrder(order), litWidth)
	if _, err := w.Write(data); err != nil {
		_ = w.Close()
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func lzwDecompress(data []byte, order string, litWidth int) ([]byte, error) {
	r := lzw.NewReader(bytes.NewReader(data), goOrder(order), litWidth)
	defer r.Close()
	return io.ReadAll(r)
}

func pattern(n, seed int, litWidth int) []byte {
	max := byte((1 << litWidth) - 1)
	if litWidth >= 8 {
		max = 255
	}
	data := make([]byte, n)
	for i := range data {
		data[i] = byte((i*31+seed)&int(max)) & max
	}
	return data
}

func generateLzw() []LzwCase {
	var cases []LzwCase
	orders := []string{"lsb", "msb"}
	for litWidth := 2; litWidth <= 8; litWidth++ {
		for _, order := range orders {
			inputs := []struct {
				name string
				data []byte
			}{
				{"empty", nil},
				{"1", pattern(1, 1, litWidth)},
				{"16", pattern(16, 2, litWidth)},
				{"256", pattern(256, 3, litWidth)},
				{"repeat", bytes.Repeat([]byte{0}, 1024)},
				{"boundary", pattern(4096, 7, litWidth)},
			}
			if litWidth == 8 {
				inputs = append(inputs, struct {
					name string
					data []byte
				}{"lcg4k", lcg(4096, 42)})
			}
			for _, in := range inputs {
				compressed, err := lzwCompress(in.data, order, litWidth)
				if err != nil {
					fail(fmt.Errorf("%s/%s/%d: %w", order, in.name, litWidth, err))
				}
				round, err := lzwDecompress(compressed, order, litWidth)
				if err != nil {
					fail(fmt.Errorf("roundtrip %s/%s/%d: %w", order, in.name, litWidth, err))
				}
				if !bytes.Equal(round, in.data) {
					fail(fmt.Errorf("go roundtrip mismatch %s/%s/%d", order, in.name, litWidth))
				}
				cases = append(cases, LzwCase{
					ID:            fmt.Sprintf("%s-%d-%s", order, litWidth, in.name),
					Order:         order,
					LitWidth:      litWidth,
					InputHex:      hex.EncodeToString(in.data),
					CompressedHex: hex.EncodeToString(compressed),
				})
			}
		}
	}
	return cases
}

func bzCompress(data []byte, level string) []byte {
	cmd := exec.Command("bzip2", "-c", "-"+level)
	cmd.Stdin = bytes.NewReader(data)
	out, err := cmd.Output()
	if err != nil {
		fail(fmt.Errorf("bzip2 -%s: %w", level, err))
	}
	return out
}

func bzDecompress(data []byte) ([]byte, error) {
	return io.ReadAll(bzip2.NewReader(bytes.NewReader(data)))
}

func sha(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func generateBzip() []BzipCase {
	hello := []byte("hello rustd-compress\n")
	empty := []byte{}
	block := lcg(4096, 99)
	rep := bytes.Repeat([]byte("ab"), 2048)
	level1 := bzCompress(hello, "1")
	level9 := bzCompress(hello, "9")
	emptyBz := bzCompress(empty, "9")
	blockBz := bzCompress(block, "9")
	repBz := bzCompress(rep, "1")
	concat := append(append([]byte{}, level1...), level9...)
	cases := []struct {
		id   string
		data []byte
	}{
		{"empty-9", emptyBz},
		{"hello-1", level1},
		{"hello-9", level9},
		{"concat-hello", concat},
		{"lcg4k-9", blockBz},
		{"repeat-1", repBz},
	}
	var out []BzipCase
	for _, c := range cases {
		plain, err := bzDecompress(c.data)
		if err != nil {
			fail(fmt.Errorf("%s decompress: %w", c.id, err))
		}
		out = append(out, BzipCase{
			ID:            c.id,
			CompressedB64: base64.StdEncoding.EncodeToString(c.data),
			SHA256:        sha(plain),
		})
	}
	badMagic := bytes.Clone(level9)
	badMagic[0] ^= 0xff
	if _, err := bzDecompress(badMagic); err == nil {
		fail(fmt.Errorf("expected bad magic to fail"))
	} else {
		out = append(out, BzipCase{
			ID:            "bad-magic",
			CompressedB64: base64.StdEncoding.EncodeToString(badMagic),
			Error:         err.Error(),
		})
	}
	trunc := level9[:len(level9)/2]
	if _, err := bzDecompress(trunc); err == nil {
		fail(fmt.Errorf("expected truncated stream to fail"))
	} else {
		out = append(out, BzipCase{
			ID:            "truncated-half",
			CompressedB64: base64.StdEncoding.EncodeToString(trunc),
			Error:         err.Error(),
		})
	}
	flip := bytes.Clone(level9)
	if len(flip) > 10 {
		flip[10] ^= 0x01
	}
	if _, err := bzDecompress(flip); err != nil {
		out = append(out, BzipCase{
			ID:            "flipped-10",
			CompressedB64: base64.StdEncoding.EncodeToString(flip),
			Error:         err.Error(),
		})
	} else {
		plain, _ := bzDecompress(flip)
		out = append(out, BzipCase{
			ID:            "flipped-10",
			CompressedB64: base64.StdEncoding.EncodeToString(flip),
			SHA256:        sha(plain),
		})
	}
	for i := 0; i < len(level1); i++ {
		cut := level1[:i]
		plain, err := bzDecompress(cut)
		c := BzipCase{
			ID:            fmt.Sprintf("hello-1-trunc-%d", i),
			CompressedB64: base64.StdEncoding.EncodeToString(cut),
		}
		if err != nil {
			c.Error = err.Error()
		} else {
			c.SHA256 = sha(plain)
		}
		out = append(out, c)
	}
	return out
}

func verifyLzw(p Packet) {
	if len(p.Lzw) == 0 {
		fail(fmt.Errorf("empty lzw cases"))
	}
	for _, c := range p.Lzw {
		input, err := hex.DecodeString(c.InputHex)
		if err != nil {
			fail(err)
		}
		compressed, err := hex.DecodeString(c.CompressedHex)
		if err != nil {
			fail(err)
		}
		got, err := lzwCompress(input, c.Order, c.LitWidth)
		if err != nil {
			fail(fmt.Errorf("%s compress: %w", c.ID, err))
		}
		if !bytes.Equal(got, compressed) {
			fail(fmt.Errorf("%s: compressed bytes differ", c.ID))
		}
		plain, err := lzwDecompress(compressed, c.Order, c.LitWidth)
		if err != nil {
			fail(fmt.Errorf("%s decompress: %w", c.ID, err))
		}
		if !bytes.Equal(plain, input) {
			fail(fmt.Errorf("%s: decompressed bytes differ", c.ID))
		}
	}
	fmt.Printf("Go verified %d lzw cases\n", len(p.Lzw))
}

func verifyBzip(p Packet) {
	if len(p.Bzip) == 0 {
		fail(fmt.Errorf("empty bzip cases"))
	}
	for _, c := range p.Bzip {
		data, err := base64.StdEncoding.DecodeString(c.CompressedB64)
		if err != nil {
			fail(err)
		}
		plain, err := bzDecompress(data)
		if c.Error != "" {
			if err == nil {
				fail(fmt.Errorf("%s: expected error %q", c.ID, c.Error))
			}
			if err.Error() != c.Error {
				fail(fmt.Errorf("%s: expected %q got %q", c.ID, c.Error, err.Error()))
			}
			continue
		}
		if err != nil {
			fail(fmt.Errorf("%s: %w", c.ID, err))
		}
		if sha(plain) != c.SHA256 {
			fail(fmt.Errorf("%s: sha256 mismatch", c.ID))
		}
	}
	fmt.Printf("Go verified %d bzip cases\n", len(p.Bzip))
}

func main() {
	pkg := flag.String("pkg", "lzw", "lzw or bzip2")
	out := flag.String("out", "", "output JSON file; stdout by default")
	verify := flag.Bool("verify", false, "verify a packet read from stdin")
	flag.Parse()
	if *pkg != "lzw" && *pkg != "bzip2" {
		fail(fmt.Errorf("unsupported package %q", *pkg))
	}
	if *verify {
		dec := json.NewDecoder(io.LimitReader(os.Stdin, 64<<20))
		dec.DisallowUnknownFields()
		var packet Packet
		if err := dec.Decode(&packet); err != nil {
			fail(err)
		}
		if packet.Schema != 1 || packet.Package != *pkg {
			fail(fmt.Errorf("invalid packet header"))
		}
		if *pkg == "lzw" {
			verifyLzw(packet)
		} else {
			verifyBzip(packet)
		}
		return
	}
	packet := Packet{Schema: 1, Package: *pkg}
	if *pkg == "lzw" {
		packet.Lzw = generateLzw()
	} else {
		packet.Bzip = generateBzip()
	}
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
