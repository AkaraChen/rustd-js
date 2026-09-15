package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"go/constant"
	"go/token"
	"io"
	"math"
	"strconv"
	"unicode/utf8"
)

type ConstCase struct {
	ID      string `json:"id"`
	X       string `json:"x"`
	Y       string `json:"y"`
	Kind    string `json:"kind"`
	ToInt   string `json:"toInt"`
	ToIntOk bool   `json:"toIntOk"`
	Sign    int    `json:"sign"`
	BitLen  int    `json:"bitLen"`
	Compare int    `json:"compare"`
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

type ConstBinCase struct {
	ID      string `json:"id"`
	Op      string `json:"op"`
	OpTok   int    `json:"opTok"`
	X       string `json:"x"`
	Y       string `json:"y"`
	Kind    string `json:"kind"`
	Exact   string `json:"exact"`
	ToInt   string `json:"toInt"`
	ToIntOk bool   `json:"toIntOk"`
	Sign    int    `json:"sign"`
	BitLen  int    `json:"bitLen"`
}

type ConstBinPacket struct {
	Schema  int            `json:"schema"`
	Package string         `json:"package"`
	Go      string         `json:"go"`
	Slice   string         `json:"slice"`
	Cases   []ConstBinCase `json:"cases"`
}

func binOps() []struct {
	name string
	tok  token.Token
} {
	return []struct {
		name string
		tok  token.Token
	}{
		{"ADD", token.ADD},
		{"SUB", token.SUB},
		{"MUL", token.MUL},
		{"QUO", token.QUO},
		{"REM", token.REM},
		{"AND", token.AND},
		{"OR", token.OR},
		{"XOR", token.XOR},
	}
}

func evalBin(x, y int64, op token.Token) ConstBinCase {
	vx := constant.MakeInt64(x)
	vy := constant.MakeInt64(y)
	v := constant.BinaryOp(vx, op, vy)
	c := ConstBinCase{
		OpTok: int(op),
		X:     strconv.FormatInt(x, 10),
		Y:     strconv.FormatInt(y, 10),
		Kind:  v.Kind().String(),
		Exact: v.ExactString(),
		Sign:  constant.Sign(v),
	}
	if v.Kind() == constant.Int {
		iv, ok := constant.Int64Val(v)
		c.ToInt = strconv.FormatInt(iv, 10)
		c.ToIntOk = ok
		c.BitLen = constant.BitLen(v)
	} else {
		c.ToInt = "0"
		c.ToIntOk = false
	}
	return c
}

func dumpConstantBin(w io.Writer) {
	packet := ConstBinPacket{
		Schema:  1,
		Package: "gotool",
		Go:      "go1.24.13",
		Slice:   "constant-int-binop",
	}
	for _, op := range binOps() {
		for i, x := range constCorpus() {
			for j, y := range constCorpus() {
				if (op.tok == token.QUO || op.tok == token.REM) && y == 0 {
					continue
				}
				c := evalBin(x, y, op.tok)
				c.ID = fmt.Sprintf("go-bin-%s-%d-%d", op.name, i, j)
				c.Op = op.name
				packet.Cases = append(packet.Cases, c)
			}
		}
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func verifyConstantBin(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 32<<20))
	dec.DisallowUnknownFields()
	var packet ConstBinPacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool" || packet.Slice != "constant-int-binop" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid constant-binop packet header or empty cases"))
	}
	ops := binOps()
	tokOf := map[string]token.Token{}
	for _, op := range ops {
		tokOf[op.name] = op.tok
	}
	for i, c := range packet.Cases {
		op, ok := tokOf[c.Op]
		if !ok {
			fail(fmt.Errorf("case %d id=%s: unknown op %q", i, c.ID, c.Op))
		}
		if c.OpTok != int(op) {
			fail(fmt.Errorf("case %d id=%s: opTok %d != Go %s %d", i, c.ID, c.OpTok, c.Op, int(op)))
		}
		x, err := strconv.ParseInt(c.X, 10, 64)
		if err != nil {
			fail(fmt.Errorf("case %d id=%s: bad x: %w", i, c.ID, err))
		}
		y, err := strconv.ParseInt(c.Y, 10, 64)
		if err != nil {
			fail(fmt.Errorf("case %d id=%s: bad y: %w", i, c.ID, err))
		}
		if (op == token.QUO || op == token.REM) && y == 0 {
			fail(fmt.Errorf("case %d id=%s: verify path does not accept QUO/REM by zero", i, c.ID))
		}
		got := evalBin(x, y, op)
		if got.Kind != c.Kind || got.Exact != c.Exact || got.ToInt != c.ToInt || got.ToIntOk != c.ToIntOk || got.Sign != c.Sign || got.BitLen != c.BitLen {
			fail(fmt.Errorf("mismatch case %d id=%s op=%s x=%s y=%s: go kind=%s exact=%s toInt=%s ok=%v sign=%d bitLen=%d got kind=%s exact=%s toInt=%s ok=%v sign=%d bitLen=%d",
				i, c.ID, c.Op, c.X, c.Y, got.Kind, got.Exact, got.ToInt, got.ToIntOk, got.Sign, got.BitLen,
				c.Kind, c.Exact, c.ToInt, c.ToIntOk, c.Sign, c.BitLen))
		}
	}
	fmt.Printf("Go verified %d gotool constant-int-binop cases\n", len(packet.Cases))
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

type ConstUSCase struct {
	ID      string `json:"id"`
	Form    string `json:"form"`
	Op      string `json:"op"`
	OpTok   int    `json:"opTok"`
	X       string `json:"x"`
	Y       string `json:"y"`
	S       string `json:"s"`
	Prec    uint   `json:"prec"`
	Kind    string `json:"kind"`
	Exact   string `json:"exact"`
	ToInt   string `json:"toInt"`
	ToIntOk bool   `json:"toIntOk"`
	Sign    int    `json:"sign"`
	BitLen  int    `json:"bitLen"`
}

type ConstUSPacket struct {
	Schema  int           `json:"schema"`
	Package string        `json:"package"`
	Go      string        `json:"go"`
	Slice   string        `json:"slice"`
	Cases   []ConstUSCase `json:"cases"`
}

func fillFromValue(v constant.Value, c *ConstUSCase) {
	c.Kind = v.Kind().String()
	c.Exact = v.ExactString()
	c.Sign = constant.Sign(v)
	if v.Kind() == constant.Int {
		iv, ok := constant.Int64Val(v)
		c.ToInt = strconv.FormatInt(iv, 10)
		c.ToIntOk = ok
		c.BitLen = constant.BitLen(v)
	} else {
		c.ToInt = "0"
		c.ToIntOk = false
		c.BitLen = 0
	}
}

func shiftCounts() []uint {
	return []uint{0, 1, 2, 8, 31, 32, 63, 64}
}

func xorPrecs() []uint {
	return []uint{0, 1, 8, 32, 63, 64}
}

func dumpConstantUnaryShift(w io.Writer) {
	packet := ConstUSPacket{
		Schema:  1,
		Package: "gotool",
		Go:      "go1.24.13",
		Slice:   "constant-int-unary-shift",
	}
	corpus := constCorpus()
	for _, op := range []struct {
		name string
		tok  token.Token
	}{
		{"ADD", token.ADD},
		{"SUB", token.SUB},
	} {
		for i, x := range corpus {
			v := constant.UnaryOp(op.tok, constant.MakeInt64(x), 0)
			c := ConstUSCase{
				ID:    fmt.Sprintf("go-unary-%s-%d", op.name, i),
				Form:  "unary",
				Op:    op.name,
				OpTok: int(op.tok),
				X:     strconv.FormatInt(x, 10),
				Y:     "0",
				S:     "0",
				Prec:  0,
			}
			fillFromValue(v, &c)
			packet.Cases = append(packet.Cases, c)
		}
	}
	for _, prec := range xorPrecs() {
		for i, x := range corpus {
			v := constant.UnaryOp(token.XOR, constant.MakeInt64(x), prec)
			c := ConstUSCase{
				ID:    fmt.Sprintf("go-unary-XOR-p%d-%d", prec, i),
				Form:  "unary",
				Op:    "XOR",
				OpTok: int(token.XOR),
				X:     strconv.FormatInt(x, 10),
				Y:     "0",
				S:     "0",
				Prec:  prec,
			}
			fillFromValue(v, &c)
			packet.Cases = append(packet.Cases, c)
		}
	}
	for i, x := range corpus {
		for j, y := range corpus {
			v := constant.BinaryOp(constant.MakeInt64(x), token.AND_NOT, constant.MakeInt64(y))
			c := ConstUSCase{
				ID:    fmt.Sprintf("go-andnot-%d-%d", i, j),
				Form:  "andnot",
				Op:    "AND_NOT",
				OpTok: int(token.AND_NOT),
				X:     strconv.FormatInt(x, 10),
				Y:     strconv.FormatInt(y, 10),
				S:     "0",
				Prec:  0,
			}
			fillFromValue(v, &c)
			packet.Cases = append(packet.Cases, c)
		}
	}
	for _, op := range []struct {
		name string
		tok  token.Token
	}{
		{"SHL", token.SHL},
		{"SHR", token.SHR},
	} {
		for _, s := range shiftCounts() {
			for i, x := range corpus {
				v := constant.Shift(constant.MakeInt64(x), op.tok, s)
				c := ConstUSCase{
					ID:    fmt.Sprintf("go-shift-%s-s%d-%d", op.name, s, i),
					Form:  "shift",
					Op:    op.name,
					OpTok: int(op.tok),
					X:     strconv.FormatInt(x, 10),
					Y:     "0",
					S:     strconv.FormatUint(uint64(s), 10),
					Prec:  0,
				}
				fillFromValue(v, &c)
				packet.Cases = append(packet.Cases, c)
			}
		}
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func verifyConstantUnaryShift(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 32<<20))
	dec.DisallowUnknownFields()
	var packet ConstUSPacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool" || packet.Slice != "constant-int-unary-shift" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid constant-unary-shift packet header or empty cases"))
	}
	tokOf := map[string]token.Token{
		"ADD": token.ADD, "SUB": token.SUB, "XOR": token.XOR,
		"AND_NOT": token.AND_NOT, "SHL": token.SHL, "SHR": token.SHR,
	}
	for i, c := range packet.Cases {
		op, ok := tokOf[c.Op]
		if !ok {
			fail(fmt.Errorf("case %d id=%s: unknown op %q", i, c.ID, c.Op))
		}
		if c.OpTok != int(op) {
			fail(fmt.Errorf("case %d id=%s: opTok %d != Go %s %d", i, c.ID, c.OpTok, c.Op, int(op)))
		}
		x, err := strconv.ParseInt(c.X, 10, 64)
		if err != nil {
			fail(fmt.Errorf("case %d id=%s: bad x: %w", i, c.ID, err))
		}
		var got ConstUSCase
		switch c.Form {
		case "unary":
			if c.Op != "ADD" && c.Op != "SUB" && c.Op != "XOR" {
				fail(fmt.Errorf("case %d id=%s: unary form with op %s", i, c.ID, c.Op))
			}
			fillFromValue(constant.UnaryOp(op, constant.MakeInt64(x), c.Prec), &got)
		case "andnot":
			if op != token.AND_NOT {
				fail(fmt.Errorf("case %d id=%s: andnot form with op %s", i, c.ID, c.Op))
			}
			y, err := strconv.ParseInt(c.Y, 10, 64)
			if err != nil {
				fail(fmt.Errorf("case %d id=%s: bad y: %w", i, c.ID, err))
			}
			fillFromValue(constant.BinaryOp(constant.MakeInt64(x), token.AND_NOT, constant.MakeInt64(y)), &got)
		case "shift":
			if op != token.SHL && op != token.SHR {
				fail(fmt.Errorf("case %d id=%s: shift form with op %s", i, c.ID, c.Op))
			}
			s, err := strconv.ParseUint(c.S, 10, 64)
			if err != nil {
				fail(fmt.Errorf("case %d id=%s: bad s: %w", i, c.ID, err))
			}
			fillFromValue(constant.Shift(constant.MakeInt64(x), op, uint(s)), &got)
		default:
			fail(fmt.Errorf("case %d id=%s: unknown form %q", i, c.ID, c.Form))
		}
		if got.Kind != c.Kind || got.Exact != c.Exact || got.ToInt != c.ToInt || got.ToIntOk != c.ToIntOk || got.Sign != c.Sign || got.BitLen != c.BitLen {
			fail(fmt.Errorf("mismatch case %d id=%s form=%s op=%s x=%s y=%s s=%s prec=%d: go kind=%s exact=%s toInt=%s ok=%v sign=%d bitLen=%d got kind=%s exact=%s toInt=%s ok=%v sign=%d bitLen=%d",
				i, c.ID, c.Form, c.Op, c.X, c.Y, c.S, c.Prec, got.Kind, got.Exact, got.ToInt, got.ToIntOk, got.Sign, got.BitLen,
				c.Kind, c.Exact, c.ToInt, c.ToIntOk, c.Sign, c.BitLen))
		}
	}
	fmt.Printf("Go verified %d gotool constant-int-unary-shift cases\n", len(packet.Cases))
}

type ConstValCase struct {
	ID         string `json:"id"`
	Form       string `json:"form"`
	X          string `json:"x"`
	Y          string `json:"y"`
	S          string `json:"s"`
	Kind       string `json:"kind"`
	ToString   string `json:"toString"`
	ToStringOk bool   `json:"toStringOk"`
	F64Bits    string `json:"f64Bits"`
	F64Exact   bool   `json:"f64Exact"`
}

type ConstValPacket struct {
	Schema  int            `json:"schema"`
	Package string         `json:"package"`
	Go      string         `json:"go"`
	Slice   string         `json:"slice"`
	Cases   []ConstValCase `json:"cases"`
}

func stringValOK(v constant.Value) (s string, ok bool) {
	defer func() {
		if recover() != nil {
			s, ok = "", false
		}
	}()
	return constant.StringVal(v), true
}

func fillVal(v constant.Value, c *ConstValCase) {
	c.Kind = v.Kind().String()
	c.ToString, c.ToStringOk = stringValOK(v)
	if v.Kind() == constant.Complex {
		c.F64Bits = "0"
		c.F64Exact = false
		return
	}
	f, exact := constant.Float64Val(v)
	c.F64Bits = fmt.Sprintf("%016x", math.Float64bits(f))
	c.F64Exact = exact
}

func evalVal(form, xStr, yStr, sStr string) (ConstValCase, error) {
	c := ConstValCase{Form: form, X: xStr, Y: yStr, S: sStr}
	switch form {
	case "int":
		x, err := strconv.ParseInt(xStr, 10, 64)
		if err != nil {
			return c, err
		}
		fillVal(constant.MakeInt64(x), &c)
	case "quo":
		x, err := strconv.ParseInt(xStr, 10, 64)
		if err != nil {
			return c, err
		}
		y, err := strconv.ParseInt(yStr, 10, 64)
		if err != nil {
			return c, err
		}
		if y == 0 {
			return c, fmt.Errorf("quo by zero is form unknown")
		}
		fillVal(constant.BinaryOp(constant.MakeInt64(x), token.QUO, constant.MakeInt64(y)), &c)
	case "shift":
		x, err := strconv.ParseInt(xStr, 10, 64)
		if err != nil {
			return c, err
		}
		s, err := strconv.ParseUint(sStr, 10, 64)
		if err != nil {
			return c, err
		}
		fillVal(constant.Shift(constant.MakeInt64(x), token.SHL, uint(s)), &c)
	case "shift-quo":
		x, err := strconv.ParseInt(xStr, 10, 64)
		if err != nil {
			return c, err
		}
		s, err := strconv.ParseUint(sStr, 10, 64)
		if err != nil {
			return c, err
		}
		den := constant.Shift(constant.MakeInt64(1), token.SHL, uint(s))
		fillVal(constant.BinaryOp(constant.MakeInt64(x), token.QUO, den), &c)
	case "unknown":
		fillVal(constant.MakeUnknown(), &c)
	default:
		return c, fmt.Errorf("unknown form %q", form)
	}
	return c, nil
}

func dumpConstantVal(w io.Writer) {
	packet := ConstValPacket{
		Schema:  1,
		Package: "gotool",
		Go:      "go1.24.13",
		Slice:   "constant-int-float-val",
	}
	corpus := constCorpus()
	for i, x := range corpus {
		c, err := evalVal("int", strconv.FormatInt(x, 10), "0", "0")
		if err != nil {
			fail(err)
		}
		c.ID = fmt.Sprintf("go-val-int-%d", i)
		packet.Cases = append(packet.Cases, c)
	}
	for i, x := range corpus {
		for j, y := range corpus {
			if y == 0 {
				continue
			}
			c, err := evalVal("quo", strconv.FormatInt(x, 10), strconv.FormatInt(y, 10), "0")
			if err != nil {
				fail(err)
			}
			c.ID = fmt.Sprintf("go-val-quo-%d-%d", i, j)
			packet.Cases = append(packet.Cases, c)
		}
	}
	for _, s := range []uint{0, 1, 52, 53, 63, 64, 100} {
		for i, x := range []int64{1, -1, 3, math.MaxInt64, math.MinInt64} {
			c, err := evalVal("shift", strconv.FormatInt(x, 10), "0", strconv.FormatUint(uint64(s), 10))
			if err != nil {
				fail(err)
			}
			c.ID = fmt.Sprintf("go-val-shl-s%d-%d", s, i)
			packet.Cases = append(packet.Cases, c)
		}
		for i, x := range []int64{1, -1, 3} {
			c, err := evalVal("shift-quo", strconv.FormatInt(x, 10), "0", strconv.FormatUint(uint64(s), 10))
			if err != nil {
				fail(err)
			}
			c.ID = fmt.Sprintf("go-val-quo-shl-s%d-%d", s, i)
			packet.Cases = append(packet.Cases, c)
		}
	}
	unk, err := evalVal("unknown", "1", "0", "0")
	if err != nil {
		fail(err)
	}
	unk.ID = "go-val-unknown-quo0"
	packet.Cases = append(packet.Cases, unk)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func verifyConstantVal(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 32<<20))
	dec.DisallowUnknownFields()
	var packet ConstValPacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool" || packet.Slice != "constant-int-float-val" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid constant-val packet header or empty cases"))
	}
	for i, c := range packet.Cases {
		got, err := evalVal(c.Form, c.X, c.Y, c.S)
		if err != nil {
			fail(fmt.Errorf("case %d id=%s: %w", i, c.ID, err))
		}
		if got.Kind != c.Kind || got.ToString != c.ToString || got.ToStringOk != c.ToStringOk || got.F64Bits != c.F64Bits || got.F64Exact != c.F64Exact {
			fail(fmt.Errorf("mismatch case %d id=%s form=%s x=%s y=%s s=%s: go kind=%s toString=%q ok=%v f64=%s exact=%v got kind=%s toString=%q ok=%v f64=%s exact=%v",
				i, c.ID, c.Form, c.X, c.Y, c.S, got.Kind, got.ToString, got.ToStringOk, got.F64Bits, got.F64Exact,
				c.Kind, c.ToString, c.ToStringOk, c.F64Bits, c.F64Exact))
		}
	}
	fmt.Printf("Go verified %d gotool constant-int-float-val cases\n", len(packet.Cases))
}

type ConstFCmpCase struct {
	ID      string `json:"id"`
	FormX   string `json:"formX"`
	XX      string `json:"xx"`
	XY      string `json:"xy"`
	XS      string `json:"xs"`
	FormY   string `json:"formY"`
	YX      string `json:"yx"`
	YY      string `json:"yy"`
	YS      string `json:"ys"`
	KindX   string `json:"kindX"`
	KindY   string `json:"kindY"`
	ExactX  string `json:"exactX"`
	ExactY  string `json:"exactY"`
	Compare int    `json:"compare"`
}

type ConstFCmpPacket struct {
	Schema  int             `json:"schema"`
	Package string          `json:"package"`
	Go      string          `json:"go"`
	Slice   string          `json:"slice"`
	Cases   []ConstFCmpCase `json:"cases"`
}

type fcmpSrc struct {
	form, x, y, s string
}

func makeConst(form, xStr, yStr, sStr string) (constant.Value, error) {
	switch form {
	case "int":
		x, err := strconv.ParseInt(xStr, 10, 64)
		if err != nil {
			return nil, err
		}
		return constant.MakeInt64(x), nil
	case "quo":
		x, err := strconv.ParseInt(xStr, 10, 64)
		if err != nil {
			return nil, err
		}
		y, err := strconv.ParseInt(yStr, 10, 64)
		if err != nil {
			return nil, err
		}
		if y == 0 {
			return nil, fmt.Errorf("quo by zero")
		}
		return constant.BinaryOp(constant.MakeInt64(x), token.QUO, constant.MakeInt64(y)), nil
	case "shift-quo":
		x, err := strconv.ParseInt(xStr, 10, 64)
		if err != nil {
			return nil, err
		}
		s, err := strconv.ParseUint(sStr, 10, 64)
		if err != nil {
			return nil, err
		}
		den := constant.Shift(constant.MakeInt64(1), token.SHL, uint(s))
		return constant.BinaryOp(constant.MakeInt64(x), token.QUO, den), nil
	default:
		return nil, fmt.Errorf("unknown form %q", form)
	}
}

func evalFloatCmp(a, b fcmpSrc) (ConstFCmpCase, error) {
	vx, err := makeConst(a.form, a.x, a.y, a.s)
	if err != nil {
		return ConstFCmpCase{}, err
	}
	vy, err := makeConst(b.form, b.x, b.y, b.s)
	if err != nil {
		return ConstFCmpCase{}, err
	}
	return ConstFCmpCase{
		FormX:   a.form,
		XX:      a.x,
		XY:      a.y,
		XS:      a.s,
		FormY:   b.form,
		YX:      b.x,
		YY:      b.y,
		YS:      b.s,
		KindX:   vx.Kind().String(),
		KindY:   vy.Kind().String(),
		ExactX:  vx.ExactString(),
		ExactY:  vy.ExactString(),
		Compare: constCmp(vx, vy),
	}, nil
}

func floatCmpCorpus() []fcmpSrc {
	var out []fcmpSrc
	for _, x := range []int64{0, 1, -1, 2, 3, -3, 42, math.MaxInt64, math.MinInt64} {
		out = append(out, fcmpSrc{"int", strconv.FormatInt(x, 10), "0", "0"})
	}
	for _, p := range [][2]int64{
		{1, 2}, {1, 3}, {2, 3}, {-1, 2}, {1, -2}, {2, 4}, {2, 1}, {0, 5},
		{3, 1}, {22, 7}, {-22, 7}, {1, -3},
		{math.MaxInt64, 2}, {1, math.MaxInt64}, {math.MinInt64, 2},
		{math.MaxInt64, math.MaxInt64}, {-1, math.MaxInt64},
	} {
		out = append(out, fcmpSrc{"quo", strconv.FormatInt(p[0], 10), strconv.FormatInt(p[1], 10), "0"})
	}
	for _, s := range []uint{1, 53, 64} {
		out = append(out, fcmpSrc{"shift-quo", "1", "0", strconv.FormatUint(uint64(s), 10)})
		out = append(out, fcmpSrc{"shift-quo", "-1", "0", strconv.FormatUint(uint64(s), 10)})
	}
	return out
}

func dumpConstantFloatCompare(w io.Writer) {
	packet := ConstFCmpPacket{
		Schema:  1,
		Package: "gotool",
		Go:      "go1.24.13",
		Slice:   "constant-float-compare",
	}
	corpus := floatCmpCorpus()
	for i, a := range corpus {
		for j, b := range corpus {
			c, err := evalFloatCmp(a, b)
			if err != nil {
				fail(err)
			}
			c.ID = fmt.Sprintf("go-fcmp-%d-%d", i, j)
			packet.Cases = append(packet.Cases, c)
		}
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func verifyConstantFloatCompare(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 32<<20))
	dec.DisallowUnknownFields()
	var packet ConstFCmpPacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool" || packet.Slice != "constant-float-compare" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid constant-float-compare packet header or empty cases"))
	}
	for i, c := range packet.Cases {
		got, err := evalFloatCmp(
			fcmpSrc{c.FormX, c.XX, c.XY, c.XS},
			fcmpSrc{c.FormY, c.YX, c.YY, c.YS},
		)
		if err != nil {
			fail(fmt.Errorf("case %d id=%s: %w", i, c.ID, err))
		}
		if got.KindX != c.KindX || got.KindY != c.KindY || got.ExactX != c.ExactX || got.ExactY != c.ExactY || got.Compare != c.Compare {
			fail(fmt.Errorf("mismatch case %d id=%s: go kind=(%s,%s) exact=(%s,%s) compare=%d got kind=(%s,%s) exact=(%s,%s) compare=%d",
				i, c.ID, got.KindX, got.KindY, got.ExactX, got.ExactY, got.Compare,
				c.KindX, c.KindY, c.ExactX, c.ExactY, c.Compare))
		}
	}
	fmt.Printf("Go verified %d gotool constant-float-compare cases\n", len(packet.Cases))
}

type ConstFBinCase struct {
	ID       string `json:"id"`
	Op       string `json:"op"`
	OpTok    int    `json:"opTok"`
	FormX    string `json:"formX"`
	XX       string `json:"xx"`
	XY       string `json:"xy"`
	XS       string `json:"xs"`
	FormY    string `json:"formY"`
	YX       string `json:"yx"`
	YY       string `json:"yy"`
	YS       string `json:"ys"`
	Kind     string `json:"kind"`
	Exact    string `json:"exact"`
	Sign     int    `json:"sign"`
	F64Bits  string `json:"f64Bits"`
	F64Exact bool   `json:"f64Exact"`
}

type ConstFBinPacket struct {
	Schema  int             `json:"schema"`
	Package string          `json:"package"`
	Go      string          `json:"go"`
	Slice   string          `json:"slice"`
	Cases   []ConstFBinCase `json:"cases"`
}

func floatBinOps() []struct {
	name string
	tok  token.Token
} {
	return []struct {
		name string
		tok  token.Token
	}{
		{"ADD", token.ADD},
		{"SUB", token.SUB},
		{"MUL", token.MUL},
		{"QUO", token.QUO},
	}
}

func evalFloatBin(a, b fcmpSrc, op token.Token) (ConstFBinCase, error) {
	vx, err := makeConst(a.form, a.x, a.y, a.s)
	if err != nil {
		return ConstFBinCase{}, err
	}
	vy, err := makeConst(b.form, b.x, b.y, b.s)
	if err != nil {
		return ConstFBinCase{}, err
	}
	v := constant.BinaryOp(vx, op, vy)
	f, exact := constant.Float64Val(v)
	return ConstFBinCase{
		OpTok:    int(op),
		FormX:    a.form,
		XX:       a.x,
		XY:       a.y,
		XS:       a.s,
		FormY:    b.form,
		YX:       b.x,
		YY:       b.y,
		YS:       b.s,
		Kind:     v.Kind().String(),
		Exact:    v.ExactString(),
		Sign:     constant.Sign(v),
		F64Bits:  fmt.Sprintf("%016x", math.Float64bits(f)),
		F64Exact: exact,
	}, nil
}

func dumpConstantFloatBin(w io.Writer) {
	packet := ConstFBinPacket{
		Schema:  1,
		Package: "gotool",
		Go:      "go1.24.13",
		Slice:   "constant-float-binop",
	}
	corpus := floatCmpCorpus()
	for _, op := range floatBinOps() {
		for i, a := range corpus {
			for j, b := range corpus {
				vy, err := makeConst(b.form, b.x, b.y, b.s)
				if err != nil {
					fail(err)
				}
				if op.tok == token.QUO && constant.Sign(vy) == 0 {
					continue
				}
				c, err := evalFloatBin(a, b, op.tok)
				if err != nil {
					fail(err)
				}
				c.ID = fmt.Sprintf("go-fbin-%s-%d-%d", op.name, i, j)
				c.Op = op.name
				packet.Cases = append(packet.Cases, c)
			}
		}
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func verifyConstantFloatBin(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 32<<20))
	dec.DisallowUnknownFields()
	var packet ConstFBinPacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool" || packet.Slice != "constant-float-binop" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid constant-float-binop packet header or empty cases"))
	}
	tokOf := map[string]token.Token{}
	for _, op := range floatBinOps() {
		tokOf[op.name] = op.tok
	}
	for i, c := range packet.Cases {
		op, ok := tokOf[c.Op]
		if !ok {
			fail(fmt.Errorf("case %d id=%s: unknown op %q", i, c.ID, c.Op))
		}
		if c.OpTok != int(op) {
			fail(fmt.Errorf("case %d id=%s: opTok %d != Go %s %d", i, c.ID, c.OpTok, c.Op, int(op)))
		}
		got, err := evalFloatBin(
			fcmpSrc{c.FormX, c.XX, c.XY, c.XS},
			fcmpSrc{c.FormY, c.YX, c.YY, c.YS},
			op,
		)
		if err != nil {
			fail(fmt.Errorf("case %d id=%s: %w", i, c.ID, err))
		}
		if got.Kind != c.Kind || got.Exact != c.Exact || got.Sign != c.Sign || got.F64Bits != c.F64Bits || got.F64Exact != c.F64Exact {
			fail(fmt.Errorf("mismatch case %d id=%s op=%s: go kind=%s exact=%s sign=%d f64=%s exact64=%v got kind=%s exact=%s sign=%d f64=%s exact64=%v",
				i, c.ID, c.Op, got.Kind, got.Exact, got.Sign, got.F64Bits, got.F64Exact,
				c.Kind, c.Exact, c.Sign, c.F64Bits, c.F64Exact))
		}
	}
	fmt.Printf("Go verified %d gotool constant-float-binop cases\n", len(packet.Cases))
}

type ConstFUnCase struct {
	ID       string `json:"id"`
	Op       string `json:"op"`
	OpTok    int    `json:"opTok"`
	FormY    string `json:"formY"`
	YX       string `json:"yx"`
	YY       string `json:"yy"`
	YS       string `json:"ys"`
	Kind     string `json:"kind"`
	Exact    string `json:"exact"`
	Sign     int    `json:"sign"`
	F64Bits  string `json:"f64Bits"`
	F64Exact bool   `json:"f64Exact"`
}

type ConstFUnPacket struct {
	Schema  int            `json:"schema"`
	Package string         `json:"package"`
	Go      string         `json:"go"`
	Slice   string         `json:"slice"`
	Cases   []ConstFUnCase `json:"cases"`
}

func floatUnaryOps() []struct {
	name string
	tok  token.Token
} {
	return []struct {
		name string
		tok  token.Token
	}{
		{"ADD", token.ADD},
		{"SUB", token.SUB},
	}
}

func evalFloatUnary(a fcmpSrc, op token.Token) (ConstFUnCase, error) {
	vy, err := makeConst(a.form, a.x, a.y, a.s)
	if err != nil {
		return ConstFUnCase{}, err
	}
	v := constant.UnaryOp(op, vy, 0)
	f, exact := constant.Float64Val(v)
	return ConstFUnCase{
		OpTok:    int(op),
		FormY:    a.form,
		YX:       a.x,
		YY:       a.y,
		YS:       a.s,
		Kind:     v.Kind().String(),
		Exact:    v.ExactString(),
		Sign:     constant.Sign(v),
		F64Bits:  fmt.Sprintf("%016x", math.Float64bits(f)),
		F64Exact: exact,
	}, nil
}

func dumpConstantFloatUnary(w io.Writer) {
	packet := ConstFUnPacket{
		Schema:  1,
		Package: "gotool",
		Go:      "go1.24.13",
		Slice:   "constant-float-unary",
	}
	corpus := floatCmpCorpus()
	for _, op := range floatUnaryOps() {
		for i, a := range corpus {
			c, err := evalFloatUnary(a, op.tok)
			if err != nil {
				fail(err)
			}
			c.ID = fmt.Sprintf("go-fun-%s-%d", op.name, i)
			c.Op = op.name
			packet.Cases = append(packet.Cases, c)
		}
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func verifyConstantFloatUnary(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 32<<20))
	dec.DisallowUnknownFields()
	var packet ConstFUnPacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool" || packet.Slice != "constant-float-unary" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid constant-float-unary packet header or empty cases"))
	}
	tokOf := map[string]token.Token{}
	for _, op := range floatUnaryOps() {
		tokOf[op.name] = op.tok
	}
	for i, c := range packet.Cases {
		op, ok := tokOf[c.Op]
		if !ok {
			fail(fmt.Errorf("case %d id=%s: unknown op %q", i, c.ID, c.Op))
		}
		if c.OpTok != int(op) {
			fail(fmt.Errorf("case %d id=%s: opTok %d != Go %s %d", i, c.ID, c.OpTok, c.Op, int(op)))
		}
		got, err := evalFloatUnary(fcmpSrc{c.FormY, c.YX, c.YY, c.YS}, op)
		if err != nil {
			fail(fmt.Errorf("case %d id=%s: %w", i, c.ID, err))
		}
		if got.Kind != c.Kind || got.Exact != c.Exact || got.Sign != c.Sign || got.F64Bits != c.F64Bits || got.F64Exact != c.F64Exact {
			fail(fmt.Errorf("mismatch case %d id=%s op=%s: go kind=%s exact=%s sign=%d f64=%s exact64=%v got kind=%s exact=%s sign=%d f64=%s exact64=%v",
				i, c.ID, c.Op, got.Kind, got.Exact, got.Sign, got.F64Bits, got.F64Exact,
				c.Kind, c.Exact, c.Sign, c.F64Bits, c.F64Exact))
		}
	}
	fmt.Printf("Go verified %d gotool constant-float-unary cases\n", len(packet.Cases))
}

type ConstLitCase struct {
	ID       string `json:"id"`
	Lit      string `json:"lit"`
	Tok      string `json:"tok"`
	TokNum   int    `json:"tokNum"`
	Kind     string `json:"kind"`
	Exact    string `json:"exact"`
	Sign     int    `json:"sign"`
	ToInt    string `json:"toInt"`
	ToIntOk  bool   `json:"toIntOk"`
	BitLen   int    `json:"bitLen"`
	F64Bits  string `json:"f64Bits"`
	F64Exact bool   `json:"f64Exact"`
}

type ConstLitPacket struct {
	Schema  int            `json:"schema"`
	Package string         `json:"package"`
	Go      string         `json:"go"`
	Slice   string         `json:"slice"`
	Cases   []ConstLitCase `json:"cases"`
}

func fillLiteral(v constant.Value, c *ConstLitCase) {
	c.Kind = v.Kind().String()
	c.Exact = v.ExactString()
	c.Sign = constant.Sign(v)
	f, exact := constant.Float64Val(v)
	c.F64Bits = fmt.Sprintf("%016x", math.Float64bits(f))
	c.F64Exact = exact
	if v.Kind() == constant.Int {
		iv, ok := constant.Int64Val(v)
		c.ToInt = strconv.FormatInt(iv, 10)
		c.ToIntOk = ok
		c.BitLen = constant.BitLen(v)
	} else {
		c.ToInt = "0"
		c.ToIntOk = false
		c.BitLen = 0
	}
}

func evalLiteral(lit string, tok token.Token) ConstLitCase {
	c := ConstLitCase{Lit: lit, TokNum: int(tok)}
	switch tok {
	case token.INT:
		c.Tok = "INT"
	case token.FLOAT:
		c.Tok = "FLOAT"
	case token.CHAR:
		c.Tok = "CHAR"
	default:
		c.Tok = tok.String()
	}
	fillLiteral(constant.MakeFromLiteral(lit, tok, 0), &c)
	return c
}

// Official go/constant TestNumbers tables (LHS only) plus invalid extras.
func literalCorpus() []struct {
	tok token.Token
	lit string
} {
	intLits := []string{
		"0_123", "0123_456",
		"1_234", "1_234_567",
		"0X_0", "0X_1234", "0X_CAFE_f00d",
		"0o0", "0o1234", "0o01234567",
		"0O0", "0O1234", "0O01234567",
		"0o_0", "0o_1234", "0o0123_4567",
		"0O_0", "0O_1234", "0O0123_4567",
		"0b0", "0b1011", "0b00101101",
		"0B0", "0B1011", "0B00101101",
		"0b_0", "0b10_11", "0b_0010_1101",
		"0", "1", "-1", "+42", "9223372036854775807", "-9223372036854775808",
		"9223372036854775808", "999999999999999999999",
		"", "08", "1.2", "0x", "+", "1_", "_1", "0b", "xyz", "0x10g",
	}
	floatLits := []string{
		"1_2_3.", "0_123.",
		"0_0e0", "1_2_3e0", "0_123e0",
		"0e-0_0", "1_2_3E+0", "0123E1_2_3",
		"0.e+1", "123.E-1_0", "01_23.e123",
		".0e-1", ".123E+10", ".0123E123",
		"1_2_3.123", "0123.01_23",
		"1e-1000000000", "1e+1000000000", "6e5518446744", "-6e5518446744",
		"0x0.p+0", "0Xdeadcafe.p-10", "0x1234.P84",
		"0x.1p-0", "0X.deadcafep4", "0x.1234P+12",
		"0x0p0", "0Xdeadcafep+1", "0x1234P-10",
		"0x0.0p0", "0Xdead.cafep+1", "0x12.34P-10",
		"0Xdead_cafep+1", "0x_1234P-10",
		"0X_dead_cafe.p-10", "0x12_34.P1_2_3",
		"1.5", "1.", ".5", "1e2", "1", "08.5", "0x1p0", "0x1.2", "0x1.2p0",
		"-1.5", "+.5",
		"", "1e", "0x", ".", "+", "1_", "_1", "xyz",
	}
	out := make([]struct {
		tok token.Token
		lit string
	}, 0, len(intLits)+len(floatLits))
	for _, lit := range intLits {
		out = append(out, struct {
			tok token.Token
			lit string
		}{token.INT, lit})
	}
	for _, lit := range floatLits {
		out = append(out, struct {
			tok token.Token
			lit string
		}{token.FLOAT, lit})
	}
	return out
}

func dumpConstantLiteral(w io.Writer) {
	packet := ConstLitPacket{
		Schema:  1,
		Package: "gotool",
		Go:      "go1.24.13",
		Slice:   "constant-int-float-literal",
	}
	for i, src := range literalCorpus() {
		c := evalLiteral(src.lit, src.tok)
		c.ID = fmt.Sprintf("go-lit-%s-%d", c.Tok, i)
		packet.Cases = append(packet.Cases, c)
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func verifyConstantLiteral(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 32<<20))
	dec.DisallowUnknownFields()
	var packet ConstLitPacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool" || packet.Slice != "constant-int-float-literal" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid constant-literal packet header or empty cases"))
	}
	tokOf := map[string]token.Token{"INT": token.INT, "FLOAT": token.FLOAT}
	for i, c := range packet.Cases {
		tok, ok := tokOf[c.Tok]
		if !ok {
			fail(fmt.Errorf("case %d id=%s: unknown tok %q", i, c.ID, c.Tok))
		}
		if c.TokNum != int(tok) {
			fail(fmt.Errorf("case %d id=%s: tokNum %d != Go %s %d", i, c.ID, c.TokNum, c.Tok, int(tok)))
		}
		got := evalLiteral(c.Lit, tok)
		if got.Kind != c.Kind || got.Exact != c.Exact || got.Sign != c.Sign || got.ToInt != c.ToInt || got.ToIntOk != c.ToIntOk || got.BitLen != c.BitLen || got.F64Bits != c.F64Bits || got.F64Exact != c.F64Exact {
			fail(fmt.Errorf("mismatch case %d id=%s lit=%q tok=%s: go kind=%s exact=%s sign=%d toInt=%s ok=%v bitLen=%d f64=%s exact64=%v got kind=%s exact=%s sign=%d toInt=%s ok=%v bitLen=%d f64=%s exact64=%v",
				i, c.ID, c.Lit, c.Tok, got.Kind, got.Exact, got.Sign, got.ToInt, got.ToIntOk, got.BitLen, got.F64Bits, got.F64Exact,
				c.Kind, c.Exact, c.Sign, c.ToInt, c.ToIntOk, c.BitLen, c.F64Bits, c.F64Exact))
		}
	}
	fmt.Printf("Go verified %d gotool constant-int-float-literal cases\n", len(packet.Cases))
}

func charLiteralCorpus() []string {
	return []string{
		`'a'`, `'A'`, `'0'`, `' '`, `'"'`, `'中'`, `'π'`, `'😀'`,
		`'\a'`, `'\b'`, `'\f'`, `'\n'`, `'\r'`, `'\t'`, `'\v'`, `'\\'`, `'\''`,
		`'\x00'`, `'\x41'`, `'\x7f'`, `'\xff'`, `'\xFF'`, `'\x80'`,
		`'\u0000'`, `'\u00e9'`, `'\u4e2d'`, `'\u0027'`,
		`'\U00000000'`, `'\U0001F600'`, `'\U0010FFFF'`,
		`'\000'`, `'\101'`, `'\377'`, `'\012'`,
		`'ab'`, `'\x4142'`, `'\0123'`, `'中x'`, `'\n '`,
		`abc`, `XyZ`,
		``, `'`, `''`, `'a`, `a'`, `'\x'`, `'\x4'`, `'\xGG'`,
		`'\u'`, `'\u12'`, `'\u00GG'`, `'\uD800'`, `'\uDFFF'`,
		`'\U'`, `'\U1234567'`, `'\U00110000'`, `'\U0000D800'`,
		`'\400'`, `'\8'`, `'\9'`, `'\"'`, `'\z'`, `'\ '`, `'\'`,
	}
}

func dumpConstantCharLiteral(w io.Writer) {
	packet := ConstLitPacket{
		Schema:  1,
		Package: "gotool",
		Go:      "go1.24.13",
		Slice:   "constant-char-literal",
	}
	for i, lit := range charLiteralCorpus() {
		c := evalLiteral(lit, token.CHAR)
		c.ID = fmt.Sprintf("go-lit-CHAR-%d", i)
		packet.Cases = append(packet.Cases, c)
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func verifyConstantCharLiteral(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 32<<20))
	dec.DisallowUnknownFields()
	var packet ConstLitPacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool" || packet.Slice != "constant-char-literal" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid constant-char-literal packet header or empty cases"))
	}
	for i, c := range packet.Cases {
		if c.Tok != "CHAR" {
			fail(fmt.Errorf("case %d id=%s: tok %q != CHAR", i, c.ID, c.Tok))
		}
		if c.TokNum != int(token.CHAR) {
			fail(fmt.Errorf("case %d id=%s: tokNum %d != Go CHAR %d", i, c.ID, c.TokNum, int(token.CHAR)))
		}
		got := evalLiteral(c.Lit, token.CHAR)
		if got.Kind != c.Kind || got.Exact != c.Exact || got.Sign != c.Sign || got.ToInt != c.ToInt || got.ToIntOk != c.ToIntOk || got.BitLen != c.BitLen || got.F64Bits != c.F64Bits || got.F64Exact != c.F64Exact {
			fail(fmt.Errorf("mismatch case %d id=%s lit=%q: go kind=%s exact=%s sign=%d toInt=%s ok=%v bitLen=%d f64=%s exact64=%v got kind=%s exact=%s sign=%d toInt=%s ok=%v bitLen=%d f64=%s exact64=%v",
				i, c.ID, c.Lit, got.Kind, got.Exact, got.Sign, got.ToInt, got.ToIntOk, got.BitLen, got.F64Bits, got.F64Exact,
				c.Kind, c.Exact, c.Sign, c.ToInt, c.ToIntOk, c.BitLen, c.F64Bits, c.F64Exact))
		}
	}
	fmt.Printf("Go verified %d gotool constant-char-literal cases\n", len(packet.Cases))
}

type ConstImagLitCase struct {
	ID         string `json:"id"`
	Lit        string `json:"lit"`
	Tok        string `json:"tok"`
	TokNum     int    `json:"tokNum"`
	Kind       string `json:"kind"`
	Exact      string `json:"exact"`
	Sign       int    `json:"sign"`
	ReKind     string `json:"reKind"`
	ReExact    string `json:"reExact"`
	ImKind     string `json:"imKind"`
	ImExact    string `json:"imExact"`
	ImF64Bits  string `json:"imF64Bits"`
	ImF64Exact bool   `json:"imF64Exact"`
}

type ConstImagLitPacket struct {
	Schema  int                `json:"schema"`
	Package string             `json:"package"`
	Go      string             `json:"go"`
	Slice   string             `json:"slice"`
	Cases   []ConstImagLitCase `json:"cases"`
}

func evalImagLiteral(lit string) ConstImagLitCase {
	c := ConstImagLitCase{Lit: lit, Tok: "IMAG", TokNum: int(token.IMAG)}
	v := constant.MakeFromLiteral(lit, token.IMAG, 0)
	c.Kind = v.Kind().String()
	c.Exact = v.ExactString()
	c.Sign = constant.Sign(v)
	re := constant.Real(v)
	im := constant.Imag(v)
	c.ReKind = re.Kind().String()
	c.ReExact = re.ExactString()
	c.ImKind = im.Kind().String()
	c.ImExact = im.ExactString()
	f, exact := constant.Float64Val(im)
	c.ImF64Bits = fmt.Sprintf("%016x", math.Float64bits(f))
	c.ImF64Exact = exact
	return c
}

// Official go/constant TestNumbers imagTests (LHS) + TestString complex
// inputs except 1e9999i (512-bit floatVal ExactString; same deferral as FLOAT).
func imagLiteralCorpus() []string {
	return []string{
		`1_234i`, `1_234_567i`,
		`0.i`, `123.i`, `0123.i`,
		`0.e+1i`, `123.E-1_0i`, `01_23.e123i`,
		`1e-1000000000i`, `1e+1000000000i`, `6e5518446744i`, `-6e5518446744i`,
		`0i`, `-0i`, `10i`, `-10i`,
		`1i`, `+1i`, `-1i`, `1.5i`, `-2.1i`, `.5i`, `1.i`, `1e2i`,
		`0x1p0i`, `0x1.2p0i`, `0Xdeadcafep+1i`, `1_2_3.i`,
		`08.5i`, `+0i`,
		``, `1`, `i`, `1I`, `1ii`, `1i2`, `xyz`, `1e`, `+`, `08i`,
		`1e+i`, `1_i`, `_1i`, `1.2.3i`, `'1i'`,
	}
}

func dumpConstantImagLiteral(w io.Writer) {
	packet := ConstImagLitPacket{
		Schema:  1,
		Package: "gotool",
		Go:      "go1.24.13",
		Slice:   "constant-imag-literal",
	}
	for i, lit := range imagLiteralCorpus() {
		c := evalImagLiteral(lit)
		c.ID = fmt.Sprintf("go-lit-IMAG-%d", i)
		packet.Cases = append(packet.Cases, c)
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func verifyConstantImagLiteral(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 32<<20))
	dec.DisallowUnknownFields()
	var packet ConstImagLitPacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool" || packet.Slice != "constant-imag-literal" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid constant-imag-literal packet header or empty cases"))
	}
	for i, c := range packet.Cases {
		if c.Tok != "IMAG" {
			fail(fmt.Errorf("case %d id=%s: tok %q != IMAG", i, c.ID, c.Tok))
		}
		if c.TokNum != int(token.IMAG) {
			fail(fmt.Errorf("case %d id=%s: tokNum %d != Go IMAG %d", i, c.ID, c.TokNum, int(token.IMAG)))
		}
		got := evalImagLiteral(c.Lit)
		if got.Kind != c.Kind || got.Exact != c.Exact || got.Sign != c.Sign || got.ReKind != c.ReKind || got.ReExact != c.ReExact || got.ImKind != c.ImKind || got.ImExact != c.ImExact || got.ImF64Bits != c.ImF64Bits || got.ImF64Exact != c.ImF64Exact {
			fail(fmt.Errorf("mismatch case %d id=%s lit=%q: go kind=%s exact=%s sign=%d re=%s/%s im=%s/%s f64=%s exact64=%v got kind=%s exact=%s sign=%d re=%s/%s im=%s/%s f64=%s exact64=%v",
				i, c.ID, c.Lit, got.Kind, got.Exact, got.Sign, got.ReKind, got.ReExact, got.ImKind, got.ImExact, got.ImF64Bits, got.ImF64Exact,
				c.Kind, c.Exact, c.Sign, c.ReKind, c.ReExact, c.ImKind, c.ImExact, c.ImF64Bits, c.ImF64Exact))
		}
	}
	fmt.Printf("Go verified %d gotool constant-imag-literal cases\n", len(packet.Cases))
}

type ConstStrLitCase struct {
	ID         string `json:"id"`
	Lit        string `json:"lit"`
	Tok        string `json:"tok"`
	TokNum     int    `json:"tokNum"`
	Kind       string `json:"kind"`
	Exact      string `json:"exact"`
	ToString   string `json:"toString"`
	ToStringOk bool   `json:"toStringOk"`
	Utf8Valid  bool   `json:"utf8Valid"`
	StringB64  string `json:"stringB64"`
}

type ConstStrLitPacket struct {
	Schema  int               `json:"schema"`
	Package string            `json:"package"`
	Go      string            `json:"go"`
	Slice   string            `json:"slice"`
	Cases   []ConstStrLitCase `json:"cases"`
}

func evalStringLiteral(lit string) ConstStrLitCase {
	c := ConstStrLitCase{Lit: lit, Tok: "STRING", TokNum: int(token.STRING)}
	v := constant.MakeFromLiteral(lit, token.STRING, 0)
	c.Kind = v.Kind().String()
	c.Exact = v.ExactString()
	s, ok := stringValOK(v)
	c.ToStringOk = ok
	c.Utf8Valid = utf8.ValidString(s)
	if v.Kind() == constant.String {
		c.StringB64 = base64.StdEncoding.EncodeToString([]byte(s))
		if c.Utf8Valid {
			c.ToString = s
		}
	}
	return c
}

// Official go/constant TestString STRING cases plus Unquote edges.
// `'ab'` as STRING is Unknown (Unquote leftover); CHAR ignores the tail.
func stringLiteralCorpus() []string {
	xxx := ""
	for i := 0; i < 68; i++ {
		xxx += "x"
	}
	return []string{
		`""`, `"foo"`, `"foo bar"`, `"hello world"`,
		`"` + xxx + `xx"`,
		`"hello\nworld"`, `"hello\tworld"`, `"hello\rworld"`,
		`"\a"`, `"\b"`, `"\f"`, `"\n"`, `"\r"`, `"\t"`, `"\v"`,
		`"\\"`, `"\""`, `"foo\"bar"`,
		`"\x00"`, `"\x41"`, `"\x7f"`, `"\xff"`, `"\xFF"`, `"\x80"`,
		`"\x41\x42"`, `"a\x41b"`,
		`"\u0000"`, `"\u00e9"`, `"\u00a0"`, `"\u00ad"`, `"\u4e2d"`,
		`"\U00000000"`, `"\U0001F600"`, `"\U0010FFFF"`,
		`"\000"`, `"\101"`, `"\377"`, `"\012"`,
		`"中"`, `"π"`, `"😀"`, `"hello 中"`, `"é"`,
		`"foo` + "\n" + `bar"`,
		`'a'`, `'\n'`, `'中'`, `'π'`, `''`, `'ab'`, `'\x41'`,
		"``", "`hello`", "`hello\\n`", "`\"`", "`'a'`",
		"`hello\nworld`", "`hello\rworld`", "`hello\r\nworld`",
		`"`, `"a`, `a"`, `"hello'`, `'hello"`,
		`"\x"`, `"\x4"`, `"\xGG"`, `"\u"`, `"\u12"`, `"\u00GG"`, `"\uD800"`, `"\uDFFF"`,
		`"\U"`, `"\U1234567"`, `"\U00110000"`, `"\U0000D800"`,
		`"\400"`, `"\8"`, `"\z"`, `"\'"`, `"\ "`,
		`hello`, `1`, `'`, ``, `"foo"bar`, "`hello`world`",
		`"\n `, `'ab'`, `"中x`,
	}
}

func dumpConstantStringLiteral(w io.Writer) {
	packet := ConstStrLitPacket{
		Schema:  1,
		Package: "gotool",
		Go:      "go1.24.13",
		Slice:   "constant-string-literal",
	}
	for i, lit := range stringLiteralCorpus() {
		c := evalStringLiteral(lit)
		c.ID = fmt.Sprintf("go-lit-STRING-%d", i)
		packet.Cases = append(packet.Cases, c)
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func verifyConstantStringLiteral(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 32<<20))
	dec.DisallowUnknownFields()
	var packet ConstStrLitPacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool" || packet.Slice != "constant-string-literal" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid constant-string-literal packet header or empty cases"))
	}
	for i, c := range packet.Cases {
		if c.Tok != "STRING" {
			fail(fmt.Errorf("case %d id=%s: tok %q != STRING", i, c.ID, c.Tok))
		}
		if c.TokNum != int(token.STRING) {
			fail(fmt.Errorf("case %d id=%s: tokNum %d != Go STRING %d", i, c.ID, c.TokNum, int(token.STRING)))
		}
		got := evalStringLiteral(c.Lit)
		if got.Kind != c.Kind || got.Exact != c.Exact || got.ToStringOk != c.ToStringOk || got.Utf8Valid != c.Utf8Valid || got.StringB64 != c.StringB64 || got.ToString != c.ToString {
			fail(fmt.Errorf("mismatch case %d id=%s lit=%q: go kind=%s exact=%s toString=%q ok=%v utf8=%v b64=%s got kind=%s exact=%s toString=%q ok=%v utf8=%v b64=%s",
				i, c.ID, c.Lit, got.Kind, got.Exact, got.ToString, got.ToStringOk, got.Utf8Valid, got.StringB64,
				c.Kind, c.Exact, c.ToString, c.ToStringOk, c.Utf8Valid, c.StringB64))
		}
	}
	fmt.Printf("Go verified %d gotool constant-string-literal cases\n", len(packet.Cases))
}

type ConstBoolCase struct {
	ID        string `json:"id"`
	Form      string `json:"form"`
	X         string `json:"x"`
	Y         string `json:"y"`
	Op        string `json:"op"`
	OpTok     int    `json:"opTok"`
	Kind      string `json:"kind"`
	Exact     string `json:"exact"`
	BoolVal   bool   `json:"boolVal"`
	BoolValOk bool   `json:"boolValOk"`
}

type ConstBoolPacket struct {
	Schema  int             `json:"schema"`
	Package string          `json:"package"`
	Go      string          `json:"go"`
	Slice   string          `json:"slice"`
	Cases   []ConstBoolCase `json:"cases"`
}

func boolValOK(v constant.Value) (b bool, ok bool) {
	defer func() {
		if recover() != nil {
			b, ok = false, false
		}
	}()
	return constant.BoolVal(v), true
}

func makeBoolSrc(name string) (constant.Value, error) {
	switch name {
	case "true":
		return constant.MakeBool(true), nil
	case "false":
		return constant.MakeBool(false), nil
	case "unknown":
		return constant.MakeUnknown(), nil
	default:
		return nil, fmt.Errorf("unknown bool src %q", name)
	}
}

func evalBool(form, xName, yName string) (ConstBoolCase, error) {
	c := ConstBoolCase{Form: form, X: xName, Y: yName}
	vx, err := makeBoolSrc(xName)
	if err != nil {
		return c, err
	}
	var v constant.Value
	switch form {
	case "make":
		c.Op = "MAKE"
		c.OpTok = 0
		v = vx
	case "not":
		c.Op = "NOT"
		c.OpTok = int(token.NOT)
		v = constant.UnaryOp(token.NOT, vx, 0)
	case "land":
		vy, err := makeBoolSrc(yName)
		if err != nil {
			return c, err
		}
		c.Op = "LAND"
		c.OpTok = int(token.LAND)
		v = constant.BinaryOp(vx, token.LAND, vy)
	case "lor":
		vy, err := makeBoolSrc(yName)
		if err != nil {
			return c, err
		}
		c.Op = "LOR"
		c.OpTok = int(token.LOR)
		v = constant.BinaryOp(vx, token.LOR, vy)
	case "eql":
		vy, err := makeBoolSrc(yName)
		if err != nil {
			return c, err
		}
		c.Op = "EQL"
		c.OpTok = int(token.EQL)
		v = constant.MakeBool(constant.Compare(vx, token.EQL, vy))
	case "neq":
		vy, err := makeBoolSrc(yName)
		if err != nil {
			return c, err
		}
		c.Op = "NEQ"
		c.OpTok = int(token.NEQ)
		v = constant.MakeBool(constant.Compare(vx, token.NEQ, vy))
	default:
		return c, fmt.Errorf("unknown form %q", form)
	}
	c.Kind = v.Kind().String()
	c.Exact = v.ExactString()
	c.BoolVal, c.BoolValOk = boolValOK(v)
	return c, nil
}

func boolSrcNames() []string {
	return []string{"true", "false", "unknown"}
}

func dumpConstantBool(w io.Writer) {
	packet := ConstBoolPacket{
		Schema:  1,
		Package: "gotool",
		Go:      "go1.24.13",
		Slice:   "constant-bool",
	}
	names := boolSrcNames()
	for i, x := range names {
		c, err := evalBool("make", x, "false")
		if err != nil {
			fail(err)
		}
		c.ID = fmt.Sprintf("go-bool-make-%d", i)
		packet.Cases = append(packet.Cases, c)
		c, err = evalBool("not", x, "false")
		if err != nil {
			fail(err)
		}
		c.ID = fmt.Sprintf("go-bool-not-%d", i)
		packet.Cases = append(packet.Cases, c)
	}
	for _, form := range []string{"land", "lor", "eql", "neq"} {
		for i, x := range names {
			for j, y := range names {
				c, err := evalBool(form, x, y)
				if err != nil {
					fail(err)
				}
				c.ID = fmt.Sprintf("go-bool-%s-%d-%d", form, i, j)
				packet.Cases = append(packet.Cases, c)
			}
		}
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(packet); err != nil {
		fail(err)
	}
}

func verifyConstantBool(r io.Reader) {
	dec := json.NewDecoder(io.LimitReader(r, 32<<20))
	dec.DisallowUnknownFields()
	var packet ConstBoolPacket
	if err := dec.Decode(&packet); err != nil {
		fail(err)
	}
	var extra interface{}
	if err := dec.Decode(&extra); err != io.EOF {
		fail(fmt.Errorf("expected a single JSON packet"))
	}
	if packet.Schema != 1 || packet.Package != "gotool" || packet.Slice != "constant-bool" || len(packet.Cases) == 0 {
		fail(fmt.Errorf("invalid constant-bool packet header or empty cases"))
	}
	tokOf := map[string]int{
		"MAKE": 0, "NOT": int(token.NOT), "LAND": int(token.LAND), "LOR": int(token.LOR),
		"EQL": int(token.EQL), "NEQ": int(token.NEQ),
	}
	for i, c := range packet.Cases {
		wantTok, ok := tokOf[c.Op]
		if !ok {
			fail(fmt.Errorf("case %d id=%s: unknown op %q", i, c.ID, c.Op))
		}
		if c.OpTok != wantTok {
			fail(fmt.Errorf("case %d id=%s: opTok %d != Go %s %d", i, c.ID, c.OpTok, c.Op, wantTok))
		}
		got, err := evalBool(c.Form, c.X, c.Y)
		if err != nil {
			fail(fmt.Errorf("case %d id=%s: %w", i, c.ID, err))
		}
		if got.Kind != c.Kind || got.Exact != c.Exact || got.BoolVal != c.BoolVal || got.BoolValOk != c.BoolValOk {
			fail(fmt.Errorf("mismatch case %d id=%s form=%s x=%s y=%s: go kind=%s exact=%s boolVal=%v ok=%v got kind=%s exact=%s boolVal=%v ok=%v",
				i, c.ID, c.Form, c.X, c.Y, got.Kind, got.Exact, got.BoolVal, got.BoolValOk,
				c.Kind, c.Exact, c.BoolVal, c.BoolValOk))
		}
	}
	fmt.Printf("Go verified %d gotool constant-bool cases\n", len(packet.Cases))
}
