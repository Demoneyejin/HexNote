package storage

import (
	"reflect"
	"testing"
	"time"
)

func TestDeletedDriveFilesRoundTrip(t *testing.T) {
	db := newTestDB(t)

	ids, err := db.GetDeletedDriveFiles("ws-1")
	if err != nil {
		t.Fatalf("GetDeletedDriveFiles: %v", err)
	}
	if ids == nil || len(ids) != 0 {
		t.Fatalf("want empty non-nil slice, got %#v", ids)
	}

	for _, id := range []string{"drv-a", "drv-b", "drv-a"} { // duplicate is a no-op
		if err := db.AddDeletedDriveFile("ws-1", id); err != nil {
			t.Fatalf("AddDeletedDriveFile(%s): %v", id, err)
		}
	}
	db.AddDeletedDriveFile("ws-2", "drv-c")

	ids, _ = db.GetDeletedDriveFiles("ws-1")
	if !reflect.DeepEqual(ids, []string{"drv-a", "drv-b"}) {
		t.Errorf("ws-1 tombstones = %v, want [drv-a drv-b]", ids)
	}

	if err := db.RemoveDeletedDriveFile("ws-1", "drv-a"); err != nil {
		t.Fatalf("RemoveDeletedDriveFile: %v", err)
	}
	ids, _ = db.GetDeletedDriveFiles("ws-1")
	if !reflect.DeepEqual(ids, []string{"drv-b"}) {
		t.Errorf("after remove = %v, want [drv-b]", ids)
	}

	// Workspace isolation
	ids, _ = db.GetDeletedDriveFiles("ws-2")
	if !reflect.DeepEqual(ids, []string{"drv-c"}) {
		t.Errorf("ws-2 tombstones = %v, want [drv-c]", ids)
	}
}

func TestDeleteWorkspaceClearsTombstones(t *testing.T) {
	db := newTestDB(t)
	ws, _ := db.CreateWorkspace("W", "folder")
	db.AddDeletedDriveFile(ws.ID, "drv-x")

	if err := db.DeleteWorkspace(ws.ID); err != nil {
		t.Fatalf("DeleteWorkspace: %v", err)
	}
	ids, _ := db.GetDeletedDriveFiles(ws.ID)
	if len(ids) != 0 {
		t.Errorf("tombstones survived workspace delete: %v", ids)
	}
}

func TestDriveTrashRoots(t *testing.T) {
	db := newTestDB(t)

	// published folder with a published child: trashing the folder is enough
	folder, _ := db.CreateDocument("Folder", "", "ws-1", true)
	db.SetDriveFileID(folder.ID, "drv-folder")
	child, _ := db.CreateDocument("Child", folder.ID, "ws-1", false)
	db.SetDriveFileID(child.ID, "drv-child")

	roots, err := db.DriveTrashRoots(folder.ID)
	if err != nil {
		t.Fatalf("DriveTrashRoots: %v", err)
	}
	if !reflect.DeepEqual(roots, []string{"drv-folder"}) {
		t.Errorf("published folder roots = %v, want [drv-folder]", roots)
	}

	// unpublished folder: descend and collect each published child
	local, _ := db.CreateDocument("Local", "", "ws-1", true)
	a, _ := db.CreateDocument("A", local.ID, "ws-1", false)
	db.SetDriveFileID(a.ID, "drv-a")
	db.CreateDocument("Draft", local.ID, "ws-1", false)
	sub, _ := db.CreateDocument("Sub", local.ID, "ws-1", true)
	b, _ := db.CreateDocument("B", sub.ID, "ws-1", false)
	db.SetDriveFileID(b.ID, "drv-b")

	roots, _ = db.DriveTrashRoots(local.ID)
	if !reflect.DeepEqual(roots, []string{"drv-a", "drv-b"}) {
		t.Errorf("unpublished folder roots = %v, want [drv-a drv-b]", roots)
	}

	// draft page: nothing to trash
	draft, _ := db.CreateDocument("Only local", "", "ws-1", false)
	roots, _ = db.DriveTrashRoots(draft.ID)
	if len(roots) != 0 {
		t.Errorf("draft roots = %v, want none", roots)
	}
}

func TestUpdatePublishedFromSyncSkipsDrafts(t *testing.T) {
	db := newTestDB(t)
	pub, _ := db.CreateDocument("Pub", "", "ws-1", false)
	db.SetDocumentStatus(pub.ID, "published")
	draft, _ := db.CreateDocument("Draft", "", "ws-1", false)
	db.UpdateDocument(draft.ID, "Draft", "my typing")

	now := time.Now().UTC().Truncate(time.Second)
	if ok, err := db.UpdatePublishedFromSync(pub.ID, "Pub", "theirs", now); !ok || err != nil {
		t.Fatalf("published page should update: %v %v", ok, err)
	}
	if ok, _ := db.UpdatePublishedFromSync(draft.ID, "Draft", "theirs", now); ok {
		t.Fatal("a draft must not be overwritten")
	}
	if d, _ := db.GetDocument(draft.ID); d.Content != "my typing" {
		t.Errorf("draft content = %q", d.Content)
	}
	if d, _ := db.GetDocument(pub.ID); d.Content != "theirs" || d.DriveModifiedAt == nil || !d.DriveModifiedAt.Equal(now) || d.IsDirty {
		t.Errorf("published page = %+v", d)
	}
}
