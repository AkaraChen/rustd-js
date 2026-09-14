package main

import (
	"debug/elf"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// DumpSym is the JSON shape of rustd-debugfmt BinaryFile.symbols()
// (issue #18 §4.6 reverse interop). value/size are decimal strings because
// JS bigint cannot JSON.stringify as number.
type DumpSym struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	Size  string `json:"size"`
	Kind  string `json:"kind"`
}

type tuple struct {
	name  string
	value uint64
	size  uint64
	kind  string
}

func key(t tuple) string {
	return fmt.Sprintf("%s\t%d\t%d\t%s", t.name, t.value, t.size, t.kind)
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: readsymbols <binary> <dump.json>")
		os.Exit(2)
	}
	bin := os.Args[1]
	dumpPath := os.Args[2]

	raw, err := os.ReadFile(dumpPath)
	if err != nil {
		fatal(err)
	}
	var dump []DumpSym
	if err := json.Unmarshal(raw, &dump); err != nil {
		fatal(fmt.Errorf("dump json: %w", err))
	}
	if len(dump) == 0 {
		fatal("empty symbols dump")
	}

	dumpSet := map[string]tuple{}
	for i, s := range dump {
		if s.Name == "" {
			fatal(fmt.Errorf("dump[%d] missing name", i))
		}
		value, err := strconv.ParseUint(s.Value, 10, 64)
		if err != nil {
			fatal(fmt.Errorf("dump[%d] value %q: %w", i, s.Value, err))
		}
		size, err := strconv.ParseUint(s.Size, 10, 64)
		if err != nil {
			fatal(fmt.Errorf("dump[%d] size %q: %w", i, s.Size, err))
		}
		if s.Kind == "" {
			fatal(fmt.Errorf("dump[%d] missing kind", i))
		}
		t := tuple{name: s.Name, value: value, size: size, kind: s.Kind}
		dumpSet[key(t)] = t
	}

	nmOut, err := exec.Command("go", "tool", "nm", "-size", bin).Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			fatal(fmt.Errorf("go tool nm -size: %v\n%s", err, ee.Stderr))
		}
		fatal(fmt.Errorf("go tool nm -size: %w", err))
	}
	nmRows := parseNmSize(string(nmOut))
	if len(nmRows) == 0 {
		fatal("go tool nm -size produced no rows")
	}

	nmSet := map[string]tuple{}
	for _, t := range nmRows {
		nmSet[key(t)] = t
	}

	var onlyDump, onlyNm []string
	for k := range dumpSet {
		if _, ok := nmSet[k]; !ok {
			onlyDump = append(onlyDump, k)
		}
	}
	for k := range nmSet {
		if _, ok := dumpSet[k]; !ok {
			onlyNm = append(onlyNm, k)
		}
	}
	if len(onlyDump) != 0 || len(onlyNm) != 0 {
		n := min(12, len(onlyNm))
		d := min(12, len(onlyDump))
		fatal(fmt.Errorf(
			"set mismatch dump=%d nm=%d onlyNm=%d sample=%q onlyDump=%d sample=%q",
			len(dumpSet), len(nmSet), len(onlyNm), onlyNm[:n], len(onlyDump), onlyDump[:d],
		))
	}

	hasMain := false
	for _, t := range dump {
		if t.Name == "main.main" {
			hasMain = true
			break
		}
	}
	if !hasMain {
		fatal("dump missing main.main")
	}

	f, err := elf.Open(bin)
	if err != nil {
		fatal(err)
	}
	defer f.Close()
	elfSyms, err := f.Symbols()
	if err != nil {
		fatal(fmt.Errorf("debug/elf.Symbols: %w", err))
	}
	dumpByNameValue := map[string]DumpSym{}
	for _, s := range dump {
		dumpByNameValue[s.Name+"\t"+s.Value] = s
	}
	matchedElf := 0
	for _, es := range elfSyms {
		if es.Name == "" || es.Name == "_" {
			continue
		}
		if elf.ST_TYPE(es.Info) == elf.STT_FILE || elf.ST_TYPE(es.Info) == elf.STT_SECTION {
			continue
		}
		want := es.Name + "\t" + strconv.FormatUint(es.Value, 10)
		got, ok := dumpByNameValue[want]
		if !ok {
			continue
		}
		size, _ := strconv.ParseUint(got.Size, 10, 64)
		if size != es.Size {
			fatal(fmt.Errorf("debug/elf size mismatch %s value=%d dump=%d elf=%d", es.Name, es.Value, size, es.Size))
		}
		matchedElf++
	}
	if matchedElf == 0 {
		fatal("no debug/elf symbols matched the dump")
	}

	fmt.Printf("ok dump=%d nm=%d elfMatched=%d main.main=1\n", len(dumpSet), len(nmSet), matchedElf)
}

func parseNmSize(text string) []tuple {
	letter := map[string]string{
		"T": "text", "t": "text",
		"D": "data", "d": "data",
		"B": "bss", "b": "bss",
		"R": "rodata", "r": "rodata",
		"U": "undefined", "u": "undefined",
		"F": "file", "f": "file",
		"_": "file",
	}
	var rows []tuple
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		parts := strings.Fields(trimmed)
		if len(parts) < 4 {
			continue
		}
		kind, ok := letter[parts[2]]
		if !ok {
			continue
		}
		value, err := strconv.ParseUint(parts[0], 16, 64)
		if err != nil {
			continue
		}
		size, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil {
			continue
		}
		name := strings.Join(parts[3:], " ")
		rows = append(rows, tuple{name: name, value: value, size: size, kind: kind})
	}
	return rows
}

func fatal(v any) {
	fmt.Fprintln(os.Stderr, v)
	os.Exit(1)
}
