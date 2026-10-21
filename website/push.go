package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// sendCMNotification posts an event to the CM push center in the background. It never blocks or
// fails the caller: errors are only logged. 429 / 5xx are retried with the same Idempotency-Key.
func (a *App) sendCMNotification(title, body, level, groupKey, extra string) {
	if a.cfg.CMPushKey == "" {
		return
	}
	payload := map[string]string{"title": clip(title, 500), "body": clip(body, 10000), "level": level}
	if groupKey != "" {
		payload["group_key"] = clip(groupKey, 255)
	}
	if extra != "" && json.Valid([]byte(extra)) && len(extra) <= 8192 {
		payload["extra"] = extra
	}
	b, _ := json.Marshal(payload)
	idem := randHex(16)
	go func() {
		for attempt := 1; attempt <= 3; attempt++ {
			retry, wait, err := a.pushOnce(b, idem)
			if err == nil {
				return
			}
			if !retry || attempt == 3 {
				log.Printf("cm push %q failed: %v", title, err)
				return
			}
			time.Sleep(wait)
		}
	}()
}

func (a *App) pushOnce(body []byte, idem string) (retry bool, wait time.Duration, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, a.cfg.CMPushURL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-App-Key", a.cfg.CMPushKey)
	req.Header.Set("Idempotency-Key", idem)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return true, 2 * time.Second, err
	}
	defer resp.Body.Close()
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	switch {
	case resp.StatusCode == http.StatusOK:
		return false, 0, nil
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		wait = 3 * time.Second
		if s, e := strconv.Atoi(resp.Header.Get("Retry-After")); e == nil && s > 0 {
			wait = min(time.Duration(s)*time.Second, 30*time.Second)
		}
		return true, wait, fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	default:
		return false, 0, fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// pushRule says which audit actions are sensitive enough to notify. Downloads are not pushed.
type pushRule struct {
	title, level, group string
}

var pushRules = map[string]struct{ ok, fail *pushRule }{
	"login.otp":         {&pushRule{"后台验证码已发送", "info", ""}, &pushRule{"后台验证码请求异常", "warning", "fk-otp-fail"}},
	"login":             {&pushRule{"后台登录成功", "warning", ""}, &pushRule{"后台登录失败", "warning", "fk-login-fail"}},
	"logout":            {&pushRule{"后台已退出登录", "info", ""}, nil},
	"release.upload":    {&pushRule{"新安装包已上传", "success", ""}, &pushRule{"安装包上传失败", "critical", ""}},
	"release.publish":   {&pushRule{"版本已发布", "success", ""}, nil},
	"release.unpublish": {&pushRule{"版本已下线", "warning", ""}, nil},
	"release.edit":      {&pushRule{"版本信息已修改", "info", ""}, nil},
	"release.delete":    {&pushRule{"版本已删除", "warning", ""}, &pushRule{"版本删除失败", "critical", ""}},
	"server.start":      {&pushRule{"官网服务已启动", "info", ""}, nil},
}

func (a *App) pushAudit(e LogEntry) {
	rules, ok := pushRules[e.Action]
	if !ok {
		return
	}
	rule := rules.ok
	if !e.OK {
		rule = rules.fail
	}
	if rule == nil {
		return
	}
	body := fmt.Sprintf("%s\nIP：%s\n时间：%s", e.Detail, e.IP, time.Now().Format("2006-01-02 15:04:05"))
	extra, _ := json.Marshal(map[string]any{"source": "fk-site", "action": e.Action, "ok": e.OK, "ip": e.IP})
	a.sendCMNotification("[FrameKit] "+rule.title, strings.TrimLeft(body, "\n"), rule.level, rule.group, string(extra))
}
