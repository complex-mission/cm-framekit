package main

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is read from the environment; loadEnvFile fills it from a .env first without
// overriding variables already set in the real environment.
type Config struct {
	Addr          string
	BaseURL       string
	DataDir       string
	SecureCookies bool
	TrustProxy    bool

	AdminPath  string
	AdminPhone string
	SessionTTL time.Duration
	OTPTTL     time.Duration

	OSSRegion   string
	OSSEndpoint string
	OSSBucket   string
	OSSKeyID    string
	OSSSecret   string
	OSSPrefix   string
	DownloadTTL time.Duration

	SMSKeyID    string
	SMSSecret   string
	SMSSign     string
	SMSTemplate string
	SMSDev      bool

	CaptchaRegion   string
	CaptchaPrefix   string
	CaptchaSceneID  string
	CaptchaKeyID    string
	CaptchaSecret   string
	CaptchaEndpoint string
	CaptchaDisabled bool
	// encryption mode: the page gets a short-lived EncryptedSceneId signed with the ekey
	CaptchaEncrypt    bool
	CaptchaEKey       string
	CaptchaEncryptTTL time.Duration
	captchaEKey       []byte

	RedisURL string

	RateDownloadsPerHour int
	RateOTPPer10Min      int
	RateUpdatePerMin     int
	RateLoginPer10Min    int
	RateScenePerMin      int

	CMPushKey string
	CMPushURL string

	RateContactPerDay int

	MaxUploadMB int64
	GitHubRepo  string
}

func loadEnvFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(strings.TrimPrefix(sc.Text(), string(rune(0xFEFF))))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		}
		if _, set := os.LookupEnv(k); !set {
			os.Setenv(k, v)
		}
	}
	return sc.Err()
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func envBool(k string, def bool) bool {
	if b, err := strconv.ParseBool(env(k, "")); err == nil {
		return b
	}
	return def
}

func envInt(k string, def int) int {
	if n, err := strconv.Atoi(env(k, "")); err == nil {
		return n
	}
	return def
}

func envDur(k string, def time.Duration) time.Duration {
	if d, err := time.ParseDuration(env(k, "")); err == nil {
		return d
	}
	return def
}

func loadConfig() (*Config, error) {
	c := &Config{
		Addr:          env("ADDR", ":8080"),
		BaseURL:       strings.TrimRight(env("BASE_URL", "https://fk.complexmission.com"), "/"),
		DataDir:       env("DATA_DIR", "./data"),
		SecureCookies: envBool("SECURE_COOKIES", true),
		TrustProxy:    envBool("TRUST_PROXY", true),

		AdminPath:  "/" + strings.Trim(env("ADMIN_PATH", "admin"), "/"),
		AdminPhone: env("ADMIN_PHONE", ""),
		SessionTTL: envDur("SESSION_TTL", 24*time.Hour),
		OTPTTL:     envDur("OTP_TTL", 5*time.Minute),

		OSSRegion:   env("OSS_REGION", "cn-hangzhou"),
		OSSEndpoint: env("OSS_ENDPOINT", ""),
		OSSBucket:   env("OSS_BUCKET", ""),
		OSSKeyID:    env("OSS_ACCESS_KEY_ID", ""),
		OSSSecret:   env("OSS_ACCESS_KEY_SECRET", ""),
		OSSPrefix:   env("OSS_PREFIX", "cm-framekit/"),
		DownloadTTL: envDur("DOWNLOAD_URL_TTL", 15*time.Minute),

		SMSKeyID:    env("ALIYUN_SMS_ACCESS_KEY_ID", ""),
		SMSSecret:   env("ALIYUN_SMS_ACCESS_KEY_SECRET", ""),
		SMSSign:     env("ALIYUN_SMS_SIGN_NAME", ""),
		SMSTemplate: env("ALIYUN_SMS_TEMPLATE_CODE", ""),
		SMSDev:      envBool("SMS_DEV", false),

		CaptchaRegion:   env("CAPTCHA_REGION", "cn"),
		CaptchaPrefix:   env("CAPTCHA_PREFIX", ""),
		CaptchaSceneID:  env("CAPTCHA_SCENE_ID", ""),
		CaptchaKeyID:    env("CAPTCHA_ACCESS_KEY_ID", env("ALIYUN_SMS_ACCESS_KEY_ID", "")),
		CaptchaSecret:   env("CAPTCHA_ACCESS_KEY_SECRET", env("ALIYUN_SMS_ACCESS_KEY_SECRET", "")),
		CaptchaEndpoint: env("CAPTCHA_ENDPOINT", "captcha.cn-shanghai.aliyuncs.com"),
		CaptchaDisabled: envBool("CAPTCHA_DISABLED", false),

		CaptchaEncrypt:    envBool("CAPTCHA_ENCRYPT", false),
		CaptchaEKey:       env("CAPTCHA_EKEY", ""),
		CaptchaEncryptTTL: envDur("CAPTCHA_ENCRYPT_TTL", time.Hour),

		RedisURL: env("REDIS_URL", ""),

		RateDownloadsPerHour: envInt("RATE_DOWNLOADS_PER_HOUR", 30),
		RateOTPPer10Min:      envInt("RATE_OTP_PER_10MIN", 3),
		RateUpdatePerMin:     envInt("RATE_UPDATE_PER_MIN", 30),
		RateLoginPer10Min:    envInt("RATE_LOGIN_PER_10MIN", 10),
		RateScenePerMin:      envInt("RATE_CAPTCHA_SCENE_PER_MIN", 30),

		CMPushKey: env("CM_PUSH_APP_KEY", ""),
		CMPushURL: env("CM_PUSH_URL", "https://cm-notification.complexmission.com/push"),

		RateContactPerDay: envInt("RATE_CONTACT_PER_DAY", 5),

		MaxUploadMB: int64(envInt("MAX_UPLOAD_MB", 1024)),
		GitHubRepo:  env("GITHUB_REPO", "complex-mission/cm-framekit"),
	}
	if c.OSSPrefix != "" && !strings.HasSuffix(c.OSSPrefix, "/") {
		c.OSSPrefix += "/"
	}
	if c.AdminPath == "/" {
		return nil, fmt.Errorf("ADMIN_PATH must not be empty")
	}
	if c.AdminPhone == "" {
		return nil, fmt.Errorf("ADMIN_PHONE is required: only this phone number can sign in to the admin")
	}
	if !c.SMSDev && (c.SMSKeyID == "" || c.SMSSecret == "" || c.SMSSign == "" || c.SMSTemplate == "") {
		return nil, fmt.Errorf("Aliyun SMS is not configured (ALIYUN_SMS_*); set SMS_DEV=true only for local testing")
	}
	if !c.CaptchaDisabled && (c.CaptchaPrefix == "" || c.CaptchaSceneID == "" || c.CaptchaKeyID == "" || c.CaptchaSecret == "") {
		return nil, fmt.Errorf("Aliyun Captcha is not configured (CAPTCHA_PREFIX, CAPTCHA_SCENE_ID, access key); set CAPTCHA_DISABLED=true only for local testing")
	}
	if c.CaptchaEncrypt && !c.CaptchaDisabled {
		key, err := base64.StdEncoding.DecodeString(c.CaptchaEKey)
		if err != nil || len(key) != 32 {
			return nil, fmt.Errorf("CAPTCHA_ENCRYPT=true needs CAPTCHA_EKEY: the console's ekey, base64 of 32 bytes")
		}
		if s := c.CaptchaEncryptTTL.Seconds(); s < 60 || s > 86400 {
			return nil, fmt.Errorf("CAPTCHA_ENCRYPT_TTL must be between 1m and 24h")
		}
		c.captchaEKey = key
	}
	return c, nil
}

func (c *Config) captchaEnabled() bool { return !c.CaptchaDisabled }

func (c *Config) ossEnabled() bool {
	return c.OSSBucket != "" && c.OSSKeyID != "" && c.OSSSecret != ""
}
