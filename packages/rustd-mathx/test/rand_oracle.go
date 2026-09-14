package main

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"strconv"
)

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
	pcg12 := rand.NewPCG(1, 2)
	pcg00 := rand.NewPCG(0, 0)
	pcg12state, err := rand.NewPCG(1, 2).MarshalBinary()
	if err != nil {
		panic(err)
	}
	pcg12mid := rand.NewPCG(1, 2)
	_ = u64s(100, pcg12mid.Uint64)
	pcg12midState, err := pcg12mid.MarshalBinary()
	if err != nil {
		panic(err)
	}
	pcg12midNext := pcg12mid.Uint64()

	var seed [32]byte
	seed[0] = 1
	chacha := rand.NewChaCha8(seed)
	chachaFresh, err := rand.NewChaCha8(seed).MarshalBinary()
	if err != nil {
		panic(err)
	}
	chachaMid := rand.NewChaCha8(seed)
	_ = u64s(100, chachaMid.Uint64)
	chachaMidState, err := chachaMid.MarshalBinary()
	if err != nil {
		panic(err)
	}
	chachaMidNext := chachaMid.Uint64()

	chachaRead := rand.NewChaCha8(seed)
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
	}
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
