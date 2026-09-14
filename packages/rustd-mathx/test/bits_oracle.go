// Oracle for rustd-mathx math/bits: emit Go-expected results as JSON.
package main

import (
	"encoding/json"
	"fmt"
	"math/bits"
	"os"
	"strconv"
)

func u64s(v uint64) string { return strconv.FormatUint(v, 10) }

func u32set() []uint32 {
	out := []uint32{0, 1, 2, 0xfffffffe, 0xffffffff, 0x80000000, 0x7fffffff, 0xaaaaaaaa, 0x55555555}
	for i := 0; i < 32; i++ {
		out = append(out, 1<<uint(i))
	}
	seen := map[uint32]struct{}{}
	var uniq []uint32
	for _, v := range out {
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		uniq = append(uniq, v)
	}
	return uniq
}

func u64set() []uint64 {
	out := []uint64{0, 1, 2, ^uint64(0) - 1, ^uint64(0), 1 << 63, 1<<63 - 1, 0xaaaaaaaaaaaaaaaa, 0x5555555555555555}
	for i := 0; i < 64; i++ {
		out = append(out, 1<<uint(i))
	}
	seen := map[uint64]struct{}{}
	var uniq []uint64
	for _, v := range out {
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		uniq = append(uniq, v)
	}
	return uniq
}

func main() {
	u8ops := map[string][]int{
		"leadingZeros": make([]int, 256), "trailingZeros": make([]int, 256),
		"onesCount": make([]int, 256), "len": make([]int, 256), "reverse": make([]int, 256),
	}
	for x := 0; x < 256; x++ {
		v := uint8(x)
		u8ops["leadingZeros"][x] = bits.LeadingZeros8(v)
		u8ops["trailingZeros"][x] = bits.TrailingZeros8(v)
		u8ops["onesCount"][x] = bits.OnesCount8(v)
		u8ops["len"][x] = bits.Len8(v)
		u8ops["reverse"][x] = int(bits.Reverse8(v))
	}
	u16ops := map[string][]int{
		"leadingZeros": make([]int, 65536), "trailingZeros": make([]int, 65536),
		"onesCount": make([]int, 65536), "len": make([]int, 65536),
		"reverse": make([]int, 65536), "reverseBytes": make([]int, 65536),
	}
	for x := 0; x < 65536; x++ {
		v := uint16(x)
		u16ops["leadingZeros"][x] = bits.LeadingZeros16(v)
		u16ops["trailingZeros"][x] = bits.TrailingZeros16(v)
		u16ops["onesCount"][x] = bits.OnesCount16(v)
		u16ops["len"][x] = bits.Len16(v)
		u16ops["reverse"][x] = int(bits.Reverse16(v))
		u16ops["reverseBytes"][x] = int(bits.ReverseBytes16(v))
	}

	v32 := u32set()
	ops32 := map[string][]int{
		"leadingZeros": make([]int, len(v32)), "trailingZeros": make([]int, len(v32)),
		"onesCount": make([]int, len(v32)), "len": make([]int, len(v32)),
	}
	rev32 := make([]uint32, len(v32))
	revb32 := make([]uint32, len(v32))
	for i, v := range v32 {
		ops32["leadingZeros"][i] = bits.LeadingZeros32(v)
		ops32["trailingZeros"][i] = bits.TrailingZeros32(v)
		ops32["onesCount"][i] = bits.OnesCount32(v)
		ops32["len"][i] = bits.Len32(v)
		rev32[i] = bits.Reverse32(v)
		revb32[i] = bits.ReverseBytes32(v)
	}

	v64 := u64set()
	ops64 := map[string][]int{
		"leadingZeros": make([]int, len(v64)), "trailingZeros": make([]int, len(v64)),
		"onesCount": make([]int, len(v64)), "len": make([]int, len(v64)),
	}
	rev64 := make([]string, len(v64))
	revb64 := make([]string, len(v64))
	values64 := make([]string, len(v64))
	for i, v := range v64 {
		ops64["leadingZeros"][i] = bits.LeadingZeros64(v)
		ops64["trailingZeros"][i] = bits.TrailingZeros64(v)
		ops64["onesCount"][i] = bits.OnesCount64(v)
		ops64["len"][i] = bits.Len64(v)
		rev64[i] = u64s(bits.Reverse64(v))
		revb64[i] = u64s(bits.ReverseBytes64(v))
		values64[i] = u64s(v)
	}

	ks := []int{-65, -64, -63, -33, -32, -31, -17, -16, -15, -9, -8, -7, -1, 0, 1, 7, 8, 9, 15, 16, 31, 32, 33, 63, 64, 65, 127, 128, 255, 256, 1000, -1000}
	xs8 := []int{0, 1, 0x80, 0xaa, 0xff}
	xs16 := []uint16{0, 1, 0x8000, 0xaaaa, 0xffff}
	xs32 := []uint32{0, 1, 0x80000000, 0xaaaaaaaa, 0xffffffff}
	xs64 := []uint64{0, 1, 1 << 63, 0xaaaaaaaaaaaaaaaa, ^uint64(0)}
	r8 := make([][]int, len(xs8))
	r16 := make([][]uint16, len(xs16))
	r32 := make([][]uint32, len(xs32))
	r64 := make([][]string, len(xs64))
	xs64s := make([]string, len(xs64))
	for i, x := range xs8 {
		r8[i] = make([]int, len(ks))
		for j, k := range ks {
			r8[i][j] = int(bits.RotateLeft8(uint8(x), k))
		}
	}
	for i, x := range xs16 {
		r16[i] = make([]uint16, len(ks))
		for j, k := range ks {
			r16[i][j] = bits.RotateLeft16(x, k)
		}
	}
	for i, x := range xs32 {
		r32[i] = make([]uint32, len(ks))
		for j, k := range ks {
			r32[i][j] = bits.RotateLeft32(x, k)
		}
	}
	for i, x := range xs64 {
		xs64s[i] = u64s(x)
		r64[i] = make([]string, len(ks))
		for j, k := range ks {
			r64[i][j] = u64s(bits.RotateLeft64(x, k))
		}
	}

	var ariths []map[string]any
	vals := []uint64{0, 1, 2, 0xffffffff, 0x80000000, ^uint64(0), 1 << 63, 0xaaaaaaaaaaaaaaaa}
	for _, x := range vals {
		for _, y := range vals {
			for _, c := range []uint64{0, 1} {
				x32, y32, c32 := uint32(x), uint32(y), uint32(c)
				s32, co32 := bits.Add32(x32, y32, c32)
				s64, co64 := bits.Add64(x, y, c)
				d32, bo32 := bits.Sub32(x32, y32, c32)
				d64, bo64 := bits.Sub64(x, y, c)
				h32, l32 := bits.Mul32(x32, y32)
				h64, l64 := bits.Mul64(x, y)
				row := map[string]any{
					"x": u64s(x), "y": u64s(y), "c": u64s(c),
					"add32": []uint32{s32, co32}, "sub32": []uint32{d32, bo32}, "mul32": []uint32{h32, l32},
					"add64": []string{u64s(s64), u64s(co64)},
					"sub64": []string{u64s(d64), u64s(bo64)},
					"mul64": []string{u64s(h64), u64s(l64)},
				}
				hi32, lo32 := c32, x32
				if y32 != 0 && y32 > hi32 {
					q, r := bits.Div32(hi32, lo32, y32)
					row["div32"] = []uint32{q, r}
					row["rem32"] = bits.Rem32(hi32, lo32, y32)
				}
				hi64, lo64 := c, x
				if y != 0 && y > hi64 {
					q, r := bits.Div64(hi64, lo64, y)
					row["div64"] = []string{u64s(q), u64s(r)}
					row["rem64"] = u64s(bits.Rem64(hi64, lo64, y))
				}
				ariths = append(ariths, row)
			}
		}
	}

	packet := map[string]any{
		"unary8":  u8ops,
		"unary16": u16ops,
		"unary32": map[string]any{"values": v32, "ops": ops32, "reverse": rev32, "reverseBytes": revb32},
		"unary64": map[string]any{"values": values64, "ops": ops64, "reverse": rev64, "reverseBytes": revb64},
		"rotate": map[string]any{
			"k": ks, "x8": xs8, "x16": xs16, "x32": xs32, "x64": xs64s,
			"r8": r8, "r16": r16, "r32": r32, "r64": r64,
		},
		"arith": ariths,
		"rotateLeft64_1_neg1": u64s(bits.RotateLeft64(1, -1)),
	}
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(packet); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
