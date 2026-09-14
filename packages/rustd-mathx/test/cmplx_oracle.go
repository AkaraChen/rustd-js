package main

import (
	"encoding/json"
	"fmt"
	"math"
	"math/cmplx"
	"math/rand"
	"os"
)

func bits(f float64) string {
	return fmt.Sprintf("%016x", math.Float64bits(f))
}

type C struct {
	Re string `json:"re"`
	Im string `json:"im"`
}

func pack(z complex128) C { return C{bits(real(z)), bits(imag(z))} }

type Unary struct {
	In                 C      `json:"in"`
	Abs                string `json:"abs"`
	Arg                string `json:"arg"`
	Norm               string `json:"norm"`
	Conj               C      `json:"conj"`
	Exp                C      `json:"exp"`
	Log                C      `json:"log"`
	Sqrt               C      `json:"sqrt"`
	Sin                C      `json:"sin"`
	Cos                C      `json:"cos"`
	Tan                C      `json:"tan"`
	Sinh               C      `json:"sinh"`
	Cosh               C      `json:"cosh"`
	Tanh               C      `json:"tanh"`
	Asin               C      `json:"asin"`
	Acos               C      `json:"acos"`
	Atan               C      `json:"atan"`
	Asinh              C      `json:"asinh"`
	Acosh              C      `json:"acosh"`
	Atanh              C      `json:"atanh"`
	Cot                C      `json:"cot"`
	PolarR             string `json:"polarR"`
	PolarPhi           string `json:"polarPhi"`
	IsInf0             bool   `json:"isInf0"`
	IsInfPos           bool   `json:"isInfPos"`
	IsInfNeg           bool   `json:"isInfNeg"`
	IsNaN              bool   `json:"isNaN"`
}

func powSafe(x, y complex128) (z complex128, ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	return cmplx.Pow(x, y), true
}

func unary(z complex128) Unary {
	r, phi := cmplx.Polar(z)
	return Unary{
		In: pack(z),
		Abs: bits(cmplx.Abs(z)), Arg: bits(cmplx.Phase(z)),
		Norm: bits(real(z)*real(z) + imag(z)*imag(z)),
		Conj: pack(cmplx.Conj(z)), Exp: pack(cmplx.Exp(z)), Log: pack(cmplx.Log(z)),
		Sqrt: pack(cmplx.Sqrt(z)), Sin: pack(cmplx.Sin(z)), Cos: pack(cmplx.Cos(z)),
		Tan: pack(cmplx.Tan(z)), Sinh: pack(cmplx.Sinh(z)), Cosh: pack(cmplx.Cosh(z)),
		Tanh: pack(cmplx.Tanh(z)), Asin: pack(cmplx.Asin(z)), Acos: pack(cmplx.Acos(z)),
		Atan: pack(cmplx.Atan(z)), Asinh: pack(cmplx.Asinh(z)), Acosh: pack(cmplx.Acosh(z)),
		Atanh: pack(cmplx.Atanh(z)), Cot: pack(cmplx.Cot(z)),
		PolarR: bits(r), PolarPhi: bits(phi),
		IsInf0:   cmplx.IsInf(z),
		IsInfPos: math.IsInf(real(z), 1) || math.IsInf(imag(z), 1),
		IsInfNeg: math.IsInf(real(z), -1) || math.IsInf(imag(z), -1),
		IsNaN:    cmplx.IsNaN(z),
	}
}

func main() {
	specials := []float64{
		0, math.Copysign(0, -1), 1, -1, 0.5, -0.5, 2, -2,
		math.Pi, math.Inf(1), math.Inf(-1), math.NaN(),
	}
	var zs []complex128
	for _, re := range specials {
		for _, im := range specials {
			zs = append(zs, complex(re, im))
		}
	}
	rng := rand.New(rand.NewSource(1))
	for i := 0; i < 64; i++ {
		zs = append(zs, complex(rng.NormFloat64()*4, rng.NormFloat64()*4))
	}

	type PowRow struct {
		X   C `json:"x"`
		Y   C `json:"y"`
		Out C `json:"out"`
	}
	unaries := make([]Unary, 0, len(zs))
	for _, z := range zs {
		unaries = append(unaries, unary(z))
	}
	powSet := zs[:len(specials)*len(specials)]
	pows := make([]PowRow, 0, len(powSet)*len(powSet))
	for _, x := range powSet {
		for _, y := range powSet {
			z, ok := powSafe(x, y)
			if !ok {
				continue
			}
			pows = append(pows, PowRow{pack(x), pack(y), pack(z)})
		}
	}
	type RectRow struct {
		R   string `json:"r"`
		Phi string `json:"phi"`
		Re  string `json:"re"`
		Im  string `json:"im"`
	}
	var rects []RectRow
	for _, r := range []float64{0, 1, -1, math.Inf(1), 2} {
		for _, phi := range []float64{0, math.Copysign(0, -1), math.Pi, -math.Pi / 2, 1} {
			z := cmplx.Rect(r, phi)
			rects = append(rects, RectRow{bits(r), bits(phi), bits(real(z)), bits(imag(z))})
		}
	}
	pr, pphi := cmplx.Polar(-1)
	out := map[string]any{
		"nan":          bits(math.NaN()),
		"inf":          pack(cmplx.Inf()),
		"nanC":         pack(cmplx.NaN()),
		"sqrtNeg1":     pack(cmplx.Sqrt(-1)),
		"polarNeg1R":   bits(pr),
		"polarNeg1Phi": bits(pphi),
		"unary":        unaries,
		"pow":          pows,
		"rect":         rects,
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		panic(err)
	}
}
