package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"hexnote/internal/drive"
	"hexnote/internal/drive/drivefake"
	"hexnote/internal/models"
	"hexnote/internal/storage"

	"golang.org/x/oauth2"
	gdrive "google.golang.org/api/drive/v3"
)

// testApp is an App wired to a temp SQLite DB and a fake Drive server.
type testApp struct {
	*App
	fake *drivefake.Server
	ws   *models.Workspace

	mu     sync.Mutex
	events []recordedEvent
}

type recordedEvent struct {
	name string
	data []interface{}
}

func newTestApp(t *testing.T) *testApp {
	t.Helper()
	dir := t.TempDir()
	db, err := storage.NewDatabase(dir)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	fake := drivefake.New()
	t.Cleanup(func() { fake.Close(); db.Close() })

	fake.Put("root-folder", "Workspace", drivefake.FolderMime, "", "")

	ta := &testApp{fake: fake}
	ta.App = &App{db: db, appDataDir: dir, authMgr: drive.NewAuthManager(dir)}
	ta.App.emitFn = func(name string, data ...interface{}) {
		ta.mu.Lock()
		defer ta.mu.Unlock()
		ta.events = append(ta.events, recordedEvent{name, data})
	}
	ta.connect(t, oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "test"}))

	ws, err := ta.CreateWorkspace("Test", "root-folder")
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	ta.ws = ws
	return ta
}

// connect points the app's Drive client at the fake server using ts.
func (ta *testApp) connect(t *testing.T, ts oauth2.TokenSource) {
	t.Helper()
	client, err := drive.NewClientWithEndpoint(context.Background(), ts, ta.fake.Endpoint())
	if err != nil {
		t.Fatalf("NewClientWithEndpoint: %v", err)
	}
	ta.setDrive(client)
}

// refresh runs TriggerSync and returns only its error.
func (ta *testApp) refresh() error {
	_, err := ta.TriggerSync()
	return err
}

// disconnect simulates being offline / signed out.
func (ta *testApp) disconnect() {
	ta.setDrive(nil)
}

func (ta *testApp) eventNames() []string {
	ta.mu.Lock()
	defer ta.mu.Unlock()
	var names []string
	for _, e := range ta.events {
		names = append(names, e.name)
	}
	return names
}

func (ta *testApp) notifications() []string {
	ta.mu.Lock()
	defer ta.mu.Unlock()
	var out []string
	for _, e := range ta.events {
		if e.name == "notification" && len(e.data) > 0 {
			if m, ok := e.data[0].(map[string]string); ok {
				out = append(out, m["message"])
			}
		}
	}
	return out
}

// newPublishedPage creates a page with content and publishes it.
func (ta *testApp) newPublishedPage(t *testing.T, title, content, parentID string) *models.Document {
	t.Helper()
	doc, err := ta.CreateDocument(title, parentID, false)
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	if _, err := ta.UpdateDocument(doc.ID, title, content); err != nil {
		t.Fatalf("UpdateDocument: %v", err)
	}
	pub, err := ta.PublishDocument(doc.ID)
	if err != nil {
		t.Fatalf("PublishDocument: %v", err)
	}
	return pub
}

func (ta *testApp) titles(t *testing.T) []string {
	t.Helper()
	tree, err := ta.GetDocumentTree()
	if err != nil {
		t.Fatalf("GetDocumentTree: %v", err)
	}
	var out []string
	var walk func([]*models.TreeNode, string)
	walk = func(nodes []*models.TreeNode, prefix string) {
		for _, n := range nodes {
			out = append(out, prefix+n.Document.Title)
			walk(n.Children, prefix+n.Document.Title+"/")
		}
	}
	walk(tree, "")
	return out
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// === Item 4: deleted pages must not come back ===

func TestDeletePublishedPageTrashesDriveFile(t *testing.T) {
	ta := newTestApp(t)
	doc := ta.newPublishedPage(t, "Roadmap", "# Roadmap\n", "")

	if err := ta.DeleteDocument(doc.ID); err != nil {
		t.Fatalf("DeleteDocument: %v", err)
	}
	if f := ta.fake.Get(doc.DriveFileID); f == nil || !f.Trashed {
		t.Fatalf("Drive file should be trashed, got %+v", f)
	}
	if err := ta.refresh(); err != nil {
		t.Fatalf("TriggerSync: %v", err)
	}
	if contains(ta.titles(t), "Roadmap") {
		t.Fatalf("deleted page came back after refresh: %v", ta.titles(t))
	}
}

func TestDeleteFolderTrashesFolderOnce(t *testing.T) {
	ta := newTestApp(t)
	folder, _ := ta.CreateDocument("Design", "", true)
	child := ta.newPublishedPage(t, "Art Bible", "colours\n", folder.ID)
	folderDoc, _ := ta.GetDocument(folder.ID)
	if folderDoc.DriveFileID == "" {
		t.Fatal("publishing the child should have published the folder")
	}

	if err := ta.DeleteDocument(folder.ID); err != nil {
		t.Fatalf("DeleteDocument: %v", err)
	}
	if !ta.fake.Get(folderDoc.DriveFileID).Trashed {
		t.Error("folder should be trashed on Drive")
	}
	if ta.fake.Get(child.DriveFileID).Trashed {
		t.Error("child should not be trashed separately (trashing the folder covers it)")
	}
	ta.refresh()
	if len(ta.titles(t)) != 0 {
		t.Fatalf("folder contents came back: %v", ta.titles(t))
	}
}

func TestDeleteDraftTouchesNoDriveFile(t *testing.T) {
	ta := newTestApp(t)
	doc, _ := ta.CreateDocument("Scratch", "", false)
	before := len(ta.fake.Requests)
	if err := ta.DeleteDocument(doc.ID); err != nil {
		t.Fatalf("DeleteDocument: %v", err)
	}
	if len(ta.fake.Requests) != before {
		t.Errorf("deleting a draft should not call Drive, got %v", ta.fake.Requests[before:])
	}
	ids, _ := ta.db.GetDeletedDriveFiles(ta.ws.ID)
	if len(ids) != 0 {
		t.Errorf("no tombstone expected, got %v", ids)
	}
}

func TestDeleteWhileOfflineRecordsTombstoneAndRetries(t *testing.T) {
	ta := newTestApp(t)
	doc := ta.newPublishedPage(t, "Offline", "x\n", "")
	client := ta.client()

	ta.disconnect()
	if err := ta.DeleteDocument(doc.ID); err != nil {
		t.Fatalf("DeleteDocument offline: %v", err)
	}
	ids, _ := ta.db.GetDeletedDriveFiles(ta.ws.ID)
	if len(ids) != 1 || ids[0] != doc.DriveFileID {
		t.Fatalf("tombstone = %v, want [%s]", ids, doc.DriveFileID)
	}
	if n := ta.notifications(); len(n) != 1 || !strings.Contains(n[0], "next refresh") {
		t.Errorf("expected a 'next refresh' notification, got %v", n)
	}
	if ta.fake.Get(doc.DriveFileID).Trashed {
		t.Fatal("file cannot be trashed while offline")
	}

	// Back online: the refresh must skip the file and retry the trash.
	ta.setDrive(client)
	if err := ta.refresh(); err != nil {
		t.Fatalf("TriggerSync: %v", err)
	}
	if contains(ta.titles(t), "Offline") {
		t.Fatal("tombstoned page came back")
	}
	if !ta.fake.Get(doc.DriveFileID).Trashed {
		t.Error("refresh should retry and trash the file")
	}
	ids, _ = ta.db.GetDeletedDriveFiles(ta.ws.ID)
	if len(ids) != 0 {
		t.Errorf("tombstone should be cleared after trash succeeds, got %v", ids)
	}
}

func TestDeleteWithoutPermissionKeepsTombstone(t *testing.T) {
	ta := newTestApp(t)
	doc := ta.newPublishedPage(t, "Theirs", "x\n", "")
	ta.fake.FailFor["PATCH /drive/v3/files/"+doc.DriveFileID] = 403

	if err := ta.DeleteDocument(doc.ID); err != nil {
		t.Fatalf("DeleteDocument: %v", err)
	}
	if n := ta.notifications(); len(n) != 1 || !strings.Contains(n[0], "permission") {
		t.Errorf("expected a permission notification, got %v", n)
	}
	if err := ta.refresh(); err != nil {
		t.Fatalf("TriggerSync: %v", err)
	}
	if contains(ta.titles(t), "Theirs") {
		t.Fatal("page came back despite tombstone")
	}
	ids, _ := ta.db.GetDeletedDriveFiles(ta.ws.ID)
	if len(ids) != 1 {
		t.Errorf("tombstone must stay while trash is forbidden, got %v", ids)
	}
}

func TestDeleteAlreadyGoneOnDriveIsFine(t *testing.T) {
	ta := newTestApp(t)
	doc := ta.newPublishedPage(t, "Gone", "x\n", "")
	ta.fake.Mu.Lock()
	delete(ta.fake.Files, doc.DriveFileID)
	ta.fake.Mu.Unlock()

	if err := ta.DeleteDocument(doc.ID); err != nil {
		t.Fatalf("DeleteDocument: %v", err)
	}
	ids, _ := ta.db.GetDeletedDriveFiles(ta.ws.ID)
	if len(ids) != 0 {
		t.Errorf("404 means done, no tombstone expected, got %v", ids)
	}
	if n := ta.notifications(); len(n) != 0 {
		t.Errorf("no warning expected, got %v", n)
	}
}

// A teammate deleting a page (trashing its Drive file) removes it here on
// refresh, but local unpublished edits are never thrown away.
func TestRefreshRemovesPagesTrashedByTeammate(t *testing.T) {
	ta := newTestApp(t)
	clean := ta.newPublishedPage(t, "Clean", "a\n", "")
	edited := ta.newPublishedPage(t, "Edited", "b\n", "")
	if _, err := ta.UpdateDocument(edited.ID, "Edited", "b plus my local edit\n"); err != nil {
		t.Fatal(err)
	}

	ta.fake.Mu.Lock()
	ta.fake.Files[clean.DriveFileID].Trashed = true
	ta.fake.Files[edited.DriveFileID].Trashed = true
	ta.fake.Mu.Unlock()

	if err := ta.refresh(); err != nil {
		t.Fatalf("TriggerSync: %v", err)
	}
	titles := ta.titles(t)
	if contains(titles, "Clean") {
		t.Errorf("page trashed by teammate should be removed locally: %v", titles)
	}
	got, err := ta.GetDocument(edited.ID)
	if err != nil {
		t.Fatalf("page with local edits must be kept: %v", err)
	}
	if got.DriveFileID != "" || got.Status != "draft" || !strings.Contains(got.Content, "my local edit") {
		t.Errorf("edited page should be an unlinked draft with its edits, got %+v", got)
	}
	if !contains(ta.eventNames(), "sync:docs-removed") {
		t.Errorf("expected sync:docs-removed event, got %v", ta.eventNames())
	}

	// Publishing the kept draft creates a new file instead of writing into the trashed one.
	pub, err := ta.PublishDocument(edited.ID)
	if err != nil {
		t.Fatalf("PublishDocument: %v", err)
	}
	if pub.DriveFileID == edited.DriveFileID || ta.fake.Get(pub.DriveFileID).Trashed {
		t.Errorf("republish should create a fresh Drive file, got %s", pub.DriveFileID)
	}
}

// A listing failure in a subfolder must abort the refresh, not make every
// page in that folder look deleted.
func TestRefreshWithFailedSubfolderListingDeletesNothing(t *testing.T) {
	ta := newTestApp(t)
	folder, _ := ta.CreateDocument("Design", "", true)
	ta.newPublishedPage(t, "Inside", "x\n", folder.ID)
	folderDoc, _ := ta.GetDocument(folder.ID)

	ta.fake.FailFor["'"+folderDoc.DriveFileID+"' in parents"] = 503
	if err := ta.refresh(); err == nil {
		t.Fatal("expected refresh error when a subfolder cannot be listed")
	}
	if !contains(ta.titles(t), "Design/Inside") {
		t.Fatalf("pages must survive a failed refresh: %v", ta.titles(t))
	}
}

// === Item 5: a revoked sign-in ends the session cleanly ===

// revokedTokenSource fails like Google's token endpoint does for a revoked
// or expired refresh token.
type revokedTokenSource struct{}

func (revokedTokenSource) Token() (*oauth2.Token, error) {
	return nil, &oauth2.RetrieveError{
		Response:  &http.Response{StatusCode: http.StatusBadRequest},
		Body:      []byte(`{"error":"invalid_grant","error_description":"Token has been expired or revoked."}`),
		ErrorCode: "invalid_grant",
	}
}

// signIn writes credentials and a token to disk, as a real sign-in would.
func (ta *testApp) signIn(t *testing.T) {
	t.Helper()
	creds := `{"installed":{"client_id":"cid.apps.googleusercontent.com","client_secret":"s"}}`
	if err := ta.authMgr.SaveCredentials(creds); err != nil {
		t.Fatalf("SaveCredentials: %v", err)
	}
	tok := `{"access_token":"a","refresh_token":"r","token_type":"Bearer"}`
	os.WriteFile(filepath.Join(ta.appDataDir, "token.json"), []byte(tok), 0600)
	os.WriteFile(filepath.Join(ta.appDataDir, "token_scope"), []byte("drive"), 0600)
	if err := ta.authMgr.LoadCredentials(); err != nil || !ta.authMgr.HasValidToken() {
		t.Fatalf("expected a loaded token, err=%v", err)
	}
}

func TestRevokedTokenExpiresSessionOnDriveCall(t *testing.T) {
	ta := newTestApp(t)
	ta.signIn(t)
	ta.connect(t, revokedTokenSource{})

	err := ta.refresh()
	if err == nil || !strings.HasPrefix(err.Error(), "ERR_AUTH:") {
		t.Fatalf("TriggerSync error = %v, want ERR_AUTH prefix", err)
	}
	if ta.client() != nil || ta.syncer() != nil {
		t.Error("Drive client should be cleared")
	}
	if ta.authMgr.HasValidToken() {
		t.Error("token should be cleared")
	}
	if _, statErr := os.Stat(filepath.Join(ta.appDataDir, "token.json")); !os.IsNotExist(statErr) {
		t.Error("token.json should be deleted")
	}
	if names := ta.eventNames(); !contains(names, "auth:expired") {
		t.Errorf("expected auth:expired event, got %v", names)
	}

	// Further calls fail cleanly without another event.
	if _, err := ta.PublishDocument("nope"); err == nil || !strings.HasPrefix(err.Error(), "ERR_AUTH:") {
		t.Errorf("PublishDocument after expiry = %v, want ERR_AUTH", err)
	}
	count := 0
	for _, n := range ta.eventNames() {
		if n == "auth:expired" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("auth:expired emitted %d times, want 1", count)
	}
}

func TestGetAuthStatusReportsExpiredSignIn(t *testing.T) {
	ta := newTestApp(t)
	ta.signIn(t)
	ta.connect(t, revokedTokenSource{})

	st, err := ta.GetAuthStatus()
	if err != nil {
		t.Fatal(err)
	}
	if st.IsSignedIn || !st.SessionExpired || !st.HasCredentials {
		t.Errorf("status = %+v, want signed out, expired, credentials kept", st)
	}
}

func TestGetAuthStatusOfflineStaysSignedIn(t *testing.T) {
	ta := newTestApp(t)
	ta.signIn(t)

	st, _ := ta.GetAuthStatus()
	if !st.IsSignedIn || st.UserEmail != "owner@example.com" {
		t.Fatalf("online status = %+v", st)
	}

	ta.fake.Close() // network gone: connection refused
	st, _ = ta.GetAuthStatus()
	if !st.IsSignedIn || st.SessionExpired {
		t.Errorf("offline must stay signed in, got %+v", st)
	}
	if st.UserEmail != "owner@example.com" || !st.Offline {
		t.Errorf("offline status should report the cached email and Offline, got %+v", st)
	}
	if !ta.authMgr.HasValidToken() {
		t.Error("offline must not clear the token")
	}
	if err := ta.refresh(); err == nil || !strings.HasPrefix(err.Error(), "ERR_OFFLINE:") {
		t.Errorf("TriggerSync offline = %v, want ERR_OFFLINE", err)
	}
	if ta.client() == nil {
		t.Error("offline must keep the Drive client")
	}
}

func TestImportDifferentCredentialsSignsOut(t *testing.T) {
	ta := newTestApp(t)
	ta.signIn(t)

	// Same client again: stays signed in.
	if err := ta.ImportCredentials(`{"installed":{"client_id":"cid.apps.googleusercontent.com","client_secret":"s"}}`); err != nil {
		t.Fatal(err)
	}
	if !ta.authMgr.HasValidToken() {
		t.Fatal("re-importing the same client must keep the sign-in")
	}
	// Different client: the token cannot work with it.
	if err := ta.ImportCredentials(`{"installed":{"client_id":"other.apps.googleusercontent.com","client_secret":"s"}}`); err != nil {
		t.Fatal(err)
	}
	if ta.authMgr.HasValidToken() || ta.client() != nil {
		t.Error("switching OAuth client must sign out")
	}
}

// === Item 6: folder renames reach Drive ===

func (ta *testApp) publishedFolder(t *testing.T, title string) *models.Document {
	t.Helper()
	folder, _ := ta.CreateDocument(title, "", true)
	if _, err := ta.PublishDocument(folder.ID); err != nil {
		t.Fatalf("PublishDocument(folder): %v", err)
	}
	doc, _ := ta.GetDocument(folder.ID)
	return doc
}

func TestRenamePublishedFolderPushesImmediately(t *testing.T) {
	ta := newTestApp(t)
	folder := ta.publishedFolder(t, "Design")

	got, err := ta.RenameDocument(folder.ID, "Art Direction")
	if err != nil {
		t.Fatalf("RenameDocument: %v", err)
	}
	if got.Status != "published" || got.Title != "Art Direction" {
		t.Errorf("folder should stay published with new title, got %+v", got)
	}
	if name := ta.fake.Get(folder.DriveFileID).Name; name != "Art Direction" {
		t.Errorf("Drive folder name = %q, want Art Direction", name)
	}
}

func TestRenameFolderOfflineBecomesDraftThenPublishes(t *testing.T) {
	ta := newTestApp(t)
	folder := ta.publishedFolder(t, "Design")
	client := ta.client()

	ta.setDrive(nil)
	got, err := ta.RenameDocument(folder.ID, "Art Direction")
	if err != nil {
		t.Fatalf("RenameDocument offline: %v", err)
	}
	if got.Status != "draft" {
		t.Errorf("offline rename should leave the folder as draft, got %s", got.Status)
	}
	if ta.fake.Get(folder.DriveFileID).Name != "Design" {
		t.Fatal("Drive must not change while offline")
	}

	// A refresh must not undo the pending local rename.
	ta.setDrive(client)
	if err := ta.refresh(); err != nil {
		t.Fatal(err)
	}
	if d, _ := ta.GetDocument(folder.ID); d.Title != "Art Direction" {
		t.Errorf("refresh reverted the pending rename: %q", d.Title)
	}

	pub, err := ta.PublishDocument(folder.ID)
	if err != nil {
		t.Fatalf("PublishDocument: %v", err)
	}
	if pub.Status != "published" || ta.fake.Get(folder.DriveFileID).Name != "Art Direction" {
		t.Errorf("publish should push the rename, got status %s, Drive name %q", pub.Status, ta.fake.Get(folder.DriveFileID).Name)
	}
}

func TestPublishingChildPushesPendingParentRename(t *testing.T) {
	ta := newTestApp(t)
	folder := ta.publishedFolder(t, "Design")
	client := ta.client()
	ta.setDrive(nil)
	ta.RenameDocument(folder.ID, "Art Direction")
	ta.setDrive(client)

	ta.newPublishedPage(t, "Palette", "x\n", folder.ID)
	if ta.fake.Get(folder.DriveFileID).Name != "Art Direction" {
		t.Error("publishing a child should push the parent's pending rename")
	}
	if d, _ := ta.GetDocument(folder.ID); d.Status != "published" {
		t.Errorf("parent status = %s, want published", d.Status)
	}
}

func TestRenamePageIsTitleOnlyDraft(t *testing.T) {
	ta := newTestApp(t)
	page := ta.newPublishedPage(t, "Roadmap", "body text\n", "")
	got, err := ta.RenameDocument(page.ID, "  Roadmap 2027 ")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Roadmap 2027" || got.Content != "body text\n" || got.Status != "draft" {
		t.Errorf("got %+v", got)
	}
	if ta.fake.Get(page.DriveFileID).Name != "Roadmap.md" {
		t.Error("a page rename waits for Publish")
	}
	if _, err := ta.RenameDocument(page.ID, "   "); err == nil {
		t.Error("empty title must be rejected")
	}
}

func TestRefreshPicksUpTeammateFolderRename(t *testing.T) {
	ta := newTestApp(t)
	folder := ta.publishedFolder(t, "Design")
	ta.fake.Mu.Lock()
	ta.fake.Files[folder.DriveFileID].Name = "Renamed by Sam"
	ta.fake.Mu.Unlock()

	if err := ta.refresh(); err != nil {
		t.Fatal(err)
	}
	if d, _ := ta.GetDocument(folder.ID); d.Title != "Renamed by Sam" || d.Status != "published" {
		t.Errorf("folder = %+v, want teammate's name", d)
	}
}

// === Item 11: stable error prefixes for the frontend ===

func TestErrorPrefixes(t *testing.T) {
	ta := newTestApp(t)

	ta.fake.FailFor["/permissions"] = 403
	err := ta.ShareWorkspace(ta.ws.ID, "sam@example.com", "writer")
	if err == nil || !strings.HasPrefix(err.Error(), "ERR_FORBIDDEN:") {
		t.Errorf("ShareWorkspace 403 = %v, want ERR_FORBIDDEN", err)
	}
	delete(ta.fake.FailFor, "/permissions")

	if _, err := ta.ResolveFolderLink("https://drive.google.com/drive/folders/missing"); err == nil || !strings.HasPrefix(err.Error(), "ERR_NOTFOUND:") {
		t.Errorf("missing folder = %v, want ERR_NOTFOUND", err)
	}
	ta.fake.Put("afile", "notes.md", "text/plain", "root-folder", "x")
	if _, err := ta.ResolveFolderLink("afile"); err == nil || !strings.HasPrefix(err.Error(), "ERR_INVALID:") {
		t.Errorf("file link = %v, want ERR_INVALID", err)
	}
	if _, err := ta.ResolveFolderLink("not a link at all"); err == nil || !strings.HasPrefix(err.Error(), "ERR_INVALID:") {
		t.Errorf("garbage link = %v, want ERR_INVALID", err)
	}
	if err := ta.ShareWorkspace(ta.ws.ID, "sam@example.com", "owner"); err == nil || !strings.HasPrefix(err.Error(), "ERR_INVALID:") {
		t.Errorf("bad role = %v, want ERR_INVALID", err)
	}
	if err := ta.ImportCredentials(`{"web":{"client_id":"x"}}`); err == nil || !strings.HasPrefix(err.Error(), "ERR_INVALID:") {
		t.Errorf("web client JSON = %v, want ERR_INVALID", err)
	}
}

// === Item 8: refresh reports what changed ===

func TestTriggerSyncSummary(t *testing.T) {
	ta := newTestApp(t)
	sum, err := ta.TriggerSync()
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Updated)+len(sum.Removed)+len(sum.Detached) != 0 {
		t.Errorf("empty workspace refresh should change nothing, got %+v", sum)
	}

	ta.fake.Put("", "From Sam.md", "text/plain", "root-folder", "# Hi\n")
	sum, err = ta.TriggerSync()
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Updated) != 1 {
		t.Errorf("want 1 updated page, got %+v", sum)
	}
	sum, _ = ta.TriggerSync()
	if len(sum.Updated) != 0 {
		t.Errorf("second refresh should be quiet, got %+v", sum)
	}
}

func TestUpdateSettingsClampsInterval(t *testing.T) {
	ta := newTestApp(t)
	for _, tc := range []struct{ in, want int }{{-5, 0}, {0, 0}, {10, 30}, {300, 300}} {
		s, err := ta.UpdateSettings(tc.in, "system", 2)
		if err != nil {
			t.Fatal(err)
		}
		if s.SyncIntervalSecs != tc.want {
			t.Errorf("UpdateSettings(%d) stored %d, want %d", tc.in, s.SyncIntervalSecs, tc.want)
		}
	}
}

// === Item 9: publish never silently overwrites a teammate's edit ===

func TestPublishTwiceByMeIsNotAConflict(t *testing.T) {
	ta := newTestApp(t)
	doc := ta.newPublishedPage(t, "Roadmap", "v1\n", "")
	for i := 2; i <= 3; i++ {
		ta.UpdateDocument(doc.ID, "Roadmap", fmt.Sprintf("v%d\n", i))
		if _, err := ta.PublishDocument(doc.ID); err != nil {
			t.Fatalf("publish #%d: %v", i, err)
		}
	}
	if got := string(ta.fake.Get(doc.DriveFileID).Content); got != "v3\n" {
		t.Errorf("Drive content = %q", got)
	}
}

func TestPublishDetectsTeammateEdit(t *testing.T) {
	ta := newTestApp(t)
	doc := ta.newPublishedPage(t, "Roadmap", "v1\n", "")
	ta.fake.Edit(doc.DriveFileID, "Sam's version\n", "Sam Rivera")
	ta.UpdateDocument(doc.ID, "Roadmap", "my version\n")

	_, err := ta.PublishDocument(doc.ID)
	if err == nil || !strings.HasPrefix(err.Error(), "ERR_CONFLICT: ") {
		t.Fatalf("PublishDocument = %v, want ERR_CONFLICT", err)
	}
	var payload map[string]string
	if jerr := json.Unmarshal([]byte(strings.TrimPrefix(err.Error(), "ERR_CONFLICT: ")), &payload); jerr != nil {
		t.Fatalf("conflict payload is not JSON: %v", jerr)
	}
	if payload["by"] != "Sam Rivera" || payload["at"] == "" {
		t.Errorf("payload = %v", payload)
	}
	if got := string(ta.fake.Get(doc.DriveFileID).Content); got != "Sam's version\n" {
		t.Fatalf("Drive must keep Sam's text, got %q", got)
	}
	if d, _ := ta.GetDocument(doc.ID); d.Status != "draft" || d.Content != "my version\n" {
		t.Errorf("local page must keep my edits as a draft, got %+v", d)
	}
}

func TestForcePublishOverwrites(t *testing.T) {
	ta := newTestApp(t)
	doc := ta.newPublishedPage(t, "Roadmap", "v1\n", "")
	ta.fake.Edit(doc.DriveFileID, "Sam's version\n", "Sam")
	ta.UpdateDocument(doc.ID, "Roadmap", "mine\n")

	pub, err := ta.ForcePublishDocument(doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if string(ta.fake.Get(doc.DriveFileID).Content) != "mine\n" || pub.Status != "published" {
		t.Error("force publish should overwrite and mark published")
	}
	// Sam's text is still in Drive's version history.
	revs, _ := ta.GetVersionHistory(doc.ID)
	found := false
	for _, r := range revs {
		if c, _ := ta.PreviewRevision(doc.ID, r.RevisionID); c == "Sam's version\n" {
			found = true
		}
	}
	if !found {
		t.Error("overwritten text should remain in version history")
	}
	// The next normal publish is not a conflict.
	ta.UpdateDocument(doc.ID, "Roadmap", "mine 2\n")
	if _, err := ta.PublishDocument(doc.ID); err != nil {
		t.Errorf("publish after overwrite: %v", err)
	}
}

func TestDiscardLocalChangesLoadsTheirs(t *testing.T) {
	ta := newTestApp(t)
	doc := ta.newPublishedPage(t, "Roadmap", "v1\n", "")
	ta.fake.Edit(doc.DriveFileID, "Sam's version\n", "Sam")
	ta.UpdateDocument(doc.ID, "Roadmap", "mine\n")

	got, err := ta.DiscardLocalChanges(doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Content != "Sam's version\n" || got.Status != "published" {
		t.Errorf("got %+v", got)
	}
	// Subsequent edit + publish is clean.
	ta.UpdateDocument(doc.ID, "Roadmap", "after\n")
	if _, err := ta.PublishDocument(doc.ID); err != nil {
		t.Errorf("publish after load-theirs: %v", err)
	}
}

func TestKeepBothVersions(t *testing.T) {
	ta := newTestApp(t)
	folder, _ := ta.CreateDocument("Design", "", true)
	doc := ta.newPublishedPage(t, "Roadmap", "v1\n", folder.ID)
	ta.fake.Edit(doc.DriveFileID, "Sam's version\n", "Sam")
	ta.UpdateDocument(doc.ID, "Roadmap", "mine\n")

	mine, err := ta.KeepBothVersions(doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if mine.Title != "Roadmap (my version)" || mine.Content != "mine\n" || mine.Status != "draft" || mine.ParentID != folder.ID || mine.DriveFileID != "" {
		t.Errorf("copy = %+v", mine)
	}
	orig, _ := ta.GetDocument(doc.ID)
	if orig.Content != "Sam's version\n" || orig.Status != "published" {
		t.Errorf("original = %+v", orig)
	}
}

func TestPublishIntoTrashedFileCreatesNewFile(t *testing.T) {
	ta := newTestApp(t)
	doc := ta.newPublishedPage(t, "Roadmap", "v1\n", "")
	ta.fake.Mu.Lock()
	ta.fake.Files[doc.DriveFileID].Trashed = true
	ta.fake.Mu.Unlock()
	ta.UpdateDocument(doc.ID, "Roadmap", "v2\n")

	pub, err := ta.PublishDocument(doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if pub.DriveFileID == doc.DriveFileID {
		t.Fatal("should publish to a new file, not into the trash")
	}
	if f := ta.fake.Get(pub.DriveFileID); f == nil || f.Trashed || string(f.Content) != "v2\n" {
		t.Errorf("new file = %+v", f)
	}
}

// === Item 12: move and reorder ===

func (ta *testApp) driveParents(id string) []string {
	return ta.fake.Get(id).Parents
}

func TestMovePublishedPageMovesDriveFile(t *testing.T) {
	ta := newTestApp(t)
	a := ta.publishedFolder(t, "A")
	b := ta.publishedFolder(t, "B")
	page := ta.newPublishedPage(t, "Doc", "x\n", a.ID)

	moved, err := ta.MoveDocument(page.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if moved.ParentID != b.ID || moved.Status != "published" {
		t.Errorf("moved = %+v", moved)
	}
	if p := ta.driveParents(page.DriveFileID); len(p) != 1 || p[0] != b.DriveFileID {
		t.Errorf("Drive parents = %v, want [%s]", p, b.DriveFileID)
	}
	// A refresh keeps it where it is.
	ta.refresh()
	if d, _ := ta.GetDocument(page.ID); d.ParentID != b.ID {
		t.Errorf("refresh moved it back to %s", d.ParentID)
	}

	// To the top level = the workspace folder on Drive.
	ta.MoveDocument(page.ID, "")
	if p := ta.driveParents(page.DriveFileID); len(p) != 1 || p[0] != "root-folder" {
		t.Errorf("Drive parents = %v, want [root-folder]", p)
	}
}

func TestMoveIntoUnpublishedFolderCreatesItOnDrive(t *testing.T) {
	ta := newTestApp(t)
	page := ta.newPublishedPage(t, "Doc", "x\n", "")
	local, _ := ta.CreateDocument("Local folder", "", true)

	if _, err := ta.MoveDocument(page.ID, local.ID); err != nil {
		t.Fatal(err)
	}
	f, _ := ta.GetDocument(local.ID)
	if f.DriveFileID == "" || f.Status != "published" {
		t.Fatalf("target folder should now exist on Drive: %+v", f)
	}
	if p := ta.driveParents(page.DriveFileID); len(p) != 1 || p[0] != f.DriveFileID {
		t.Errorf("Drive parents = %v", p)
	}
}

func TestMoveDraftIsLocalOnly(t *testing.T) {
	ta := newTestApp(t)
	b := ta.publishedFolder(t, "B")
	draft, _ := ta.CreateDocument("Draft", "", false)
	before := len(ta.fake.Requests)
	if _, err := ta.MoveDocument(draft.ID, b.ID); err != nil {
		t.Fatal(err)
	}
	if len(ta.fake.Requests) != before {
		t.Errorf("moving a draft should not call Drive: %v", ta.fake.Requests[before:])
	}
}

func TestMoveGuards(t *testing.T) {
	ta := newTestApp(t)
	outer, _ := ta.CreateDocument("Outer", "", true)
	inner, _ := ta.CreateDocument("Inner", outer.ID, true)
	page, _ := ta.CreateDocument("Page", "", false)

	for name, tc := range map[string][2]string{
		"into itself":         {outer.ID, outer.ID},
		"into its descendant": {outer.ID, inner.ID},
		"into a page":         {inner.ID, page.ID},
	} {
		if _, err := ta.MoveDocument(tc[0], tc[1]); err == nil || !strings.HasPrefix(err.Error(), "ERR_INVALID:") {
			t.Errorf("%s: err = %v, want ERR_INVALID", name, err)
		}
	}
	if d, _ := ta.GetDocument(outer.ID); d.ParentID != "" {
		t.Error("a rejected move must not change anything")
	}
}

func TestMoveOfflineBecomesDraftAndPublishFinishesIt(t *testing.T) {
	ta := newTestApp(t)
	b := ta.publishedFolder(t, "B")
	page := ta.newPublishedPage(t, "Doc", "x\n", "")
	client := ta.client()

	ta.setDrive(nil)
	moved, err := ta.MoveDocument(page.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if moved.Status != "draft" || moved.ParentID != b.ID {
		t.Fatalf("offline move = %+v", moved)
	}
	ta.setDrive(client)
	ta.refresh()
	if d, _ := ta.GetDocument(page.ID); d.ParentID != b.ID {
		t.Fatal("refresh must not undo a pending local move")
	}
	if _, err := ta.PublishDocument(page.ID); err != nil {
		t.Fatal(err)
	}
	if p := ta.driveParents(page.DriveFileID); len(p) != 1 || p[0] != b.DriveFileID {
		t.Errorf("publish should finish the move, parents = %v", p)
	}
}

func TestRefreshFollowsTeammateMove(t *testing.T) {
	ta := newTestApp(t)
	b := ta.publishedFolder(t, "B")
	page := ta.newPublishedPage(t, "Doc", "x\n", "")
	ta.fake.Mu.Lock()
	ta.fake.Files[page.DriveFileID].Parents = []string{b.DriveFileID}
	ta.fake.Mu.Unlock()

	ta.refresh()
	if d, _ := ta.GetDocument(page.ID); d.ParentID != b.ID || d.Status != "published" {
		t.Errorf("page should follow the teammate's move: %+v", d)
	}
}

func TestReorderSiblings(t *testing.T) {
	ta := newTestApp(t)
	one, _ := ta.CreateDocument("One", "", false)
	two, _ := ta.CreateDocument("Two", "", false)
	three, _ := ta.CreateDocument("Three", "", false)

	if _, err := ta.MoveDocumentTo(three.ID, "", one.ID); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(ta.titles(t), ","); got != "Three,One,Two" {
		t.Errorf("order = %s, want Three,One,Two", got)
	}
	ta.MoveDocumentTo(three.ID, "", "")
	if got := strings.Join(ta.titles(t), ","); got != "One,Two,Three" {
		t.Errorf("order = %s, want One,Two,Three", got)
	}
	_ = two
}

// === Item 13: portable image links ===

func TestPublishWritesRelativeImageLinks(t *testing.T) {
	ta := newTestApp(t)
	local := "![shot](/images/" + ta.ws.ID + "/img-a.png)\n"
	top := ta.newPublishedPage(t, "Top", local, "")
	if got := string(ta.fake.Get(top.DriveFileID).Content); got != "![shot](assets/img-a.png)\n" {
		t.Errorf("top-level file on Drive = %q", got)
	}
	folder, _ := ta.CreateDocument("Design", "", true)
	sub, _ := ta.CreateDocument("Sub", folder.ID, true)
	nested := ta.newPublishedPage(t, "Nested", local, sub.ID)
	if got := string(ta.fake.Get(nested.DriveFileID).Content); got != "![shot](../../assets/img-a.png)\n" {
		t.Errorf("nested file on Drive = %q", got)
	}
	// The local copy keeps the form the editor can display.
	if d, _ := ta.GetDocument(top.ID); d.Content != local {
		t.Errorf("local content changed: %q", d.Content)
	}
}

func TestPullLocalizesAllImageForms(t *testing.T) {
	ta := newTestApp(t)
	ta.fake.Put("", "Old.md", "text/plain", "root-folder", "![a](/images/11111111-2222-3333-4444-555555555555/img-a.png)\n")
	ta.fake.Put("", "Slash.md", "text/plain", "root-folder", "![a](//images/abc/img-a.png)\n")
	ta.fake.Put("", "New.md", "text/plain", "root-folder", "![a](assets/img-a.png)\n")
	if err := ta.refresh(); err != nil {
		t.Fatal(err)
	}
	want := "![a](/images/" + ta.ws.ID + "/img-a.png)\n"
	tree, _ := ta.GetDocumentTree()
	for _, n := range tree {
		if n.Document.Content != want {
			t.Errorf("%s content = %q, want %q", n.Document.Title, n.Document.Content, want)
		}
	}
}

func TestRestoreVersionLocalizesImages(t *testing.T) {
	ta := newTestApp(t)
	local := "![shot](/images/" + ta.ws.ID + "/img-a.png)\n"
	doc := ta.newPublishedPage(t, "Top", local, "")
	revs, _ := ta.GetVersionHistory(doc.ID)
	restored, err := ta.RestoreVersion(doc.ID, revs[len(revs)-1].RevisionID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Document.Content != local {
		t.Errorf("restored content = %q, want %q", restored.Document.Content, local)
	}
}

// === Item 14: workspace access tag ===

func TestGetWorkspacesReportsAccess(t *testing.T) {
	ta := newTestApp(t)
	list, _ := ta.GetWorkspaces()
	if list[0].Access != "" {
		t.Errorf("access unknown before members load, got %q", list[0].Access)
	}
	ta.signIn(t)
	ta.GetAuthStatus() // caches the account email (owner@example.com)
	ta.fake.Mu.Lock()
	ta.fake.Permissions["root-folder"] = []*gdrive.Permission{
		{Id: "p1", Type: "user", Role: "owner", EmailAddress: "Owner@Example.com"},
		{Id: "p2", Type: "user", Role: "writer", EmailAddress: "sam@example.com"},
	}
	ta.fake.Mu.Unlock()
	if _, err := ta.GetWorkspaceMembers(ta.ws.ID); err != nil {
		t.Fatal(err)
	}
	list, _ = ta.GetWorkspaces()
	if list[0].Access != "owner" {
		t.Errorf("access = %q, want owner", list[0].Access)
	}
}

// === Item 16: restoring keeps the replaced text recoverable ===

func TestRestoreBacksUpUnpublishedEdits(t *testing.T) {
	ta := newTestApp(t)
	doc := ta.newPublishedPage(t, "Roadmap", "v1\n", "")
	ta.UpdateDocument(doc.ID, "Roadmap", "v2\n")
	ta.PublishDocument(doc.ID)
	ta.UpdateDocument(doc.ID, "Roadmap", "unpublished work\n")

	revs, _ := ta.GetVersionHistory(doc.ID)
	first := revs[len(revs)-1].RevisionID // oldest (list is newest first)
	res, err := ta.RestoreVersion(doc.ID, first)
	if err != nil {
		t.Fatal(err)
	}
	if res.Document.Content != "v1\n" || res.Document.Status != "draft" {
		t.Errorf("restored = %+v", res.Document)
	}
	if res.BackupID == "" || res.BackupTitle != "Roadmap (before restore)" {
		t.Fatalf("expected a backup page, got %+v", res)
	}
	backup, _ := ta.GetDocument(res.BackupID)
	if backup.Content != "unpublished work\n" || backup.Status != "draft" {
		t.Errorf("backup = %+v", backup)
	}
}

func TestRestoreOfUpToDatePageNeedsNoBackup(t *testing.T) {
	ta := newTestApp(t)
	doc := ta.newPublishedPage(t, "Roadmap", "v1\n", "")
	ta.UpdateDocument(doc.ID, "Roadmap", "v2\n")
	ta.PublishDocument(doc.ID)

	revs, _ := ta.GetVersionHistory(doc.ID)
	res, err := ta.RestoreVersion(doc.ID, revs[len(revs)-1].RevisionID)
	if err != nil {
		t.Fatal(err)
	}
	if res.BackupID != "" {
		t.Errorf("published text is already a Drive revision; no backup expected, got %+v", res)
	}
	// ...and the replaced text really is in the history.
	found := false
	for _, r := range revs {
		if c, _ := ta.PreviewRevision(doc.ID, r.RevisionID); c == "v2\n" {
			found = true
		}
	}
	if !found {
		t.Error("v2 should be recoverable from version history")
	}
}
