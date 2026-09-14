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
	}
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
