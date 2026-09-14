// Go 1.24.13 reference dump for rustd-gotool checkpoint 1 (`go/version`).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/version"
	"io"
	"os"
)

type Case struct {
	ID      string `json:"id"`
	X       string `json:"x"`
	Y       string `json:"y"`
	Compare int    `json:"compare"`
	XValid  bool   `json:"xValid"`
	YValid  bool   `json:"yValid"`
	XLang   string `json:"xLang"`
	YLang   string `json:"yLang"`
}

type Packet struct {
	Schema  int    `json:"schema"`
	Package string `json:"package"`
	Go      string `json:"go"`
	Cases   []Case `json:"cases"`
}

func eval(x, y string) Case {
	return Case{
		X: x, Y: y,
		Compare: version.Compare(x, y),
		XValid:  version.IsValid(x),
		YValid:  version.IsValid(y),
		XLang:   version.Lang(x),
		YLang:   version.Lang(y),
	}
}

func corpus() [][2]string {
	// Official go/version tests plus issue #28 boundary strings.
	official := [][2]string{
		{"", ""},
		{"x", "x"},
		{"", "x"},
		{"1", "1.1"},
		{"go1", "go1.1"},
		{"go1.5", "go1.6"},
		{"go1.5", "go1.10"},
		{"go1.6", "go1.6.1"},
		{"go1.19", "go1.19.0"},
		{"go1.19rc1", "go1.19"},
		{"go1.20", "go1.20.0"},
		{"go1.20", "go1.20.0-bigcorp"},
		{"go1.20rc1", "go1.20"},
		{"go1.21", "go1.21.0"},
		{"go1.21", "go1.21.0-bigcorp"},
		{"go1.21", "go1.21rc1"},
		{"go1.21rc1", "go1.21.0"},
		{"go1.6", "go1.19"},
		{"go1.19", "go1.19.1"},
		{"go1.19rc1", "go1.19.1"},
		{"go1.19rc1", "go1.19rc2"},
		{"go1.19.0", "go1.19.1"},
		{"go1.19rc1", "go1.19.0"},
		{"go1.19alpha3", "go1.19beta2"},
		{"go1.19beta2", "go1.19rc1"},
		{"go1.1", "go1.99999999999999998"},
		{"go1.99999999999999998", "go1.99999999999999999"},
		{"bad", ""},
		{"go1.2rc3", "go1.2"},
		{"go1.2.3", "go1.2"},
		{"go1", "go1"},
		{"go222", "go1"},
		{"go1.999testmod", "go1.999"},
		{"1.2.3", "go1.2.3"},
		{"go1.600+auto", "go1.22"},
		{"go1.22", "go1.21.0"},
		{"go1.21rc2", "go1.21"},
		{"go1.23.4-custom", "go1.23.4"},
		{"go1.21rc2", "go1.21.2"},
		{"GO1.21", "go1.21"},
		{"go1.21.0rc1", "go1.21.0"},
		{"go01.21", "go1.21"},
		{"go1.21rc", "go1.21rc1"},
		{"go1.20.0-bigcorp", "go1.20.1"},
		{"go1.21.0-bigcorp", "go1.21.1"},
	}
	return official
}

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }

func main() {
	out := flag.String("out", "", "output JSON file; stdout by default")
	verify := flag.Bool("verify", false, "verify a packet read from stdin")
	scan := flag.Bool("scan", false, "dump go/scanner fixtures")
	verifyScanFlag := flag.Bool("verify-scan", false, "verify a scanner packet read from stdin")
	parseFlag := flag.Bool("parse", false, "dump go/parser ast.Fprint fixtures")
	verifyParseFlag := flag.Bool("verify-parse", false, "verify a parser packet read from stdin")
	parseErrorsFlag := flag.Bool("parse-errors", false, "dump go/parser error-recovery fixtures")
	verifyParseErrorsFlag := flag.Bool("verify-parse-errors", false, "verify a parse-error packet read from stdin")
	parseEdgesFlag := flag.Bool("parse-edges", false, "dump go/parser issue #28 §4.8 boundary fixtures")
	verifyParseEdgesFlag := flag.Bool("verify-parse-edges", false, "verify a parse-edge packet read from stdin")
	constantFlag := flag.Bool("constant", false, "dump go/constant Int/MakeInt64 fixtures")
	verifyConstantFlag := flag.Bool("verify-constant", false, "verify a constant-int packet read from stdin")
	constantBinFlag := flag.Bool("constant-binop", false, "dump go/constant Int BinaryOp fixtures")
	verifyConstantBinFlag := flag.Bool("verify-constant-binop", false, "verify a constant-int-binop packet read from stdin")
	flag.Parse()
	if *verifyConstantBinFlag {
		verifyConstantBin(os.Stdin)
		return
	}
	if *constantBinFlag {
		var writer io.Writer = os.Stdout
		if *out != "" {
			f, err := os.Create(*out)
			if err != nil {
				fail(err)
			}
			defer f.Close()
			writer = f
		}
		dumpConstantBin(writer)
		return
	}
	if *verifyConstantFlag {
		verifyConstant(os.Stdin)
		return
	}
	if *constantFlag {
		var writer io.Writer = os.Stdout
		if *out != "" {
			f, err := os.Create(*out)
			if err != nil {
				fail(err)
			}
			defer f.Close()
			writer = f
		}
		dumpConstant(writer)
		return
	}
	if *verifyScanFlag {
		verifyScan(os.Stdin)
		return
	}
	if *verifyParseFlag {
		verifyParse(os.Stdin)
		return
	}
	if *verifyParseErrorsFlag {
		verifyParseErrors(os.Stdin)
		return
	}
	if *verifyParseEdgesFlag {
		verifyParseEdges(os.Stdin)
		return
	}
	if *parseEdgesFlag {
		var writer io.Writer = os.Stdout
		if *out != "" {
			f, err := os.Create(*out)
			if err != nil {
				fail(err)
			}
			defer f.Close()
			writer = f
		}
		dumpParseEdges(writer)
		return
	}
	if *parseErrorsFlag {
		var writer io.Writer = os.Stdout
		if *out != "" {
			f, err := os.Create(*out)
			if err != nil {
				fail(err)
			}
			defer f.Close()
			writer = f
		}
		dumpParseErrors(writer)
		return
	}
	if *parseFlag {
		var writer io.Writer = os.Stdout
		if *out != "" {
			f, err := os.Create(*out)
			if err != nil {
				fail(err)
			}
			defer f.Close()
			writer = f
		}
		dumpParse(writer)
		return
	}
	if *scan {
		var writer io.Writer = os.Stdout
		if *out != "" {
			f, err := os.Create(*out)
			if err != nil {
				fail(err)
			}
			defer f.Close()
			writer = f
		}
		dumpScan(writer)
		return
	}
	if *verify {
		dec := json.NewDecoder(io.LimitReader(os.Stdin, 32<<20))
		dec.DisallowUnknownFields()
		var packet Packet
		if err := dec.Decode(&packet); err != nil {
			fail(err)
		}
		var extra interface{}
		if err := dec.Decode(&extra); err != io.EOF {
			fail(fmt.Errorf("expected a single JSON packet"))
		}
		if packet.Schema != 1 || packet.Package != "gotool" || len(packet.Cases) == 0 {
			fail(fmt.Errorf("invalid packet header or empty cases"))
		}
		for i, c := range packet.Cases {
			got := eval(c.X, c.Y)
			if got.Compare != c.Compare || got.XValid != c.XValid || got.YValid != c.YValid || got.XLang != c.XLang || got.YLang != c.YLang {
				fail(fmt.Errorf("mismatch case %d id=%s x=%q y=%q: go compare=%d valid=(%v,%v) lang=(%q,%q) got compare=%d valid=(%v,%v) lang=(%q,%q)",
					i, c.ID, c.X, c.Y, got.Compare, got.XValid, got.YValid, got.XLang, got.YLang,
					c.Compare, c.XValid, c.YValid, c.XLang, c.YLang))
			}
		}
		fmt.Printf("Go verified %d gotool cases\n", len(packet.Cases))
		return
	}
	packet := Packet{Schema: 1, Package: "gotool", Go: "go1.24.13"}
	for i, pair := range corpus() {
		c := eval(pair[0], pair[1])
		c.ID = fmt.Sprintf("go-version-%d", i)
		packet.Cases = append(packet.Cases, c)
		if pair[0] != pair[1] {
			rev := eval(pair[1], pair[0])
			rev.ID = fmt.Sprintf("go-version-%d-rev", i)
			packet.Cases = append(packet.Cases, rev)
		}
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
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}
