// Package fixture loads the golden files of contract/testdata for the tests.
// The files are written by contract/emit-fixtures.ts from the TypeScript that
// the board really runs; nothing in the Go module produces them. The package is
// imported by test files only and is not part of the binary.
package fixture

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Body is one recorded create body.
type Body struct {
	ID        string  `json:"id"`
	Form      string  `json:"form"`
	Name      string  `json:"name"`
	File      string  `json:"file"`
	MemoryMB  float64 `json:"memoryMb"`
	CPUs      float64 `json:"cpus"`
	PidsLimit int64   `json:"pidsLimit"`
	Image     string  `json:"image"`
	Nonce     string  `json:"nonce"`
}

// Archive is one recorded tar upload.
type Archive struct {
	ID        string `json:"id"`
	MountPath string `json:"mountPath"`
	Nonce     string `json:"nonce"`
	MTime     int64  `json:"mtime"`
	File      string `json:"file"`
}

// Manifest is manifest.json.
type Manifest struct {
	BotKey     string    `json:"botKey"`
	Image      string    `json:"image"`
	ImageID    string    `json:"imageId"`
	VolumeRoot string    `json:"volumeRoot"`
	Network    string    `json:"network"`
	Nonces     []string  `json:"nonces"`
	Bodies     []Body    `json:"bodies"`
	Archives   []Archive `json:"archives"`
}

// Record is one request of traffic.json.
type Record struct {
	Step       string            `json:"step"`
	Method     string            `json:"method"`
	Target     string            `json:"target"`
	Headers    map[string]string `json:"headers"`
	BodyBase64 string            `json:"bodyBase64"`
}

// RecordBody decodes the body of a record.
func (r Record) RecordBody(t testing.TB) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(r.BodyBase64)
	if err != nil {
		t.Fatalf("traffic body: %v", err)
	}
	return b
}

// Dir is contract/testdata, or the directory named by DOCKERGATE_CONTRACT_DIR:
// CI emits the fixtures afresh from the TypeScript of the same commit and runs
// the tests against them, so a change of the driver surface that the checked-in
// fixtures do not show still turns the tests red.
func Dir() string {
	if dir := os.Getenv("DOCKERGATE_CONTRACT_DIR"); dir != "" {
		return dir
	}
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "contract", "testdata")
}

// Read returns a file of the fixture directory.
func Read(t testing.TB, rel string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(Dir(), rel))
	if err != nil {
		t.Fatalf("fixture %s: %v", rel, err)
	}
	return data
}

// Load reads manifest.json.
func Load(t testing.TB) *Manifest {
	t.Helper()
	var m Manifest
	if err := json.Unmarshal(Read(t, "manifest.json"), &m); err != nil {
		t.Fatalf("manifest: %v", err)
	}
	return &m
}

// Traffic reads traffic.json.
func Traffic(t testing.TB) []Record {
	t.Helper()
	var recs []Record
	if err := json.Unmarshal(Read(t, "traffic.json"), &recs); err != nil {
		t.Fatalf("traffic: %v", err)
	}
	return recs
}

// Body reads the bytes of a recorded body.
func (m *Manifest) Body(t testing.TB, b Body) []byte { return Read(t, b.File) }

// FindBody returns the recorded body with the id and the name suffix
// ("", ".next" or ".helper").
func (m *Manifest) FindBody(t testing.TB, id, suffix string) (Body, []byte) {
	t.Helper()
	want := "myrmidon-bot-" + m.BotKey + suffix
	for _, b := range m.Bodies {
		if b.ID == id && b.Name == want {
			return b, Read(t, b.File)
		}
	}
	t.Fatalf("no recorded body %s%s", id, suffix)
	return Body{}, nil
}

// Script reads scripts/<name>.sh.
func Script(t testing.TB, name string) string {
	t.Helper()
	return string(Read(t, "scripts/"+name+".sh"))
}

// ArchiveBytes returns the bytes of a recorded tar.
func ArchiveBytes(t testing.TB, a Archive) []byte { return Read(t, a.File) }
