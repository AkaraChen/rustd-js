package main

import (
	"encoding/binary"
	"os"
	"path/filepath"

	randv2 "math/rand/v2"
)

const n = 1_000_000

func writeStream(path string, next func() uint64) {
	buf := make([]byte, n*8)
	for i := 0; i < n; i++ {
		binary.LittleEndian.PutUint64(buf[i*8:], next())
	}
	if err := os.WriteFile(path, buf, 0o644); err != nil {
		panic(err)
	}
}

func main() {
	if len(os.Args) != 2 {
		panic("usage: rand_oracle_million <outdir>")
	}
	dir := os.Args[1]
	pcg12 := randv2.NewPCG(1, 2)
	pcg00 := randv2.NewPCG(0, 0)
	var seed [32]byte
	seed[0] = 1
	chacha := randv2.NewChaCha8(seed)
	writeStream(filepath.Join(dir, "pcg12.bin"), pcg12.Uint64)
	writeStream(filepath.Join(dir, "pcg00.bin"), pcg00.Uint64)
	writeStream(filepath.Join(dir, "chacha.bin"), chacha.Uint64)
}
