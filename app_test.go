package main

import (
	"context"
	"strings"
	"sync"
	"testing"

	"hexnote/internal/drive"
	"hexnote/internal/drive/drivefake"
	"hexnote/internal/models"
	"hexnote/internal/storage"

	"golang.org/x/oauth2"
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
	ta.driveClient = client
	ta.syncMgr = drive.NewSyncManager(client, ta.db, ta.appDataDir)
}

// disconnect simulates being offline / signed out.
func (ta *testApp) disconnect() {
	ta.driveClient = nil
	ta.syncMgr = nil
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
	if err := ta.TriggerSync(); err != nil {
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
	ta.TriggerSync()
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
	client := ta.driveClient

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
	ta.driveClient = client
	ta.syncMgr = drive.NewSyncManager(client, ta.db, ta.appDataDir)
	if err := ta.TriggerSync(); err != nil {
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
	if err := ta.TriggerSync(); err != nil {
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

	if err := ta.TriggerSync(); err != nil {
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
	if err := ta.TriggerSync(); err == nil {
		t.Fatal("expected refresh error when a subfolder cannot be listed")
	}
	if !contains(ta.titles(t), "Design/Inside") {
		t.Fatalf("pages must survive a failed refresh: %v", ta.titles(t))
	}
}
