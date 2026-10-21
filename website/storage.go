package main

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
)

// Storage keeps installer files. OSS (private bucket, presigned download links) in production;
// a local folder under DATA_DIR when OSS is not configured, for development.
type Storage interface {
	Put(ctx context.Context, key, localPath string) error
	// DownloadURL returns a time-limited URL; "" means serve it with ServeLocal.
	DownloadURL(ctx context.Context, key, filename string) (string, error)
	Delete(ctx context.Context, key string) error
	Name() string
}

func newStorage(c *Config) Storage {
	if !c.ossEnabled() {
		return &localStorage{dir: filepath.Join(c.DataDir, "files")}
	}
	cfg := oss.LoadDefaultConfig().
		WithCredentialsProvider(credentials.NewStaticCredentialsProvider(c.OSSKeyID, c.OSSSecret)).
		WithRegion(c.OSSRegion)
	if c.OSSEndpoint != "" {
		cfg = cfg.WithEndpoint(c.OSSEndpoint)
	}
	return &ossStorage{client: oss.NewClient(cfg), bucket: c.OSSBucket, ttl: c.DownloadTTL}
}

type ossStorage struct {
	client *oss.Client
	bucket string
	ttl    time.Duration
}

func (s *ossStorage) Name() string { return "oss://" + s.bucket }

func (s *ossStorage) Put(ctx context.Context, key, localPath string) error {
	_, err := s.client.NewUploader().UploadFile(ctx, &oss.PutObjectRequest{
		Bucket: oss.Ptr(s.bucket),
		Key:    oss.Ptr(key),
	}, localPath)
	return err
}

func (s *ossStorage) DownloadURL(ctx context.Context, key, filename string) (string, error) {
	r, err := s.client.Presign(ctx, &oss.GetObjectRequest{
		Bucket:                     oss.Ptr(s.bucket),
		Key:                        oss.Ptr(key),
		ResponseContentDisposition: oss.Ptr(contentDisposition(filename)),
	}, oss.PresignExpires(s.ttl))
	if err != nil {
		return "", err
	}
	return r.URL, nil
}

func (s *ossStorage) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &oss.DeleteObjectRequest{Bucket: oss.Ptr(s.bucket), Key: oss.Ptr(key)})
	return err
}

type localStorage struct{ dir string }

func (s *localStorage) Name() string { return "local:" + s.dir }

func (s *localStorage) path(key string) string {
	return filepath.Join(s.dir, filepath.FromSlash(key))
}

func (s *localStorage) Put(_ context.Context, key, localPath string) error {
	dst := s.path(key)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func (s *localStorage) DownloadURL(context.Context, string, string) (string, error) { return "", nil }

func (s *localStorage) Delete(_ context.Context, key string) error {
	err := os.Remove(s.path(key))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func contentDisposition(filename string) string {
	ascii := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, filename)
	return fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, ascii, url.PathEscape(filename))
}
