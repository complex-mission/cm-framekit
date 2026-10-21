package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type releaseView struct {
	Version     string    `json:"version"`
	Platform    string    `json:"platform"`
	Notes       string    `json:"notes"`
	NotesEN     string    `json:"notes_en"`
	Mandatory   bool      `json:"mandatory"`
	FileName    string    `json:"file_name"`
	Size        int64     `json:"size"`
	SHA256      string    `json:"sha256"`
	PublishedAt time.Time `json:"published_at"`
}

func viewOf(r Release) releaseView {
	return releaseView{r.Version, r.Platform, r.Notes, r.NotesEN, r.Mandatory, r.FileName, r.Size, r.SHA256, r.PublishedAt}
}

func platformParam(r *http.Request) string {
	if p := r.URL.Query().Get("platform"); validPlatform(p) {
		return p
	}
	return "windows-x64"
}

func (a *App) handleHome(w http.ResponseWriter, r *http.Request) {
	latest := map[string]Release{}
	for _, rel := range a.store.Published("") {
		if _, ok := latest[rel.Platform]; !ok {
			latest[rel.Platform] = rel
		}
	}
	main, hasMain := latest["windows-x64"]
	var others []Release
	for _, p := range platforms {
		if rel, ok := latest[p]; ok && p != "windows-x64" {
			others = append(others, rel)
		}
	}
	a.render(w, r, "home", map[string]any{"Main": main, "HasMain": hasMain, "Others": others})
}

func (a *App) handleChangelog(w http.ResponseWriter, r *http.Request) {
	// one entry per version; platforms of the same version are merged
	type entry struct {
		Version     string
		Notes       string
		NotesEN     string
		PublishedAt time.Time
		Mandatory   bool
		Platforms   []string
	}
	var list []*entry
	idx := map[string]*entry{}
	for _, rel := range a.store.Published("") {
		e := idx[rel.Version]
		if e == nil {
			e = &entry{Version: rel.Version, Notes: rel.Notes, NotesEN: rel.NotesEN, PublishedAt: rel.PublishedAt, Mandatory: rel.Mandatory}
			idx[rel.Version] = e
			list = append(list, e)
		}
		e.Platforms = append(e.Platforms, rel.Platform)
	}
	a.render(w, r, "changelog", map[string]any{"Entries": list})
}

func (a *App) handleDownloadPage(w http.ResponseWriter, r *http.Request) {
	p := platformParam(r)
	rel, ok := a.store.Latest(p)
	if v := r.URL.Query().Get("version"); v != "" {
		if x, found := a.store.Find(p, v); found && x.Published {
			rel, ok = x, true
		}
	}
	a.render(w, r, "download", map[string]any{"Rel": rel, "Has": ok, "Platform": p})
}

// handleUpdate is the in-app update check: GET /api/update?version=2.0.0&platform=windows-x64
func (a *App) handleUpdate(w http.ResponseWriter, r *http.Request) {
	if !allow(r.Context(), a.kv, "update", a.clientIP(r), a.cfg.RateUpdatePerMin, time.Minute) {
		jsonErr(w, http.StatusTooManyRequests, "rate limited")
		return
	}
	p := platformParam(r)
	cur := strings.TrimPrefix(r.URL.Query().Get("version"), "v")
	rel, ok := a.store.Latest(p)
	resp := map[string]any{"update": false, "current": cur, "platform": p}
	if ok {
		v := viewOf(rel)
		if r.URL.Query().Get("lang") == "en" && v.NotesEN != "" {
			v.Notes = v.NotesEN
		}
		resp["latest"] = v
		resp["update"] = cmpVersion(rel.Version, cur) > 0
		// mandatory if any newer published release is marked mandatory
		mandatory := false
		for _, x := range a.store.Published(p) {
			if cmpVersion(x.Version, cur) > 0 && x.Mandatory {
				mandatory = true
			}
		}
		resp["mandatory"] = mandatory
		resp["download_page"] = a.cfg.BaseURL + "/download?platform=" + p
		resp["changelog"] = a.cfg.BaseURL + "/changelog"
	}
	writeJSON(w, http.StatusOK, resp)
}

func (a *App) handleLatest(w http.ResponseWriter, r *http.Request) {
	rel, ok := a.store.Latest(platformParam(r))
	if !ok {
		jsonErr(w, http.StatusNotFound, "no release")
		return
	}
	writeJSON(w, http.StatusOK, viewOf(rel))
}

func (a *App) handleReleases(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("platform")
	if p != "" && !validPlatform(p) {
		p = ""
	}
	out := []releaseView{}
	for _, rel := range a.store.Published(p) {
		out = append(out, viewOf(rel))
	}
	writeJSON(w, http.StatusOK, out)
}

// handleDownload trades a passed Aliyun Captcha for a short-lived download link.
func (a *App) handleDownload(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Platform string `json:"platform"`
		Version  string `json:"version"`
		Captcha  string `json:"captcha"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil {
		jsonErr(w, http.StatusBadRequest, "bad request")
		return
	}
	ip := a.clientIP(r)
	if !allow(r.Context(), a.kv, "dl", ip, a.cfg.RateDownloadsPerHour, time.Hour) {
		a.log(r, "download", false, "rate limited")
		jsonErr(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	pass, err := a.verifyCaptcha(r.Context(), in.Captcha)
	if err != nil {
		log.Printf("captcha verify: %v", err)
	}
	if !pass {
		a.log(r, "download", false, "captcha failed")
		jsonErr(w, http.StatusForbidden, "captcha_failed")
		return
	}
	if !validPlatform(in.Platform) {
		in.Platform = "windows-x64"
	}
	rel, ok := a.store.Latest(in.Platform)
	if in.Version != "" {
		rel, ok = a.store.Find(in.Platform, in.Version)
		ok = ok && rel.Published
	}
	if !ok {
		jsonErr(w, http.StatusNotFound, "not_found")
		return
	}
	u, err := a.storage.DownloadURL(r.Context(), rel.Key, rel.FileName)
	if err != nil {
		log.Printf("presign %s: %v", rel.Key, err)
		jsonErr(w, http.StatusInternalServerError, "storage_error")
		return
	}
	if u == "" { // local storage: one-off token
		tok := randHex(16)
		a.kv.Set(r.Context(), "file:"+tok, rel.ID, a.cfg.DownloadTTL)
		u = "/files/" + tok
	}
	a.store.CountDownload(rel.ID)
	a.log(r, "download", true, rel.Version+" "+rel.Platform)
	writeJSON(w, http.StatusOK, map[string]string{"url": u, "file_name": rel.FileName, "version": rel.Version})
}

func (a *App) handleLocalFile(w http.ResponseWriter, r *http.Request) {
	id, ok, _ := a.kv.Get(r.Context(), "file:"+r.PathValue("token"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	rel, ok := a.store.Get(id)
	ls, isLocal := a.storage.(*localStorage)
	if !ok || !isLocal {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(ls.path(rel.Key))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Disposition", contentDisposition(rel.FileName))
	http.ServeContent(w, r, filepath.Base(rel.FileName), rel.CreatedAt, f)
}

// handleContact takes a message from the site's contact form and forwards it to the CM push
// center. Rate limited per IP and globally; a hidden "website" field catches simple bots.
func (a *App) handleContact(w http.ResponseWriter, r *http.Request) {
	if o := r.Header.Get("Origin"); o != "" && !strings.HasSuffix(o, "://"+r.Host) {
		jsonErr(w, http.StatusForbidden, "forbidden")
		return
	}
	var in struct {
		Name    string `json:"name"`
		Contact string `json:"contact"`
		Message string `json:"message"`
		Website string `json:"website"` // honeypot
		Lang    string `json:"lang"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&in); err != nil {
		jsonErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	if in.Website != "" { // pretend it worked
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	in.Name, in.Contact, in.Message = strings.TrimSpace(in.Name), strings.TrimSpace(in.Contact), strings.TrimSpace(in.Message)
	n := len([]rune(in.Message))
	if n < 5 || n > 2000 || len([]rune(in.Name)) > 50 || len([]rune(in.Contact)) > 100 {
		jsonErr(w, http.StatusBadRequest, "invalid")
		return
	}
	ip := a.clientIP(r)
	ctx := r.Context()
	if !allow(ctx, a.kv, "contact", ip, a.cfg.RateContactPerDay, 24*time.Hour) ||
		!allow(ctx, a.kv, "contact-min", ip, 1, time.Minute) ||
		!allow(ctx, a.kv, "contact-all", "all", 200, 24*time.Hour) {
		a.log(r, "contact", false, "rate limited")
		jsonErr(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	name, contact := in.Name, in.Contact
	if name == "" {
		name = "（未填）"
	}
	if contact == "" {
		contact = "（未填）"
	}
	body := fmt.Sprintf("称呼：%s\n联系方式：%s\n语言：%s\nIP：%s\n\n%s", name, contact, in.Lang, ip, in.Message)
	extra, _ := json.Marshal(map[string]string{"source": "fk-site", "action": "contact", "ip": ip})
	a.sendCMNotification("[FrameKit] 官网留言", body, "info", "", string(extra))
	a.audit.Add(LogEntry{IP: ip, Action: "contact", OK: true, Detail: name + " / " + contact + "：" + clip(in.Message, 200)})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) handleContactPage(w http.ResponseWriter, r *http.Request) {
	a.render(w, r, "contact", nil)
}
