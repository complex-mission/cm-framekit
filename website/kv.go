package main

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// KV holds short-lived state (sessions, login codes, rate-limit counters). Redis when REDIS_URL is
// set, so state survives restarts and is shared between instances; otherwise process memory.
type KV interface {
	Set(ctx context.Context, key, val string, ttl time.Duration) error
	Get(ctx context.Context, key string) (string, bool, error)
	Del(ctx context.Context, key string) error
	// Incr bumps a counter; the ttl starts when the key is created (fixed window).
	Incr(ctx context.Context, key string, ttl time.Duration) (int64, error)
	Name() string
}

func newKV(redisURL string) (KV, error) {
	if redisURL == "" {
		return newMemKV(), nil
	}
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	c := redis.NewClient(opt)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Ping(ctx).Err(); err != nil {
		return nil, err
	}
	return &redisKV{c: c, prefix: "fk:"}, nil
}

type redisKV struct {
	c      *redis.Client
	prefix string
}

func (r *redisKV) Name() string { return "redis" }

func (r *redisKV) Set(ctx context.Context, key, val string, ttl time.Duration) error {
	return r.c.Set(ctx, r.prefix+key, val, ttl).Err()
}

func (r *redisKV) Get(ctx context.Context, key string) (string, bool, error) {
	v, err := r.c.Get(ctx, r.prefix+key).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	return v, err == nil, err
}

func (r *redisKV) Del(ctx context.Context, key string) error {
	return r.c.Del(ctx, r.prefix+key).Err()
}

func (r *redisKV) Incr(ctx context.Context, key string, ttl time.Duration) (int64, error) {
	k := r.prefix + key
	pipe := r.c.TxPipeline()
	incr := pipe.Incr(ctx, k)
	pipe.ExpireNX(ctx, k, ttl)
	if _, err := pipe.Exec(ctx); err != nil {
		return 0, err
	}
	return incr.Val(), nil
}

type memItem struct {
	val string
	n   int64
	exp time.Time
}

type memKV struct {
	mu sync.Mutex
	m  map[string]*memItem
}

func newMemKV() *memKV {
	m := &memKV{m: map[string]*memItem{}}
	go func() {
		for range time.Tick(time.Minute) {
			now := time.Now()
			m.mu.Lock()
			for k, it := range m.m {
				if now.After(it.exp) {
					delete(m.m, k)
				}
			}
			m.mu.Unlock()
		}
	}()
	return m
}

func (m *memKV) Name() string { return "memory" }

func (m *memKV) live(key string) *memItem {
	it := m.m[key]
	if it != nil && time.Now().After(it.exp) {
		delete(m.m, key)
		return nil
	}
	return it
}

func (m *memKV) Set(_ context.Context, key, val string, ttl time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.m[key] = &memItem{val: val, exp: time.Now().Add(ttl)}
	return nil
}

func (m *memKV) Get(_ context.Context, key string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if it := m.live(key); it != nil {
		return it.val, true, nil
	}
	return "", false, nil
}

func (m *memKV) Del(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.m, key)
	return nil
}

func (m *memKV) Incr(_ context.Context, key string, ttl time.Duration) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	it := m.live(key)
	if it == nil {
		it = &memItem{exp: time.Now().Add(ttl)}
		m.m[key] = it
	}
	it.n++
	return it.n, nil
}

// allow reports whether one more hit fits in limit per window; on a KV error it fails open so a
// Redis outage does not take the site down.
func allow(ctx context.Context, kv KV, name, who string, limit int, window time.Duration) bool {
	if limit <= 0 {
		return true
	}
	bucket := time.Now().Unix() / int64(window.Seconds())
	n, err := kv.Incr(ctx, "rl:"+name+":"+who+":"+itoa(bucket), window)
	if err != nil {
		return true
	}
	return n <= int64(limit)
}
