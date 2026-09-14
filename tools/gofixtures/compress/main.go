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
	"path/filepath"
	"strings"
)

type LzwCase struct {
	ID            string `json:"id"`
	Order         string `json:"order"`
	LitWidth      int    `json:"litWidth"`
	InputHex      string `json:"inputHex"`
	CompressedHex string `json:"compressedHex"`
}

type LzwErrorCase struct {
	ID            string `json:"id"`
	Order         string `json:"order"`
	LitWidth      int    `json:"litWidth"`
	CompressedHex string `json:"compressedHex"`
	Error         string `json:"error,omitempty"`
	PlainHex      string `json:"plainHex,omitempty"` // present on success, including empty output
}

type BzipCase struct {
	ID            string `json:"id"`
	File          string `json:"file,omitempty"`
	CompressedB64 string `json:"compressedB64"`
	SHA256        string `json:"sha256,omitempty"`
	Error         string `json:"error,omitempty"`
}

type Packet struct {
	Schema    int            `json:"schema"`
	Package   string         `json:"package"`
	Lzw       []LzwCase      `json:"lzw,omitempty"`
	LzwErrors []LzwErrorCase `json:"lzwErrors,omitempty"`
	Bzip      []BzipCase     `json:"bzip,omitempty"`
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

func lzwErrorOf(data []byte, order string, litWidth int) LzwErrorCase {
	plain, err := lzwDecompress(data, order, litWidth)
	c := LzwErrorCase{
		Order:         order,
		LitWidth:      litWidth,
		CompressedHex: hex.EncodeToString(data),
	}
	if err != nil {
		c.Error = err.Error()
	} else {
		c.PlainHex = hex.EncodeToString(plain)
	}
	return c
}

func generateLzwErrors() []LzwErrorCase {
	var out []LzwErrorCase
	for _, order := range []string{"lsb", "msb"} {
		src := pattern(16, 1, 8)
		compressed, err := lzwCompress(src, order, 8)
		if err != nil {
			fail(err)
		}
		empty := lzwErrorOf(nil, order, 8)
		empty.ID = fmt.Sprintf("%s-8-empty", order)
		out = append(out, empty)
		for i := 0; i <= len(compressed); i++ {
			c := lzwErrorOf(compressed[:i], order, 8)
			c.ID = fmt.Sprintf("%s-8-16-trunc-%d", order, i)
			out = append(out, c)
		}
		for i := 0; i < len(compressed); i++ {
			flip := bytes.Clone(compressed)
			flip[i] ^= 0xff
			c := lzwErrorOf(flip, order, 8)
			c.ID = fmt.Sprintf("%s-8-16-flip-%d", order, i)
			out = append(out, c)
		}
	}
	return out
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

func catalogBz(id, file string, data []byte) BzipCase {
	c := BzipCase{
		ID:            id,
		File:          file,
		CompressedB64: base64.StdEncoding.EncodeToString(data),
	}
	plain, err := bzDecompress(data)
	if err != nil {
		c.Error = err.Error()
	} else {
		c.SHA256 = sha(plain)
	}
	return c
}

func writeBz2(dir, file string, data []byte) {
	if dir == "" || file == "" {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fail(err)
	}
	if err := os.WriteFile(filepath.Join(dir, file), data, 0o644); err != nil {
		fail(err)
	}
}

func generateBzip(testdataDir string) []BzipCase {
	hello := []byte("hello rustd-compress\n")
	empty := []byte{}
	block := lcg(4096, 99)
	rep := bytes.Repeat([]byte("ab"), 2048)
	level1 := bzCompress(hello, "1")
	level5 := bzCompress(hello, "5")
	level9 := bzCompress(hello, "9")
	emptyBz := bzCompress(empty, "9")
	blockBz := bzCompress(block, "9")
	repBz := bzCompress(rep, "1")
	concat := append(append([]byte{}, level1...), level9...)
	badMagic := bytes.Clone(level9)
	badMagic[0] ^= 0xff
	trunc := level9[:len(level9)/2]
	flip := bytes.Clone(level9)
	if len(flip) > 10 {
		flip[10] ^= 0x01
	}
	committed := []struct {
		id   string
		data []byte
	}{
		{"empty-9", emptyBz},
		{"hello-1", level1},
		{"hello-5", level5},
		{"hello-9", level9},
		{"concat-hello", concat},
		{"lcg4k-9", blockBz},
		{"repeat-1", repBz},
		{"bad-magic", badMagic},
		{"truncated-half", trunc},
		{"flipped-10", flip},
	}
	var out []BzipCase
	for _, c := range committed {
		file := c.id + ".bz2"
		writeBz2(testdataDir, file, c.data)
		out = append(out, catalogBz(c.id, file, c.data))
	}
	for i := 0; i < len(level9); i++ {
		mut := bytes.Clone(level9)
		mut[i] ^= 0x01
		out = append(out, catalogBz(fmt.Sprintf("hello-9-flip-%d", i), "", mut))
	}
	for i := 0; i < len(level1); i++ {
		out = append(out, catalogBz(fmt.Sprintf("hello-1-trunc-%d", i), "", level1[:i]))
	}
	for i := 0; i < len(level9); i++ {
		out = append(out, catalogBz(fmt.Sprintf("hello-9-trunc-%d", i), "", level9[:i]))
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

func verifyLzwErrors(p Packet) {
	if len(p.LzwErrors) == 0 {
		fail(fmt.Errorf("empty lzw error cases"))
	}
	for _, c := range p.LzwErrors {
		data, err := hex.DecodeString(c.CompressedHex)
		if err != nil {
			fail(err)
		}
		plain, err := lzwDecompress(data, c.Order, c.LitWidth)
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
		if hex.EncodeToString(plain) != c.PlainHex {
			fail(fmt.Errorf("%s: plain bytes differ", c.ID))
		}
	}
	fmt.Printf("Go verified %d lzw error cases\n", len(p.LzwErrors))
}

func verifyBzip(p Packet, testdataDir string) {
	if len(p.Bzip) == 0 {
		fail(fmt.Errorf("empty bzip cases"))
	}
	files := 0
	for _, c := range p.Bzip {
		data, err := base64.StdEncoding.DecodeString(c.CompressedB64)
		if err != nil {
			fail(err)
		}
		if c.File != "" && testdataDir != "" {
			disk, err := os.ReadFile(filepath.Join(testdataDir, c.File))
			if err != nil {
				fail(fmt.Errorf("%s: %w", c.ID, err))
			}
			if !bytes.Equal(disk, data) {
				fail(fmt.Errorf("%s: testdata/%s differs from catalog bytes", c.ID, c.File))
			}
			files++
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
	if testdataDir != "" && files == 0 {
		fail(fmt.Errorf("no catalog cases named a testdata file"))
	}
	fmt.Printf("Go verified %d bzip cases (%d testdata files)\n", len(p.Bzip), files)
}

func main() {
	pkg := flag.String("pkg", "lzw", "lzw, lzw-errors, or bzip2")
	out := flag.String("out", "", "output JSON file, testdata directory, or stdout")
	testdata := flag.String("testdata", "", "write/read committed .bz2 streams here")
	verify := flag.Bool("verify", false, "verify a packet read from stdin")
	flag.Parse()
	if *pkg != "lzw" && *pkg != "lzw-errors" && *pkg != "bzip2" {
		fail(fmt.Errorf("unsupported package %q", *pkg))
	}
	outPath := *out
	if outPath != "" {
		info, err := os.Stat(outPath)
		if (err == nil && info.IsDir()) || strings.HasSuffix(outPath, string(filepath.Separator)) || strings.HasSuffix(outPath, "/") {
			if *testdata == "" {
				*testdata = strings.TrimRight(outPath, `/\`)
			}
			if err := os.MkdirAll(*testdata, 0o755); err != nil {
				fail(err)
			}
			outPath = filepath.Join(*testdata, *pkg+".json")
		}
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
		switch *pkg {
		case "lzw":
			verifyLzw(packet)
		case "lzw-errors":
			verifyLzwErrors(packet)
		default:
			verifyBzip(packet, *testdata)
		}
		return
	}
	packet := Packet{Schema: 1, Package: *pkg}
	switch *pkg {
	case "lzw":
		packet.Lzw = generateLzw()
	case "lzw-errors":
		packet.LzwErrors = generateLzwErrors()
	default:
		packet.Bzip = generateBzip(*testdata)
	}
	var writer io.Writer = os.Stdout
	if outPath != "" {
		if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
			fail(err)
		}
		f, err := os.Create(outPath)
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
	if *pkg == "bzip2" && *testdata != "" {
		catalogPath := filepath.Join(*testdata, "bzip2.json")
		if catalogPath != outPath {
			f, err := os.Create(catalogPath)
			if err != nil {
				fail(err)
			}
			if err := json.NewEncoder(f).Encode(packet); err != nil {
				fail(err)
			}
			_ = f.Close()
		}
	}
}
