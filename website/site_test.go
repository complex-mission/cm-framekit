package main

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestCmpVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"2.0.0", "2.0.0", 0},
		{"2.0.1", "2.0.0", 1},
		{"2.10.0", "2.9.9", 1},
		{"v2.1.0", "2.1.0", 0},
		{"2.1.0-beta.1", "2.1.0", -1},
		{"2.1.0-beta.2", "2.1.0-beta.10", -1},
		{"2.1.0-rc.1", "2.1.0-beta.9", 1},
		{"garbage", "0.0.1", -1},
		{"1.0.0", "", 1},
	}
	for _, c := range cases {
		if got := sign(cmpVersion(c.a, c.b)); got != c.want {
			t.Errorf("cmpVersion(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func sign(n int) int {
	switch {
	case n > 0:
		return 1
	case n < 0:
		return -1
	}
	return 0
}

func TestRenderNotesEscapes(t *testing.T) {
	got := string(renderNotes("## 新增\n- <b>x</b>\n- y\n\nplain"))
	want := "<h4>新增</h4><ul><li>&lt;b&gt;x&lt;/b&gt;</li><li>y</li></ul><p>plain</p>"
	if got != want {
		t.Fatalf("got %s\nwant %s", got, want)
	}
}

func TestSafeFileName(t *testing.T) {
	if got := safeFileName(`C:\x\CM FrameKit_2.1.0_x64-setup.exe`, "2.1.0", "windows-x64"); got != "CM_FrameKit_2.1.0_x64-setup.exe" {
		t.Fatal(got)
	}
	if got := safeFileName("../../", "2.1.0", "windows-x64"); !strings.HasPrefix(got, "CM-FrameKit_2.1.0") {
		t.Fatal(got)
	}
}

func TestNormPhone(t *testing.T) {
	a := &App{cfg: &Config{AdminPhone: "13800138000"}}
	for _, p := range []string{"13800138000", "+86 138-0013-8000", "8613800138000"} {
		if !a.isAdminPhone(p) {
			t.Errorf("%q should match", p)
		}
	}
	if a.isAdminPhone("13800138001") || a.isAdminPhone("") {
		t.Error("wrong number matched")
	}
}

func TestPopEncode(t *testing.T) {
	if got := popEncode("a b*~/"); got != "a%20b%2A~%2F" {
		t.Fatal(got)
	}
}

func TestEncryptSceneIDRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	now := time.Unix(1712345678, 0)
	a, err := encryptSceneID("sdewfwe", key, time.Hour, now)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := encryptSceneID("sdewfwe", key, time.Hour, now)
	if a == b {
		t.Fatal("IV must be random per call")
	}
	raw, err := base64.StdEncoding.DecodeString(a)
	if err != nil || len(raw)%aes.BlockSize != 0 || len(raw) < 2*aes.BlockSize {
		t.Fatalf("bad layout: %v len=%d", err, len(raw))
	}
	block, _ := aes.NewCipher(key)
	plain := make([]byte, len(raw)-aes.BlockSize)
	cipher.NewCBCDecrypter(block, raw[:aes.BlockSize]).CryptBlocks(plain, raw[aes.BlockSize:])
	pad := int(plain[len(plain)-1])
	if got := string(plain[:len(plain)-pad]); got != "sdewfwe&1712345678&3600" {
		t.Fatalf("plaintext %q", got)
	}
	if _, err := encryptSceneID("x", key[:16], time.Hour, now); err == nil {
		t.Fatal("short key accepted")
	}
	if _, err := encryptSceneID("x", key, 48*time.Hour, now); err == nil {
		t.Fatal("ttl over 24h accepted")
	}
}
