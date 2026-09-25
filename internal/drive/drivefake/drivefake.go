// Package drivefake is an in-memory stand-in for the parts of the Google
// Drive v3 REST API that HexNote uses. It exists for tests only: point a
// drive.Client at Server.URL with drive.NewClientWithEndpoint and the real
// generated API client talks to it over HTTP.
//
// Supported: about, files list (the query shapes HexNote builds), get,
// download (alt=media), create and update (metadata-only and multipart
// upload), addParents/removeParents, trash, revisions, permissions.
package drivefake

import (
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"google.golang.org/api/drive/v3"
)

const FolderMime = "application/vnd.google-apps.folder"

// File is one stored Drive file.
type File struct {
	ID           string
	Name         string
	MimeType     string
	Parents      []string
	Trashed      bool
	Content      []byte
	ModifiedTime time.Time
	ModifiedBy   string
	Revisions    []Revision
}

type Revision struct {
	ID           string
	ModifiedTime time.Time
	Content      []byte
	ModifiedBy   string
}

// Server is a fake Drive backend. All exported fields may be changed by a
// test between calls; hold Mu while doing so if requests may be in flight.
type Server struct {
	*httptest.Server

	Mu          sync.Mutex
	Files       map[string]*File
	Permissions map[string][]*drive.Permission
	Email       string
	// User is recorded as the last modifying user on writes.
	User string
	// FailStatus, when non-zero, makes every request fail with that HTTP status.
	FailStatus int
	// FailFor makes requests whose "METHOD path?decoded-query" contains the
	// key fail with the mapped status (for example "PATCH /drive/v3/files/abc":
	// 403, or "'folderID' in parents": 503 to fail one folder listing).
	FailFor map[string]int
	// Requests records "METHOD path?query" for every request.
	Requests []string

	nextID int
	clock  time.Time
}

// New starts a fake Drive server. Close it with Close().
func New() *Server {
	s := &Server{
		Files:       map[string]*File{},
		Permissions: map[string][]*drive.Permission{},
		Email:       "owner@example.com",
		User:        "Owner",
		FailFor:     map[string]int{},
		clock:       time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC),
	}
	s.Server = httptest.NewServer(http.HandlerFunc(s.handle))
	return s
}

// Endpoint is the base path to pass to drive.NewClientWithEndpoint.
func (s *Server) Endpoint() string { return s.URL + "/drive/v3/" }

// Tick advances the fake clock and returns the new time. Every write
// advances it too, so modifiedTime values are strictly increasing.
func (s *Server) tick() time.Time {
	s.clock = s.clock.Add(10 * time.Second)
	return s.clock
}

// Put stores a file directly (as if another user created it) and returns it.
func (s *Server) Put(id, name, mimeType, parent, content string) *File {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	if id == "" {
		id = s.newID()
	}
	f := &File{ID: id, Name: name, MimeType: mimeType, Content: []byte(content), ModifiedTime: s.tick(), ModifiedBy: s.User}
	if parent != "" {
		f.Parents = []string{parent}
	}
	f.Revisions = []Revision{{ID: "r1", ModifiedTime: f.ModifiedTime, Content: f.Content, ModifiedBy: f.ModifiedBy}}
	s.Files[id] = f
	return f
}

// Edit changes a file's content as another user would.
func (s *Server) Edit(id, content, by string) {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	f := s.Files[id]
	f.Content = []byte(content)
	f.ModifiedTime = s.tick()
	f.ModifiedBy = by
	f.Revisions = append(f.Revisions, Revision{ID: fmt.Sprintf("r%d", len(f.Revisions)+1), ModifiedTime: f.ModifiedTime, Content: f.Content, ModifiedBy: by})
}

// Get returns a copy of a stored file, or nil.
func (s *Server) Get(id string) *File {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	f, ok := s.Files[id]
	if !ok {
		return nil
	}
	c := *f
	return &c
}

// FindByName returns the first non-trashed file with the given name.
func (s *Server) FindByName(name string) *File {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	ids := make([]string, 0, len(s.Files))
	for id := range s.Files {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		f := s.Files[id]
		if f.Name == name && !f.Trashed {
			c := *f
			return &c
		}
	}
	return nil
}

func (s *Server) newID() string {
	s.nextID++
	return fmt.Sprintf("fake%03d", s.nextID)
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.Mu.Lock()
	defer s.Mu.Unlock()

	key := r.Method + " " + r.URL.Path
	query, _ := url.QueryUnescape(r.URL.RawQuery)
	full := key + "?" + query
	s.Requests = append(s.Requests, full)
	if s.FailStatus != 0 {
		writeError(w, s.FailStatus, "forced failure")
		return
	}
	for k, code := range s.FailFor {
		if strings.Contains(full, k) {
			writeError(w, code, "forced failure for "+k)
			return
		}
	}

	path := r.URL.Path
	upload := strings.HasPrefix(path, "/upload")
	path = strings.TrimPrefix(path, "/upload")
	path = strings.TrimPrefix(path, "/drive/v3")
	parts := strings.Split(strings.Trim(path, "/"), "/")

	switch {
	case len(parts) == 1 && parts[0] == "about":
		writeJSON(w, map[string]any{"user": map[string]any{"emailAddress": s.Email, "displayName": s.User}})
	case len(parts) == 1 && parts[0] == "files" && r.Method == http.MethodGet:
		s.list(w, r)
	case len(parts) == 1 && parts[0] == "files" && r.Method == http.MethodPost:
		s.create(w, r, upload)
	case len(parts) == 2 && parts[0] == "files" && r.Method == http.MethodGet:
		s.get(w, r, parts[1])
	case len(parts) == 2 && parts[0] == "files" && r.Method == http.MethodPatch:
		s.update(w, r, parts[1], upload)
	case len(parts) == 3 && parts[2] == "revisions":
		s.listRevisions(w, parts[1])
	case len(parts) == 4 && parts[2] == "revisions":
		s.getRevision(w, r, parts[1], parts[3])
	case len(parts) == 3 && parts[2] == "permissions" && r.Method == http.MethodGet:
		writeJSON(w, map[string]any{"permissions": s.Permissions[parts[1]]})
	case len(parts) == 3 && parts[2] == "permissions" && r.Method == http.MethodPost:
		var p drive.Permission
		json.NewDecoder(r.Body).Decode(&p)
		p.Id = s.newID()
		p.Type = "user"
		s.Permissions[parts[1]] = append(s.Permissions[parts[1]], &p)
		writeJSON(w, p)
	case len(parts) == 4 && parts[2] == "permissions" && r.Method == http.MethodDelete:
		list := s.Permissions[parts[1]]
		for i, p := range list {
			if p.Id == parts[3] {
				s.Permissions[parts[1]] = append(list[:i], list[i+1:]...)
				break
			}
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		writeError(w, http.StatusNotImplemented, "drivefake: unsupported "+key)
	}
}

func (s *Server) toAPI(f *File) *drive.File {
	out := &drive.File{
		Id:           f.ID,
		Name:         f.Name,
		MimeType:     f.MimeType,
		Parents:      f.Parents,
		Trashed:      f.Trashed,
		ModifiedTime: f.ModifiedTime.Format(time.RFC3339Nano),
		Size:         int64(len(f.Content)),
	}
	if f.ModifiedBy != "" {
		out.LastModifyingUser = &drive.User{DisplayName: f.ModifiedBy}
	}
	return out
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	match := parseQuery(r.URL.Query().Get("q"))
	ids := make([]string, 0, len(s.Files))
	for id := range s.Files {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	files := []*drive.File{}
	for _, id := range ids {
		if match(s.Files[id]) {
			files = append(files, s.toAPI(s.Files[id]))
		}
	}
	writeJSON(w, map[string]any{"files": files})
}

// parseQuery understands the clause shapes HexNote generates, joined by " and ".
func parseQuery(q string) func(*File) bool {
	var preds []func(*File) bool
	for _, clause := range strings.Split(q, " and ") {
		clause = strings.TrimSpace(clause)
		switch {
		case clause == "":
		case strings.HasSuffix(clause, " in parents"):
			id := unquote(strings.TrimSuffix(clause, " in parents"))
			preds = append(preds, func(f *File) bool {
				for _, p := range f.Parents {
					if p == id {
						return true
					}
				}
				return false
			})
		case clause == "trashed=false":
			preds = append(preds, func(f *File) bool { return !f.Trashed })
		case strings.HasPrefix(clause, "mimeType="):
			m := unquote(strings.TrimPrefix(clause, "mimeType="))
			preds = append(preds, func(f *File) bool { return f.MimeType == m })
		case strings.HasPrefix(clause, "name contains "):
			n := unquote(strings.TrimPrefix(clause, "name contains "))
			preds = append(preds, func(f *File) bool { return strings.Contains(f.Name, n) })
		case strings.HasPrefix(clause, "name="):
			n := unquote(strings.TrimPrefix(clause, "name="))
			preds = append(preds, func(f *File) bool { return f.Name == n })
		case clause == "sharedWithMe=true":
			preds = append(preds, func(f *File) bool { return false })
		}
	}
	return func(f *File) bool {
		for _, p := range preds {
			if !p(f) {
				return false
			}
		}
		return true
	}
}

func unquote(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "'")
	s = strings.TrimSuffix(s, "'")
	s = strings.ReplaceAll(s, `\'`, `'`)
	return strings.ReplaceAll(s, `\\`, `\`)
}

func (s *Server) get(w http.ResponseWriter, r *http.Request, id string) {
	f, ok := s.Files[id]
	if !ok {
		writeError(w, http.StatusNotFound, "File not found: "+id)
		return
	}
	if r.URL.Query().Get("alt") == "media" {
		w.Write(f.Content)
		return
	}
	writeJSON(w, s.toAPI(f))
}

// readBody returns the JSON metadata and (for uploads) the media bytes.
func readBody(r *http.Request, upload bool) (*drive.File, []byte, bool, error) {
	meta := &drive.File{}
	if !upload {
		if err := json.NewDecoder(r.Body).Decode(meta); err != nil && err != io.EOF {
			return nil, nil, false, err
		}
		return meta, nil, false, nil
	}
	mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		return nil, nil, false, err
	}
	if !strings.HasPrefix(mediaType, "multipart/") {
		data, err := io.ReadAll(r.Body)
		return meta, data, true, err
	}
	mr := multipart.NewReader(r.Body, params["boundary"])
	var media []byte
	for i := 0; ; i++ {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, false, err
		}
		data, _ := io.ReadAll(p)
		if i == 0 {
			json.Unmarshal(data, meta)
		} else {
			media = data
		}
	}
	return meta, media, true, nil
}

func (s *Server) create(w http.ResponseWriter, r *http.Request, upload bool) {
	meta, media, hasMedia, err := readBody(r, upload)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	f := &File{ID: s.newID(), Name: meta.Name, MimeType: meta.MimeType, Parents: meta.Parents, ModifiedTime: s.tick(), ModifiedBy: s.User}
	if f.MimeType == "" {
		f.MimeType = "text/plain"
	}
	if hasMedia {
		f.Content = media
	}
	f.Revisions = []Revision{{ID: "r1", ModifiedTime: f.ModifiedTime, Content: f.Content, ModifiedBy: s.User}}
	s.Files[f.ID] = f
	writeJSON(w, s.toAPI(f))
}

func (s *Server) update(w http.ResponseWriter, r *http.Request, id string, upload bool) {
	f, ok := s.Files[id]
	if !ok {
		writeError(w, http.StatusNotFound, "File not found: "+id)
		return
	}
	meta, media, hasMedia, err := readBody(r, upload)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if meta.Name != "" {
		f.Name = meta.Name
	}
	if meta.Trashed {
		f.Trashed = true
	}
	q := r.URL.Query()
	if rm := q.Get("removeParents"); rm != "" {
		remove := map[string]bool{}
		for _, p := range strings.Split(rm, ",") {
			remove[p] = true
		}
		kept := []string{}
		for _, p := range f.Parents {
			if !remove[p] {
				kept = append(kept, p)
			}
		}
		f.Parents = kept
	}
	if add := q.Get("addParents"); add != "" {
		f.Parents = append(f.Parents, strings.Split(add, ",")...)
	}
	if hasMedia {
		f.Content = media
		f.Revisions = append(f.Revisions, Revision{ID: fmt.Sprintf("r%d", len(f.Revisions)+1), Content: media, ModifiedBy: s.User})
	}
	f.ModifiedTime = s.tick()
	f.ModifiedBy = s.User
	if hasMedia {
		f.Revisions[len(f.Revisions)-1].ModifiedTime = f.ModifiedTime
	}
	writeJSON(w, s.toAPI(f))
}

func (s *Server) listRevisions(w http.ResponseWriter, id string) {
	f, ok := s.Files[id]
	if !ok {
		writeError(w, http.StatusNotFound, "File not found: "+id)
		return
	}
	revs := []*drive.Revision{}
	for _, rv := range f.Revisions {
		revs = append(revs, &drive.Revision{Id: rv.ID, ModifiedTime: rv.ModifiedTime.Format(time.RFC3339Nano), Size: int64(len(rv.Content)), LastModifyingUser: &drive.User{DisplayName: rv.ModifiedBy}})
	}
	writeJSON(w, map[string]any{"revisions": revs})
}

func (s *Server) getRevision(w http.ResponseWriter, r *http.Request, id, rev string) {
	f, ok := s.Files[id]
	if !ok {
		writeError(w, http.StatusNotFound, "File not found: "+id)
		return
	}
	for _, rv := range f.Revisions {
		if rv.ID == rev {
			w.Write(rv.Content)
			return
		}
	}
	writeError(w, http.StatusNotFound, "Revision not found: "+rev)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": code, "message": msg, "errors": []map[string]any{{"message": msg, "reason": http.StatusText(code)}}}})
}
