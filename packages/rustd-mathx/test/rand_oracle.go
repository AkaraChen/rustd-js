package main

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	randv2 "math/rand/v2"
	"os"
	"strconv"
)

func i64s(n int, next func() int64) []string {
	out := make([]string, n)
	for i := 0; i < n; i++ {
		out[i] = strconv.FormatInt(next(), 10)
	}
	return out
}

func f64bits(n int, next func() float64) []string {
	out := make([]string, n)
	for i := 0; i < n; i++ {
		out[i] = strconv.FormatUint(math.Float64bits(next()), 16)
	}
	return out
}

func f32bits(n int, next func() float32) []string {
	out := make([]string, n)
	for i := 0; i < n; i++ {
		out[i] = strconv.FormatUint(uint64(math.Float32bits(next())), 16)
	}
	return out
}

func ints(n int, next func() int) []int {
	out := make([]int, n)
	for i := 0; i < n; i++ {
		out[i] = next()
	}
	return out
}

func permOf(r interface{ Perm(int) []int }, n int) []int {
	return r.Perm(n)
}

func shuffleOf(n int, next func(n int, swap func(i, j int))) []int {
	p := make([]int, n)
	for i := range p {
		p[i] = i
	}
	next(n, func(i, j int) { p[i], p[j] = p[j], p[i] })
	return p
}

func v1Read(seed int64, n int) []byte {
	buf := make([]byte, n)
	if _, err := rand.New(rand.NewSource(seed)).Read(buf); err != nil {
		panic(err)
	}
	return buf
}

func v1ReadContinue(seed int64, first, second int) []byte {
	r := rand.New(rand.NewSource(seed))
	a := make([]byte, first)
	b := make([]byte, second)
	if _, err := r.Read(a); err != nil {
		panic(err)
	}
	if _, err := r.Read(b); err != nil {
		panic(err)
	}
	out := make([]byte, 0, first+second)
	out = append(out, a...)
	out = append(out, b...)
	return out
}

func u64s(n int, next func() uint64) []string {
	out := make([]string, n)
	for i := 0; i < n; i++ {
		out[i] = strconv.FormatUint(next(), 10)
	}
	return out
}

func hexOf(b []byte) string {
	const hexdigits = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, v := range b {
		out[i*2] = hexdigits[v>>4]
		out[i*2+1] = hexdigits[v&0x0f]
	}
	return string(out)
}

func main() {
	const n = 10000
	pcg12 := randv2.NewPCG(1, 2)
	pcg00 := randv2.NewPCG(0, 0)
	pcg12state, err := randv2.NewPCG(1, 2).MarshalBinary()
	if err != nil {
		panic(err)
	}
	pcg12mid := randv2.NewPCG(1, 2)
	_ = u64s(100, pcg12mid.Uint64)
	pcg12midState, err := pcg12mid.MarshalBinary()
	if err != nil {
		panic(err)
	}
	pcg12midNext := pcg12mid.Uint64()

	var seed [32]byte
	seed[0] = 1
	chacha := randv2.NewChaCha8(seed)
	chachaFresh, err := randv2.NewChaCha8(seed).MarshalBinary()
	if err != nil {
		panic(err)
	}
	chachaMid := randv2.NewChaCha8(seed)
	_ = u64s(100, chachaMid.Uint64)
	chachaMidState, err := chachaMid.MarshalBinary()
	if err != nil {
		panic(err)
	}
	chachaMidNext := chachaMid.Uint64()

	chachaRead := randv2.NewChaCha8(seed)
	var tmp [3]byte
	if _, err := chachaRead.Read(tmp[:]); err != nil {
		panic(err)
	}
	chachaReadState, err := chachaRead.MarshalBinary()
	if err != nil {
		panic(err)
	}
	chachaReadNext := chachaRead.Uint64()

	pcgN7 := randv2.New(randv2.NewPCG(1, 2))
	pcgPow2 := randv2.New(randv2.NewPCG(1, 2))
	pcgU32 := randv2.New(randv2.NewPCG(1, 2))
	pcgU32N := randv2.New(randv2.NewPCG(1, 2))
	pcgIntN := randv2.New(randv2.NewPCG(1, 2))
	pcgI32 := randv2.New(randv2.NewPCG(1, 2))
	pcgI32N := randv2.New(randv2.NewPCG(1, 2))
	pcgI64N := randv2.New(randv2.NewPCG(1, 2))
	pcgI64 := randv2.New(randv2.NewPCG(1, 2))
	pcgInt := randv2.New(randv2.NewPCG(1, 2))
	pcgUint := randv2.New(randv2.NewPCG(1, 2))
	pcgF64 := randv2.New(randv2.NewPCG(1, 2))
	pcgF32 := randv2.New(randv2.NewPCG(1, 2))
	pcgPerm := randv2.New(randv2.NewPCG(1, 2))
	pcgShuf := randv2.New(randv2.NewPCG(1, 2))
	chachaWide := randv2.New(randv2.NewChaCha8(seed))
	chachaN3 := randv2.New(randv2.NewChaCha8(seed))
	v1I63n := rand.New(rand.NewSource(1))
	v1I31 := rand.New(rand.NewSource(1))
	v1I31n := rand.New(rand.NewSource(1))
	v1Intn := rand.New(rand.NewSource(1))
	v1U32 := rand.New(rand.NewSource(1))
	v1F32 := rand.New(rand.NewSource(1))
	v1Perm := rand.New(rand.NewSource(1))
	v1Shuf := rand.New(rand.NewSource(1))

	out := map[string]any{
		"pcg12First3": []string{
			"14192431797130687760",
			"11371241257079532652",
			"14470142590855381128",
		},
		"pcg12":         u64s(n, pcg12.Uint64),
		"pcg00":         u64s(n, pcg00.Uint64),
		"pcg12State":    hexOf(pcg12state),
		"pcg12MidState": hexOf(pcg12midState),
		"pcg12MidNext":  strconv.FormatUint(pcg12midNext, 10),
		"chacha":        u64s(n, chacha.Uint64),
		"chachaState":   hexOf(chachaFresh),
		"chachaMidState": hexOf(chachaMidState),
		"chachaMidNext": strconv.FormatUint(chachaMidNext, 10),
		"chachaReadState": hexOf(chachaReadState),
		"chachaReadNext":  strconv.FormatUint(chachaReadNext, 10),
		"chachaRead3":     hexOf(tmp[:]),
		"v1Seed1Int63":    i64s(n, rand.New(rand.NewSource(1)).Int63),
		"v1Seed1Float64":  f64bits(n, rand.New(rand.NewSource(1)).Float64),
		"v1Seed1Read8":    hexOf(v1Read(1, 8)),
		"v1Seed1Read64":   hexOf(v1Read(1, 64)),
		"v1Seed1Read3Then8": hexOf(v1ReadContinue(1, 3, 8)),
		"v1Seed0Int63Head": i64s(8, rand.New(rand.NewSource(0)).Int63),
		"v1SeedNeg1Int63Head": i64s(8, rand.New(rand.NewSource(-1)).Int63),
		"pcg12Uint64N7":    u64s(n, func() uint64 { return pcgN7.Uint64N(7) }),
		"pcg12Uint64NPow2": u64s(256, func() uint64 { return pcgPow2.Uint64N(1 << 10) }),
		"pcg12Uint32":      ints(n, func() int { return int(pcgU32.Uint32()) }),
		"pcg12Uint32N10":   ints(n, func() int { return int(pcgU32N.Uint32N(10)) }),
		"pcg12IntN100":     ints(n, func() int { return pcgIntN.IntN(100) }),
		"pcg12Int32":       ints(n, func() int { return int(pcgI32.Int32()) }),
		"pcg12Int32N7":     ints(n, func() int { return int(pcgI32N.Int32N(7)) }),
		"pcg12Int64N":      i64s(n, func() int64 { return pcgI64N.Int64N(1 << 40) }),
		"pcg12Int64":       i64s(n, pcgI64.Int64),
		"pcg12Int":         i64s(n, func() int64 { return int64(pcgInt.Int()) }),
		"pcg12Uint":        u64s(n, func() uint64 { return uint64(pcgUint.Uint()) }),
		"pcg12Float64":     f64bits(n, pcgF64.Float64),
		"pcg12Float32":     f32bits(n, pcgF32.Float32),
		"pcg12Perm0":       permOf(pcgPerm, 0),
		"pcg12Perm1":       permOf(pcgPerm, 1),
		"pcg12Perm2":       permOf(pcgPerm, 2),
		"pcg12Perm1000":    permOf(pcgPerm, 1000),
		"pcg12Perm10000":   permOf(pcgPerm, 10000),
		"pcg12Shuffle0":    shuffleOf(0, pcgShuf.Shuffle),
		"pcg12Shuffle1":    shuffleOf(1, pcgShuf.Shuffle),
		"pcg12Shuffle2":    shuffleOf(2, pcgShuf.Shuffle),
		"pcg12Shuffle1000": shuffleOf(1000, pcgShuf.Shuffle),
		"pcg12Shuffle10000": shuffleOf(10000, pcgShuf.Shuffle),
		"chachaFloat64":    f64bits(n, chachaWide.Float64),
		"chachaUint64N3":   u64s(n, func() uint64 { return chachaN3.Uint64N(3) }),
		"v1Int63n100":      i64s(n, func() int64 { return v1I63n.Int63n(100) }),
		"v1Int31":          ints(n, func() int { return int(v1I31.Int31()) }),
		"v1Int31n10":       ints(n, func() int { return int(v1I31n.Int31n(10)) }),
		"v1Intn50":         ints(n, func() int { return v1Intn.Intn(50) }),
		"v1Uint32":         ints(n, func() int { return int(v1U32.Uint32()) }),
		"v1Float32":        f32bits(n, v1F32.Float32),
		"v1Perm0": permOf(v1Perm, 0),
		"v1Perm1": permOf(v1Perm, 1),
		"v1Perm2": permOf(v1Perm, 2),
		"v1Perm1000": permOf(v1Perm, 1000),
		"v1Perm10000": permOf(v1Perm, 10000),
		"v1Shuffle0": shuffleOf(0, v1Shuf.Shuffle),
		"v1Shuffle1": shuffleOf(1, v1Shuf.Shuffle),
		"v1Shuffle2": shuffleOf(2, v1Shuf.Shuffle),
		"v1Shuffle1000": shuffleOf(1000, v1Shuf.Shuffle),
		"v1Shuffle10000": shuffleOf(10000, v1Shuf.Shuffle),
	}
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
