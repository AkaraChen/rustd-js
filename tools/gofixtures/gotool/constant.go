package main

import (
	"encoding/json"
	"fmt"
	"go/constant"
	"go/token"
	"io"
	"math"
	"strconv"
)

type ConstCase struct {
	ID       string `json:"id"`
	X        string `json:"x"`
	Y        string `json:"y"`
	Kind     string `json:"kind"`
	ToInt    string `json:"toInt"`
	ToIntOk  bool   `json:"toIntOk"`
	Sign     int    `json:"sign"`
	BitLen   int    `json:"bitLen"`
	Compare  int    `json:"compare"`
}

type ConstPacket struct {
	Schema  int         `json:"schema"`
	Package string      `json:"package"`
	Go      string      `json:"go"`
	Slice   string      `json:"slice"`
	Cases   []ConstCase `json:"cases"`
}

func constCorpus() []int64 {
	return []int64{
		0, 1, -1, 2, -2, 42, -42, 127, -128,
		1<<31 - 1, -1 << 31, 1 << 32, -1 << 32,
		1 << 62, -1 << 62, math.MaxInt64, math.MinInt64,
	}
}

func constCmp(x, y constant.Value) int {
	switch {
	case constant.Compare(x, token.LSS, y):
		return -1
	case constant.Compare(x, token.GTR, y):
		return 1
	default:
		return 0
	}
}

func evalConst(x, y int64) ConstCase {
	vx := constant.MakeInt64(x)
	vy := constant.MakeInt64(y)
	iv, ok := constant.Int64Val(vx)
	return ConstCase{
		X:       strconv.FormatInt(x, 10),
		Y:       strconv.FormatInt(y, 10),
		Kind:    vx.Kind().String(),
		ToInt:   strconv.FormatInt(iv, 10),
		ToIntOk: ok,
		Sign:    constant.Sign(vx),
		BitLen:  constant.BitLen(vx),
		Compare: constCmp(vx, vy),
	}
}

func dumpConstant(w io.Writer) {
	packet := ConstPacket{
		Schema:  1,
		Package: "gotool",
		Go:      "go1.24.13",
		Slice:   "constant-int",
	}
	for i, x := range constCorpus() {
		for j, y := range constCorpus() {
			c := evalConst(x, y)
			c.ID = fmt.Sprintf("go-const-%d-%d", i, j)
			packet.Cases = append(packet.Cases, c)
		}
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func verifyConstant(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 32<<20))
	dec.DisallowUnknownFields()
	var packet ConstPacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool" || packet.Slice != "constant-int" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid constant packet header or empty cases"))
	}
	for i, c := range packet.Cases {
		x, err := strconv.ParseInt(c.X, 10, 64)
		if err != nil {
			fail(fmt.Errorf("case %d id=%s: bad x: %w", i, c.ID, err))
		}
		y, err := strconv.ParseInt(c.Y, 10, 64)
		if err != nil {
			fail(fmt.Errorf("case %d id=%s: bad y: %w", i, c.ID, err))
		}
		got := evalConst(x, y)
		if got.Kind != c.Kind || got.ToInt != c.ToInt || got.ToIntOk != c.ToIntOk || got.Sign != c.Sign || got.BitLen != c.BitLen || got.Compare != c.Compare {
			fail(fmt.Errorf("mismatch case %d id=%s x=%s y=%s: go kind=%s toInt=%s ok=%v sign=%d bitLen=%d compare=%d got kind=%s toInt=%s ok=%v sign=%d bitLen=%d compare=%d",
				i, c.ID, c.X, c.Y, got.Kind, got.ToInt, got.ToIntOk, got.Sign, got.BitLen, got.Compare,
				c.Kind, c.ToInt, c.ToIntOk, c.Sign, c.BitLen, c.Compare))
		}
	}
	fmt.Printf("Go verified %d gotool constant-int cases\n", len(packet.Cases))
}
