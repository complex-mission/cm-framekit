package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// aliyunRPC calls an Aliyun RPC-style API (signature v1, HMAC-SHA1) with a form POST and decodes
// the JSON response into out.
func aliyunRPC(ctx context.Context, host, keyID, secret, action, version string, params map[string]string, out any) error {
	nonce := make([]byte, 16)
	rand.Read(nonce)
	q := map[string]string{
		"AccessKeyId":      keyID,
		"Action":           action,
		"Format":           "JSON",
		"SignatureMethod":  "HMAC-SHA1",
		"SignatureNonce":   hex.EncodeToString(nonce),
		"SignatureVersion": "1.0",
		"Timestamp":        time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		"Version":          version,
	}
	for k, v := range params {
		q[k] = v
	}
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = popEncode(k) + "=" + popEncode(q[k])
	}
	canonical := strings.Join(parts, "&")
	mac := hmac.New(sha1.New, []byte(secret+"&"))
	mac.Write([]byte("POST&" + popEncode("/") + "&" + popEncode(canonical)))
	body := "Signature=" + popEncode(base64.StdEncoding.EncodeToString(mac.Sum(nil))) + "&" + canonical

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+host+"/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("%s: http %d: %v", action, resp.StatusCode, err)
	}
	return nil
}

// sendSMSCode sends a login code through Aliyun SMS (template must contain ${code}). With
// SMS_DEV=true the code is only written to the log.
func (a *App) sendSMSCode(ctx context.Context, phone, code string) error {
	c := a.cfg
	if c.SMSDev {
		log.Printf("[SMS_DEV] login code for %s: %s", maskPhone(phone), code)
		return nil
	}
	param, _ := json.Marshal(map[string]string{"code": code})
	var out struct{ Code, Message string }
	err := aliyunRPC(ctx, "dysmsapi.aliyuncs.com", c.SMSKeyID, c.SMSSecret, "SendSms", "2017-05-25", map[string]string{
		"PhoneNumbers":  phone,
		"RegionId":      "cn-hangzhou",
		"SignName":      c.SMSSign,
		"TemplateCode":  c.SMSTemplate,
		"TemplateParam": string(param),
	}, &out)
	if err != nil {
		return err
	}
	if out.Code != "OK" {
		return fmt.Errorf("sms: %s: %s", out.Code, out.Message)
	}
	return nil
}

// verifyCaptcha checks an Aliyun Captcha 2.0 token (captchaVerifyParam from the page) with
// VerifyIntelligentCaptcha. Tokens are single-use. Disabled captcha always passes.
func (a *App) verifyCaptcha(ctx context.Context, param string) (bool, error) {
	c := a.cfg
	if !c.captchaEnabled() {
		return true, nil
	}
	if param == "" || len(param) > 8192 {
		return false, nil
	}
	var out struct {
		Code    string
		Message string
		Success bool
		Result  struct {
			VerifyResult bool
			VerifyCode   string
		}
	}
	err := aliyunRPC(ctx, c.CaptchaEndpoint, c.CaptchaKeyID, c.CaptchaSecret, "VerifyIntelligentCaptcha", "2023-03-05",
		map[string]string{"CaptchaVerifyParam": param, "SceneId": c.CaptchaSceneID}, &out)
	if err != nil {
		return false, err
	}
	if !out.Success {
		return false, fmt.Errorf("captcha: %s: %s", out.Code, out.Message)
	}
	return out.Result.VerifyResult, nil
}

// popEncode is Aliyun's percent-encoding (RFC 3986: space -> %20, keep ~).
func popEncode(s string) string {
	e := url.QueryEscape(s)
	e = strings.ReplaceAll(e, "+", "%20")
	e = strings.ReplaceAll(e, "*", "%2A")
	return strings.ReplaceAll(e, "%7E", "~")
}

func maskPhone(p string) string {
	if len(p) < 7 {
		return "***"
	}
	return p[:3] + "****" + p[len(p)-4:]
}
