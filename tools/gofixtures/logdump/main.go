// Go 1.24.13 reference dump for rustd-log. Header formatting is copied from
// src/log/log.go so the clock can be injected; slog output uses the stdlib
// handlers with slog.NewRecord at a fixed time.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"
)

var now = time.Date(2009, 11, 10, 23, 0, 0, 123456789, time.UTC)

const (
	ldate         = 1 << iota
	ltime
	lmicroseconds
	llongfile
	lshortfile
	lutc
	lmsgprefix
	lstdFlags     = ldate | ltime
)

func itoa(buf *[]byte, i int, wid int) {
	var b [20]byte
	bp := len(b) - 1
	for i >= 10 || wid > 1 {
		wid--
		q := i / 10
		b[bp] = byte('0' + i - q*10)
		bp--
		i = q
	}
	b[bp] = byte('0' + i)
	*buf = append(*buf, b[bp:]...)
}

func formatHeader(buf *[]byte, t time.Time, prefix string, flag int, file string, line int) {
	if flag&lmsgprefix == 0 {
		*buf = append(*buf, prefix...)
	}
	if flag&(ldate|ltime|lmicroseconds) != 0 {
		if flag&lutc != 0 {
			t = t.UTC()
		}
		if flag&ldate != 0 {
			year, month, day := t.Date()
			itoa(buf, year, 4)
			*buf = append(*buf, '/')
			itoa(buf, int(month), 2)
			*buf = append(*buf, '/')
			itoa(buf, day, 2)
			*buf = append(*buf, ' ')
		}
		if flag&(ltime|lmicroseconds) != 0 {
			hour, min, sec := t.Clock()
			itoa(buf, hour, 2)
			*buf = append(*buf, ':')
			itoa(buf, min, 2)
			*buf = append(*buf, ':')
			itoa(buf, sec, 2)
			if flag&lmicroseconds != 0 {
				*buf = append(*buf, '.')
				itoa(buf, t.Nanosecond()/1e3, 6)
			}
			*buf = append(*buf, ' ')
		}
	}
	if flag&(lshortfile|llongfile) != 0 {
		if flag&lshortfile != 0 {
			short := file
			for i := len(file) - 1; i > 0; i-- {
				if file[i] == '/' {
					short = file[i+1:]
					break
				}
			}
			file = short
		}
		*buf = append(*buf, file...)
		*buf = append(*buf, ':')
		itoa(buf, line, -1)
		*buf = append(*buf, ": "...)
	}
	if flag&lmsgprefix != 0 {
		*buf = append(*buf, prefix...)
	}
}

func logLine(flag int, prefix, file string, line int, msg string) string {
	buf := []byte{}
	formatHeader(&buf, now, prefix, flag, file, line)
	buf = append(buf, msg...)
	if len(buf) == 0 || buf[len(buf)-1] != '\n' {
		buf = append(buf, '\n')
	}
	return string(buf)
}

type lv string

func (v lv) LogValue() slog.Value { return slog.StringValue(string(v)) }

type attrDTO struct {
	Key         string    `json:"key"`
	Kind        string    `json:"kind"`
	String      string    `json:"string,omitempty"`
	Bool        *bool     `json:"bool,omitempty"`
	Int64       *int64    `json:"int64,omitempty"`
	Uint64      string    `json:"uint64,omitempty"`
	Float64     *float64  `json:"float64,omitempty"`
	DurationNs  string    `json:"durationNs,omitempty"`
	TimeNs      string    `json:"timeNs,omitempty"`
	AnyText     string    `json:"anyText,omitempty"`
	AnyJSON     string    `json:"anyJson,omitempty"`
	Group       []attrDTO `json:"group,omitempty"`
}

func dto(a slog.Attr) attrDTO {
	v := a.Value.Resolve()
	d := attrDTO{Key: a.Key, Kind: v.Kind().String()}
	switch v.Kind() {
	case slog.KindBool:
		b := v.Bool()
		d.Bool = &b
	case slog.KindDuration:
		d.DurationNs = fmt.Sprintf("%d", v.Duration().Nanoseconds())
	case slog.KindFloat64:
		f := v.Float64()
		d.Float64 = &f
	case slog.KindInt64:
		n := v.Int64()
		d.Int64 = &n
	case slog.KindString:
		d.String = v.String()
	case slog.KindTime:
		d.TimeNs = fmt.Sprintf("%d", v.Time().UnixNano())
	case slog.KindUint64:
		d.Uint64 = fmt.Sprintf("%d", v.Uint64())
	case slog.KindGroup:
		for _, g := range v.Group() {
			d.Group = append(d.Group, dto(g))
		}
	default:
		d.Kind = "any"
		d.AnyText = fmt.Sprintf("%+v", v.Any())
		raw, err := json.Marshal(v.Any())
		if err != nil {
			d.AnyJSON = "null"
		} else {
			d.AnyJSON = string(raw)
		}
	}
	return d
}

type slogCase struct {
	ID         string    `json:"id"`
	Level      int       `json:"level"`
	Msg        string    `json:"msg"`
	AddSource  bool      `json:"addSource"`
	SourceFile string    `json:"sourceFile,omitempty"`
	SourceLine int       `json:"sourceLine,omitempty"`
	SourceFn   string    `json:"sourceFn,omitempty"`
	Groups     []string  `json:"groups,omitempty"`
	WithAttrs  []attrDTO `json:"withAttrs,omitempty"`
	Attrs      []attrDTO `json:"attrs,omitempty"`
	Text       string    `json:"text"`
	JSON       string    `json:"json"`
}

func render(jsonH bool, c slogCase, rec slog.Record, with []slog.Attr) string {
	var buf bytes.Buffer
	opts := &slog.HandlerOptions{AddSource: c.AddSource}
	if c.AddSource {
		opts.ReplaceAttr = func(groups []string, a slog.Attr) slog.Attr {
			if a.Key == slog.SourceKey {
				return slog.Any(slog.SourceKey, &slog.Source{Function: c.SourceFn, File: c.SourceFile, Line: c.SourceLine})
			}
			return a
		}
	}
	var h slog.Handler
	if jsonH {
		h = slog.NewJSONHandler(&buf, opts)
	} else {
		h = slog.NewTextHandler(&buf, opts)
	}
	if len(with) > 0 {
		h = h.WithAttrs(with)
	}
	for _, g := range c.Groups {
		h = h.WithGroup(g)
	}
	_ = h.Handle(context.Background(), rec)
	return buf.String()
}

func makeCase(id string, level slog.Level, msg string, attrs []slog.Attr, with []slog.Attr, groups []string) slogCase {
	rec := slog.NewRecord(now, level, msg, 0)
	rec.AddAttrs(attrs...)
	c := slogCase{ID: id, Level: int(level), Msg: msg, Groups: groups}
	for _, a := range attrs {
		c.Attrs = append(c.Attrs, dto(a))
	}
	for _, a := range with {
		c.WithAttrs = append(c.WithAttrs, dto(a))
	}
	c.Text = render(false, c, rec, with)
	c.JSON = render(true, c, rec, with)
	return c
}

type logCase struct {
	ID      string `json:"id"`
	Flags   int    `json:"flags"`
	Prefix  string `json:"prefix"`
	File    string `json:"file"`
	Line    int    `json:"line"`
	Method  string `json:"method"`
	Format  string `json:"format,omitempty"`
	Args    []any  `json:"args"`
	Message string `json:"message"`
	Output  string `json:"output"`
}

type syslogCase struct {
	ID        string `json:"id"`
	Local     bool   `json:"local"`
	Priority  int    `json:"priority"`
	Hostname  string `json:"hostname"`
	Tag       string `json:"tag"`
	Pid       int    `json:"pid"`
	Msg       string `json:"msg"`
	Output    string `json:"output"`
}

type packet struct {
	Schema    int          `json:"schema"`
	NowUnixNs string       `json:"nowUnixNs"`
	Log       []logCase    `json:"log"`
	Slog      []slogCase   `json:"slog"`
	Syslog    []syslogCase `json:"syslog"`
}

func b(v bool) *bool { return &v }

func build() packet {
	p := packet{Schema: 1, NowUnixNs: fmt.Sprintf("%d", now.UnixNano())}
	flags := []int{
		0,
		ldate,
		ltime,
		lstdFlags,
		lstdFlags | lmicroseconds,
		lstdFlags | lutc,
		lstdFlags | lmicroseconds | lutc,
		lstdFlags | lshortfile,
		lstdFlags | llongfile,
		lstdFlags | lmsgprefix,
		ldate | ltime | lmicroseconds | llongfile | lutc,
		ltime | lmicroseconds | lutc | lshortfile | lmsgprefix,
	}
	prefixes := []string{"", "APP "}
	for _, f := range flags {
		for _, prefix := range prefixes {
			msg := fmt.Sprint("hello", 1)
			id := fmt.Sprintf("print/%d/%q", f, prefix)
			p.Log = append(p.Log, logCase{
				ID: id, Flags: f, Prefix: prefix, File: "/a/b/c.go", Line: 23,
				Method: "print", Args: []any{"hello", 1}, Message: msg,
				Output: logLine(f, prefix, "/a/b/c.go", 23, msg),
			})
			msg = fmt.Sprintln("hello", 1)
			p.Log = append(p.Log, logCase{
				ID: "println/" + id, Flags: f, Prefix: prefix, File: "/a/b/c.go", Line: 23,
				Method: "println", Args: []any{"hello", 1}, Message: msg,
				Output: logLine(f, prefix, "/a/b/c.go", 23, msg),
			})
			msg = fmt.Sprintf("n=%d %s", 7, "x")
			p.Log = append(p.Log, logCase{
				ID: "printf/" + id, Flags: f, Prefix: prefix, File: "/a/b/c.go", Line: 23,
				Method: "printf", Format: "n=%d %s", Args: []any{7, "x"}, Message: msg,
				Output: logLine(f, prefix, "/a/b/c.go", 23, msg),
			})
		}
	}
	p.Log = append(p.Log, logCase{
		ID: "empty", Flags: 0, Prefix: "", File: "", Line: 0, Method: "print",
		Args: []any{""}, Message: "", Output: logLine(0, "", "", 0, ""),
	})

	u63 := uint64(1 << 63)
	cases := []slogCase{
		makeCase("bare", slog.LevelInfo, "hello", nil, nil, nil),
		makeCase("debug", slog.LevelDebug, "d", nil, nil, nil),
		makeCase("warn", slog.LevelWarn, "w", nil, nil, nil),
		makeCase("error", slog.LevelError, "e", nil, nil, nil),
		makeCase("info+2", slog.LevelInfo+2, "m", nil, nil, nil),
		makeCase("debug-1", slog.LevelDebug-1, "m", nil, nil, nil),
		makeCase("error+4", slog.LevelError+4, "m", nil, nil, nil),
		makeCase("level-128", slog.Level(-128), "m", nil, nil, nil),
		makeCase("level-127", slog.Level(127), "m", nil, nil, nil),
		makeCase("bool", slog.LevelInfo, "m", []slog.Attr{slog.Bool("ok", true), slog.Bool("no", false)}, nil, nil),
		makeCase("duration", slog.LevelInfo, "m", []slog.Attr{slog.Duration("d", 1500*time.Millisecond)}, nil, nil),
		makeCase("duration-ns", slog.LevelInfo, "m", []slog.Attr{slog.Duration("d", time.Nanosecond)}, nil, nil),
		makeCase("duration-hms", slog.LevelInfo, "m", []slog.Attr{slog.Duration("d", time.Hour+2*time.Minute+3*time.Second)}, nil, nil),
		makeCase("duration-neg", slog.LevelInfo, "m", []slog.Attr{slog.Duration("d", -1500*time.Millisecond)}, nil, nil),
		makeCase("float", slog.LevelInfo, "m", []slog.Attr{slog.Float64("f", 1.5), slog.Float64("z", 0)}, nil, nil),
		makeCase("int", slog.LevelInfo, "m", []slog.Attr{slog.Int("n", 42), slog.Int64("i64", -1)}, nil, nil),
		makeCase("uint64", slog.LevelInfo, "m", []slog.Attr{slog.Uint64("u", u63)}, nil, nil),
		makeCase("string", slog.LevelInfo, "m", []slog.Attr{slog.String("s", "plain")}, nil, nil),
		makeCase("string-space", slog.LevelInfo, "m", []slog.Attr{slog.String("s", "has space")}, nil, nil),
		makeCase("string-eq", slog.LevelInfo, "m", []slog.Attr{slog.String("s", "a=b")}, nil, nil),
		makeCase("string-quote", slog.LevelInfo, "m", []slog.Attr{slog.String("s", `say "hi"`)}, nil, nil),
		makeCase("string-ctrl", slog.LevelInfo, "m", []slog.Attr{slog.String("s", "a\nb\tc")}, nil, nil),
		makeCase("string-html", slog.LevelInfo, "m", []slog.Attr{slog.String("s", "<&>")}, nil, nil),
		makeCase("string-empty", slog.LevelInfo, "m", []slog.Attr{slog.String("s", "")}, nil, nil),
		makeCase("time", slog.LevelInfo, "m", []slog.Attr{slog.Time("t", now)}, nil, nil),
		makeCase("any-nil", slog.LevelInfo, "m", []slog.Attr{slog.Any("n", nil)}, nil, nil),
		makeCase("any-map", slog.LevelInfo, "m", []slog.Attr{slog.Any("m", map[string]int{"a": 1})}, nil, nil),
		makeCase("any-slice", slog.LevelInfo, "m", []slog.Attr{slog.Any("s", []int{1, 2, 3})}, nil, nil),
		makeCase("any-string", slog.LevelInfo, "m", []slog.Attr{slog.Any("s", "x")}, nil, nil),
		makeCase("group", slog.LevelInfo, "m", []slog.Attr{slog.Group("g", slog.Int("a", 1), slog.String("b", "x"))}, nil, nil),
		makeCase("group-empty-name", slog.LevelInfo, "m", []slog.Attr{slog.Group("", slog.Int("a", 1), slog.Int("b", 2))}, nil, nil),
		makeCase("group-empty", slog.LevelInfo, "m", []slog.Attr{slog.Group("g"), slog.Int("keep", 1)}, nil, nil),
		makeCase("group-attrs", slog.LevelInfo, "m", []slog.Attr{slog.Group("g", slog.Int("a", 1))}, nil, nil),
		makeCase("nested-group", slog.LevelInfo, "m", []slog.Attr{slog.Group("g", slog.Group("h", slog.Int("a", 1)))}, nil, nil),
		makeCase("logvaluer", slog.LevelInfo, "m", []slog.Attr{slog.Any("s", lv("secret"))}, nil, nil),
		makeCase("with-attrs", slog.LevelInfo, "m", []slog.Attr{slog.Int("b", 2)}, []slog.Attr{slog.String("a", "1")}, nil),
		makeCase("with-group", slog.LevelInfo, "m", []slog.Attr{slog.Int("a", 1)}, nil, []string{"g"}),
		makeCase("with-group2", slog.LevelInfo, "m", []slog.Attr{slog.Int("a", 1)}, []slog.Attr{slog.Int("x", 9)}, []string{"g", "h"}),
		makeCase("with-empty-group", slog.LevelInfo, "m", []slog.Attr{slog.Int("a", 1)}, nil, []string{""}),
		makeCase("msg-special", slog.LevelInfo, "has space and =", []slog.Attr{slog.String("k", "v")}, nil, nil),
		makeCase("many", slog.LevelInfo, "m", []slog.Attr{
			slog.Bool("b", true), slog.Duration("d", time.Second), slog.Float64("f", 2.5),
			slog.Int("i", 3), slog.String("s", "x"), slog.Time("t", now), slog.Uint64("u", 7),
		}, nil, nil),
	}
	src := makeCase("source", slog.LevelInfo, "m", []slog.Attr{slog.Int("a", 1)}, nil, nil)
	src.AddSource = true
	src.SourceFile = "app.js"
	src.SourceLine = 10
	src.SourceFn = "run"
	rec := slog.NewRecord(now, slog.LevelInfo, "m", 1)
	rec.AddAttrs(slog.Int("a", 1))
	src.Text = render(false, src, rec, nil)
	src.JSON = render(true, src, rec, nil)
	cases = append(cases, src)

	// Pad to >= 80 with systematic strings and ints.
	for i := 0; i < 40; i++ {
		cases = append(cases, makeCase(
			fmt.Sprintf("pad-%d", i),
			slog.Level(i-10),
			fmt.Sprintf("msg %d", i),
			[]slog.Attr{slog.Int("n", i), slog.String("s", fmt.Sprintf("v=%d", i))},
			nil, nil,
		))
	}
	p.Slog = cases

	facilities := []int{0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 128, 136, 144, 152, 160, 168, 176, 184}
	severities := []int{0, 1, 2, 3, 4, 5, 6, 7}
	tags := []string{"tag", "app", "rustd"}
	n := 0
	for _, fac := range facilities {
		for _, sev := range severities {
			for _, tag := range tags {
				if n >= 24 {
					break
				}
				pri := fac | sev
				msg := "hello"
				nl := "\n"
				local := fmt.Sprintf("<%d>%s %s[%d]: %s%s", pri, now.Format(time.Stamp), tag, 4242, msg, nl)
				net := fmt.Sprintf("<%d>%s %s %s[%d]: %s%s", pri, now.Format(time.RFC3339), "host.example", tag, 4242, msg, nl)
				p.Syslog = append(p.Syslog, syslogCase{ID: fmt.Sprintf("local/%d", pri), Local: true, Priority: pri, Tag: tag, Pid: 4242, Msg: msg, Output: local})
				p.Syslog = append(p.Syslog, syslogCase{ID: fmt.Sprintf("net/%d", pri), Local: false, Priority: pri, Hostname: "host.example", Tag: tag, Pid: 4242, Msg: msg, Output: net})
				n++
			}
		}
	}
	_ = b
	return p
}

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }

func main() {
	verify := flag.Bool("verify", false, "verify packet from stdin")
	flag.Parse()
	want := build()
	if *verify {
		dec := json.NewDecoder(io.LimitReader(os.Stdin, 32<<20))
		var got packet
		if err := dec.Decode(&got); err != nil {
			fail(err)
		}
		if got.Schema != 1 || got.NowUnixNs != want.NowUnixNs {
			fail(fmt.Errorf("packet header mismatch"))
		}
		if len(got.Log) != len(want.Log) || len(got.Slog) != len(want.Slog) || len(got.Syslog) != len(want.Syslog) {
			fail(fmt.Errorf("count mismatch log=%d/%d slog=%d/%d syslog=%d/%d",
				len(got.Log), len(want.Log), len(got.Slog), len(want.Slog), len(got.Syslog), len(want.Syslog)))
		}
		for i, c := range want.Log {
			if got.Log[i].Output != c.Output {
				fail(fmt.Errorf("log %s mismatch", c.ID))
			}
		}
		for i, c := range want.Slog {
			if got.Slog[i].Text != c.Text || got.Slog[i].JSON != c.JSON {
				fail(fmt.Errorf("slog %s mismatch", c.ID))
			}
		}
		for i, c := range want.Syslog {
			if got.Syslog[i].Output != c.Output {
				fail(fmt.Errorf("syslog %s mismatch", c.ID))
			}
		}
		fmt.Printf("Go verified %d log, %d slog, %d syslog cases\n", len(want.Log), len(want.Slog), len(want.Syslog))
		return
	}
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(want); err != nil {
		fail(err)
	}
}
