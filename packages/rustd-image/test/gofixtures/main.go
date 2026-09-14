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
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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

func main() {
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
