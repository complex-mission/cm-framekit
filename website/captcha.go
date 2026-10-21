package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// encryptSceneID builds Aliyun Captcha 2.0's EncryptedSceneId (encryption mode, V3):
// base64(IV ‖ AES-256-CBC-PKCS7("sceneId&timestamp&expireSeconds")), with a fresh random IV.
func encryptSceneID(sceneID string, ekey []byte, ttl time.Duration, now time.Time) (string, error) {
	if len(ekey) != 32 {
		return "", fmt.Errorf("ekey must be 32 bytes, got %d", len(ekey))
	}
	secs := int(ttl.Seconds())
	if secs < 1 || secs > 86400 {
		return "", fmt.Errorf("expire time must be 1..86400 seconds, got %d", secs)
	}
	plain := []byte(sceneID + "&" + strconv.FormatInt(now.Unix(), 10) + "&" + strconv.Itoa(secs))
	pad := aes.BlockSize - len(plain)%aes.BlockSize
	plain = append(plain, bytes.Repeat([]byte{byte(pad)}, pad)...)

	block, err := aes.NewCipher(ekey)
	if err != nil {
		return "", err
	}
	out := make([]byte, aes.BlockSize+len(plain))
	iv := out[:aes.BlockSize]
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(out[aes.BlockSize:], plain)
	return base64.StdEncoding.EncodeToString(out), nil
}

// handleCaptchaScene hands the download page a fresh EncryptedSceneId (encryption mode only).
func (a *App) handleCaptchaScene(w http.ResponseWriter, r *http.Request) {
	if !a.cfg.CaptchaEncrypt {
		jsonErr(w, http.StatusNotFound, "encryption mode is off")
		return
	}
	if !allow(r.Context(), a.kv, "scene", a.clientIP(r), a.cfg.RateScenePerMin, time.Minute) {
		jsonErr(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	// Aliyun rejects a timestamp later than its own clock; back off a few seconds for skew.
	id, err := encryptSceneID(a.cfg.CaptchaSceneID, a.cfg.captchaEKey, a.cfg.CaptchaEncryptTTL, time.Now().Add(-5*time.Second))
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, "captcha_config")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"EncryptedSceneId": id,
		"expires_in":       int(a.cfg.CaptchaEncryptTTL.Seconds()),
	})
}
