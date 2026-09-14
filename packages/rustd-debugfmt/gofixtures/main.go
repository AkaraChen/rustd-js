package main

import "fmt"

var version = "dev"

type Box struct {
	Label string
}

//go:noinline
func (b *Box) Name() string { return b.Label }

func helper(n int) int {
	if n < 2 {
		return n
	}
	return helper(n-1) + helper(n-2)
}

//go:noinline
func opaque() int { return 3 }

func inlineAdd(a, b int) int {
	return a + b
}

func inlineMul(a, b int) int {
	return inlineAdd(a, 1) + a*b
}

func main() {
	box := &Box{Label: version}
	x := opaque()
	fmt.Println(box.Name(), helper(8), inlineMul(x, x+1))
}
