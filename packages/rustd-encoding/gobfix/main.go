package main

import (
	"bytes"
	"encoding/gob"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"reflect"
)

type Point struct{ X, Y int }
type Inner struct{ N int }
type Outer struct{ I Inner }
type Person struct {
	Name string
	Age  int
	Note string
}
type Holder struct{ V any }

type Case struct {
	Name   string `json:"name"`
	EncHex string `json:"encHex"`
}

type Packet struct {
	Version int    `json:"version"`
	Cases   []Case `json:"cases"`
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func encode(v any) []byte {
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(v); err != nil {
		fail(err)
	}
	return buf.Bytes()
}

func encodeOne(name string) []byte {
	var nilSlice []int
	var nilMap map[string]int
	switch name {
	case "int3":
		return encode(3)
	case "boolT":
		return encode(true)
	case "str":
		return encode("hi")
	case "bytes":
		return encode([]byte{1, 2, 3})
	case "point":
		return encode(Point{22, 33})
	case "outer":
		return encode(Outer{I: Inner{N: 7}})
	case "slice":
		return encode([]int{1, 2, 3})
	case "arr":
		return encode([2]int{4, 5})
	case "person":
		return encode(Person{Name: "x", Age: 0, Note: "y"})
	case "emptySlice":
		return encode([]int{})
	case "nilSlice":
		return encode(nilSlice)
	case "emptyMap":
		return encode(map[string]int{})
	case "nilMap":
		return encode(nilMap)
	case "float":
		return encode(float64(1))
	case "int64":
		return encode(int64(1 << 62))
	case "uint":
		return encode(uint64(128))
	case "holder":
		gob.Register(Point{})
		return encode(Holder{V: Point{22, 33}})
	case "iface":
		gob.Register(Point{})
		var i any = Point{22, 33}
		var buf bytes.Buffer
		if err := gob.NewEncoder(&buf).EncodeValue(reflect.ValueOf(&i).Elem()); err != nil {
			fail(err)
		}
		return buf.Bytes()
	default:
		fail(fmt.Errorf("unknown case %s", name))
		return nil
	}
}

func main() {
	verify := flag.Bool("verify", false, "decode packet from stdin")
	one := flag.String("one", "", "encode a single isolated case")
	trunc := flag.Bool("trunc", false, "assert every proper prefix of each fixture fails to decode")
	flag.Parse()
	if *one != "" {
		fmt.Print(hex.EncodeToString(encodeOne(*one)))
		return
	}
	if *verify {
		verifyPacket()
		return
	}
	if *trunc {
		truncCheck()
		return
	}
	names := []string{
		"int3", "boolT", "str", "bytes", "point", "outer", "slice", "arr", "person",
		"emptySlice", "nilSlice", "emptyMap", "nilMap", "float", "int64", "uint", "holder", "iface",
	}
	self, err := os.Executable()
	if err != nil {
		fail(err)
	}
	pkt := Packet{Version: 1}
	for _, name := range names {
		out, err := exec.Command(self, "-one", name).Output()
		if err != nil {
			if _, ok := err.(*exec.Error); ok {
				out, err = exec.Command("go", "run", ".", "-one", name).Output()
			}
		}
		if err != nil {
			fail(fmt.Errorf("%s: %w", name, err))
		}
		pkt.Cases = append(pkt.Cases, Case{Name: name, EncHex: string(bytes.TrimSpace(out))})
	}
	if err := json.NewEncoder(os.Stdout).Encode(pkt); err != nil {
		fail(err)
	}
}

func verifyPacket() {
	var pkt Packet
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 8<<20)).Decode(&pkt); err != nil {
		fail(err)
	}
	gob.Register(Point{})
	for _, c := range pkt.Cases {
		raw, err := hex.DecodeString(c.EncHex)
		if err != nil {
			fail(fmt.Errorf("%s: %w", c.Name, err))
		}
		g := gob.NewDecoder(bytes.NewReader(raw))
		switch c.Name {
		case "int3":
			var v int
			check(c.Name, g.Decode(&v), v == 3)
		case "boolT":
			var v bool
			check(c.Name, g.Decode(&v), v)
		case "str":
			var v string
			check(c.Name, g.Decode(&v), v == "hi")
		case "bytes":
			var v []byte
			check(c.Name, g.Decode(&v), bytes.Equal(v, []byte{1, 2, 3}))
		case "point":
			var v Point
			check(c.Name, g.Decode(&v), v == (Point{22, 33}))
		case "outer":
			var v Outer
			check(c.Name, g.Decode(&v), v.I.N == 7)
		case "slice":
			var v []int
			check(c.Name, g.Decode(&v), len(v) == 3 && v[0] == 1 && v[2] == 3)
		case "emptySlice", "nilSlice":
			var v []int
			check(c.Name, g.Decode(&v), len(v) == 0)
		case "arr":
			var v [2]int
			check(c.Name, g.Decode(&v), v == [2]int{4, 5})
		case "person":
			var v Person
			check(c.Name, g.Decode(&v), v.Name == "x" && v.Age == 0 && v.Note == "y")
		case "emptyMap", "nilMap":
			var v map[string]int
			check(c.Name, g.Decode(&v), true)
		case "float":
			var v float64
			check(c.Name, g.Decode(&v), v == 1)
		case "int64":
			var v int64
			check(c.Name, g.Decode(&v), v == 1<<62)
		case "uint":
			var v uint64
			check(c.Name, g.Decode(&v), v == 128)
		case "holder", "iface":
			if c.Name == "holder" {
				var v Holder
				check(c.Name, g.Decode(&v), true)
				p, ok := v.V.(Point)
				check(c.Name, nil, ok && p == (Point{22, 33}))
			} else {
				var v any
				check(c.Name, g.Decode(&v), true)
				p, ok := v.(Point)
				check(c.Name, nil, ok && p == (Point{22, 33}))
			}
		default:
			fail(fmt.Errorf("unknown case %s", c.Name))
		}
	}
	fmt.Printf("Go verified %d gob cases\n", len(pkt.Cases))
}

func truncCheck() {
	names := []string{
		"int3", "boolT", "str", "bytes", "point", "outer", "slice", "arr", "person",
		"emptySlice", "float", "int64", "uint",
	}
	type truncCase struct {
		Name   string `json:"name"`
		Len    int    `json:"len"`
		Failed int    `json:"failedPrefixes"`
	}
	out := struct {
		Version int         `json:"version"`
		Cases   []truncCase `json:"cases"`
	}{Version: 1}
	self, err := os.Executable()
	if err != nil {
		fail(err)
	}
	for _, name := range names {
		hexOut, err := exec.Command(self, "-one", name).Output()
		if err != nil {
			if _, ok := err.(*exec.Error); ok {
				hexOut, err = exec.Command("go", "run", ".", "-one", name).Output()
			}
		}
		if err != nil {
			fail(fmt.Errorf("%s: %w", name, err))
		}
		raw, err := hex.DecodeString(string(bytes.TrimSpace(hexOut)))
		if err != nil {
			fail(fmt.Errorf("%s: %w", name, err))
		}
		failed := 0
		for i := 0; i < len(raw); i++ {
			if decodePrefix(name, raw[:i]) == nil {
				fail(fmt.Errorf("%s: prefix %d/%d decoded", name, i, len(raw)))
			}
			failed++
		}
		if err := decodePrefix(name, raw); err != nil {
			fail(fmt.Errorf("%s: full stream: %w", name, err))
		}
		out.Cases = append(out.Cases, truncCase{Name: name, Len: len(raw), Failed: failed})
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fail(err)
	}
}

func decodePrefix(name string, raw []byte) error {
	g := gob.NewDecoder(bytes.NewReader(raw))
	switch name {
	case "int3":
		var v int
		return g.Decode(&v)
	case "boolT":
		var v bool
		return g.Decode(&v)
	case "str":
		var v string
		return g.Decode(&v)
	case "bytes":
		var v []byte
		return g.Decode(&v)
	case "point":
		var v Point
		return g.Decode(&v)
	case "outer":
		var v Outer
		return g.Decode(&v)
	case "slice", "emptySlice":
		var v []int
		return g.Decode(&v)
	case "arr":
		var v [2]int
		return g.Decode(&v)
	case "person":
		var v Person
		return g.Decode(&v)
	case "float":
		var v float64
		return g.Decode(&v)
	case "int64":
		var v int64
		return g.Decode(&v)
	case "uint":
		var v uint64
		return g.Decode(&v)
	default:
		return fmt.Errorf("unknown case %s", name)
	}
}

func check(name string, err error, ok bool) {
	if err != nil {
		fail(fmt.Errorf("%s: %w", name, err))
	}
	if !ok {
		fail(fmt.Errorf("%s: value mismatch", name))
	}
}
