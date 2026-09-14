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
