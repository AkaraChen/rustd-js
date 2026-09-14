package main

import (
	"debug/elf"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
)

const (
	go12Magic  = 0xfffffffb
	go116Magic = 0xfffffffa
	go118Magic = 0xfffffff0
	go120Magic = 0xfffffff1

	pcdataInlTreeIndex = 2
	funcdataInlTree    = 3
	inlCallSize        = 16
)

type frame struct {
	File string `json:"file"`
	Line uint32 `json:"line"`
	Fn   string `json:"fn"`
}

type row struct {
	Name         string  `json:"name"`
	PC           string  `json:"pc"`
	File         string  `json:"file"`
	Line         uint32  `json:"line"`
	Fn           string  `json:"fn"`
	InlineFrames []frame `json:"inlineFrames"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: dumpinline <binary>")
		os.Exit(2)
	}
	f, err := elf.Open(os.Args[1])
	if err != nil {
		fatal(err)
	}
	defer f.Close()
	pcln := f.Section(".gopclntab")
	if pcln == nil {
		fatal("no .gopclntab")
	}
	data, err := pcln.Data()
	if err != nil {
		fatal(err)
	}
	text := f.Section(".text")
	if text == nil {
		fatal("no .text")
	}
	gofunc := loadGoFunc(f)
	tab, err := parseTable(data, text.Addr, gofunc)
	if err != nil {
		fatal(err)
	}
	var rows []row
	for i := uint32(0); i < tab.nfunctab; i++ {
		info, err := tab.funcInfo(i)
		if err != nil {
			fatal(err)
		}
		if len(info.name) < 5 || info.name[:5] != "main." {
			continue
		}
		entry := info.entry
		end := info.end
		for pc := entry; pc < end; pc++ {
			file, line, err := tab.pcFileLine(i, pc)
			if err != nil {
				fatal(err)
			}
			inls, err := tab.inlineFrames(i, pc)
			if err != nil {
				fatal(err)
			}
			if len(inls) == 0 && pc != entry && pc != entry+(end-entry)/2 {
				continue
			}
			rows = append(rows, row{
				Name:         info.name,
				PC:           fmt.Sprintf("0x%x", pc),
				File:         file,
				Line:         line,
				Fn:           info.name,
				InlineFrames: inls,
			})
		}
	}
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(rows); err != nil {
		fatal(err)
	}
}

func fatal(v any) {
	fmt.Fprintln(os.Stderr, v)
	os.Exit(1)
}

func loadGoFunc(f *elf.File) []byte {
	syms, err := f.Symbols()
	if err != nil {
		return nil
	}
	for _, s := range syms {
		if s.Name != "go:func.*" {
			continue
		}
		if int(s.Section) >= len(f.Sections) {
			return nil
		}
		sec := f.Sections[s.Section]
		b, err := sec.Data()
		if err != nil {
			return nil
		}
		if s.Value < sec.Addr {
			return nil
		}
		off := s.Value - sec.Addr
		if off > uint64(len(b)) {
			return nil
		}
		end := uint64(len(b))
		if s.Size > 0 && off+s.Size <= uint64(len(b)) {
			end = off + s.Size
		}
		return b[off:end]
	}
	return nil
}

type table struct {
	data           []byte
	gofunc         []byte
	little         bool
	quantum        uint32
	ptrsize        uint32
	textStart      uint64
	nfunctab       uint32
	funcnametabOff int
	cutabOff       int
	filetabOff     int
	pctabOff       int
	funcdataBase   int
	functab        []byte
}

func parseTable(data []byte, textStart uint64, gofunc []byte) (*table, error) {
	if len(data) < 16 {
		return nil, fmt.Errorf("short pclntab")
	}
	le := binary.LittleEndian.Uint32(data[:4])
	be := binary.BigEndian.Uint32(data[:4])
	little := true
	switch {
	case le == go120Magic:
		little = true
	case be == go120Magic:
		little = false
	case le == go118Magic:
		little = true
	case be == go118Magic:
		little = false
	default:
		return nil, fmt.Errorf("unsupported pclntab magic")
	}
	quantum := uint32(data[6])
	ptrsize := uint32(data[7])
	u := func(word uint32) uint64 {
		off := 8 + int(word)*int(ptrsize)
		if ptrsize == 4 {
			return uint64(u32(data, off, little))
		}
		return u64(data, off, little)
	}
	nfunctab := uint32(u(0))
	funcnametabOff := int(u(3))
	cutabOff := int(u(4))
	filetabOff := int(u(5))
	pctabOff := int(u(6))
	funcdataOff := int(u(7))
	sz := 4
	functabsize := (int(nfunctab)*2 + 1) * sz
	if funcdataOff+functabsize > len(data) {
		return nil, fmt.Errorf("functab truncated")
	}
	return &table{
		data:           data,
		gofunc:         gofunc,
		little:         little,
		quantum:        quantum,
		ptrsize:        ptrsize,
		textStart:      textStart,
		nfunctab:       nfunctab,
		funcnametabOff: funcnametabOff,
		cutabOff:       cutabOff,
		filetabOff:     filetabOff,
		pctabOff:       pctabOff,
		funcdataBase:   funcdataOff,
		functab:        data[funcdataOff : funcdataOff+functabsize],
	}, nil
}

type funcInfo struct {
	name  string
	entry uint64
	end   uint64
}

func (t *table) funcPC(i uint32) uint64 {
	off := 2 * int(i) * 4
	return uint64(u32(t.functab, off, t.little)) + t.textStart
}

func (t *table) funcOff(i uint32) uint32 {
	off := (2*int(i) + 1) * 4
	return u32(t.functab, off, t.little)
}

func (t *table) funcBytes(i uint32) []byte {
	return t.data[t.funcdataBase+int(t.funcOff(i)):]
}

func (t *table) field(fn []byte, n uint32) uint32 {
	off := 4 + int(n-1)*4
	return u32(fn, off, t.little)
}

func (t *table) entryPC(fn []byte) uint64 {
	return uint64(u32(fn, 0, t.little)) + t.textStart
}

func (t *table) funcName(fn []byte) string {
	return cstring(t.data[t.funcnametabOff:], int(t.field(fn, 1)))
}

func (t *table) funcInfo(i uint32) (funcInfo, error) {
	fn := t.funcBytes(i)
	return funcInfo{
		name:  t.funcName(fn),
		entry: t.funcPC(i),
		end:   t.funcPC(i + 1),
	}, nil
}

func (t *table) nfuncdata(fn []byte) uint8 {
	return fn[4+9*4+3]
}

func (t *table) npcdata(fn []byte) uint32 {
	return t.field(fn, 7)
}

func (t *table) pcdataStart(fn []byte, table uint32) (uint32, bool) {
	if table >= t.npcdata(fn) {
		return 0, false
	}
	off := 4 + 9*4 + 4 + int(table)*4
	v := u32(fn, off, t.little)
	if v == 0 {
		return 0, false
	}
	return v, true
}

func (t *table) funcdataOff(fn []byte, i uint8) (uint32, bool) {
	if i >= t.nfuncdata(fn) {
		return 0, false
	}
	off := 4 + 9*4 + 4 + int(t.npcdata(fn))*4 + int(i)*4
	v := u32(fn, off, t.little)
	if v == ^uint32(0) {
		return 0, false
	}
	return v, true
}

func (t *table) pcvalue(off uint32, entry, target uint64) int32 {
	p := t.data[t.pctabOff+int(off):]
	val := int32(-1)
	pc := entry
	first := true
	for {
		ok := t.step(&p, &pc, &val, first)
		first = false
		if !ok {
			return -1
		}
		if target < pc {
			return val
		}
	}
}

func (t *table) step(p *[]byte, pc *uint64, val *int32, first bool) bool {
	uv, rest, err := readvarint(*p)
	if err != nil {
		return false
	}
	*p = rest
	if uv == 0 && !first {
		return false
	}
	var vdelta int32
	if uv&1 != 0 {
		vdelta = ^int32(uv >> 1)
	} else {
		vdelta = int32(uv >> 1)
	}
	pcdelta, rest, err := readvarint(*p)
	if err != nil {
		return false
	}
	*p = rest
	*pc += uint64(pcdelta) * uint64(t.quantum)
	*val += vdelta
	return true
}

func (t *table) fileName(fn []byte, fno int32) string {
	if fno < 0 {
		return ""
	}
	cu := t.field(fn, 8)
	if cu == ^uint32(0) {
		return ""
	}
	idx := int(cu+uint32(fno)) * 4
	fnoff := u32(t.data[t.cutabOff:], idx, t.little)
	if fnoff == ^uint32(0) {
		return ""
	}
	return cstring(t.data[t.filetabOff:], int(fnoff))
}

func (t *table) pcFileLine(i uint32, pc uint64) (string, uint32, error) {
	fn := t.funcBytes(i)
	entry := t.entryPC(fn)
	line := t.pcvalue(t.field(fn, 6), entry, pc)
	fno := t.pcvalue(t.field(fn, 5), entry, pc)
	file := t.fileName(fn, fno)
	if line < 0 {
		line = 0
	}
	return file, uint32(line), nil
}

func (t *table) inlineFrames(i uint32, pc uint64) ([]frame, error) {
	empty := []frame{}
	if len(t.gofunc) == 0 {
		return empty, nil
	}
	fn := t.funcBytes(i)
	entry := t.entryPC(fn)
	treeOff, ok := t.funcdataOff(fn, funcdataInlTree)
	if !ok {
		return empty, nil
	}
	var frames []frame
	current := pc
	for range 64 {
		off, ok := t.pcdataStart(fn, pcdataInlTreeIndex)
		if !ok {
			break
		}
		idx := t.pcvalue(off, entry, current)
		if idx < 0 {
			break
		}
		base := int(treeOff) + int(idx)*inlCallSize
		if base+inlCallSize > len(t.gofunc) {
			break
		}
		call := t.gofunc[base : base+inlCallSize]
		nameOff := int32(u32(call, 4, t.little))
		parentPc := int32(u32(call, 8, t.little))
		name := cstring(t.data[t.funcnametabOff:], int(nameOff))
		file, line, err := t.pcFileLine(i, current)
		if err != nil {
			return nil, err
		}
		frames = append(frames, frame{File: file, Line: line, Fn: name})
		if parentPc < 0 {
			break
		}
		current = entry + uint64(parentPc)
	}
	return frames, nil
}

func u32(b []byte, off int, little bool) uint32 {
	if off < 0 || off+4 > len(b) {
		return 0
	}
	if little {
		return binary.LittleEndian.Uint32(b[off : off+4])
	}
	return binary.BigEndian.Uint32(b[off : off+4])
}

func u64(b []byte, off int, little bool) uint64 {
	if off < 0 || off+8 > len(b) {
		return 0
	}
	if little {
		return binary.LittleEndian.Uint64(b[off : off+8])
	}
	return binary.BigEndian.Uint64(b[off : off+8])
}

func cstring(b []byte, off int) string {
	if off < 0 || off >= len(b) {
		return ""
	}
	n := 0
	for off+n < len(b) && b[off+n] != 0 {
		n++
	}
	return string(b[off : off+n])
}

func readvarint(p []byte) (uint32, []byte, error) {
	var v, shift uint32
	for {
		if len(p) == 0 {
			return 0, nil, fmt.Errorf("truncated varint")
		}
		b := p[0]
		p = p[1:]
		v |= uint32(b&0x7f) << shift
		if b&0x80 == 0 {
			return v, p, nil
		}
		shift += 7
		if shift >= 32 {
			return 0, nil, fmt.Errorf("varint overflow")
		}
	}
}
