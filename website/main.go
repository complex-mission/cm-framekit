// CM FrameKit website: the official site, the in-app update check, captcha-gated installer
// downloads from Aliyun OSS, and an SMS-login admin for publishing versions.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

//go:embed web
var webFS embed.FS

type App struct {
	cfg     *Config
	kv      KV
	storage Storage
	store   *Store
	audit   *AuditLog
	pages   map[string]*pageTpl
}

func main() {
	envPath := flag.String("env", ".env", "path to the .env file (optional)")
	pushTest := flag.Bool("push-test", false, "send one info message to the CM push center and exit")
	flag.Parse()
	if err := loadEnvFile(*envPath); err != nil && !os.IsNotExist(err) {
		log.Fatalf("env: %v", err)
	}
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(cfg.DataDir, "tmp"), 0o700); err != nil {
		log.Fatal(err)
	}
	kv, err := newKV(cfg.RedisURL)
	if err != nil {
		log.Fatalf("redis: %v", err)
	}
	store, err := openStore(cfg.DataDir)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	a := &App{
		cfg:     cfg,
		kv:      kv,
		storage: newStorage(cfg),
		store:   store,
		audit:   &AuditLog{dir: filepath.Join(cfg.DataDir, "logs")},
	}
	os.MkdirAll(a.audit.dir, 0o700)
	if *pushTest {
		if cfg.CMPushKey == "" {
			log.Fatal("CM_PUSH_APP_KEY is empty")
		}
		b, _ := json.Marshal(map[string]string{"title": "[FrameKit] 推送测试", "body": "CM FrameKit 官网已接入 CM 推送中心（" + cfg.BaseURL + "）", "level": "info"})
		if _, _, err := a.pushOnce(b, randHex(16)); err != nil {
			log.Fatalf("push test failed: %v", err)
		}
		log.Print("push test sent")
		return
	}
	if a.pages, err = loadPages(); err != nil {
		log.Fatalf("templates: %v", err)
	}
	if !cfg.ossEnabled() {
		log.Printf("WARNING: OSS not configured, installers are stored in %s", a.storage.Name())
	}
	if !cfg.captchaEnabled() {
		log.Printf("WARNING: CAPTCHA_DISABLED=true, downloads are not challenged")
	}
	if cfg.captchaEnabled() {
		log.Printf("captcha: encryption mode %v", cfg.CaptchaEncrypt)
	}
	if cfg.SMSDev {
		log.Printf("WARNING: SMS_DEV=true, login codes are printed to this log instead of sent")
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           a.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	start := LogEntry{IP: "-", Action: "server.start", OK: true, Detail: "监听 " + cfg.Addr + "，存储 " + a.storage.Name() + "，会话 " + kv.Name()}
	a.audit.Add(start)
	a.pushAudit(start)
	go func() {
		log.Printf("listening on %s (kv=%s, storage=%s, admin=%s)", cfg.Addr, kv.Name(), a.storage.Name(), cfg.AdminPath)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	store.Flush()
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	static, _ := fs.Sub(webFS, "web/static")
	mux.Handle("GET /static/", http.StripPrefix("/static/", cacheFor(24*time.Hour, http.FileServerFS(static))))
	mux.HandleFunc("GET /favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/static/logo.svg", http.StatusMovedPermanently)
	})
	mux.HandleFunc("GET /robots.txt", a.handleRobots)
	mux.HandleFunc("GET /sitemap.xml", a.handleSitemap)
	mux.HandleFunc("GET /llms.txt", a.handleLLMs)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })

	mux.HandleFunc("GET /{$}", a.handleHome)
	mux.HandleFunc("GET /changelog", a.handleChangelog)
	mux.HandleFunc("GET /download", a.handleDownloadPage)
	mux.HandleFunc("GET /contact", a.handleContactPage)
	mux.HandleFunc("POST /api/contact", a.handleContact)

	mux.HandleFunc("GET /api/update", cors(a.handleUpdate))
	mux.HandleFunc("GET /api/latest", cors(a.handleLatest))
	mux.HandleFunc("GET /api/releases", cors(a.handleReleases))
	mux.HandleFunc("GET /api/captcha-scene", a.handleCaptchaScene)
	mux.HandleFunc("POST /api/download", a.handleDownload)
	mux.HandleFunc("GET /files/{token}", a.handleLocalFile)

	p := a.cfg.AdminPath
	mux.HandleFunc("GET "+p, a.handleAdmin)
	mux.HandleFunc("POST "+p+"/api/otp", a.adminPost(a.handleOTP, false))
	mux.HandleFunc("POST "+p+"/api/login", a.adminPost(a.handleLogin, false))
	mux.HandleFunc("POST "+p+"/api/logout", a.adminPost(a.handleLogout, true))
	mux.HandleFunc("POST "+p+"/api/upload", a.adminPost(a.handleUpload, true))
	mux.HandleFunc("GET "+p+"/api/releases", a.adminGet(a.handleAdminReleases))
	mux.HandleFunc("POST "+p+"/api/releases/{id}", a.adminPost(a.handleEditRelease, true))
	mux.HandleFunc("POST "+p+"/api/releases/{id}/delete", a.adminPost(a.handleDeleteRelease, true))
	mux.HandleFunc("GET "+p+"/api/logs", a.adminGet(a.handleLogs))
	return securityHeaders(mux)
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		hd.Set("X-Frame-Options", "DENY")
		h.ServeHTTP(w, r)
	})
}

func cacheFor(d time.Duration, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age="+itoa(int64(d.Seconds())))
		h.ServeHTTP(w, r)
	})
}

// cors opens the read-only APIs to the desktop app's webview (tauri://localhost etc.).
func cors(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		h(w, r)
	}
}

func (a *App) clientIP(r *http.Request) string {
	if a.cfg.TrustProxy {
		// X-Real-IP first: nginx (and BaoTa's default proxy) sets it to $remote_addr, while
		// X-Forwarded-For often keeps whatever the client sent ($proxy_add_x_forwarded_for).
		if v := strings.TrimSpace(r.Header.Get("X-Real-IP")); v != "" {
			return v
		}
		if v := r.Header.Get("X-Forwarded-For"); v != "" {
			first, _, _ := strings.Cut(v, ",")
			if ip := strings.TrimSpace(first); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (a *App) log(r *http.Request, action string, ok bool, detail string) {
	e := LogEntry{IP: a.clientIP(r), Action: action, OK: ok, Detail: detail}
	a.audit.Add(e)
	a.pushAudit(e)
	if !strings.HasPrefix(action, "download") {
		log.Printf("[audit] %s ok=%v ip=%s %s", action, ok, a.clientIP(r), detail)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func jsonErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
