// Command iotestcheck records Go 1.24 testing/iotest Read sequences.
// It does not define a JS Reader shape; later rustd-io can consume this packet.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"
	"testing/iotest"
)

type Call struct {
	N   int    `json:"n"`
	Err string `json:"err"`
	Hex string `json:"hex"`
}

type Sequence struct {
	ID         string `json:"id"`
	Wrap       string `json:"wrap"`
	ContentHex string `json:"contentHex"`
	BufSize    int    `json:"bufSize"`
	Calls      []Call `json:"calls"`
}

type TestReaderCase struct {
	ID         string `json:"id"`
	ContentHex string `json:"contentHex"`
	OK         bool   `json:"ok"`
	Error      string `json:"error"`
}

type Packet struct {
	Schema     int              `json:"schema"`
	Package    string           `json:"package"`
	GoVersion  string           `json:"goVersion"`
	Sequences  []Sequence       `json:"sequences"`
	TestReader []TestReaderCase `json:"testReader"`
}

type step struct {
	data []byte
	err  error
}

type scriptedReader struct {
	steps []step
	i     int
}

func (r *scriptedReader) Read(p []byte) (int, error) {
	if r.i >= len(r.steps) {
		return 0, io.EOF
	}
	s := r.steps[r.i]
	r.i++
	n := copy(p, s.data)
	return n, s.err
}

func errName(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, io.EOF) {
		return "EOF"
	}
	return err.Error()
}

func wrapReader(kind string, inner io.Reader, err error) io.Reader {
	switch kind {
	case "identity":
		return inner
	case "oneByte":
		return iotest.OneByteReader(inner)
	case "half":
		return iotest.HalfReader(inner)
	case "dataErr":
		return iotest.DataErrReader(inner)
	case "err":
		return iotest.ErrReader(err)
	default:
		panic(kind)
	}
}

func drain(r io.Reader, bufSize int, maxCalls int) []Call {
	calls := make([]Call, 0, 8)
	for i := 0; i < maxCalls; i++ {
		var buf []byte
		if bufSize > 0 {
			buf = make([]byte, bufSize)
		}
		n, err := r.Read(buf)
		got := []byte(nil)
		if n > 0 {
			got = append([]byte(nil), buf[:n]...)
		}
		calls = append(calls, Call{N: n, Err: errName(err), Hex: hex.EncodeToString(got)})
		if err != nil || n == 0 {
			break
		}
	}
	return calls
}

func seq(id, wrap string, content []byte, inner io.Reader, bufSize int, err error) Sequence {
	r := wrapReader(wrap, inner, err)
	return Sequence{
		ID:         id,
		Wrap:       wrap,
		ContentHex: hex.EncodeToString(content),
		BufSize:    bufSize,
		Calls:      drain(r, bufSize, 64),
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func build() Packet {
	hello := []byte("Hello, World!")
	empty := []byte{}
	boom := errors.New("io failure")
	p := Packet{
		Schema:    1,
		Package:   "iotest",
		GoVersion: runtime.Version(),
	}

	p.Sequences = append(p.Sequences,
		seq("oneByte/hello/buf0", "oneByte", hello, bytes.NewReader(hello), 0, nil),
		seq("oneByte/hello/buf1", "oneByte", hello, bytes.NewReader(hello), 1, nil),
		seq("oneByte/hello/buf3", "oneByte", hello, bytes.NewReader(hello), 3, nil),
		seq("oneByte/hello/buf16", "oneByte", hello, bytes.NewReader(hello), 16, nil),
		seq("oneByte/empty/buf5", "oneByte", empty, bytes.NewReader(empty), 5, nil),
		seq("half/hello/buf0", "half", hello, bytes.NewReader(hello), 0, nil),
		seq("half/hello/buf1", "half", hello, bytes.NewReader(hello), 1, nil),
		seq("half/hello/buf2", "half", hello, bytes.NewReader(hello), 2, nil),
		seq("half/hello/buf8", "half", hello, bytes.NewReader(hello), 8, nil),
		seq("half/empty/buf5", "half", empty, bytes.NewReader(empty), 5, nil),
		seq("dataErr/hello/buf3", "dataErr", hello, bytes.NewReader(hello), 3, nil),
		seq("dataErr/hello/buf16", "dataErr", hello, bytes.NewReader(hello), 16, nil),
		seq("dataErr/empty/buf5", "dataErr", empty, bytes.NewReader(empty), 5, nil),
		seq("dataErr/scripted-last-err/buf8", "dataErr", []byte("abcde"), &scriptedReader{steps: []step{
			{data: []byte("abc"), err: nil},
			{data: []byte("de"), err: nil},
			{data: nil, err: boom},
		}}, 8, nil),
		seq("dataErr/scripted-data-eof/buf8", "dataErr", []byte("ab"), &scriptedReader{steps: []step{
			{data: []byte("ab"), err: io.EOF},
		}}, 8, nil),
		seq("err/io-failure/buf8", "err", nil, nil, 8, boom),
		seq("err/eof/buf8", "err", nil, nil, 8, io.EOF),
		seq("err/nil/buf8", "err", nil, nil, 8, nil),
		seq("err/io-failure/buf0", "err", nil, nil, 0, boom),
		seq("identity/hello/buf4", "identity", hello, bytes.NewReader(hello), 4, nil),
	)

	const msg = "Now is the time for all good gophers."
	okErr := iotest.TestReader(bytes.NewReader([]byte(msg)), []byte(msg))
	badErr := iotest.TestReader(bytes.NewReader([]byte(msg[:10])), []byte(msg))
	truncErr := iotest.TestReader(iotest.OneByteReader(bytes.NewReader([]byte(msg))), []byte(msg+"x"))
	p.TestReader = []TestReaderCase{
		{ID: "bytes/ok", ContentHex: hex.EncodeToString([]byte(msg)), OK: okErr == nil, Error: errName(okErr)},
		{ID: "bytes/short-source", ContentHex: hex.EncodeToString([]byte(msg)), OK: badErr == nil, Error: errName(badErr)},
		{ID: "oneByte/content-mismatch", ContentHex: hex.EncodeToString([]byte(msg + "x")), OK: truncErr == nil, Error: errName(truncErr)},
	}
	return p
}

func equalPacket(got, want Packet) error {
	if got.Schema != want.Schema || got.Package != want.Package {
		return fmt.Errorf("header mismatch schema/package")
	}
	if len(got.Sequences) != len(want.Sequences) {
		return fmt.Errorf("sequence count %d want %d", len(got.Sequences), len(want.Sequences))
	}
	gb, err := json.Marshal(got.Sequences)
	if err != nil {
		return err
	}
	wb, err := json.Marshal(want.Sequences)
	if err != nil {
		return err
	}
	if !bytes.Equal(gb, wb) {
		return fmt.Errorf("sequences differ")
	}
	gb, err = json.Marshal(got.TestReader)
	if err != nil {
		return err
	}
	wb, err = json.Marshal(want.TestReader)
	if err != nil {
		return err
	}
	if !bytes.Equal(gb, wb) {
		return fmt.Errorf("testReader cases differ")
	}
	return nil
}

func main() {
	out := flag.String("out", "", "write JSON packet to this path (stdout if empty)")
	verify := flag.Bool("verify", false, "verify a packet from stdin against a live Go regenerate")
	flag.Parse()
	live := build()
	if *verify {
		dec := json.NewDecoder(io.LimitReader(os.Stdin, 8<<20))
		dec.DisallowUnknownFields()
		var got Packet
		if err := dec.Decode(&got); err != nil {
			fail(err)
		}
		var extra interface{}
		if err := dec.Decode(&extra); err != io.EOF {
			fail(fmt.Errorf("expected a single JSON packet"))
		}
		if err := equalPacket(got, live); err != nil {
			fail(err)
		}
		if got.GoVersion == "" {
			fail(fmt.Errorf("missing goVersion"))
		}
		fmt.Printf("Go verified %d iotest sequences and %d TestReader cases\n", len(got.Sequences), len(got.TestReader))
		return
	}
	raw, err := json.MarshalIndent(live, "", "  ")
	if err != nil {
		fail(err)
	}
	raw = append(raw, '\n')
	if *out == "" {
		if _, err := os.Stdout.Write(raw); err != nil {
			fail(err)
		}
		return
	}
	if err := os.WriteFile(*out, raw, 0o644); err != nil {
		fail(err)
	}
}
