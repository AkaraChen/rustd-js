package main

import (
	"debug/elf"
	"debug/gosym"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: dumpgosym <binary>")
		os.Exit(2)
	}
	f, err := elf.Open(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer f.Close()
	sec := f.Section(".gopclntab")
	if sec == nil {
		fmt.Fprintln(os.Stderr, "no .gopclntab")
		os.Exit(1)
	}
	data, err := sec.Data()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	text := f.Section(".text")
	if text == nil {
		fmt.Fprintln(os.Stderr, "no .text")
		os.Exit(1)
	}
	tab, err := gosym.NewTable(nil, gosym.NewLineTable(data, text.Addr))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fn := tab.LookupFunc("main.main")
	if fn == nil {
		fmt.Fprintln(os.Stderr, "no main.main")
		os.Exit(1)
	}
	file, ln, _ := tab.PCToLine(fn.Entry)
	fmt.Printf("name=%s entry=%#x end=%#x file=%s line=%d\n", fn.Name, fn.Entry, fn.End, file, ln)
}
