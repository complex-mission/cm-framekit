package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"html"
	"html/template"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"time"
)

type pageTpl struct{ t *template.Template }

var pageNames = []string{"home", "changelog", "download", "contact", "admin_login", "admin"}

var tplFuncs = template.FuncMap{
	"asset": assetURL,
	"notes": renderNotes,
	"size":  humanSize,
	"date":  func(t time.Time) string { return t.Local().Format("2006-01-02") },
	"plat":  platformName,
	// loc picks the English text on English pages when there is one
	"loc": func(lang, zh, en string) string {
		if lang == "en" && strings.TrimSpace(en) != "" {
			return en
		}
		return zh
	},
}

// assetVersions maps each embedded static file to a short content hash. Asset URLs carry it
// (?v=…), so nginx's and browsers' caches can never serve a stale CSS/JS after an update.
var assetVersions = map[string]string{}

func hashAssets() error {
	return fs.WalkDir(webFS, "web/static", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := webFS.ReadFile(p)
		if err != nil {
			return err
		}
		h := sha256.Sum256(b)
		assetVersions[strings.TrimPrefix(p, "web/static/")] = hex.EncodeToString(h[:5])
		return nil
	})
}

// assetURL turns "site.css" into "/static/site.css?v=<hash>".
func assetURL(name string) string {
	u := "/static/" + name
	if v, ok := assetVersions[name]; ok {
		u += "?v=" + v
	}
	return u
}

func loadPages() (map[string]*pageTpl, error) {
	if err := hashAssets(); err != nil {
		return nil, err
	}
	out := map[string]*pageTpl{}
	for _, n := range pageNames {
		t, err := template.New("layout.html").Funcs(tplFuncs).ParseFS(webFS, "web/templates/layout.html", "web/templates/"+n+".html")
		if err != nil {
			return nil, err
		}
		out[n] = &pageTpl{t}
	}
	return out, nil
}

// view is what every template sees: {{.T "key"}} translates, .Data is the page's own data.
type view struct {
	Lang    string
	Page    string
	Data    any
	BaseURL string
	Repo    string
	Admin   string
	Year    int

	// SEO
	Canonical string
	AltZH     string
	AltEN     string
	Desc      string
	OGImage   string
	LD        template.JS
	NoIndex   bool

	CaptchaOn     bool
	CaptchaRegion string
	CaptchaPrefix string
	CaptchaScene  string
	CaptchaCrypt  bool
}

// FAQ lists the FAQ dict keys, shared by the page and its FAQPage JSON-LD.
func (v view) FAQ() []string { return faqKeys }

func (v view) T(key string) string {
	if s, ok := dict[v.Lang][key]; ok {
		return s
	}
	if s, ok := dict["zh"][key]; ok {
		return s
	}
	return key
}

func (a *App) lang(w http.ResponseWriter, r *http.Request) string {
	if l := r.URL.Query().Get("lang"); l == "zh" || l == "en" {
		http.SetCookie(w, &http.Cookie{Name: "lang", Value: l, Path: "/", MaxAge: 365 * 86400, SameSite: http.SameSiteLaxMode})
		return l
	}
	if c, err := r.Cookie("lang"); err == nil && (c.Value == "zh" || c.Value == "en") {
		return c.Value
	}
	al := strings.ToLower(r.Header.Get("Accept-Language"))
	if al == "" || strings.Contains(al, "zh") {
		return "zh"
	}
	return "en"
}

func (a *App) render(w http.ResponseWriter, r *http.Request, page string, data any) {
	p := a.pages[page]
	v := view{
		Lang: a.lang(w, r), Page: page, Data: data, BaseURL: a.cfg.BaseURL, Repo: a.cfg.GitHubRepo,
		Admin: a.cfg.AdminPath, Year: time.Now().Year(),
		CaptchaOn: a.cfg.captchaEnabled(), CaptchaRegion: a.cfg.CaptchaRegion,
		CaptchaPrefix: a.cfg.CaptchaPrefix, CaptchaScene: a.cfg.CaptchaSceneID,
		CaptchaCrypt: a.cfg.CaptchaEncrypt,
	}
	a.seoMeta(&v, r.URL.Path)
	var buf bytes.Buffer
	if err := p.t.Execute(&buf, v); err != nil {
		log.Printf("render %s: %v", page, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(buf.Bytes())
}

// renderNotes turns plain-text release notes into HTML: "- " / "* " lines are list items,
// "## " lines are headings, other lines are paragraphs. Everything is escaped.
func renderNotes(s string) template.HTML {
	var b strings.Builder
	inList := false
	closeList := func() {
		if inList {
			b.WriteString("</ul>")
			inList = false
		}
	}
	for _, line := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
		t := strings.TrimSpace(line)
		switch {
		case t == "":
			closeList()
		case strings.HasPrefix(t, "- ") || strings.HasPrefix(t, "* "):
			if !inList {
				b.WriteString("<ul>")
				inList = true
			}
			b.WriteString("<li>" + html.EscapeString(strings.TrimSpace(t[2:])) + "</li>")
		case strings.HasPrefix(t, "#"):
			closeList()
			b.WriteString("<h4>" + html.EscapeString(strings.TrimSpace(strings.TrimLeft(t, "#"))) + "</h4>")
		default:
			closeList()
			b.WriteString("<p>" + html.EscapeString(t) + "</p>")
		}
	}
	closeList()
	return template.HTML(b.String())
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.2f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

func platformName(p string) string {
	switch p {
	case "windows-x64":
		return "Windows x64"
	case "windows-arm64":
		return "Windows ARM64"
	case "macos-arm64":
		return "macOS Apple Silicon"
	case "macos-x64":
		return "macOS Intel"
	case "linux-x64":
		return "Linux x64"
	}
	return p
}

var dict = map[string]map[string]string{
	"zh": {
		"nav.home":       "首页",
		"nav.changelog":  "更新日志",
		"nav.source":     "开源",
		"hero.tagline":   "截帧 · 提取音频 · 雪碧图 · 预览视频",
		"hero.sub":       "输出面向全浏览器 / 全 Apple 设备兼容。内置精简 FFmpeg，开箱即用，免费开源。",
		"dl.button":      "下载 Windows 版",
		"dl.none":        "安装包即将发布",
		"dl.req":         "Windows 10 / 11 · 64 位",
		"dl.other":       "其他平台",
		"dl.changelog":   "查看更新日志",
		"dl.working":     "正在准备下载…",
		"dl.started":     "下载已开始。如果没有自动开始，请",
		"dl.retry":       "点此重试",
		"dl.failed":      "下载失败，请稍后再试",
		"dl.captcha":     "人机验证未通过，请重试",
		"dl.limited":     "下载次数过多，请稍后再试",
		"dl.title":       "下载 CM FrameKit",
		"dl.version":     "版本",
		"dl.size":        "大小",
		"dl.date":        "发布日期",
		"dl.platform":    "平台",
		"dl.verify":      "点击下载后需完成一次人机验证",
		"f.frames":       "截帧",
		"f.frames.d":     "时间轴逐帧定位，批量按间隔导出 PNG / JPG / WebP。",
		"f.audio":        "提取音频",
		"f.audio.d":      "AAC(.m4a) / MP3 / Opus，多音轨分别导出。",
		"f.sprite":       "雪碧图 + WebVTT",
		"f.sprite.d":     "生成播放器缩略图预览，超过 WebP 尺寸上限自动分多张。",
		"f.preview":      "预览视频",
		"f.preview.d":    "多片段拼接，输出 MP4（H.264 / H.265，支持 NVENC / QSV / AMF）、GIF、动画 WebP。",
		"compat.title":   "为网页播放而生",
		"compat.1":       "导入时分析源文件：moov 位置、hev1、10-bit H.264、AV1、AC-3/Opus、HDR 等兼容风险",
		"compat.2":       "生成的 MP4 固定 8-bit 4:2:0 + AAC + faststart + hvc1，写完自动校验",
		"compat.3":       "HDR → SDR 色调映射、自动反交错、非方形像素校正、竖拍旋转",
		"compat.4":       "AVI / WMV / MPEG-2 / ProRes 等格式自动切换为逐帧预览",
		"oss.title":      "开源",
		"oss.desc":       "源代码托管在 GitHub，欢迎 Star、提 Issue 和 PR。",
		"cl.title":       "更新日志",
		"cl.empty":       "暂无发布记录",
		"cl.mandatory":   "重要更新",
		"shots.title":    "界面一览",
		"shots.single":   "单文件精修：时间轴逐帧定位，截帧、音频、雪碧图、预览视频一次勾选导出",
		"shots.batch":    "批量处理：一次加入多个视频，按同一套设置统一导出",
		"shots.home":     "开始页：拖入视频，或从最近打开继续",
		"nav.contact":    "留言",
		"ct.title":       "留言",
		"ct.lead":        "问题反馈、功能建议或合作，都可以在这里留言。需要回复的话请留下联系方式。",
		"ct.name":        "称呼",
		"ct.optional":    "选填",
		"ct.contact":     "联系方式",
		"ct.contact.ph":  "邮箱 / 微信 / 手机（选填）",
		"ct.message":     "留言内容",
		"ct.message.ph":  "请描述你的问题或建议，至少 5 个字",
		"ct.send":        "发送",
		"ct.sending":     "正在发送…",
		"ct.ok":          "已收到，谢谢你的留言！",
		"ct.short":       "留言内容至少 5 个字，最多 2000 字",
		"ct.limited":     "发送太频繁了，请稍后再试",
		"ct.failed":      "发送失败，请稍后再试",
		"meta.home":      "CM FrameKit 是一款免费开源的 Windows 视频工具：截帧、提取音频、生成雪碧图与 WebVTT、导出预览视频，输出的 MP4 保证所有浏览器和 Apple 设备都能播放。",
		"meta.changelog": "CM FrameKit 各版本的更新内容与发布日期。",
		"meta.download":  "下载 CM FrameKit Windows 版安装包，免费开源，支持 Windows 10 / 11 64 位。",
		"meta.contact":   "给 CM FrameKit 团队留言：问题反馈、功能建议或合作。",
		"faq.title":      "常见问题",
		"faq.free.q":     "CM FrameKit 免费吗？",
		"faq.free.a":     "完全免费，源代码在 GitHub 上公开，没有广告、没有功能限制，也不需要注册账号。",
		"faq.os.q":       "支持哪些系统？",
		"faq.os.a":       "目前支持 Windows 10 和 Windows 11（64 位）。安装包约 19 MB，默认安装到当前用户目录，不需要管理员权限。",
		"faq.privacy.q":  "视频会上传到服务器吗？",
		"faq.privacy.a":  "不会。所有截帧、转码和导出都在你的电脑本地完成，视频文件不会离开本机。软件唯一的联网操作是启动时检查有没有新版本。",
		"faq.ffmpeg.q":   "需要自己安装 FFmpeg 吗？",
		"faq.ffmpeg.a":   "不需要。软件内置一份为本软件精简编译的 FFmpeg（含 x264、x265、libwebp、LAME、Opus），装好即可使用。",
		"faq.compat.q":   "导出的视频能在哪些设备上播放？",
		"faq.compat.a":   "导出的 MP4 固定为 H.264 / H.265 8-bit 4:2:0 + AAC + faststart，写完会自动校验，Chrome、Edge、Firefox、Safari 以及 iPhone、iPad、Mac、Android 都能直接播放。H.265 体积更小，但部分浏览器需要显卡支持硬解。",
		"faq.gpu.q":      "支持显卡硬件加速吗？",
		"faq.gpu.a":      "支持 NVIDIA NVENC、Intel QSV 和 AMD AMF，用于导出预览视频时的编码。默认使用画质更好的软件编码，需要更快时可以在编码选项里切换到硬件编码。",
		"footer.rights":  "Complex Mission",
		"admin.title":    "发布管理",
		"admin.login":    "管理员登录",
		"admin.phone":    "手机号",
		"admin.code":     "短信验证码",
		"admin.send":     "获取验证码",
		"admin.signin":   "登录",
		"admin.only":     "仅限授权手机号登录",
	},
	"en": {
		"nav.home":       "Home",
		"nav.changelog":  "Changelog",
		"nav.source":     "Source",
		"hero.tagline":   "Frames · Audio · Sprites · Preview videos",
		"hero.sub":       "Output that plays in every browser and on every Apple device. Ships with a slim FFmpeg build. Free and open source.",
		"dl.button":      "Download for Windows",
		"dl.none":        "Installer coming soon",
		"dl.req":         "Windows 10 / 11 · 64-bit",
		"dl.other":       "Other platforms",
		"dl.changelog":   "View changelog",
		"dl.working":     "Preparing your download…",
		"dl.started":     "Your download has started. If it didn't, ",
		"dl.retry":       "try again",
		"dl.failed":      "Download failed, please try again later",
		"dl.captcha":     "Verification failed, please try again",
		"dl.limited":     "Too many downloads, please try again later",
		"dl.title":       "Download CM FrameKit",
		"dl.version":     "Version",
		"dl.size":        "Size",
		"dl.date":        "Released",
		"dl.platform":    "Platform",
		"dl.verify":      "A quick human check runs when you click download",
		"f.frames":       "Frame capture",
		"f.frames.d":     "Step through the timeline frame by frame, or batch-export at an interval as PNG / JPG / WebP.",
		"f.audio":        "Audio extraction",
		"f.audio.d":      "AAC (.m4a) / MP3 / Opus, one file per audio track.",
		"f.sprite":       "Sprites + WebVTT",
		"f.sprite.d":     "Thumbnail sprites for player scrubbing, split automatically past the WebP size limit.",
		"f.preview":      "Preview videos",
		"f.preview.d":    "Join clips into MP4 (H.264 / H.265 with NVENC / QSV / AMF), GIF or animated WebP.",
		"compat.title":   "Built for web playback",
		"compat.1":       "Flags risky sources on import: moov position, hev1, 10-bit H.264, AV1, AC-3/Opus, HDR",
		"compat.2":       "MP4 output is always 8-bit 4:2:0 + AAC + faststart + hvc1, and is verified after writing",
		"compat.3":       "HDR → SDR tone mapping, auto deinterlace, non-square pixel fix, portrait rotation",
		"compat.4":       "AVI / WMV / MPEG-2 / ProRes and friends fall back to frame-by-frame preview",
		"oss.title":      "Open source",
		"oss.desc":       "The source lives on GitHub. Stars, issues and pull requests are welcome.",
		"cl.title":       "Changelog",
		"cl.empty":       "No releases yet",
		"cl.mandatory":   "Important update",
		"shots.title":    "Screenshots",
		"shots.single":   "Single file: step through frames, then export frames, audio, sprites and a preview in one go",
		"shots.batch":    "Batch: add many videos and export them all with the same settings",
		"shots.home":     "Start screen: drop a video in, or pick up a recent one",
		"nav.contact":    "Contact",
		"ct.title":       "Contact",
		"ct.lead":        "Bug reports, feature ideas or partnerships, leave a message here. Add a way to reach you if you'd like a reply.",
		"ct.name":        "Name",
		"ct.optional":    "Optional",
		"ct.contact":     "Contact",
		"ct.contact.ph":  "Email / WeChat / phone (optional)",
		"ct.message":     "Message",
		"ct.message.ph":  "Describe your question or idea (at least 5 characters)",
		"ct.send":        "Send",
		"ct.sending":     "Sending…",
		"ct.ok":          "Got it, thanks for your message!",
		"ct.short":       "Messages need 5 to 2000 characters",
		"ct.limited":     "Too many messages, please try again later",
		"ct.failed":      "Could not send, please try again later",
		"meta.home":      "CM FrameKit is a free, open-source Windows video tool: capture frames, extract audio, build sprite sheets with WebVTT and export preview videos as MP4 that plays in every browser and on every Apple device.",
		"meta.changelog": "What changed in each CM FrameKit release, and when it shipped.",
		"meta.download":  "Download the CM FrameKit installer for Windows 10 / 11 (64-bit). Free and open source.",
		"meta.contact":   "Send the CM FrameKit team a bug report, feature idea or partnership enquiry.",
		"faq.title":      "FAQ",
		"faq.free.q":     "Is CM FrameKit free?",
		"faq.free.a":     "Yes, completely. The source code is public on GitHub, and there are no ads, no feature limits and no account to sign up for.",
		"faq.os.q":       "Which systems does it run on?",
		"faq.os.a":       "Windows 10 and Windows 11 (64-bit). The installer is about 19 MB and installs for the current user, so no administrator rights are needed.",
		"faq.privacy.q":  "Are my videos uploaded anywhere?",
		"faq.privacy.a":  "No. Frame capture, transcoding and export all run locally on your computer, and your video files never leave it. The only network request the app makes is a version check at startup.",
		"faq.ffmpeg.q":   "Do I need to install FFmpeg?",
		"faq.ffmpeg.a":   "No. The app ships with its own slim FFmpeg build (with x264, x265, libwebp, LAME and Opus), so it works right after installing.",
		"faq.compat.q":   "Where do the exported videos play?",
		"faq.compat.a":   "Exported MP4 is always H.264 / H.265 8-bit 4:2:0 + AAC + faststart and is verified after writing, so it plays in Chrome, Edge, Firefox and Safari and on iPhone, iPad, Mac and Android. H.265 files are smaller, but some browsers need GPU decoding for them.",
		"faq.gpu.q":      "Does it support GPU acceleration?",
		"faq.gpu.a":      "Yes: NVIDIA NVENC, Intel QSV and AMD AMF are used when encoding preview videos. Software encoding stays the default because it gives better quality; switch to a hardware encoder in the codec options when speed matters more.",
		"footer.rights":  "Complex Mission",
		"admin.title":    "Releases",
		"admin.login":    "Admin sign-in",
		"admin.phone":    "Phone number",
		"admin.code":     "SMS code",
		"admin.send":     "Send code",
		"admin.signin":   "Sign in",
		"admin.only":     "Only the authorized phone number can sign in",
	},
}
