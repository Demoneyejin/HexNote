package storage

import (
	"testing"
)

// newTestDB creates a fresh in-memory database for testing. The temp directory
// is automatically cleaned up when the test finishes.
func newTestDB(t *testing.T) *Database {
	t.Helper()
	db, err := NewDatabase(t.TempDir())
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// === Document round-trip tests ===
// These lock in the field mapping behavior of scanDocument/scanDocumentFromRows
// before the scanner interface refactor merges them.

func TestDocumentCreateAndGet(t *testing.T) {
	db := newTestDB(t)

	doc, err := db.CreateDocument("Test Doc", "", "ws-1", false)
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	if doc.ID == "" {
		t.Fatal("expected non-empty ID")
	}
	if doc.Title != "Test Doc" {
		t.Errorf("Title = %q, want %q", doc.Title, "Test Doc")
	}
	if doc.WorkspaceID != "ws-1" {
		t.Errorf("WorkspaceID = %q, want %q", doc.WorkspaceID, "ws-1")
	}
	if doc.IsFolder {
		t.Error("expected IsFolder=false")
	}
	if !doc.IsDirty {
		t.Error("expected IsDirty=true for new doc")
	}
	if doc.CreatedAt.IsZero() {
		t.Error("expected non-zero CreatedAt")
	}

	// Round-trip through GetDocument (uses scanDocument / *sql.Row path)
	got, err := db.GetDocument(doc.ID)
	if err != nil {
		t.Fatalf("GetDocument: %v", err)
	}
	if got.ID != doc.ID {
		t.Errorf("ID = %q, want %q", got.ID, doc.ID)
	}
	if got.Title != doc.Title {
		t.Errorf("Title = %q, want %q", got.Title, doc.Title)
	}
	if got.WorkspaceID != doc.WorkspaceID {
		t.Errorf("WorkspaceID = %q, want %q", got.WorkspaceID, doc.WorkspaceID)
	}
	if got.IsFolder != doc.IsFolder {
		t.Errorf("IsFolder = %v, want %v", got.IsFolder, doc.IsFolder)
	}
	if got.IsDirty != doc.IsDirty {
		t.Errorf("IsDirty = %v, want %v", got.IsDirty, doc.IsDirty)
	}
}

func TestDocumentUpdate(t *testing.T) {
	db := newTestDB(t)

	doc, _ := db.CreateDocument("Original", "", "ws-1", false)
	updated, err := db.UpdateDocument(doc.ID, "Updated Title", "New content here")
	if err != nil {
		t.Fatalf("UpdateDocument: %v", err)
	}
	if updated.Title != "Updated Title" {
		t.Errorf("Title = %q, want %q", updated.Title, "Updated Title")
	}
	if updated.Content != "New content here" {
		t.Errorf("Content = %q, want %q", updated.Content, "New content here")
	}
	if !updated.IsDirty {
		t.Error("expected IsDirty=true after update")
	}
}

func TestDocumentDelete(t *testing.T) {
	db := newTestDB(t)

	parent, _ := db.CreateDocument("Parent", "", "ws-1", true)
	child, _ := db.CreateDocument("Child", parent.ID, "ws-1", false)

	// Delete parent — should cascade to child
	if err := db.DeleteDocument(parent.ID); err != nil {
		t.Fatalf("DeleteDocument: %v", err)
	}

	if _, err := db.GetDocument(parent.ID); err == nil {
		t.Error("expected error getting deleted parent")
	}
	if _, err := db.GetDocument(child.ID); err == nil {
		t.Error("expected error getting deleted child")
	}
}

// TestDocumentTree verifies tree building via GetDocumentTree, which uses
// scanDocumentFromRows / *sql.Rows path.
func TestDocumentTree(t *testing.T) {
	db := newTestDB(t)

	folder, _ := db.CreateDocument("Folder", "", "ws-1", true)
	child, _ := db.CreateDocument("Child", folder.ID, "ws-1", false)

	tree, err := db.GetDocumentTree("ws-1")
	if err != nil {
		t.Fatalf("GetDocumentTree: %v", err)
	}
	if len(tree) != 1 {
		t.Fatalf("expected 1 root node, got %d", len(tree))
	}
	if tree[0].Document.Title != "Folder" {
		t.Errorf("root title = %q, want %q", tree[0].Document.Title, "Folder")
	}
	if tree[0].Document.IsFolder != true {
		t.Error("root should be a folder")
	}
	if len(tree[0].Children) != 1 {
		t.Fatalf("expected 1 child, got %d", len(tree[0].Children))
	}
	if tree[0].Children[0].Document.ID != child.ID {
		t.Errorf("child ID = %q, want %q", tree[0].Children[0].Document.ID, child.ID)
	}
}

func TestDocumentMove(t *testing.T) {
	db := newTestDB(t)

	folderA, _ := db.CreateDocument("Folder A", "", "ws-1", true)
	folderB, _ := db.CreateDocument("Folder B", "", "ws-1", true)
	doc, _ := db.CreateDocument("Doc", folderA.ID, "ws-1", false)

	if err := db.MoveDocument(doc.ID, folderB.ID); err != nil {
		t.Fatalf("MoveDocument: %v", err)
	}

	moved, _ := db.GetDocument(doc.ID)
	if moved.ParentID != folderB.ID {
		t.Errorf("ParentID = %q, want %q", moved.ParentID, folderB.ID)
	}
}

// === Workspace round-trip tests ===
// Locks in field mapping for the scanWorkspace / GetActiveWorkspace refactor.

func TestWorkspaceCreateAndGet(t *testing.T) {
	db := newTestDB(t)

	ws, err := db.CreateWorkspace("My Workspace", "drive-folder-abc")
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	if ws.ID == "" {
		t.Fatal("expected non-empty ID")
	}
	if ws.Name != "My Workspace" {
		t.Errorf("Name = %q, want %q", ws.Name, "My Workspace")
	}
	if ws.DriveFolderID != "drive-folder-abc" {
		t.Errorf("DriveFolderID = %q", ws.DriveFolderID)
	}
	if ws.DriveFolderURL != "https://drive.google.com/drive/folders/drive-folder-abc" {
		t.Errorf("DriveFolderURL = %q", ws.DriveFolderURL)
	}
	if ws.IsActive {
		t.Error("expected IsActive=false for new workspace")
	}
	if ws.CreatedAt.IsZero() {
		t.Error("expected non-zero CreatedAt")
	}

	// Verify GetWorkspaces returns it (uses scanWorkspace / *sql.Rows path)
	all, err := db.GetWorkspaces()
	if err != nil {
		t.Fatalf("GetWorkspaces: %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("expected 1 workspace, got %d", len(all))
	}
	if all[0].ID != ws.ID {
		t.Errorf("ID = %q, want %q", all[0].ID, ws.ID)
	}
	if all[0].Name != ws.Name {
		t.Errorf("Name = %q, want %q", all[0].Name, ws.Name)
	}
}

func TestWorkspaceSwitchAndGetActive(t *testing.T) {
	db := newTestDB(t)

	ws, _ := db.CreateWorkspace("WS", "folder-1")

	// Initially no active workspace
	active, err := db.GetActiveWorkspace()
	if err != nil {
		t.Fatalf("GetActiveWorkspace: %v", err)
	}
	if active != nil {
		t.Error("expected nil before switch")
	}

	// Switch activates it (uses GetActiveWorkspace / *sql.Row path)
	switched, err := db.SwitchWorkspace(ws.ID)
	if err != nil {
		t.Fatalf("SwitchWorkspace: %v", err)
	}
	if !switched.IsActive {
		t.Error("expected IsActive=true after switch")
	}
	if switched.ID != ws.ID {
		t.Errorf("ID = %q, want %q", switched.ID, ws.ID)
	}
	if switched.Name != ws.Name {
		t.Errorf("Name = %q, want %q", switched.Name, ws.Name)
	}
	if switched.DriveFolderID != ws.DriveFolderID {
		t.Errorf("DriveFolderID = %q, want %q", switched.DriveFolderID, ws.DriveFolderID)
	}

	// GetActiveWorkspace returns the same
	active2, _ := db.GetActiveWorkspace()
	if active2 == nil || active2.ID != ws.ID {
		t.Errorf("GetActiveWorkspace returned wrong workspace")
	}
}

func TestWorkspaceDelete(t *testing.T) {
	db := newTestDB(t)

	ws, _ := db.CreateWorkspace("Doomed", "folder-x")
	db.CreateDocument("Doc in WS", "", ws.ID, false)

	if err := db.DeleteWorkspace(ws.ID); err != nil {
		t.Fatalf("DeleteWorkspace: %v", err)
	}

	all, _ := db.GetWorkspaces()
	if len(all) != 0 {
		t.Errorf("expected 0 workspaces after delete, got %d", len(all))
	}

	tree, _ := db.GetDocumentTree(ws.ID)
	if len(tree) != 0 {
		t.Errorf("expected 0 documents after workspace delete, got %d", len(tree))
	}
}

// === Settings round-trip ===

func TestSettingsRoundTrip(t *testing.T) {
	db := newTestDB(t)

	// Defaults
	s, err := db.GetSettings()
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	if s.Theme != "system" {
		t.Errorf("default Theme = %q, want %q", s.Theme, "system")
	}
	if s.SyncIntervalSecs != 60 {
		t.Errorf("default SyncIntervalSecs = %d, want 60", s.SyncIntervalSecs)
	}
	if s.AutoSaveDelaySecs != 2 {
		t.Errorf("default AutoSaveDelaySecs = %d, want 2", s.AutoSaveDelaySecs)
	}

	// Update and reload
	s.Theme = "dark"
	s.SyncIntervalSecs = 120
	s.AutoSaveDelaySecs = 5
	if err := db.UpdateSettings(s); err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}

	s2, err := db.GetSettings()
	if err != nil {
		t.Fatalf("GetSettings after update: %v", err)
	}
	if s2.Theme != "dark" {
		t.Errorf("Theme = %q, want %q", s2.Theme, "dark")
	}
	if s2.SyncIntervalSecs != 120 {
		t.Errorf("SyncIntervalSecs = %d, want 120", s2.SyncIntervalSecs)
	}
	if s2.AutoSaveDelaySecs != 5 {
		t.Errorf("AutoSaveDelaySecs = %d, want 5", s2.AutoSaveDelaySecs)
	}
}

// === Labels ===

func TestLabelCRUD(t *testing.T) {
	db := newTestDB(t)

	label, err := db.CreateLabel("Bug", "#ff0000")
	if err != nil {
		t.Fatalf("CreateLabel: %v", err)
	}
	if label.Name != "Bug" || label.Color != "#ff0000" {
		t.Errorf("label = %+v", label)
	}

	labels, _ := db.GetLabels()
	if len(labels) != 1 {
		t.Fatalf("expected 1 label, got %d", len(labels))
	}

	if err := db.DeleteLabel(label.ID); err != nil {
		t.Fatalf("DeleteLabel: %v", err)
	}

	labels, _ = db.GetLabels()
	if len(labels) != 0 {
		t.Errorf("expected 0 labels after delete, got %d", len(labels))
	}
}

func TestDocumentLabels(t *testing.T) {
	db := newTestDB(t)

	doc, _ := db.CreateDocument("Doc", "", "ws-1", false)
	label, _ := db.CreateLabel("Important", "#00ff00")

	if err := db.SetDocumentLabels(doc.ID, []string{label.ID}); err != nil {
		t.Fatalf("SetDocumentLabels: %v", err)
	}

	labels, err := db.GetDocumentLabels(doc.ID)
	if err != nil {
		t.Fatalf("GetDocumentLabels: %v", err)
	}
	if len(labels) != 1 {
		t.Fatalf("expected 1 label, got %d", len(labels))
	}
	if labels[0].ID != label.ID {
		t.Errorf("label ID = %q, want %q", labels[0].ID, label.ID)
	}

	// Clear labels
	if err := db.SetDocumentLabels(doc.ID, []string{}); err != nil {
		t.Fatalf("SetDocumentLabels (clear): %v", err)
	}
	labels, _ = db.GetDocumentLabels(doc.ID)
	if len(labels) != 0 {
		t.Errorf("expected 0 labels after clear, got %d", len(labels))
	}
}

// === Empty slice guarantees ===
// The frontend depends on receiving [] rather than null for empty collections.

func TestEmptySliceReturns(t *testing.T) {
	db := newTestDB(t)

	labels, _ := db.GetLabels()
	if labels == nil {
		t.Error("GetLabels returned nil, want empty slice")
	}

	ws, _ := db.GetWorkspaces()
	if ws == nil {
		t.Error("GetWorkspaces returned nil, want empty slice")
	}

	results, _ := db.SearchDocuments("test", "ws-1")
	if results == nil {
		t.Error("SearchDocuments returned nil, want empty slice")
	}

	dl, _ := db.GetDocumentLabels("nonexistent")
	if dl == nil {
		t.Error("GetDocumentLabels returned nil, want empty slice")
	}

	members, _ := db.GetWorkspaceMembers("nonexistent")
	if members == nil {
		t.Error("GetWorkspaceMembers returned nil, want empty slice")
	}
}

// === Image assets ===

func TestImageAssetRoundTrip(t *testing.T) {
	db := newTestDB(t)

	asset, err := db.CreateImageAsset("ws-1", "img-test.png")
	if err != nil {
		t.Fatalf("CreateImageAsset: %v", err)
	}
	if asset.ID == "" {
		t.Fatal("expected non-empty ID")
	}

	got, err := db.GetImageAsset("ws-1", "img-test.png")
	if err != nil {
		t.Fatalf("GetImageAsset: %v", err)
	}
	if got.ID != asset.ID {
		t.Errorf("ID = %q, want %q", got.ID, asset.ID)
	}

	// Set Drive file ID
	if err := db.SetImageDriveFileID(asset.ID, "drive-file-123"); err != nil {
		t.Fatalf("SetImageDriveFileID: %v", err)
	}

	// Unsynced should now be empty for this workspace
	unsynced, err := db.GetUnsyncedImages("ws-1")
	if err != nil {
		t.Fatalf("GetUnsyncedImages: %v", err)
	}
	if len(unsynced) != 0 {
		t.Errorf("expected 0 unsynced after setting drive ID, got %d", len(unsynced))
	}
}
