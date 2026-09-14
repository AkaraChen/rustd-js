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

type heapOp struct {
	Kind  string `json:"kind"`
	V     *int   `json:"v,omitempty"`
	I     *int   `json:"i,omitempty"`
	Out   *int   `json:"out,omitempty"`
	After []int  `json:"after"`
}

type heapCase struct {
	Name   string   `json:"name"`
	Pushes []int    `json:"pushes,omitempty"`
	Pops   []int    `json:"pops,omitempty"`
	After  []int    `json:"after,omitempty"`
	Ops    []heapOp `json:"ops,omitempty"`
}

type listOp struct {
	Kind       string `json:"kind"`
	V          *int   `json:"v,omitempty"`
	I          *int   `json:"i,omitempty"`
	Mark       *int   `json:"mark,omitempty"`
	Other      []int  `json:"other,omitempty"`
	Out        *int   `json:"out,omitempty"`
	After      []int  `json:"after"`
	AfterOther []int  `json:"afterOther,omitempty"`
}

type listCase struct {
	Name      string   `json:"name"`
	A         []int    `json:"a,omitempty"`
	B         []int    `json:"b,omitempty"`
	AfterA    []int    `json:"afterA,omitempty"`
	AfterB    []int    `json:"afterB,omitempty"`
	RemoveVal int      `json:"removeVal,omitempty"`
	RemoveOut int      `json:"removeOut,omitempty"`
	Join      string   `json:"join,omitempty"`
	Ops       []listOp `json:"ops,omitempty"`
}

type ringCase struct {
	Name    string `json:"name"`
	N       int    `json:"n"`
	Move    int    `json:"move"`
	Values  []any  `json:"values"`
	Moved   []any  `json:"moved"`
	Unlink  int    `json:"unlink"`
	Left    []any  `json:"left"`
	Took    []any  `json:"took"`
	DoCalls *int   `json:"doCalls,omitempty"`
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
	for _, seed := range []uint32{1, 7, 99} {
		heapCases = append(heapCases, makeHeapSeq(fmt.Sprintf("seq-%d", seed), seed, 400))
	}

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
	frontA := list.New()
	frontB := list.New()
	for _, v := range []int{10, 20} {
		frontA.PushBack(v)
	}
	for _, v := range []int{30, 40, 50} {
		frontB.PushBack(v)
	}
	frontA.PushFrontList(frontB)
	listCases := []listCase{
		{
			Name:      "copy-back",
			A:         []int{1, 2, 3},
			B:         []int{4, 5},
			AfterA:    dumpList(a),
			AfterB:    dumpList(b),
			RemoveVal: 99,
			RemoveOut: removed.(int),
		},
		{
			Name:   "copy-front",
			A:      []int{10, 20},
			B:      []int{30, 40, 50},
			AfterA: dumpList(frontA),
			AfterB: dumpList(frontB),
			Join:   "front",
		},
		makeListSeq("seq-1", 1, 80),
		makeListSeq("seq-2", 2, 80),
	}

	ringCases := []ringCase{
		makeRingCase("move-unlink", []any{"x", "y", "z"}, 2, 1),
		makeRingCase("unlink-len", []any{1, 2, 3}, 0, 3),
		makeRingCase("unlink-0", []any{1, 2, 3}, 0, 0),
		makeRingCase("move-0", []any{"a", "b", "c"}, 0, 1),
		makeRingCase("move-len", []any{"a", "b", "c"}, 3, 1),
		makeRingCase("move-neg-len", []any{"a", "b", "c"}, -3, 1),
		makeRingCase("move-len-plus-1", []any{"a", "b", "c"}, 4, 1),
		makeRingCase("unlink-neg", []any{7, 8}, 0, -1),
	}
	zero := 0
	ringCases = append(ringCases, ringCase{
		Name:    "empty",
		N:       0,
		Values:  []any{},
		Moved:   []any{},
		Left:    []any{},
		Took:    []any{},
		DoCalls: &zero,
	})

	return packet{Version: 1, SA: saCases, Heap: heapCases, List: listCases, Ring: ringCases}
}

func intptr(v int) *int { return &v }

func dumpHeap(h *intHeap) []int {
	out := make([]int, len(*h))
	copy(out, *h)
	return out
}

func makeHeapSeq(name string, seed uint32, n int) heapCase {
	h := &intHeap{}
	heap.Init(h)
	ops := make([]heapOp, 0, n)
	rng := seed
	next := func() int {
		rng = rng*1664525 + 1013904223
		return int(rng)
	}
	for i := 0; i < n; i++ {
		r := next() % 10
		if r < 0 {
			r = -r
		}
		switch {
		case h.Len() == 0 || r < 4:
			v := next() % 1000
			if v < 0 {
				v = -v
			}
			heap.Push(h, v)
			ops = append(ops, heapOp{Kind: "push", V: intptr(v), After: dumpHeap(h)})
		case r < 7:
			out := heap.Pop(h).(int)
			ops = append(ops, heapOp{Kind: "pop", Out: &out, After: dumpHeap(h)})
		case r < 8 && h.Len() > 0:
			idx := next() % h.Len()
			if idx < 0 {
				idx = -idx
			}
			out := heap.Remove(h, idx).(int)
			ops = append(ops, heapOp{Kind: "remove", I: intptr(idx), Out: &out, After: dumpHeap(h)})
		default:
			idx := next() % h.Len()
			if idx < 0 {
				idx = -idx
			}
			v := next() % 1000
			if v < 0 {
				v = -v
			}
			(*h)[idx] = v
			heap.Fix(h, idx)
			ops = append(ops, heapOp{Kind: "fix", I: intptr(idx), V: intptr(v), After: dumpHeap(h)})
		}
	}
	return heapCase{Name: name, Ops: ops}
}

func listAt(l *list.List, i int) *list.Element {
	e := l.Front()
	for j := 0; j < i && e != nil; j++ {
		e = e.Next()
	}
	return e
}

func makeListSeq(name string, seed uint32, n int) listCase {
	l := list.New()
	ops := make([]listOp, 0, n)
	rng := seed
	next := func() int {
		rng = rng*1664525 + 1013904223
		return int(rng)
	}
	pos := func(mod int) int {
		if mod <= 0 {
			return 0
		}
		v := next() % mod
		if v < 0 {
			v = -v
		}
		return v
	}
	val := func() int {
		v := next() % 1000
		if v < 0 {
			v = -v
		}
		return v
	}
	for i := 0; i < n; i++ {
		r := pos(10)
		switch {
		case l.Len() == 0 || r < 3:
			v := val()
			if r%2 == 0 {
				l.PushBack(v)
				ops = append(ops, listOp{Kind: "pushBack", V: intptr(v), After: dumpList(l)})
			} else {
				l.PushFront(v)
				ops = append(ops, listOp{Kind: "pushFront", V: intptr(v), After: dumpList(l)})
			}
		case r == 3 && l.Len() > 0:
			idx := pos(l.Len())
			out := l.Remove(listAt(l, idx)).(int)
			ops = append(ops, listOp{Kind: "removeIndex", I: intptr(idx), Out: &out, After: dumpList(l)})
		case r == 4:
			v := val()
			foreign := list.New().PushBack(v)
			out := l.Remove(foreign).(int)
			ops = append(ops, listOp{Kind: "removeForeign", V: intptr(v), Out: &out, After: dumpList(l)})
		case r == 5:
			otherVals := []int{val(), val()}
			other := list.New()
			for _, v := range otherVals {
				other.PushBack(v)
			}
			l.PushBackList(other)
			ops = append(ops, listOp{Kind: "pushBackList", Other: otherVals, After: dumpList(l), AfterOther: dumpList(other)})
		case r == 6:
			otherVals := []int{val(), val()}
			other := list.New()
			for _, v := range otherVals {
				other.PushBack(v)
			}
			l.PushFrontList(other)
			ops = append(ops, listOp{Kind: "pushFrontList", Other: otherVals, After: dumpList(l), AfterOther: dumpList(other)})
		case r == 7 && l.Len() > 0:
			idx := pos(l.Len())
			l.MoveToFront(listAt(l, idx))
			ops = append(ops, listOp{Kind: "moveToFront", I: intptr(idx), After: dumpList(l)})
		case r == 8 && l.Len() > 0:
			idx := pos(l.Len())
			l.MoveToBack(listAt(l, idx))
			ops = append(ops, listOp{Kind: "moveToBack", I: intptr(idx), After: dumpList(l)})
		default:
			if l.Len() == 0 {
				v := val()
				l.PushBack(v)
				ops = append(ops, listOp{Kind: "pushBack", V: intptr(v), After: dumpList(l)})
				continue
			}
			mark := pos(l.Len())
			v := val()
			if r%2 == 0 {
				l.InsertBefore(v, listAt(l, mark))
				ops = append(ops, listOp{Kind: "insertBefore", V: intptr(v), Mark: intptr(mark), After: dumpList(l)})
			} else {
				l.InsertAfter(v, listAt(l, mark))
				ops = append(ops, listOp{Kind: "insertAfter", V: intptr(v), Mark: intptr(mark), After: dumpList(l)})
			}
		}
	}
	return listCase{Name: name, Ops: ops}
}

func fillRing(values []any) *ring.Ring {
	if len(values) == 0 {
		return ring.New(0)
	}
	r := ring.New(len(values))
	p := r
	for i, v := range values {
		p.Value = v
		if i < len(values)-1 {
			p = p.Next()
		}
	}
	return r
}

func makeRingCase(name string, values []any, move, unlink int) ringCase {
	r := fillRing(values)
	moved := r.Move(move)
	took := r.Unlink(unlink)
	return ringCase{
		Name:   name,
		N:      len(values),
		Move:   move,
		Values: values,
		Moved:  dumpRing(moved),
		Unlink: unlink,
		Left:   dumpRing(r),
		Took:   dumpRing(took),
	}
}

func dumpList(l *list.List) []int {
	out := make([]int, 0, l.Len())
	for e := l.Front(); e != nil; e = e.Next() {
		out = append(out, e.Value.(int))
	}
	if out == nil {
		out = []int{}
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
