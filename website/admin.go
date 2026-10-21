package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const sessionCookie = "fk_sess"

func normPhone(p string) string {
	p = strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, p)
	if len(p) == 13 && strings.HasPrefix(p, "86") {
		p = p[2:]
	}
	return p
}

func (a *App) isAdminPhone(p string) bool {
	return subtle.ConstantTimeCompare([]byte(normPhone(p)), []byte(normPhone(a.cfg.AdminPhone))) == 1
}

func sessionKey(token string) string {
	h := sha256.Sum256([]byte(token))
	return "sess:" + hex.EncodeToString(h[:])
}

func (a *App) authed(r *http.Request) bool {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return false
	}
	_, ok, _ := a.kv.Get(r.Context(), sessionKey(c.Value))
	return ok
}

// sameOrigin rejects cross-site POSTs (cookie is SameSite=Strict too).
func (a *App) sameOrigin(r *http.Request) bool {
	if r.Header.Get("X-FK-Admin") != "1" {
		return false
	}
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	return err == nil && u.Host == r.Host
}

func (a *App) adminPost(h http.HandlerFunc, needAuth bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.sameOrigin(r) {
			jsonErr(w, http.StatusForbidden, "forbidden")
			return
		}
		if needAuth && !a.authed(r) {
			jsonErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		h(w, r)
	}
}

func (a *App) adminGet(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.authed(r) {
			jsonErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		h(w, r)
	}
}

func (a *App) handleAdmin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Robots-Tag", "noindex")
	if !a.authed(r) {
		a.render(w, r, "admin_login", nil)
		return
	}
	a.render(w, r, "admin", map[string]any{"Platforms": platforms, "Storage": a.storage.Name(), "KV": a.kv.Name()})
}

func (a *App) handleOTP(w http.ResponseWriter, r *http.Request) {
	var in struct{ Phone string }
	json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in)
	ctx := r.Context()
	if !allow(ctx, a.kv, "otp", a.clientIP(r), a.cfg.RateOTPPer10Min, 10*time.Minute) {
		a.log(r, "login.otp", false, "rate limited")
		jsonErr(w, http.StatusTooManyRequests, "请求过于频繁，请稍后再试")
		return
	}
	// The answer is the same for a wrong number, so the admin number cannot be probed.
	if !a.isAdminPhone(in.Phone) {
		a.log(r, "login.otp", false, "not admin phone "+maskPhone(normPhone(in.Phone)))
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	if _, cooling, _ := a.kv.Get(ctx, "otp:cool"); cooling {
		jsonErr(w, http.StatusTooManyRequests, "验证码已发送，请 60 秒后再试")
		return
	}
	n, _ := rand.Int(rand.Reader, big.NewInt(1000000))
	code := fmt.Sprintf("%06d", n.Int64())
	if err := a.sendSMSCode(ctx, normPhone(a.cfg.AdminPhone), code); err != nil {
		log.Printf("sms: %v", err)
		a.log(r, "login.otp", false, "sms error")
		jsonErr(w, http.StatusBadGateway, "短信发送失败")
		return
	}
	a.kv.Set(ctx, "otp:code", code, a.cfg.OTPTTL)
	a.kv.Del(ctx, "otp:tries")
	a.kv.Set(ctx, "otp:cool", "1", time.Minute)
	a.log(r, "login.otp", true, "sent to "+maskPhone(normPhone(a.cfg.AdminPhone)))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) handleLogin(w http.ResponseWriter, r *http.Request) {
	var in struct{ Phone, Code string }
	json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in)
	ctx := r.Context()
	if !allow(ctx, a.kv, "login", a.clientIP(r), a.cfg.RateLoginPer10Min, 10*time.Minute) {
		a.log(r, "login", false, "rate limited")
		jsonErr(w, http.StatusTooManyRequests, "请求过于频繁，请稍后再试")
		return
	}
	fail := func() {
		a.log(r, "login", false, "bad code")
		jsonErr(w, http.StatusUnauthorized, "验证码错误或已过期")
	}
	if !a.isAdminPhone(in.Phone) {
		fail()
		return
	}
	code, ok, _ := a.kv.Get(ctx, "otp:code")
	if !ok {
		fail()
		return
	}
	// five wrong tries burn the code
	if n, _ := a.kv.Incr(ctx, "otp:tries", a.cfg.OTPTTL); n > 5 {
		a.kv.Del(ctx, "otp:code")
		fail()
		return
	}
	if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(in.Code)), []byte(code)) != 1 {
		fail()
		return
	}
	a.kv.Del(ctx, "otp:code")
	a.kv.Del(ctx, "otp:tries")
	token := randHex(32)
	if err := a.kv.Set(ctx, sessionKey(token), a.clientIP(r), a.cfg.SessionTTL); err != nil {
		jsonErr(w, http.StatusInternalServerError, "session error")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: token, Path: a.cfg.AdminPath,
		MaxAge: int(a.cfg.SessionTTL.Seconds()), HttpOnly: true, Secure: a.cfg.SecureCookies, SameSite: http.SameSiteStrictMode,
	})
	a.log(r, "login", true, "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		a.kv.Del(r.Context(), sessionKey(c.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: a.cfg.AdminPath, MaxAge: -1, HttpOnly: true, Secure: a.cfg.SecureCookies, SameSite: http.SameSiteStrictMode})
	a.log(r, "logout", true, "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func safeFileName(name, version, platform string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Trim(unsafeName.ReplaceAllString(name, "_"), "._")
	if name == "" {
		name = "CM-FrameKit_" + version + "_" + platform
	}
	return name
}

// handleUpload streams the multipart body to a temp file (hashing it on the way), then pushes
// it to storage. Form fields must come before the file part.
func (a *App) handleUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, a.cfg.MaxUploadMB<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		jsonErr(w, http.StatusBadRequest, "需要 multipart/form-data")
		return
	}
	fields := map[string]string{}
	var tmpPath, origName string
	var size int64
	var sum string
	defer func() {
		if tmpPath != "" {
			os.Remove(tmpPath)
		}
	}()
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			jsonErr(w, http.StatusBadRequest, "上传中断或超过大小上限")
			return
		}
		if part.FormName() != "file" {
			b, _ := io.ReadAll(io.LimitReader(part, 64<<10))
			fields[part.FormName()] = string(b)
			continue
		}
		if tmpPath != "" {
			jsonErr(w, http.StatusBadRequest, "只能上传一个文件")
			return
		}
		f, err := os.CreateTemp(filepath.Join(a.cfg.DataDir, "tmp"), "upload-*")
		if err != nil {
			jsonErr(w, http.StatusInternalServerError, "无法创建临时文件")
			return
		}
		tmpPath, origName = f.Name(), part.FileName()
		h := sha256.New()
		size, err = io.Copy(io.MultiWriter(f, h), part)
		f.Close()
		if err != nil {
			jsonErr(w, http.StatusBadRequest, "上传中断或超过大小上限")
			return
		}
		sum = hex.EncodeToString(h.Sum(nil))
	}
	version := strings.TrimPrefix(strings.TrimSpace(fields["version"]), "v")
	platform := strings.TrimSpace(fields["platform"])
	switch {
	case !validVersion(version):
		jsonErr(w, http.StatusBadRequest, "版本号格式应为 x.y.z 或 x.y.z-beta.1")
		return
	case !validPlatform(platform):
		jsonErr(w, http.StatusBadRequest, "平台无效")
		return
	case tmpPath == "" || size == 0:
		jsonErr(w, http.StatusBadRequest, "请选择安装包文件")
		return
	}
	if _, exists := a.store.Find(platform, version); exists {
		jsonErr(w, http.StatusConflict, "该平台已存在此版本，请换一个版本号或先删除旧的")
		return
	}
	name := safeFileName(origName, version, platform)
	key := a.cfg.OSSPrefix + "releases/" + version + "/" + platform + "/" + name
	if err := a.storage.Put(r.Context(), key, tmpPath); err != nil {
		log.Printf("upload %s: %v", key, err)
		a.log(r, "release.upload", false, version+" "+platform+": storage error")
		jsonErr(w, http.StatusBadGateway, "上传到存储失败")
		return
	}
	rel, err := a.store.Add(Release{
		Version: version, Platform: platform, Notes: strings.TrimSpace(fields["notes"]), NotesEN: strings.TrimSpace(fields["notes_en"]),
		Mandatory: fields["mandatory"] == "1", Published: fields["publish"] == "1",
		FileName: name, Key: key, Size: size, SHA256: sum,
	})
	if err != nil {
		a.storage.Delete(r.Context(), key)
		jsonErr(w, http.StatusConflict, err.Error())
		return
	}
	a.log(r, "release.upload", true, fmt.Sprintf("%s %s %s (%d bytes, published=%v)", version, platform, name, size, rel.Published))
	writeJSON(w, http.StatusOK, rel)
}

func (a *App) handleAdminReleases(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.store.All())
}

func (a *App) handleEditRelease(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Notes     *string `json:"notes"`
		NotesEN   *string `json:"notes_en"`
		Mandatory *bool   `json:"mandatory"`
		Published *bool   `json:"published"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
		jsonErr(w, http.StatusBadRequest, "bad request")
		return
	}
	var changes []string
	rel, ok, err := a.store.Update(r.PathValue("id"), func(x *Release) {
		if in.Notes != nil && *in.Notes != x.Notes {
			x.Notes = strings.TrimSpace(*in.Notes)
			changes = append(changes, "notes")
		}
		if in.NotesEN != nil && strings.TrimSpace(*in.NotesEN) != x.NotesEN {
			x.NotesEN = strings.TrimSpace(*in.NotesEN)
			changes = append(changes, "notes_en")
		}
		if in.Mandatory != nil && *in.Mandatory != x.Mandatory {
			x.Mandatory = *in.Mandatory
			changes = append(changes, "mandatory="+strconv.FormatBool(x.Mandatory))
		}
		if in.Published != nil && *in.Published != x.Published {
			x.Published = *in.Published
			changes = append(changes, "published="+strconv.FormatBool(x.Published))
		}
	})
	if !ok {
		jsonErr(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, "保存失败")
		return
	}
	action := "release.edit"
	if in.Published != nil && len(changes) > 0 {
		if *in.Published {
			action = "release.publish"
		} else {
			action = "release.unpublish"
		}
	}
	if len(changes) > 0 {
		a.log(r, action, true, rel.Version+" "+rel.Platform+" "+strings.Join(changes, ", "))
	}
	writeJSON(w, http.StatusOK, rel)
}

func (a *App) handleDeleteRelease(w http.ResponseWriter, r *http.Request) {
	rel, ok := a.store.Get(r.PathValue("id"))
	if !ok {
		jsonErr(w, http.StatusNotFound, "not found")
		return
	}
	if err := a.storage.Delete(r.Context(), rel.Key); err != nil {
		log.Printf("delete %s: %v", rel.Key, err)
		a.log(r, "release.delete", false, rel.Version+" "+rel.Platform+": storage error")
		jsonErr(w, http.StatusBadGateway, "删除存储文件失败")
		return
	}
	if _, _, err := a.store.Delete(rel.ID); err != nil {
		jsonErr(w, http.StatusInternalServerError, "保存失败")
		return
	}
	a.log(r, "release.delete", true, rel.Version+" "+rel.Platform+" "+rel.FileName)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) handleLogs(w http.ResponseWriter, r *http.Request) {
	n, _ := strconv.Atoi(r.URL.Query().Get("n"))
	if n <= 0 || n > 2000 {
		n = 300
	}
	out := a.audit.Tail(n, r.URL.Query().Get("action"))
	if out == nil {
		out = []LogEntry{}
	}
	writeJSON(w, http.StatusOK, out)
}
