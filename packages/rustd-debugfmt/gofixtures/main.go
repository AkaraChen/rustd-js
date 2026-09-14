package main

import "fmt"

var version = "dev"

type Box struct {
	Label string
}

func (b *Box) Name() string { return b.Label }

func helper(n int) int {
	if n < 2 {
		return n
	}
	return helper(n-1) + helper(n-2)
}

func main() {
	box := &Box{Label: version}
	fmt.Println(box.Name(), helper(8))
}
