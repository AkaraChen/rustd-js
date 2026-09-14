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
	"os"
	"path/filepath"
)

type dump struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	ColorModel string `json:"colorModel"`
	Pix        string `json:"pix"`
	BytesHex   string `json:"bytesHex"`
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

	nrgba := sampleNRGBA()
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, nrgba); err != nil {
		panic(err)
	}
	pngBytes := pngBuf.Bytes()
	cfg, err := png.DecodeConfig(bytes.NewReader(pngBytes))
	if err != nil {
		panic(err)
	}
	decoded, err := png.Decode(bytes.NewReader(pngBytes))
	if err != nil {
		panic(err)
	}
	dumps = append(dumps, dump{
		Name: "nrgba8", Kind: "png", Width: cfg.Width, Height: cfg.Height,
		ColorModel: modelName(cfg.ColorModel), Pix: pixdump(decoded), BytesHex: hex(pngBytes),
	})

	gray := image.NewGray(image.Rect(0, 0, 4, 4))
	for i := 0; i < 16; i++ {
		gray.SetGray(i%4, i/4, color.Gray{Y: uint8(i * 16)})
	}
	pngBuf.Reset()
	if err := png.Encode(&pngBuf, gray); err != nil {
		panic(err)
	}
	pngBytes = pngBuf.Bytes()
	cfg, _ = png.DecodeConfig(bytes.NewReader(pngBytes))
	decoded, _ = png.Decode(bytes.NewReader(pngBytes))
	dumps = append(dumps, dump{
		Name: "gray8", Kind: "png", Width: cfg.Width, Height: cfg.Height,
		ColorModel: modelName(cfg.ColorModel), Pix: pixdump(decoded), BytesHex: hex(pngBytes),
	})

	var jpegBuf bytes.Buffer
	if err := jpeg.Encode(&jpegBuf, nrgba, &jpeg.Options{Quality: 75}); err != nil {
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
		Name: "q75", Kind: "jpeg", Width: jcfg.Width, Height: jcfg.Height,
		ColorModel: modelName(jcfg.ColorModel), Pix: pixdump(jdec), BytesHex: hex(jpegBytes),
	})

	pal := image.NewPaletted(image.Rect(0, 0, 8, 8), palette.Plan9)
	draw.Draw(pal, pal.Bounds(), nrgba, image.Point{}, draw.Src)
	var gifBuf bytes.Buffer
	if err := gif.Encode(&gifBuf, pal, nil); err != nil {
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
		Name: "plan9", Kind: "gif", Width: gcfg.Width, Height: gcfg.Height,
		ColorModel: modelName(gcfg.ColorModel), Pix: pixdump(gdec), BytesHex: hex(gifBytes),
	})

	// Palette index table for 8 probe colors.
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

	// Draw Over/Src fixtures: dst RGBA filled, src NRGBA.
	dst := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			dst.SetRGBA(x, y, color.RGBA{R: 0, G: 0, B: 255, A: 255})
		}
	}
	src := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			src.SetNRGBA(x, y, color.NRGBA{R: 255, G: 0, B: 0, A: 128})
		}
	}
	over := image.NewRGBA(image.Rect(0, 0, 4, 4))
	draw.Draw(over, over.Bounds(), dst, image.Point{}, draw.Src)
	draw.Draw(over, over.Bounds(), src, image.Point{}, draw.Over)
	srcOp := image.NewRGBA(image.Rect(0, 0, 4, 4))
	draw.Draw(srcOp, srcOp.Bounds(), dst, image.Point{}, draw.Src)
	draw.Draw(srcOp, srcOp.Bounds(), src, image.Point{}, draw.Src)

	extra := map[string]any{
		"plan9Index": indexes,
		"drawOver":   pixdump(over),
		"drawSrc":    pixdump(srcOp),
	}

	payload := map[string]any{"fixtures": dumps, "extra": extra}
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(outDir, "go-fixtures.json"), raw, 0o644); err != nil {
		panic(err)
	}
}
