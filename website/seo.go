package main

import (
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"strings"
	"time"
)

// Indexable pages and the dict keys of their titles; used by the sitemap and breadcrumbs.
var seoPages = []struct{ path, page, titleKey string }{
	{"/", "home", ""},
	{"/changelog", "changelog", "cl.title"},
	{"/download", "download", "dl.title"},
	{"/contact", "contact", "ct.title"},
}

var faqKeys = []string{"faq.free", "faq.os", "faq.privacy", "faq.ffmpeg", "faq.compat", "faq.gpu"}

// pageURL is the canonical URL of path in lang: Chinese is the default, English adds ?lang=en.
func (a *App) pageURL(path, lang string) string {
	u := a.cfg.BaseURL + path
	if lang == "en" {
		u += "?lang=en"
	}
	return u
}

// seoMeta fills the per-page head tags and JSON-LD.
func (a *App) seoMeta(v *view, path string) {
	if !strings.HasPrefix(v.Page, "admin") {
		v.Canonical = a.pageURL(path, v.Lang)
		v.AltZH = a.pageURL(path, "zh")
		v.AltEN = a.pageURL(path, "en")
	} else {
		v.NoIndex = true
	}
	v.Desc = v.T("meta." + v.Page)
	if v.Desc == "meta."+v.Page {
		v.Desc = v.T("meta.home")
	}
	og := "og.jpg"
	if v.Lang == "en" {
		og = "og-en.jpg"
	}
	v.OGImage = a.cfg.BaseURL + assetURL(og)
	if v.NoIndex {
		return
	}

	org := map[string]any{
		"@type": "Organization", "@id": a.cfg.BaseURL + "/#org",
		"name": "Complex Mission", "url": a.cfg.BaseURL,
		"logo":   a.cfg.BaseURL + assetURL("logo.svg"),
		"sameAs": []string{"https://github.com/complex-mission"},
	}
	graph := []any{org, map[string]any{
		"@type": "WebSite", "@id": a.cfg.BaseURL + "/#site",
		"url": a.cfg.BaseURL, "name": "CM FrameKit", "inLanguage": []string{"zh-CN", "en"},
		"publisher": map[string]string{"@id": a.cfg.BaseURL + "/#org"},
	}}

	if v.Page == "home" {
		app := map[string]any{
			"@type": "SoftwareApplication", "@id": a.cfg.BaseURL + "/#app",
			"name": "CM FrameKit", "url": v.Canonical,
			"description":            v.T("meta.home"),
			"applicationCategory":    "MultimediaApplication",
			"applicationSubCategory": "Video tools",
			"operatingSystem":        "Windows 10, Windows 11",
			"offers":                 map[string]any{"@type": "Offer", "price": "0", "priceCurrency": "CNY"},
			"isAccessibleForFree":    true,
			"license":                "https://opensource.org/licenses/MIT",
			"codeRepository":         "https://github.com/" + a.cfg.GitHubRepo,
			"featureList":            []string{v.T("f.frames.d"), v.T("f.audio.d"), v.T("f.sprite.d"), v.T("f.preview.d"), v.T("compat.2")},
			"inLanguage":             []string{"zh-CN", "en"},
			"publisher":              map[string]string{"@id": a.cfg.BaseURL + "/#org"},
			"image":                  v.OGImage,
		}
		var shots []string
		sfx := ""
		if v.Lang == "en" {
			sfx = "-en"
		}
		for _, s := range []string{"single", "batch", "home"} {
			shots = append(shots, a.cfg.BaseURL+assetURL("shots/"+s+sfx+".webp"))
		}
		app["screenshot"] = shots
		if rel, ok := a.store.Latest("windows-x64"); ok {
			app["softwareVersion"] = rel.Version
			app["fileSize"] = fmt.Sprintf("%dMB", (rel.Size+(1<<20)-1)>>20)
			app["datePublished"] = rel.PublishedAt.Format("2006-01-02")
			app["downloadUrl"] = a.pageURL("/download", v.Lang)
			app["releaseNotes"] = a.pageURL("/changelog", v.Lang)
		}
		var qa []any
		for _, k := range faqKeys {
			qa = append(qa, map[string]any{
				"@type": "Question", "name": v.T(k + ".q"),
				"acceptedAnswer": map[string]string{"@type": "Answer", "text": v.T(k + ".a")},
			})
		}
		graph = append(graph, app, map[string]any{"@type": "FAQPage", "mainEntity": qa, "inLanguage": htmlLang(v.Lang)})
	} else {
		var name string
		for _, p := range seoPages {
			if p.page == v.Page {
				name = v.T(p.titleKey)
			}
		}
		graph = append(graph, map[string]any{
			"@type": "BreadcrumbList",
			"itemListElement": []any{
				map[string]any{"@type": "ListItem", "position": 1, "name": "CM FrameKit", "item": a.pageURL("/", v.Lang)},
				map[string]any{"@type": "ListItem", "position": 2, "name": name, "item": v.Canonical},
			},
		})
	}
	b, _ := json.Marshal(map[string]any{"@context": "https://schema.org", "@graph": graph})
	v.LD = template.JS(b) // json.Marshal escapes <, > and &, so this cannot break out of the script
}

func htmlLang(l string) string {
	if l == "en" {
		return "en"
	}
	return "zh-CN"
}

// robots.txt deliberately does not list the admin path: that would publish it. Admin pages carry
// noindex instead.
func (a *App) handleRobots(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprintf(w, "User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /files/\n\nSitemap: %s/sitemap.xml\n", a.cfg.BaseURL)
}

func (a *App) handleSitemap(w http.ResponseWriter, r *http.Request) {
	last := time.Now()
	if rels := a.store.Published(""); len(rels) > 0 {
		last = rels[0].PublishedAt
	}
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	b.WriteString(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">` + "\n")
	for _, p := range seoPages {
		for _, l := range []string{"zh", "en"} {
			fmt.Fprintf(&b, "  <url>\n    <loc>%s</loc>\n    <lastmod>%s</lastmod>\n", xmlEsc(a.pageURL(p.path, l)), last.Format("2006-01-02"))
			fmt.Fprintf(&b, "    <xhtml:link rel=\"alternate\" hreflang=\"zh-CN\" href=\"%s\"/>\n", xmlEsc(a.pageURL(p.path, "zh")))
			fmt.Fprintf(&b, "    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"%s\"/>\n", xmlEsc(a.pageURL(p.path, "en")))
			fmt.Fprintf(&b, "    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"%s\"/>\n  </url>\n", xmlEsc(a.pageURL(p.path, "zh")))
		}
	}
	b.WriteString("</urlset>\n")
	w.Write([]byte(b.String()))
}

func xmlEsc(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

// handleLLMs serves /llms.txt: a plain-language summary for AI search and answer engines.
func (a *App) handleLLMs(w http.ResponseWriter, r *http.Request) {
	zh := view{Lang: "zh"}
	en := view{Lang: "en"}
	var b strings.Builder
	fmt.Fprintf(&b, "# CM FrameKit\n\n> %s\n\n%s\n\n", en.T("meta.home"), zh.T("meta.home"))
	if rel, ok := a.store.Latest("windows-x64"); ok {
		fmt.Fprintf(&b, "Latest version: %s (%s), Windows 10 / 11 x64, %s. Free and open source.\n\n", rel.Version, rel.PublishedAt.Format("2006-01-02"), humanSize(rel.Size))
	}
	b.WriteString("## Features\n\n")
	for _, k := range []string{"f.frames", "f.audio", "f.sprite", "f.preview"} {
		fmt.Fprintf(&b, "- %s: %s\n", en.T(k), en.T(k+".d"))
	}
	b.WriteString("\n## Web compatibility\n\n")
	for _, k := range []string{"compat.1", "compat.2", "compat.3", "compat.4"} {
		fmt.Fprintf(&b, "- %s\n", en.T(k))
	}
	b.WriteString("\n## FAQ\n\n")
	for _, k := range faqKeys {
		fmt.Fprintf(&b, "### %s\n\n%s\n\n", en.T(k+".q"), en.T(k+".a"))
	}
	b.WriteString("## 常见问题\n\n")
	for _, k := range faqKeys {
		fmt.Fprintf(&b, "### %s\n\n%s\n\n", zh.T(k+".q"), zh.T(k+".a"))
	}
	fmt.Fprintf(&b, "## Links\n\n- Website: %s\n- Download: %s/download\n- Changelog: %s/changelog\n- Source code: https://github.com/%s\n- Contact: %s/contact\n",
		a.cfg.BaseURL, a.cfg.BaseURL, a.cfg.BaseURL, a.cfg.GitHubRepo, a.cfg.BaseURL)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(b.String()))
}
