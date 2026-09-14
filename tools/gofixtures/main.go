package main

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"hash"
	"hash/adler32"
	"hash/crc32"
	"hash/crc64"
	"hash/fnv"
	"io"
	"os"
)

type Case struct {
	ID          string            `json:"id"`
	Hex         string            `json:"hex"`
	Expected    map[string]string `json:"expected"`
	Incremental map[string]string `json:"incremental,omitempty"`
}
type Packet struct {
	Schema  int    `json:"schema"`
	Package string `json:"package"`
	Cases   []Case `json:"cases"`
}

func hashes() map[string]func() hash.Hash {
	return map[string]func() hash.Hash{
		"adler32":          func() hash.Hash { return adler32.New() },
		"crc32-ieee":       func() hash.Hash { return crc32.NewIEEE() },
		"crc32-castagnoli": func() hash.Hash { return crc32.New(crc32.MakeTable(crc32.Castagnoli)) },
		"crc32-koopman":    func() hash.Hash { return crc32.New(crc32.MakeTable(crc32.Koopman)) },
		"crc32-custom":     func() hash.Hash { return crc32.New(crc32.MakeTable(0xa833982b)) },
		"crc64-iso":        func() hash.Hash { return crc64.New(crc64.MakeTable(crc64.ISO)) },
		"crc64-ecma":       func() hash.Hash { return crc64.New(crc64.MakeTable(crc64.ECMA)) },
		"fnv32":            func() hash.Hash { return fnv.New32() }, "fnv32a": func() hash.Hash { return fnv.New32a() },
		"fnv64": func() hash.Hash { return fnv.New64() }, "fnv64a": func() hash.Hash { return fnv.New64a() },
		"fnv128": fnv.New128, "fnv128a": fnv.New128a,
	}
}
func results(pkg string, data []byte, incremental bool) map[string]string {
	if pkg == "template" {
		return map[string]string{"echo": hex.EncodeToString(data)}
	}
	values := map[string]string{}
	for name, create := range hashes() {
		h := create()
		if incremental {
			rest := data
			for _, n := range []int{1, 3, 7, 64, 1024} {
				if n > len(rest) {
					n = len(rest)
				}
				h.Write(rest[:n])
				rest = rest[n:]
			}
			h.Write(rest)
		} else {
			h.Write(data)
		}
		values[name] = hex.EncodeToString(h.Sum(nil))
	}
	return values
}
func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
func main() {
	pkg := flag.String("pkg", "template", "template, checksum, or archive")
	out := flag.String("out", "", "output JSON file; stdout by default")
	verify := flag.Bool("verify", false, "verify a packet read from stdin")
	flag.Parse()
	if *pkg == "archive" {
		runArchive(*out, *verify)
		return
	}
	if *pkg != "template" && *pkg != "checksum" {
		fail(fmt.Errorf("unsupported package %q", *pkg))
	}
	packet := Packet{Schema: 1, Package: *pkg}
	if *verify {
		dec := json.NewDecoder(io.LimitReader(os.Stdin, 32<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&packet); err != nil {
			fail(err)
		}
		var extra interface{}
		if err := dec.Decode(&extra); err != io.EOF {
			fail(fmt.Errorf("expected a single JSON packet"))
		}
		if packet.Schema != 1 || packet.Package != *pkg || len(packet.Cases) == 0 {
			fail(fmt.Errorf("invalid packet header or empty cases"))
		}
		for _, c := range packet.Cases {
			data, err := hex.DecodeString(c.Hex)
			if err != nil {
				fail(err)
			}
			expected := results(*pkg, data, false)
			if len(c.Expected) != len(expected) {
				fail(fmt.Errorf("%s: result field count differs", c.ID))
			}
			for name, value := range expected {
				if c.Expected[name] != value {
					fail(fmt.Errorf("%s/%s: expected %s got %s; input hex=%s", c.ID, name, value, c.Expected[name], c.Hex))
				}
			}
			if c.Incremental != nil {
				if len(c.Incremental) != len(expected) {
					fail(fmt.Errorf("%s: incremental field count differs", c.ID))
				}
				for name, value := range expected {
					if c.Incremental[name] != value {
						fail(fmt.Errorf("%s/%s: incremental mismatch", c.ID, name))
					}
				}
			}
		}
		fmt.Printf("Go verified %d %s cases\n", len(packet.Cases), *pkg)
		return
	}
	for _, size := range []int{0, 1, 55, 56, 64, 65, 1024, 1 << 20} {
		data := make([]byte, size)
		state := uint32(42)
		for i := range data {
			state = 1664525*state + 1013904223
			data[i] = byte(state >> 24)
		}
		packet.Cases = append(packet.Cases, Case{fmt.Sprintf("lcg42-%d", size), hex.EncodeToString(data), results(*pkg, data, false), results(*pkg, data, true)})
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
	if err := json.NewEncoder(writer).Encode(packet); err != nil {
		fail(err)
	}
}
