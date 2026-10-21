package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Release is one uploaded installer. A version can exist once per platform; only published
// releases are visible to the site and the in-app update check.
type Release struct {
	ID          string    `json:"id"`
	Version     string    `json:"version"`
	Platform    string    `json:"platform"`
	Notes       string    `json:"notes"`
	NotesEN     string    `json:"notes_en"`
	Mandatory   bool      `json:"mandatory"`
	FileName    string    `json:"file_name"`
	Key         string    `json:"key"`
	Size        int64     `json:"size"`
	SHA256      string    `json:"sha256"`
	Published   bool      `json:"published"`
	CreatedAt   time.Time `json:"created_at"`
	PublishedAt time.Time `json:"published_at,omitempty"`
	Downloads   int64     `json:"downloads"`
}

var platforms = []string{"windows-x64", "windows-arm64", "macos-arm64", "macos-x64", "linux-x64"}

func validPlatform(p string) bool {
	for _, x := range platforms {
		if x == p {
			return true
		}
	}
	return false
}

var semverRe = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$`)

func validVersion(v string) bool { return semverRe.MatchString(v) }

// cmpVersion compares semantic versions (a leading "v" is ignored); a pre-release sorts before
// its release. Unparsable versions sort lowest.
func cmpVersion(a, b string) int {
	pa, pb := semverRe.FindStringSubmatch(strings.TrimPrefix(a, "v")), semverRe.FindStringSubmatch(strings.TrimPrefix(b, "v"))
	switch {
	case pa == nil && pb == nil:
		return 0
	case pa == nil:
		return -1
	case pb == nil:
		return 1
	}
	for i := 1; i <= 3; i++ {
		x, _ := strconv.Atoi(pa[i])
		y, _ := strconv.Atoi(pb[i])
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	switch {
	case pa[4] == pb[4]:
		return 0
	case pa[4] == "":
		return 1
	case pb[4] == "":
		return -1
	}
	return cmpPre(pa[4], pb[4])
}

func cmpPre(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) && i < len(bs); i++ {
		x, ex := strconv.Atoi(as[i])
		y, ey := strconv.Atoi(bs[i])
		switch {
		case ex == nil && ey == nil && x != y:
			if x < y {
				return -1
			}
			return 1
		case ex == nil && ey != nil:
			return -1
		case ex != nil && ey == nil:
			return 1
		case as[i] != bs[i]:
			return strings.Compare(as[i], bs[i])
		}
	}
	return len(as) - len(bs)
}

type Store struct {
	mu       sync.Mutex
	path     string
	releases []*Release
	dirty    bool
}

func openStore(dataDir string) (*Store, error) {
	s := &Store{path: filepath.Join(dataDir, "releases.json")}
	b, err := os.ReadFile(s.path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if len(b) > 0 {
		if err := json.Unmarshal(b, &s.releases); err != nil {
			return nil, err
		}
	}
	// download counters are flushed lazily
	go func() {
		for range time.Tick(15 * time.Second) {
			s.mu.Lock()
			if s.dirty {
				s.saveLocked()
			}
			s.mu.Unlock()
		}
	}()
	return s, nil
}

func (s *Store) saveLocked() error {
	b, _ := json.MarshalIndent(s.releases, "", "  ")
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}
	s.dirty = false
	return nil
}

func (s *Store) Flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dirty {
		s.saveLocked()
	}
}

// All returns copies sorted newest version first.
func (s *Store) All() []Release {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Release, len(s.releases))
	for i, r := range s.releases {
		out[i] = *r
	}
	sort.SliceStable(out, func(i, j int) bool {
		if c := cmpVersion(out[i].Version, out[j].Version); c != 0 {
			return c > 0
		}
		return out[i].Platform < out[j].Platform
	})
	return out
}

func (s *Store) Published(platform string) []Release {
	var out []Release
	for _, r := range s.All() {
		if r.Published && (platform == "" || r.Platform == platform) {
			out = append(out, r)
		}
	}
	return out
}

func (s *Store) Latest(platform string) (Release, bool) {
	if l := s.Published(platform); len(l) > 0 {
		return l[0], true
	}
	return Release{}, false
}

func (s *Store) Find(platform, version string) (Release, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.releases {
		if r.Platform == platform && r.Version == version {
			return *r, true
		}
	}
	return Release{}, false
}

func (s *Store) Get(id string) (Release, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.releases {
		if r.ID == id {
			return *r, true
		}
	}
	return Release{}, false
}

var errExists = errors.New("this version already exists for this platform")

func (s *Store) Add(r Release) (Release, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, x := range s.releases {
		if x.Platform == r.Platform && x.Version == r.Version {
			return Release{}, errExists
		}
	}
	r.ID = randHex(8)
	r.CreatedAt = time.Now()
	if r.Published {
		r.PublishedAt = r.CreatedAt
	}
	s.releases = append(s.releases, &r)
	return r, s.saveLocked()
}

func (s *Store) Update(id string, fn func(*Release)) (Release, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.releases {
		if r.ID == id {
			was := r.Published
			fn(r)
			if r.Published && !was {
				r.PublishedAt = time.Now()
			}
			return *r, true, s.saveLocked()
		}
	}
	return Release{}, false, nil
}

func (s *Store) Delete(id string) (Release, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, r := range s.releases {
		if r.ID == id {
			s.releases = append(s.releases[:i], s.releases[i+1:]...)
			return *r, true, s.saveLocked()
		}
	}
	return Release{}, false, nil
}

func (s *Store) CountDownload(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.releases {
		if r.ID == id {
			r.Downloads++
			s.dirty = true
			return
		}
	}
}

// ---- audit log: one JSON line per event, one file per month ----

type LogEntry struct {
	Time   time.Time `json:"time"`
	IP     string    `json:"ip"`
	Action string    `json:"action"`
	OK     bool      `json:"ok"`
	Detail string    `json:"detail,omitempty"`
}

type AuditLog struct {
	mu  sync.Mutex
	dir string
}

func (l *AuditLog) file(t time.Time) string {
	return filepath.Join(l.dir, "audit-"+t.Format("2006-01")+".log")
}

func (l *AuditLog) Add(e LogEntry) {
	e.Time = time.Now()
	b, _ := json.Marshal(e)
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := os.OpenFile(l.file(e.Time), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	f.Write(append(b, '\n'))
	f.Close()
}

// Tail returns up to n newest entries (this month and last), filtered by action prefix.
func (l *AuditLog) Tail(n int, action string) []LogEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	var all []LogEntry
	for _, t := range []time.Time{now.AddDate(0, -1, 0), now} {
		f, err := os.Open(l.file(t))
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			var e LogEntry
			if json.Unmarshal(sc.Bytes(), &e) == nil && (action == "" || strings.HasPrefix(e.Action, action)) {
				all = append(all, e)
			}
		}
		f.Close()
	}
	if len(all) > n {
		all = all[len(all)-n:]
	}
	for i, j := 0, len(all)-1; i < j; i, j = i+1, j-1 {
		all[i], all[j] = all[j], all[i]
	}
	return all
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
