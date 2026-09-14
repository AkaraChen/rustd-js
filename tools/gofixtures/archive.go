package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

type ArchiveEntry struct {
	Name           string `json:"name"`
	Type           string `json:"type,omitempty"`
	Method         uint16 `json:"method,omitempty"`
	Size           int64  `json:"size"`
	Mode           int64  `json:"mode,omitempty"`
	Linkname       string `json:"linkname,omitempty"`
	Comment        string `json:"comment,omitempty"`
	CRC32          uint32 `json:"crc32,omitempty"`
	CompressedSize int64  `json:"compressedSize,omitempty"`
	NonUTF8        bool   `json:"nonUtf8,omitempty"`
	DataHex        string `json:"dataHex"`
	MtimeUnix      int64  `json:"mtimeUnix,omitempty"`
}

type ArchiveCase struct {
	ID         string         `json:"id"`
	Kind       string         `json:"kind"`
	ArchiveHex string         `json:"archiveHex"`
	Entries    []ArchiveEntry `json:"entries"`
}

type ArchivePacket struct {
	Schema  int           `json:"schema"`
	Package string        `json:"package"`
	Cases   []ArchiveCase `json:"cases"`
}

func tarType(flag byte) string {
	switch flag {
	case tar.TypeReg, tar.TypeRegA:
		return "reg"
	case tar.TypeDir:
		return "dir"
	case tar.TypeSymlink:
		return "symlink"
	case tar.TypeLink:
		return "hardlink"
	case tar.TypeChar:
		return "char"
	case tar.TypeBlock:
		return "block"
	case tar.TypeFifo:
		return "fifo"
	case tar.TypeXGlobalHeader:
		return "x-global-header"
	default:
		return string([]byte{flag})
	}
}

func writeTar(entries []ArchiveEntry) []byte {
	var buf bytes.Buffer
	w := tar.NewWriter(&buf)
	for _, e := range entries {
		data, err := hex.DecodeString(e.DataHex)
		if err != nil {
			fail(err)
		}
		hdr := &tar.Header{Name: e.Name, Size: int64(len(data)), Mode: e.Mode, ModTime: time.Unix(e.MtimeUnix, 0).UTC()}
		if hdr.Mode == 0 {
			hdr.Mode = 0o644
		}
		switch e.Type {
		case "dir":
			hdr.Typeflag = tar.TypeDir
			hdr.Size = 0
			data = nil
		case "symlink":
			hdr.Typeflag = tar.TypeSymlink
			hdr.Linkname = e.Linkname
			hdr.Size = 0
			data = nil
		case "hardlink":
			hdr.Typeflag = tar.TypeLink
			hdr.Linkname = e.Linkname
			hdr.Size = 0
			data = nil
		case "fifo":
			hdr.Typeflag = tar.TypeFifo
			hdr.Size = 0
			data = nil
		default:
			hdr.Typeflag = tar.TypeReg
		}
		if err := w.WriteHeader(hdr); err != nil {
			fail(err)
		}
		if len(data) > 0 {
			if _, err := w.Write(data); err != nil {
				fail(err)
			}
		}
	}
	if err := w.Close(); err != nil {
		fail(err)
	}
	return buf.Bytes()
}

func writeZip(entries []ArchiveEntry, method uint16, comment string) []byte {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	if comment != "" {
		w.SetComment(comment)
	}
	for _, e := range entries {
		data, err := hex.DecodeString(e.DataHex)
		if err != nil {
			fail(err)
		}
		hdr := &zip.FileHeader{Name: e.Name, Method: method, Comment: e.Comment}
		if e.MtimeUnix != 0 {
			hdr.Modified = time.Unix(e.MtimeUnix, 0).UTC()
		}
		if e.NonUTF8 {
			hdr.NonUTF8 = true
		}
		fw, err := w.CreateHeader(hdr)
		if err != nil {
			fail(err)
		}
		if _, err := fw.Write(data); err != nil {
			fail(err)
		}
	}
	if err := w.Close(); err != nil {
		fail(err)
	}
	return buf.Bytes()
}

func readTar(raw []byte) []ArchiveEntry {
	r := tar.NewReader(bytes.NewReader(raw))
	var out []ArchiveEntry
	for {
		hdr, err := r.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			fail(err)
		}
		data, err := io.ReadAll(r)
		if err != nil {
			fail(err)
		}
		out = append(out, ArchiveEntry{
			Name: hdr.Name, Type: tarType(hdr.Typeflag), Size: hdr.Size, Mode: hdr.Mode,
			Linkname: hdr.Linkname, DataHex: hex.EncodeToString(data), MtimeUnix: hdr.ModTime.Unix(),
		})
	}
	return out
}

func readZip(raw []byte) []ArchiveEntry {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		fail(err)
	}
	var out []ArchiveEntry
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			fail(err)
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			fail(err)
		}
		out = append(out, ArchiveEntry{
			Name: f.Name, Method: f.Method, Size: int64(f.UncompressedSize64),
			CompressedSize: int64(f.CompressedSize64), CRC32: f.CRC32, Comment: f.Comment,
			NonUTF8: f.NonUTF8, DataHex: hex.EncodeToString(data),
		})
	}
	return out
}

func hexData(s string) string { return hex.EncodeToString([]byte(s)) }

func craftedZip64() []byte {
	name := []byte("z64.txt")
	payload := []byte("zip64")
	var extra bytes.Buffer
	binary.Write(&extra, binary.LittleEndian, uint16(0x0001))
	binary.Write(&extra, binary.LittleEndian, uint16(16))
	binary.Write(&extra, binary.LittleEndian, uint64(len(payload)))
	binary.Write(&extra, binary.LittleEndian, uint64(len(payload)))
	var local bytes.Buffer
	binary.Write(&local, binary.LittleEndian, uint32(0x04034b50))
	binary.Write(&local, binary.LittleEndian, uint16(45))
	binary.Write(&local, binary.LittleEndian, uint16(1<<11))
	binary.Write(&local, binary.LittleEndian, uint16(0))
	binary.Write(&local, binary.LittleEndian, uint16(0))
	binary.Write(&local, binary.LittleEndian, uint16(0))
	crc := uint32(0x8c84722b) // will recompute below via zip writer path if needed
	_ = crc
	h := zipCRC(payload)
	binary.Write(&local, binary.LittleEndian, h)
	binary.Write(&local, binary.LittleEndian, uint32(0xffffffff))
	binary.Write(&local, binary.LittleEndian, uint32(0xffffffff))
	binary.Write(&local, binary.LittleEndian, uint16(len(name)))
	binary.Write(&local, binary.LittleEndian, uint16(extra.Len()))
	local.Write(name)
	local.Write(extra.Bytes())
	local.Write(payload)
	var cd bytes.Buffer
	binary.Write(&cd, binary.LittleEndian, uint32(0x02014b50))
	binary.Write(&cd, binary.LittleEndian, uint16(0x031d))
	binary.Write(&cd, binary.LittleEndian, uint16(45))
	binary.Write(&cd, binary.LittleEndian, uint16(1<<11))
	binary.Write(&cd, binary.LittleEndian, uint16(0))
	binary.Write(&cd, binary.LittleEndian, uint16(0))
	binary.Write(&cd, binary.LittleEndian, uint16(0))
	binary.Write(&cd, binary.LittleEndian, h)
	binary.Write(&cd, binary.LittleEndian, uint32(0xffffffff))
	binary.Write(&cd, binary.LittleEndian, uint32(0xffffffff))
	binary.Write(&cd, binary.LittleEndian, uint16(len(name)))
	binary.Write(&cd, binary.LittleEndian, uint16(extra.Len()))
	binary.Write(&cd, binary.LittleEndian, uint16(0))
	binary.Write(&cd, binary.LittleEndian, uint16(0))
	binary.Write(&cd, binary.LittleEndian, uint16(0))
	binary.Write(&cd, binary.LittleEndian, uint32(0))
	binary.Write(&cd, binary.LittleEndian, uint32(0))
	cd.Write(name)
	cd.Write(extra.Bytes())
	var out bytes.Buffer
	out.Write(local.Bytes())
	cdStart := out.Len()
	out.Write(cd.Bytes())
	cdSize := out.Len() - cdStart
	zip64Off := out.Len()
	binary.Write(&out, binary.LittleEndian, uint32(0x06064b50))
	binary.Write(&out, binary.LittleEndian, uint64(44))
	binary.Write(&out, binary.LittleEndian, uint16(45))
	binary.Write(&out, binary.LittleEndian, uint16(45))
	binary.Write(&out, binary.LittleEndian, uint32(0))
	binary.Write(&out, binary.LittleEndian, uint32(0))
	binary.Write(&out, binary.LittleEndian, uint64(1))
	binary.Write(&out, binary.LittleEndian, uint64(1))
	binary.Write(&out, binary.LittleEndian, uint64(cdSize))
	binary.Write(&out, binary.LittleEndian, uint64(cdStart))
	binary.Write(&out, binary.LittleEndian, uint32(0x07064b50))
	binary.Write(&out, binary.LittleEndian, uint32(0))
	binary.Write(&out, binary.LittleEndian, uint64(zip64Off))
	binary.Write(&out, binary.LittleEndian, uint32(1))
	binary.Write(&out, binary.LittleEndian, uint32(0x06054b50))
	binary.Write(&out, binary.LittleEndian, uint16(0))
	binary.Write(&out, binary.LittleEndian, uint16(0))
	binary.Write(&out, binary.LittleEndian, uint16(0xffff))
	binary.Write(&out, binary.LittleEndian, uint16(0xffff))
	binary.Write(&out, binary.LittleEndian, uint32(0xffffffff))
	binary.Write(&out, binary.LittleEndian, uint32(0xffffffff))
	binary.Write(&out, binary.LittleEndian, uint16(0))
	return out.Bytes()
}

func zipCRC(p []byte) uint32 {
	// IEEE CRC-32 (same polynomial zip uses).
	var table = make([]uint32, 256)
	const poly = 0xedb88320
	for i := uint32(0); i < 256; i++ {
		crc := i
		for j := 0; j < 8; j++ {
			if crc&1 != 0 {
				crc = poly ^ (crc >> 1)
			} else {
				crc >>= 1
			}
		}
		table[i] = crc
	}
	crc := uint32(0xffffffff)
	for _, b := range p {
		crc = table[(crc^uint32(b))&0xff] ^ (crc >> 8)
	}
	return crc ^ 0xffffffff
}

func generateArchive() ArchivePacket {
	mtime := int64(1_700_000_000)
	long := strings.Repeat("a", 120)
	deep := "d1/d2/d3/" + strings.Repeat("n", 80)
	packet := ArchivePacket{Schema: 1, Package: "archive"}
	addTar := func(id string, entries []ArchiveEntry) {
		raw := writeTar(entries)
		ents := readTar(raw)
		if ents == nil {
			ents = []ArchiveEntry{}
		}
		packet.Cases = append(packet.Cases, ArchiveCase{id, "tar", hex.EncodeToString(raw), ents})
	}
	addZip := func(id string, method uint16, comment string, entries []ArchiveEntry) {
		raw := writeZip(entries, method, comment)
		ents := readZip(raw)
		if ents == nil {
			ents = []ArchiveEntry{}
		}
		packet.Cases = append(packet.Cases, ArchiveCase{id, "zip", hex.EncodeToString(raw), ents})
	}
	addTar("tar-empty", nil)
	addTar("tar-one-file", []ArchiveEntry{{Name: "a.txt", Type: "reg", DataHex: hexData("hello"), Mode: 0o644, MtimeUnix: mtime}})
	addTar("tar-empty-file", []ArchiveEntry{{Name: "empty", Type: "reg", DataHex: "", Mode: 0o644, MtimeUnix: mtime}})
	addTar("tar-tree", []ArchiveEntry{
		{Name: "dir/", Type: "dir", DataHex: "", Mode: 0o755, MtimeUnix: mtime},
		{Name: "dir/b.txt", Type: "reg", DataHex: hexData("bee"), Mode: 0o644, MtimeUnix: mtime},
		{Name: "dir/c.txt", Type: "reg", DataHex: hexData("sea"), Mode: 0o600, MtimeUnix: mtime},
	})
	addTar("tar-symlink", []ArchiveEntry{
		{Name: "target", Type: "reg", DataHex: hexData("t"), Mode: 0o644, MtimeUnix: mtime},
		{Name: "link", Type: "symlink", Linkname: "target", DataHex: "", Mode: 0o777, MtimeUnix: mtime},
	})
	addTar("tar-hardlink", []ArchiveEntry{
		{Name: "orig", Type: "reg", DataHex: hexData("same"), Mode: 0o644, MtimeUnix: mtime},
		{Name: "alias", Type: "hardlink", Linkname: "orig", DataHex: "", Mode: 0o644, MtimeUnix: mtime},
	})
	addTar("tar-long-name", []ArchiveEntry{{Name: long + ".txt", Type: "reg", DataHex: hexData("L"), Mode: 0o644, MtimeUnix: mtime}})
	addTar("tar-deep-path", []ArchiveEntry{{Name: deep, Type: "reg", DataHex: hexData("D"), Mode: 0o644, MtimeUnix: mtime}})
	addTar("tar-utf8", []ArchiveEntry{{Name: "你好.txt", Type: "reg", DataHex: hexData("hi"), Mode: 0o644, MtimeUnix: mtime}})
	addTar("tar-255-name", []ArchiveEntry{{Name: strings.Repeat("n", 255), Type: "reg", DataHex: hexData("x"), Mode: 0o644, MtimeUnix: mtime}})
	addTar("tar-dup-names", []ArchiveEntry{
		{Name: "dup", Type: "reg", DataHex: hexData("1"), Mode: 0o644, MtimeUnix: mtime},
		{Name: "dup", Type: "reg", DataHex: hexData("2"), Mode: 0o644, MtimeUnix: mtime},
	})
	addTar("tar-fifo", []ArchiveEntry{{Name: "pipe", Type: "fifo", DataHex: "", Mode: 0o644, MtimeUnix: mtime}})
	addTar("tar-binary", []ArchiveEntry{{Name: "bin", Type: "reg", DataHex: hex.EncodeToString([]byte{0, 1, 2, 255, 10}), Mode: 0o755, MtimeUnix: mtime}})
	addZip("zip-empty", 0, "", nil)
	addZip("zip-store", 0, "", []ArchiveEntry{{Name: "s.txt", DataHex: hexData("store")}})
	addZip("zip-deflate", 8, "", []ArchiveEntry{{Name: "d.txt", DataHex: hexData("deflate me now")}})
	addZip("zip-comment", 8, "archive-comment", []ArchiveEntry{{Name: "c.txt", DataHex: hexData("c"), Comment: "entry"}})
	addZip("zip-dir", 0, "", []ArchiveEntry{{Name: "folder/", DataHex: ""}, {Name: "folder/f.txt", DataHex: hexData("in")}})
	addZip("zip-utf8", 8, "", []ArchiveEntry{{Name: "café.txt", DataHex: hexData("e")}})
	addZip("zip-tree", 8, "", []ArchiveEntry{
		{Name: "a/b/c.txt", DataHex: hexData("abc")},
		{Name: "a/d.txt", DataHex: hexData("ad")},
	})
	addZip("zip-empty-file", 0, "", []ArchiveEntry{{Name: "z", DataHex: ""}})
	addZip("zip-many", 8, "", []ArchiveEntry{
		{Name: "1", DataHex: hexData("one")}, {Name: "2", DataHex: hexData("two")}, {Name: "3", DataHex: hexData("three")},
	})
	raw64 := craftedZip64()
	packet.Cases = append(packet.Cases, ArchiveCase{"zip-zip64-crafted", "zip", hex.EncodeToString(raw64), readZip(raw64)})
	addZip("zip-dup", 0, "", []ArchiveEntry{{Name: "x", DataHex: hexData("a")}, {Name: "x", DataHex: hexData("b")}})
	addTar("tar-mode-exec", []ArchiveEntry{{Name: "run", Type: "reg", DataHex: hexData("#!"), Mode: 0o755, MtimeUnix: mtime}})
	addTar("tar-zero-mtime", []ArchiveEntry{{Name: "old", Type: "reg", DataHex: hexData("o"), Mode: 0o644, MtimeUnix: 0}})
	addZip("zip-long-name", 8, "", []ArchiveEntry{{Name: strings.Repeat("z", 180) + ".txt", DataHex: hexData("Z")}})
	addTar("tar-two-files", []ArchiveEntry{
		{Name: "one", Type: "reg", DataHex: hexData("1"), Mode: 0o644, MtimeUnix: mtime},
		{Name: "two", Type: "reg", DataHex: hexData("22"), Mode: 0o644, MtimeUnix: mtime},
	})
	addZip("zip-binary", 8, "", []ArchiveEntry{{Name: "b.bin", DataHex: hex.EncodeToString([]byte{0, 255, 1, 2})}})
	addTar("tar-spaces", []ArchiveEntry{{Name: "file with spaces.txt", Type: "reg", DataHex: hexData("sp"), Mode: 0o644, MtimeUnix: mtime}})
	if len(packet.Cases) < 30 {
		fail(fmt.Errorf("need 30+ fixtures, got %d", len(packet.Cases)))
	}
	return packet
}

func runArchive(out string, verify bool) {
	if verify {
		dec := json.NewDecoder(io.LimitReader(os.Stdin, 32<<20))
		var packet ArchivePacket
		if err := dec.Decode(&packet); err != nil {
			fail(err)
		}
		if packet.Schema != 1 || packet.Package != "archive" || len(packet.Cases) == 0 {
			fail(fmt.Errorf("invalid archive packet"))
		}
		for _, c := range packet.Cases {
			raw, err := hex.DecodeString(c.ArchiveHex)
			if err != nil {
				fail(err)
			}
			var got []ArchiveEntry
			if c.Kind == "tar" {
				got = readTar(raw)
			} else {
				got = readZip(raw)
			}
			if len(got) != len(c.Entries) {
				fail(fmt.Errorf("%s: entry count %d != %d", c.ID, len(got), len(c.Entries)))
			}
			for i, want := range c.Entries {
				g := got[i]
				if g.Name != want.Name || g.DataHex != want.DataHex {
					fail(fmt.Errorf("%s/%d: name/data mismatch want %s/%s got %s/%s", c.ID, i, want.Name, want.DataHex, g.Name, g.DataHex))
				}
			}
		}
		fmt.Printf("Go verified %d archive cases\n", len(packet.Cases))
		return
	}
	packet := generateArchive()
	var writer io.Writer = os.Stdout
	if out != "" {
		f, err := os.Create(out)
		if err != nil {
			fail(err)
		}
		defer f.Close()
		writer = f
	}
	if err := json.NewEncoder(writer).Encode(packet); err != nil {
		fail(err)
	}
}
