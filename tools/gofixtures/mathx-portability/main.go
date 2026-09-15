package main

import (
	"fmt"
	"math"
	"math/bits"
	"math/cmplx"
	"runtime"
)

//go:noinline
func opaque(x uint8) uint8 { return x }

func main() {
	fmt.Printf("go=%s arch=%s\n", runtime.Version(), runtime.GOARCH)
	fmt.Printf("Reverse8(1) constant=%d runtime=%d\n", bits.Reverse8(1), bits.Reverse8(opaque(1)))
	fmt.Printf("Reverse8(1)==128 constant=%t runtime=%t\n", bits.Reverse8(1) == 128, bits.Reverse8(opaque(1)) == 128)
	if bits.Reverse8(opaque(1)) != 128 {
		fmt.Printf("direct branch: FAIL (value printed separately: %d)\n", bits.Reverse8(opaque(1)))
	} else {
		fmt.Println("direct branch: PASS")
	}
	if opaque(bits.Reverse8(opaque(1))) != 128 {
		fmt.Println("materialized result branch: FAIL")
	} else {
		fmt.Println("materialized result branch: PASS")
	}
	x, y := complex(math.Pi, 1), complex(math.Pi, math.Pi)
	m, phase := cmplx.Abs(x), cmplx.Phase(x)
	theta := real(y) * phase
	plain := theta + float64(imag(y)*math.Log(m))
	fused := math.FMA(imag(y), math.Log(m), theta)
	fmt.Printf("Pow(pi+i,pi+pi*i).real=%016x modulus=%016x phase=%016x log=%016x theta_plain=%016x theta_fma=%016x\n",
		math.Float64bits(real(cmplx.Pow(x, y))), math.Float64bits(m), math.Float64bits(phase), math.Float64bits(math.Log(m)), math.Float64bits(plain), math.Float64bits(fused))
}
