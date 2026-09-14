// Go 1.25 reference for rustd-crypto checkpoint 1. No Rust/JS result is trusted.
package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"hash"
	"io"
	"os"
	"reflect"
	"time"
)

var names = []string{"md5", "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-224", "sha512-256"}

func constructor(name string) func() hash.Hash {
	switch name {
	case "md5":
		return md5.New
	case "sha1":
		return sha1.New
	case "sha224":
		return sha256.New224
	case "sha256":
		return sha256.New
	case "sha384":
		return sha512.New384
	case "sha512":
		return sha512.New
	case "sha512-224":
		return sha512.New512_224
	case "sha512-256":
		return sha512.New512_256
	default:
		panic("unknown algorithm")
	}
}

type Case struct {
	Algorithm       string `json:"algorithm"`
	Length          int    `json:"length"`
	Seed            int    `json:"seed"`
	KeyHex          string `json:"keyHex"`
	HashHex         string `json:"hashHex"`
	SumHex          string `json:"sumHex"`
	ExtendedHex     string `json:"extendedHex"`
	HmacHex         string `json:"hmacHex"`
	HmacSumHex      string `json:"hmacSumHex"`
	HmacExtendedHex string `json:"hmacExtendedHex"`
}
type Packet struct {
	Version int    `json:"version"`
	Cases   []Case `json:"cases"`
}

func pattern(n, seed int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i*31 + seed)
	}
	return b
}
func evaluate(c Case) Case {
	data := pattern(c.Length, c.Seed)
	key, err := hex.DecodeString(c.KeyHex)
	if err != nil {
		panic(err)
	}
	h := constructor(c.Algorithm)()
	m := hmac.New(constructor(c.Algorithm), key)
	// Exercise uneven incremental writes on the Go reference too.
	chunks := []int{1, 2, 3, 7, 64, 4096}
	for start, i := 0, 0; start < len(data); i++ {
		end := min(start+chunks[i%len(chunks)], len(data))
		h.Write(data[start:end])
		m.Write(data[start:end])
		start = end
	}
	c.HashHex = hex.EncodeToString(h.Sum(nil))
	c.HmacHex = hex.EncodeToString(m.Sum(nil))
	c.SumHex = hex.EncodeToString(h.Sum([]byte{0xde, 0xad, 0xbe, 0xef}))
	c.HmacSumHex = hex.EncodeToString(m.Sum([]byte{0xde, 0xad, 0xbe, 0xef}))
	h.Write([]byte("后缀\x00"))
	m.Write([]byte("后缀\x00"))
	c.ExtendedHex = hex.EncodeToString(h.Sum(nil))
	c.HmacExtendedHex = hex.EncodeToString(m.Sum(nil))
	return c
}
func run() error {
	verify := flag.Bool("verify", false, "verify JS-produced cases from stdin")
	bench := flag.Bool("bench", false, "measure 128 MiB per algorithm in 64 KiB chunks")
	flag.Parse()
	if *bench {
		rows := []map[string]any{}
		data := pattern(65536, 17)
		for _, name := range names {
			h := constructor(name)()
			m := hmac.New(constructor(name), bytes.Repeat([]byte{73}, 131))
			start := time.Now()
			for range 2048 {
				h.Write(data)
			}
			h.Sum(nil)
			hashMs := float64(time.Since(start).Nanoseconds()) / 1e6
			start = time.Now()
			for range 2048 {
				m.Write(data)
			}
			m.Sum(nil)
			macMs := float64(time.Since(start).Nanoseconds()) / 1e6
			rows = append(rows, map[string]any{"algorithm": name, "hashMs": hashMs, "hmacMs": macMs})
		}
		return json.NewEncoder(os.Stdout).Encode(rows)
	}
	if *verify {
		var packet Packet
		d := json.NewDecoder(io.LimitReader(os.Stdin, 16<<20))
		d.DisallowUnknownFields()
		if err := d.Decode(&packet); err != nil {
			return err
		}
		if err := d.Decode(new(any)); err != io.EOF {
			return fmt.Errorf("trailing input")
		}
		if packet.Version != 1 || len(packet.Cases) == 0 {
			return fmt.Errorf("invalid or empty packet")
		}
		for i, c := range packet.Cases {
			found := false
			for _, n := range names {
				if n == c.Algorithm {
					found = true
				}
			}
			if !found || c.Length < 0 || c.Length > 1<<20 || c.Seed < 0 || c.Seed > 255 || len(c.KeyHex) > 8192 {
				return fmt.Errorf("invalid input case %d", i)
			}
			if _, err := hex.DecodeString(c.KeyHex); err != nil {
				return err
			}
			if want := evaluate(c); !reflect.DeepEqual(c, want) {
				return fmt.Errorf("mismatch case %d algorithm %s length %d", i, c.Algorithm, c.Length)
			}
		}
		fmt.Printf("Go verified %d native cases\n", len(packet.Cases))
		return nil
	}
	packet := Packet{Version: 1}
	for _, name := range names {
		for i, n := range []int{0, 1, 55, 56, 64, 65, 1024, 1048576} {
			// Empty, normal and over-block-size keys, including SHA-512's 128-byte block.
			key := bytes.Repeat([]byte{0xaa}, []int{0, 20, 131}[i%3])
			packet.Cases = append(packet.Cases, evaluate(Case{Algorithm: name, Length: n, Seed: 17, KeyHex: hex.EncodeToString(key)}))
		}
	}
	e := json.NewEncoder(os.Stdout)
	e.SetIndent("", "  ")
	return e.Encode(packet)
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
