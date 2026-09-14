package main

import (
	"fmt"
	"hash/adler32"
	"hash/crc32"
	"hash/fnv"
	"time"
)

func main() {
	data := make([]byte, 1<<20)
	state := uint32(42)
	for i := range data {
		state = 1664525*state + 1013904223
		data[i] = byte(state >> 24)
	}
	bench("crc32-ieee", func() {
		_ = crc32.ChecksumIEEE(data)
	})
	bench("adler32", func() {
		_ = adler32.Checksum(data)
	})
	bench("fnv32a", func() {
		h := fnv.New32a()
		h.Write(data)
		_ = h.Sum32()
	})
}

func bench(name string, fn func()) {
	for i := 0; i < 20; i++ {
		fn()
	}
	start := time.Now()
	const n = 1000
	for i := 0; i < n; i++ {
		fn()
	}
	elapsed := time.Since(start)
	fmt.Printf("%s %d loops %d ns/op %.2f MiB/s\n", name, n, elapsed.Nanoseconds()/n, float64(n)/elapsed.Seconds())
}
