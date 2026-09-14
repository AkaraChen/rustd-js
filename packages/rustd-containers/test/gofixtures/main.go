package main

import (
	"bytes"
	"container/heap"
	"container/list"
	"container/ring"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"index/suffixarray"
	"io"
	"os"
	"strconv"
)

type lookupCase struct {
	Query string `json:"queryHex"`
	N     int    `json:"n"`
	Hits  []int  `json:"hits"`
}

type saCase struct {
	Name  string       `json:"name"`
	Data  string       `json:"dataHex"`
	Write string       `json:"writeHex"`
	Looks []lookupCase `json:"lookups"`
}

type heapCase struct {
	Name   string `json:"name"`
	Pushes []int  `json:"pushes"`
	Pops   []int  `json:"pops"`
	After  []int  `json:"after"`
}

type listCase struct {
	Name      string `json:"name"`
	A         []int  `json:"a"`
	B         []int  `json:"b"`
	AfterA    []int  `json:"afterA"`
	AfterB    []int  `json:"afterB"`
	RemoveVal int    `json:"removeVal"`
	RemoveOut int    `json:"removeOut"`
}

type ringCase struct {
	Name   string `json:"name"`
	N      int    `json:"n"`
	Move   int    `json:"move"`
	Values []any  `json:"values"`
	Moved  []any  `json:"moved"`
	Unlink int    `json:"unlink"`
	Left   []any  `json:"left"`
	Took   []any  `json:"took"`
}

type packet struct {
	Version int        `json:"version"`
	SA      []saCase   `json:"suffixarray"`
	Heap    []heapCase `json:"heap"`
	List    []listCase `json:"list"`
	Ring    []ringCase `json:"ring"`
}

type intHeap []int

func (h intHeap) Len() int           { return len(h) }
func (h intHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h intHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *intHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *intHeap) Pop() any {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[:n-1]
	return x
}

func dumpRing(r *ring.Ring) []any {
	if r == nil {
		return []any{}
	}
	out := make([]any, 0, r.Len())
	r.Do(func(v any) { out = append(out, v) })
	return out
}

func generate() packet {
	inputs := [][]byte{
		{},
		[]byte{0},
		[]byte("a"),
		[]byte("aa"),
		[]byte("aaa"),
		[]byte("banana"),
		[]byte("mississippi"),
		[]byte("abcabxabcd"),
		[]byte("the quick brown fox"),
		[]byte("你好世界"),
		bytes.Repeat([]byte("a"), 64),
		bytes.Repeat([]byte("ab"), 32),
		{0, 1, 2, 255, 0, 1},
		[]byte("DNAACGTACGTACGTAAAA"),
	}
	for i := 0; i < 200; i++ {
		b := make([]byte, 8+(i%40))
		for j := range b {
			b[j] = byte(i*13 + j*7)
		}
		inputs = append(inputs, b)
	}
	for n := 1; n <= 32; n++ {
		inputs = append(inputs, bytes.Repeat([]byte{byte(n)}, n))
	}

	saCases := make([]saCase, 0, len(inputs))
	queries := [][]byte{[]byte("a"), []byte("an"), []byte("na"), []byte("aa"), {0}, []byte("世界"), []byte("xyz")}
	for i, data := range inputs {
		ix := suffixarray.New(data)
		var buf bytes.Buffer
		if err := ix.Write(&buf); err != nil {
			panic(err)
		}
		c := saCase{
			Name:  strconv.Itoa(i) + "_" + strconv.Itoa(len(data)),
			Data:  hex.EncodeToString(data),
			Write: hex.EncodeToString(buf.Bytes()),
		}
		for _, q := range queries {
			for _, n := range []int{-1, 0, 1, 2, 8} {
				hits := ix.Lookup(q, n)
				if hits == nil {
					hits = []int{}
				}
				c.Looks = append(c.Looks, lookupCase{Query: hex.EncodeToString(q), N: n, Hits: hits})
			}
		}
		saCases = append(saCases, c)
	}

	h := &intHeap{5, 3, 9, 1, 4, 8, 2}
	heap.Init(h)
	var pops []int
	pops = append(pops, heap.Pop(h).(int))
	heap.Push(h, 0)
	pops = append(pops, heap.Pop(h).(int))
	heap.Remove(h, 1)
	(*h)[0] = 7
	heap.Fix(h, 0)
	after := append([]int(nil), *h...)
	heapCases := []heapCase{{
		Name:   "int-min",
		Pushes: []int{5, 3, 9, 1, 4, 8, 2},
		Pops:   pops,
		After:  after,
	}}

	a := list.New()
	b := list.New()
	for _, v := range []int{1, 2, 3} {
		a.PushBack(v)
	}
	for _, v := range []int{4, 5} {
		b.PushBack(v)
	}
	foreign := list.New().PushBack(99)
	removed := a.Remove(foreign)
	a.PushBackList(b)
	listCases := []listCase{{
		Name:      "copy-back",
		A:         []int{1, 2, 3},
		B:         []int{4, 5},
		AfterA:    dumpList(a),
		AfterB:    dumpList(b),
		RemoveVal: 99,
		RemoveOut: removed.(int),
	}}

	r := ring.New(3)
	vals := []any{"x", "y", "z"}
	p := r
	for i, v := range vals {
		p.Value = v
		if i < len(vals)-1 {
			p = p.Next()
		}
	}
	moved := r.Move(2)
	took := r.Unlink(1)
	ringCases := []ringCase{{
		Name:   "move-unlink",
		N:      3,
		Move:   2,
		Values: vals,
		Moved:  dumpRing(moved),
		Unlink: 1,
		Left:   dumpRing(r),
		Took:   dumpRing(took),
	}, {
		Name:   "unlink-len",
		N:      3,
		Move:   0,
		Values: []any{1, 2, 3},
		Moved:  []any{1, 2, 3},
		Unlink: 3,
		Left:   []any{1, 2, 3},
		Took:   dumpRing(func() *ring.Ring {
			rr := ring.New(3)
			rr.Value, rr.Next().Value, rr.Next().Next().Value = 1, 2, 3
			return rr.Unlink(3)
		}()),
	}}

	return packet{Version: 1, SA: saCases, Heap: heapCases, List: listCases, Ring: ringCases}
}

func dumpList(l *list.List) []int {
	out := make([]int, 0, l.Len())
	for e := l.Front(); e != nil; e = e.Next() {
		out = append(out, e.Value.(int))
	}
	return out
}

func verify(p packet) error {
	if p.Version != 1 || len(p.SA) == 0 {
		return fmt.Errorf("empty or bad packet")
	}
	for i, c := range p.SA {
		data, err := hex.DecodeString(c.Data)
		if err != nil {
			return err
		}
		ix := suffixarray.New(data)
		var buf bytes.Buffer
		if err := ix.Write(&buf); err != nil {
			return err
		}
		got := hex.EncodeToString(buf.Bytes())
		if got != c.Write {
			return fmt.Errorf("mismatch case %d write", i)
		}
		raw, err := hex.DecodeString(c.Write)
		if err != nil {
			return err
		}
		var restored suffixarray.Index
		if err := restored.Read(bytes.NewReader(raw)); err != nil {
			return fmt.Errorf("mismatch case %d read: %v", i, err)
		}
		for _, look := range c.Looks {
			q, err := hex.DecodeString(look.Query)
			if err != nil {
				return err
			}
			hits := restored.Lookup(q, look.N)
			if hits == nil {
				hits = []int{}
			}
			if !eqInts(hits, look.Hits) {
				return fmt.Errorf("mismatch case %d lookup %s n=%d", i, look.Query, look.N)
			}
		}
		_ = io.Discard
	}
	return nil
}

func eqInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func main() {
	verifyMode := false
	for _, a := range os.Args[1:] {
		if a == "-verify" {
			verifyMode = true
		}
	}
	if verifyMode {
		var p packet
		if err := json.NewDecoder(os.Stdin).Decode(&p); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			os.Exit(1)
		}
		if err := verify(p); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Go verified %d suffixarray cases\n", len(p.SA))
		return
	}
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(generate()); err != nil {
		panic(err)
	}
}
