package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/color/palette"
	"image/draw"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type dump struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	ColorModel string `json:"colorModel"`
	Pix        string `json:"pix"`
	BytesHex   string `json:"bytesHex"`
	Interlace  bool   `json:"interlace,omitempty"`
}

type gifFrame struct {
	Pix              string `json:"pix"`
	Width            int    `json:"width"`
	Height           int    `json:"height"`
	MinX             int    `json:"minX"`
	MinY             int    `json:"minY"`
	Delay            int    `json:"delay"`
	Disposal         byte   `json:"disposal"`
	Palette          string `json:"palette"`
	TransparentIndex int    `json:"transparentIndex"`
}

func modelName(m color.Model) string {
	switch m {
	case color.RGBAModel:
		return "rgba"
	case color.RGBA64Model:
		return "rgba64"
	case color.NRGBAModel:
		return "nrgba"
	case color.NRGBA64Model:
		return "nrgba64"
	case color.AlphaModel:
		return "alpha"
	case color.Alpha16Model:
		return "alpha16"
	case color.GrayModel:
		return "gray"
	case color.Gray16Model:
		return "gray16"
	case color.YCbCrModel:
		return "ycbcr"
	case color.CMYKModel:
		return "cmyk"
	default:
		if _, ok := m.(color.Palette); ok {
			return "paletted"
		}
		return "unknown"
	}
}

func pixdump(img image.Image) string {
	b := img.Bounds()
	out := make([]byte, 0, b.Dx()*b.Dy()*16)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, a := img.At(x, y).RGBA()
			out = append(out, fmt.Sprintf("%04x%04x%04x%04x", r, g, bl, a)...)
		}
	}
	return string(out)
}

func hex(b []byte) string {
	return fmt.Sprintf("%x", b)
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func dumpGifDecoded(raw []byte) map[string]any {
	gall, err := gif.DecodeAll(bytes.NewReader(raw))
	if err != nil {
		panic(err)
	}
	var frames []gifFrame
	for i, fr := range gall.Image {
		tr := -1
		for pi, c := range fr.Palette {
			if n, ok := c.(color.NRGBA); ok && n.A == 0 {
				tr = pi
				break
			}
		}
		palHex := ""
		for _, c := range fr.Palette {
			r, g, b, a := c.RGBA()
			palHex += fmt.Sprintf("%02x%02x%02x%02x", r>>8, g>>8, b>>8, a>>8)
		}
		disp := byte(0)
		if i < len(gall.Disposal) {
			disp = gall.Disposal[i]
		}
		dly := 0
		if i < len(gall.Delay) {
			dly = gall.Delay[i]
		}
		frames = append(frames, gifFrame{
			Pix:              pixdump(fr),
			Width:            fr.Bounds().Dx(),
			Height:           fr.Bounds().Dy(),
			MinX:             fr.Bounds().Min.X,
			MinY:             fr.Bounds().Min.Y,
			Delay:            dly,
			Disposal:         disp,
			Palette:          palHex,
			TransparentIndex: tr,
		})
	}
	return map[string]any{
		"bytesHex":         hex(raw),
		"loopCount":        gall.LoopCount,
		"backgroundIndex":  gall.BackgroundIndex,
		"width":            gall.Config.Width,
		"height":           gall.Config.Height,
		"frames":           frames,
	}
}

func stripJPEGDht(b []byte) []byte {
	out := make([]byte, 0, len(b))
	i := 0
	if len(b) >= 2 {
		out = append(out, b[0], b[1])
		i = 2
	}
	for i < len(b) {
		if b[i] != 0xff {
			out = append(out, b[i])
			i++
			continue
		}
		j := i
		for j < len(b) && b[j] == 0xff {
			j++
		}
		if j >= len(b) {
			out = append(out, b[i:]...)
			break
		}
		marker := b[j]
		if marker == 0xd8 || marker == 0xd9 || (marker >= 0xd0 && marker <= 0xd7) {
			out = append(out, b[i:j+1]...)
			i = j + 1
			continue
		}
		if j+2 >= len(b) {
			out = append(out, b[i:]...)
			break
		}
		n := int(b[j+1])<<8 | int(b[j+2])
		end := j + 1 + n
		if end > len(b) {
			out = append(out, b[i:]...)
			break
		}
		if marker == 0xc4 {
			i = end
			continue
		}
		out = append(out, b[i:end]...)
		i = end
	}
	return out
}

func dumpPNGFile(path, name string) dump {
	raw, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		panic(fmt.Errorf("%s config: %w", name, err))
	}
	decoded, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		panic(fmt.Errorf("%s decode: %w", name, err))
	}
	return dump{
		Name:       name,
		Kind:       "png",
		Width:      cfg.Width,
		Height:     cfg.Height,
		ColorModel: modelName(cfg.ColorModel),
		Pix:        pixdump(decoded),
		BytesHex:   hex(raw),
		Interlace:  strings.Contains(name, "interlace") || strings.Contains(name, "interlaced"),
	}
}

func sampleNRGBA() *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 32), G: uint8(y * 32), B: 128, A: 255})
		}
	}
	img.SetNRGBA(0, 0, color.NRGBA{R: 255, G: 0, B: 0, A: 128})
	return img
}

func timeIters(iters int, fn func()) float64 {
	start := time.Now()
	for i := 0; i < iters; i++ {
		fn()
	}
	return float64(time.Since(start).Nanoseconds()) / 1e6
}

func runDecode() {
	if len(os.Args) < 4 {
		panic("usage: go run ./gofixtures -decode png|jpeg|gif <file>")
	}
	kind := os.Args[2]
	raw, err := os.ReadFile(os.Args[3])
	if err != nil {
		panic(err)
	}
	r := bytes.NewReader(raw)
	var cfg image.Config
	var img image.Image
	switch kind {
	case "png":
		cfg, err = png.DecodeConfig(r)
		if err != nil {
			panic(err)
		}
		r.Reset(raw)
		img, err = png.Decode(r)
	case "jpeg":
		cfg, err = jpeg.DecodeConfig(r)
		if err != nil {
			panic(err)
		}
		r.Reset(raw)
		img, err = jpeg.Decode(r)
	case "gif":
		cfg, err = gif.DecodeConfig(r)
		if err != nil {
			panic(err)
		}
		r.Reset(raw)
		img, err = gif.Decode(r)
	default:
		panic("unknown kind " + kind)
	}
	if err != nil {
		panic(err)
	}
	out := map[string]any{
		"width":      cfg.Width,
		"height":     cfg.Height,
		"colorModel": modelName(cfg.ColorModel),
		"pix":        pixdump(img),
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		panic(err)
	}
}

func runBench() {
	const w, h, iters = 512, 512, 8
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	rng := rand.New(rand.NewSource(1))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, color.NRGBA{
				R: uint8(rng.Intn(256)),
				G: uint8(rng.Intn(256)),
				B: uint8(rng.Intn(256)),
				A: 255,
			})
		}
	}
	var pngBuf, jpegBuf bytes.Buffer
	if err := png.Encode(&pngBuf, img); err != nil {
		panic(err)
	}
	if err := jpeg.Encode(&jpegBuf, img, &jpeg.Options{Quality: 75}); err != nil {
		panic(err)
	}
	pngBytes := pngBuf.Bytes()
	jpegBytes := jpegBuf.Bytes()
	if _, err := png.Decode(bytes.NewReader(pngBytes)); err != nil {
		panic(err)
	}
	if _, err := jpeg.Decode(bytes.NewReader(jpegBytes)); err != nil {
		panic(err)
	}
	if err := png.Encode(io.Discard, img); err != nil {
		panic(err)
	}
	if err := jpeg.Encode(io.Discard, img, &jpeg.Options{Quality: 75}); err != nil {
		panic(err)
	}
	pngDecodeMs := timeIters(iters, func() {
		if _, err := png.Decode(bytes.NewReader(pngBytes)); err != nil {
			panic(err)
		}
	})
	jpegDecodeMs := timeIters(iters, func() {
		if _, err := jpeg.Decode(bytes.NewReader(jpegBytes)); err != nil {
			panic(err)
		}
	})
	pngEncodeMs := timeIters(iters, func() {
		if err := png.Encode(io.Discard, img); err != nil {
			panic(err)
		}
	})
	jpegEncodeMs := timeIters(iters, func() {
		if err := jpeg.Encode(io.Discard, img, &jpeg.Options{Quality: 75}); err != nil {
			panic(err)
		}
	})
	out := map[string]any{
		"go":           runtime.Version(),
		"width":        w,
		"height":       h,
		"iters":        iters,
		"pngBytes":     len(pngBytes),
		"jpegBytes":    len(jpegBytes),
		"pngDecodeMs":  pngDecodeMs,
		"jpegDecodeMs": jpegDecodeMs,
		"pngEncodeMs":  pngEncodeMs,
		"jpegEncodeMs": jpegEncodeMs,
		"pngHex":       hex(pngBytes),
		"jpegHex":      hex(jpegBytes),
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		panic(err)
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "-bench" {
		runBench()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "-decode" {
		runDecode()
		return
	}
	outDir := "."
	if len(os.Args) > 1 {
		outDir = os.Args[1]
	}
	_ = os.MkdirAll(outDir, 0o755)
	var dumps []dump

	root := os.Getenv("GOROOT")
	if root == "" {
		root = runtime.GOROOT()
	}
	if root == "" {
		panic("GOROOT is empty; set it so png testdata can be read")
	}
	pngDir := filepath.Join(root, "src/image/png/testdata")
	suite := filepath.Join(pngDir, "pngsuite")
	entries, err := os.ReadDir(suite)
	if err != nil {
		panic(err)
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".png") {
			continue
		}
		dumps = append(dumps, dumpPNGFile(filepath.Join(suite, e.Name()), e.Name()))
	}
	for _, extra := range []string{"gray-gradient.png", "gray-gradient.interlaced.png", "benchRGB-interlace.png"} {
		dumps = append(dumps, dumpPNGFile(filepath.Join(pngDir, extra), extra))
	}

	one := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	one.SetNRGBA(0, 0, color.NRGBA{R: 10, G: 20, B: 30, A: 255})
	mono := image.NewGray(image.Rect(0, 0, 2, 2))
	mono.SetGray(0, 0, color.Gray{Y: 128})
	mono.SetGray(1, 1, color.Gray{Y: 255})
	clear := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	for _, bound := range []struct {
		name string
		img  image.Image
	}{
		{"bound-1x1.png", one},
		{"bound-gray-2x2.png", mono},
		{"bound-transparent-2x2.png", clear},
	} {
		var pbuf bytes.Buffer
		if err := png.Encode(&pbuf, bound.img); err != nil {
			panic(err)
		}
		raw := pbuf.Bytes()
		cfg, err := png.DecodeConfig(bytes.NewReader(raw))
		if err != nil {
			panic(err)
		}
		dec, err := png.Decode(bytes.NewReader(raw))
		if err != nil {
			panic(err)
		}
		dumps = append(dumps, dump{
			Name:       bound.name,
			Kind:       "png",
			Width:      cfg.Width,
			Height:     cfg.Height,
			ColorModel: modelName(cfg.ColorModel),
			Pix:        pixdump(dec),
			BytesHex:   hex(raw),
		})
	}

	nrgba := sampleNRGBA()
	for _, q := range []int{1, 50, 75, 100} {
		var jpegBuf bytes.Buffer
		if err := jpeg.Encode(&jpegBuf, nrgba, &jpeg.Options{Quality: q}); err != nil {
			panic(err)
		}
		jpegBytes := jpegBuf.Bytes()
		jcfg, err := jpeg.DecodeConfig(bytes.NewReader(jpegBytes))
		if err != nil {
			panic(err)
		}
		jdec, err := jpeg.Decode(bytes.NewReader(jpegBytes))
		if err != nil {
			panic(err)
		}
		dumps = append(dumps, dump{
			Name:       fmt.Sprintf("q%d", q),
			Kind:       "jpeg",
			Width:      jcfg.Width,
			Height:     jcfg.Height,
			ColorModel: modelName(jcfg.ColorModel),
			Pix:        pixdump(jdec),
			BytesHex:   hex(jpegBytes),
		})
	}

	f1 := image.NewPaletted(image.Rect(0, 0, 8, 8), palette.Plan9)
	f2 := image.NewPaletted(image.Rect(0, 0, 8, 8), palette.Plan9)
	draw.Draw(f1, f1.Bounds(), nrgba, image.Point{}, draw.Src)
	src2 := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			src2.SetNRGBA(x, y, color.NRGBA{R: 0, G: uint8(x * 30), B: uint8(y * 30), A: 255})
		}
	}
	draw.Draw(f2, f2.Bounds(), src2, image.Point{}, draw.Src)
	anim := gif.GIF{
		Image:     []*image.Paletted{f1, f2},
		Delay:     []int{10, 20},
		LoopCount: 3,
		Disposal:  []byte{gif.DisposalNone, gif.DisposalBackground},
		Config:    image.Config{ColorModel: color.Palette(palette.Plan9), Width: 8, Height: 8},
	}
	var gifBuf bytes.Buffer
	if err := gif.EncodeAll(&gifBuf, &anim); err != nil {
		panic(err)
	}
	gifBytes := gifBuf.Bytes()
	gcfg, err := gif.DecodeConfig(bytes.NewReader(gifBytes))
	if err != nil {
		panic(err)
	}
	gdec, err := gif.Decode(bytes.NewReader(gifBytes))
	if err != nil {
		panic(err)
	}
	dumps = append(dumps, dump{
		Name:       "twoframe",
		Kind:       "gif",
		Width:      gcfg.Width,
		Height:     gcfg.Height,
		ColorModel: modelName(gcfg.ColorModel),
		Pix:        pixdump(gdec),
		BytesHex:   hex(gifBytes),
	})
	gall, err := gif.DecodeAll(bytes.NewReader(gifBytes))
	if err != nil {
		panic(err)
	}
	var gframes []gifFrame
	for i, fr := range gall.Image {
		tr := -1
		for pi, c := range fr.Palette {
			if n, ok := c.(color.NRGBA); ok && n.A == 0 {
				tr = pi
				break
			}
		}
		palHex := ""
		for _, c := range fr.Palette {
			r, g, b, a := c.RGBA()
			palHex += fmt.Sprintf("%02x%02x%02x%02x", r>>8, g>>8, b>>8, a>>8)
		}
		disp := byte(0)
		if i < len(gall.Disposal) {
			disp = gall.Disposal[i]
		}
		dly := 0
		if i < len(gall.Delay) {
			dly = gall.Delay[i]
		}
		gframes = append(gframes, gifFrame{
			Pix:              pixdump(fr),
			Width:            fr.Bounds().Dx(),
			Height:           fr.Bounds().Dy(),
			MinX:             fr.Bounds().Min.X,
			MinY:             fr.Bounds().Min.Y,
			Delay:            dly,
			Disposal:         disp,
			Palette:          palHex,
			TransparentIndex: tr,
		})
	}

	type idx struct {
		R     uint32 `json:"r"`
		G     uint32 `json:"g"`
		B     uint32 `json:"b"`
		A     uint32 `json:"a"`
		Index int    `json:"index"`
	}
	var indexes []idx
	probes := []color.NRGBA{
		{0, 0, 0, 255}, {255, 255, 255, 255}, {255, 0, 0, 255}, {0, 255, 0, 255},
		{0, 0, 255, 255}, {128, 128, 128, 255}, {255, 128, 0, 255}, {10, 20, 30, 40},
	}
	for _, p := range probes {
		r, g, b, a := p.RGBA()
		indexes = append(indexes, idx{R: r, G: g, B: b, A: a, Index: color.Palette(palette.Plan9).Index(p)})
	}

	dst := image.NewRGBA(image.Rect(0, 0, 4, 4))
	src := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			dst.SetRGBA(x, y, color.RGBA{R: 0, G: 0, B: 255, A: 255})
			src.SetNRGBA(x, y, color.NRGBA{R: 255, G: 0, B: 0, A: 128})
		}
	}
	over := image.NewRGBA(image.Rect(0, 0, 4, 4))
	draw.Draw(over, over.Bounds(), dst, image.Point{}, draw.Src)
	draw.Draw(over, over.Bounds(), src, image.Point{}, draw.Over)
	srcOp := image.NewRGBA(image.Rect(0, 0, 4, 4))
	draw.Draw(srcOp, srcOp.Bounds(), dst, image.Point{}, draw.Src)
	draw.Draw(srcOp, srcOp.Bounds(), src, image.Point{}, draw.Src)

	maskDst := image.NewRGBA(image.Rect(0, 0, 8, 8))
	maskSrc := sampleNRGBA()
	mask := image.NewAlpha(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			maskDst.SetRGBA(x, y, color.RGBA{R: 0, G: 0, B: 255, A: 255})
			mask.SetAlpha(x, y, color.Alpha{A: uint8((x + y) * 16)})
		}
	}
	maskOver := image.NewRGBA(image.Rect(0, 0, 8, 8))
	draw.Draw(maskOver, maskOver.Bounds(), maskDst, image.Point{}, draw.Src)
	draw.DrawMask(maskOver, maskOver.Bounds(), maskSrc, image.Point{}, mask, image.Point{}, draw.Over)
	maskSrcOp := image.NewRGBA(image.Rect(0, 0, 8, 8))
	draw.Draw(maskSrcOp, maskSrcOp.Bounds(), maskDst, image.Point{}, draw.Src)
	draw.DrawMask(maskSrcOp, maskSrcOp.Bounds(), maskSrc, image.Point{}, mask, image.Point{}, draw.Src)

	grad := image.NewNRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			grad.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 16), G: uint8(y * 16), B: uint8((x + y) * 8), A: 255})
		}
	}
	floydPlan9 := image.NewPaletted(grad.Bounds(), palette.Plan9)
	draw.FloydSteinberg.Draw(floydPlan9, floydPlan9.Bounds(), grad, image.Point{})
	floydWeb := image.NewPaletted(grad.Bounds(), palette.WebSafe)
	draw.FloydSteinberg.Draw(floydWeb, floydWeb.Bounds(), grad, image.Point{})
	srcPlan9 := image.NewPaletted(grad.Bounds(), palette.Plan9)
	draw.Draw(srcPlan9, srcPlan9.Bounds(), grad, image.Point{}, draw.Src)

	crcRaw, err := os.ReadFile(filepath.Join(pngDir, "invalid-crc32.png"))
	if err != nil {
		panic(err)
	}
	_, crcErr := png.Decode(bytes.NewReader(crcRaw))
	_, crcCfgErr := png.DecodeConfig(bytes.NewReader(crcRaw))
	zlibRaw, err := os.ReadFile(filepath.Join(pngDir, "invalid-zlib.png"))
	if err != nil {
		panic(err)
	}
	_, zlibErr := png.Decode(bytes.NewReader(zlibRaw))
	zcfg, zcfgErr := png.DecodeConfig(bytes.NewReader(zlibRaw))

	var j75 bytes.Buffer
	if err := jpeg.Encode(&j75, nrgba, &jpeg.Options{Quality: 75}); err != nil {
		panic(err)
	}
	noDht := stripJPEGDht(j75.Bytes())
	_, jpegErr := jpeg.Decode(bytes.NewReader(noDht))
	jcfgNo, jcfgErr := jpeg.DecodeConfig(bytes.NewReader(noDht))

	singleGif := gif.GIF{Image: []*image.Paletted{f1}, Delay: []int{10}, LoopCount: 1}
	var singleBuf bytes.Buffer
	if err := gif.EncodeAll(&singleBuf, &singleGif); err != nil {
		panic(err)
	}

	loop1Gif := gif.GIF{
		Image:     []*image.Paletted{f1, f2},
		Delay:     []int{10, 20},
		LoopCount: 1,
		Disposal:  []byte{gif.DisposalNone, gif.DisposalPrevious},
		Config:    image.Config{ColorModel: color.Palette(palette.Plan9), Width: 8, Height: 8},
	}
	var loop1Buf bytes.Buffer
	if err := gif.EncodeAll(&loop1Buf, &loop1Gif); err != nil {
		panic(err)
	}

	cycleGif := gif.GIF{
		Image:     []*image.Paletted{f1, f2},
		Delay:     []int{10, 10},
		LoopCount: 0,
		Disposal:  []byte{gif.DisposalPrevious, gif.DisposalPrevious},
		Config:    image.Config{ColorModel: color.Palette(palette.Plan9), Width: 8, Height: 8},
	}
	var cycleBuf bytes.Buffer
	if err := gif.EncodeAll(&cycleBuf, &cycleGif); err != nil {
		panic(err)
	}

	var gif256, gif300 bytes.Buffer
	if err := gif.Encode(&gif256, nrgba, &gif.Options{NumColors: 256}); err != nil {
		panic(err)
	}
	if err := gif.Encode(&gif300, nrgba, &gif.Options{NumColors: 300}); err != nil {
		panic(err)
	}
	g256, err := gif.Decode(bytes.NewReader(gif256.Bytes()))
	if err != nil {
		panic(err)
	}
	g300, err := gif.Decode(bytes.NewReader(gif300.Bytes()))
	if err != nil {
		panic(err)
	}

	officialLoop1 := []byte("GIF89a000\x00000" +
		"!\xff\vNETSCAPE2.0\x03\x01\x01\x00\x00" +
		",0\x00\x00\x00\n\x00\n\x00\x80000000" +
		"\x02\b\xf01u\xb9\xfdal\x05\x00" +
		",0\x00\x00\x00\n\x00\n\x00\x80000000" +
		"\x02\b\xf01u\xb9\xfdal\x05\x00;")

	rng := rand.New(rand.NewSource(1))
	var plan9Rand []idx
	var webRand []idx
	for i := 0; i < 1024; i++ {
		c := color.NRGBA{
			R: uint8(rng.Intn(256)),
			G: uint8(rng.Intn(256)),
			B: uint8(rng.Intn(256)),
			A: uint8(rng.Intn(256)),
		}
		r, g, b, a := c.RGBA()
		plan9Rand = append(plan9Rand, idx{R: r, G: g, B: b, A: a, Index: color.Palette(palette.Plan9).Index(c)})
		webRand = append(webRand, idx{R: r, G: g, B: b, A: a, Index: color.Palette(palette.WebSafe).Index(c)})
	}

	extra := map[string]any{
		"plan9Index":        indexes,
		"plan9IndexRandom":  plan9Rand,
		"webSafeIndexRandom": webRand,
		"drawOver":          pixdump(over),
		"drawSrc":           pixdump(srcOp),
		"drawMaskOver":      pixdump(maskOver),
		"drawMaskSrc":       pixdump(maskSrcOp),
		"floydPlan9":        pixdump(floydPlan9),
		"floydPlan9Pix":     hex(floydPlan9.Pix),
		"floydWebSafe":      pixdump(floydWeb),
		"floydWebSafePix":   hex(floydWeb.Pix),
		"quantSrcPlan9":     pixdump(srcPlan9),
		"quantSrcPlan9Pix":  hex(srcPlan9.Pix),
		"gifAll": map[string]any{
			"loopCount":       gall.LoopCount,
			"backgroundIndex": gall.BackgroundIndex,
			"frames":          gframes,
		},
		"pngCrcError": map[string]any{
			"bytesHex":    hex(crcRaw),
			"decodeError": errString(crcErr),
			"configError": errString(crcCfgErr),
		},
		"pngZlibError": map[string]any{
			"bytesHex":    hex(zlibRaw),
			"decodeError": errString(zlibErr),
			"configError": errString(zcfgErr),
			"width":       zcfg.Width,
			"height":      zcfg.Height,
			"colorModel":  modelName(zcfg.ColorModel),
		},
		"jpegNoDht": map[string]any{
			"bytesHex":    hex(noDht),
			"decodeError": errString(jpegErr),
			"configError": errString(jcfgErr),
			"width":       jcfgNo.Width,
			"height":      jcfgNo.Height,
			"colorModel":  modelName(jcfgNo.ColorModel),
		},
		"gifSingle":     dumpGifDecoded(singleBuf.Bytes()),
		"gifLoop1":      dumpGifDecoded(loop1Buf.Bytes()),
		"gifCycle":      dumpGifDecoded(cycleBuf.Bytes()),
		"gifOfficialLoop1": dumpGifDecoded(officialLoop1),
		"gifNumColors256": map[string]any{
			"pix":     pixdump(g256),
			"palLen":  len(g256.(*image.Paletted).Palette),
			"bytesHex": hex(gif256.Bytes()),
		},
		"gifNumColors300": map[string]any{
			"pix":     pixdump(g300),
			"palLen":  len(g300.(*image.Paletted).Palette),
			"bytesHex": hex(gif300.Bytes()),
		},
	}

	payload := map[string]any{"fixtures": dumps, "extra": extra}
	raw, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(outDir, "go-fixtures.json"), raw, 0o644); err != nil {
		panic(err)
	}
	fmt.Fprintf(os.Stderr, "wrote %d fixtures to %s\n", len(dumps), filepath.Join(outDir, "go-fixtures.json"))
}
