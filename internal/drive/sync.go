package drive

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"hexnote/internal/models"
	"hexnote/internal/storage"
)

// SyncManager handles pulling published content from Google Drive.
// Push (publishing) is handled explicitly via PublishDocument in app.go.
type SyncManager struct {
	client     *Client
	db         *storage.Database
	appDataDir string
	status     models.SyncStatus

	// mu prevents concurrent syncs from colliding
	mu sync.Mutex
}

// imagePathRe matches image references like /images/{uuid}/ in markdown content.
var imagePathRe = regexp.MustCompile(`(/images/)[a-f0-9][-a-f0-9]*/`)

// ParseTime parses a Google Drive timestamp.
func ParseTime(s string) (time.Time, error) { return parseDriveTime(s) }

// LocalizeContent prepares markdown downloaded from Drive for this PC
// (image links point at this workspace's local image cache).
func LocalizeContent(content, localWorkspaceID string) string {
	return rewriteImagePaths(content, localWorkspaceID)
}

// parseDriveTime parses a Google Drive timestamp which may or may not have
// fractional seconds. Go's time.RFC3339 rejects fractional seconds and
// time.RFC3339Nano requires them, so we try both.
func parseDriveTime(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t, err = time.Parse(time.RFC3339, s)
	}
	return t, err
}

func NewSyncManager(client *Client, db *storage.Database, appDataDir string) *SyncManager {
	return &SyncManager{
		client:     client,
		db:         db,
		appDataDir: appDataDir,
		status:     models.SyncStatus{State: "idle"},
	}
}

func (sm *SyncManager) GetStatus() models.SyncStatus {
	return sm.status
}

// SyncResult reports what a refresh changed locally.
type SyncResult struct {
	// UpdatedIDs are documents created or updated from Drive.
	UpdatedIDs []string
	// RemovedIDs are documents deleted locally because their Drive file was
	// trashed or deleted by someone else.
	RemovedIDs []string
	// DetachedIDs are documents whose Drive file disappeared while they had
	// unpublished local edits; they are kept as unlinked drafts.
	DetachedIDs []string
}

// SyncWorkspace retries pending Drive trash operations, then pulls published
// content from Drive into the local DB.
func (sm *SyncManager) SyncWorkspace(workspace *models.Workspace) (*SyncResult, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	sm.status = models.SyncStatus{State: "syncing", Message: "Refreshing..."}

	sm.retryPendingTrash(workspace)

	result, err := sm.pullFromDrive(workspace)
	if err != nil {
		sm.status = models.SyncStatus{State: "error", Message: fmt.Sprintf("Refresh failed: %v", err)}
		return nil, err
	}

	sm.db.UpdateWorkspaceSyncTime(workspace.ID)
	now := time.Now().UTC()
	sm.status = models.SyncStatus{State: "idle", Message: "Up to date", LastSynced: &now}

	return result, nil
}

// retryPendingTrash trashes Drive files of pages that were deleted while the
// trash call could not be made (offline, signed out). A file that no longer
// exists counts as done. Other failures keep the tombstone for next time.
func (sm *SyncManager) retryPendingTrash(workspace *models.Workspace) {
	ids, err := sm.db.GetDeletedDriveFiles(workspace.ID)
	if err != nil {
		return
	}
	for _, id := range ids {
		err := sm.client.TrashFile(id)
		if err == nil || IsNotFound(err) {
			sm.db.RemoveDeletedDriveFile(workspace.ID, id)
		}
	}
}

// pullRun holds the state of one pull pass.
type pullRun struct {
	workspace *models.Workspace
	// local maps Drive file IDs to local documents; entries are removed as
	// the corresponding Drive files are seen, so what remains was not found.
	local map[string]*models.Document
	// skip holds Drive IDs of pages the user deleted locally (tombstones).
	skip   map[string]bool
	result *SyncResult
}

// pullFromDrive downloads published files from Drive into local DB (recursive).
func (sm *SyncManager) pullFromDrive(workspace *models.Workspace) (*SyncResult, error) {
	tree, err := sm.db.GetDocumentTree(workspace.ID)
	if err != nil {
		return nil, err
	}
	run := &pullRun{
		workspace: workspace,
		local:     make(map[string]*models.Document),
		skip:      make(map[string]bool),
		result:    &SyncResult{UpdatedIDs: []string{}, RemovedIDs: []string{}, DetachedIDs: []string{}},
	}
	flattenTree(tree, run.local)
	tombstones, err := sm.db.GetDeletedDriveFiles(workspace.ID)
	if err != nil {
		return nil, err
	}
	for _, id := range tombstones {
		run.skip[id] = true
	}

	if err := sm.pullFolder(run, workspace.DriveFolderID, ""); err != nil {
		return nil, err
	}

	// Every folder was listed successfully, so anything left in run.local is
	// no longer in the workspace on Drive: a teammate trashed or deleted it.
	sm.reconcileMissing(tree, run)
	return run.result, nil
}

// reconcileMissing handles local documents whose Drive file was not found.
// A subtree with no local-only work is deleted locally. A subtree that holds
// unpublished edits is kept: its missing Drive links are cleared and the
// pages become drafts, so publishing creates new files instead of writing
// into a trashed one.
func (sm *SyncManager) reconcileMissing(tree []*models.TreeNode, run *pullRun) {
	if len(run.local) == 0 {
		return
	}
	var walk func(nodes []*models.TreeNode, parentMissing bool)
	walk = func(nodes []*models.TreeNode, parentMissing bool) {
		for _, node := range nodes {
			doc := node.Document
			_, missing := run.local[doc.DriveFileID]
			missing = missing && doc.DriveFileID != ""
			if missing && !parentMissing {
				if subtreeHasLocalWork(node) {
					detachMissing(sm, node, run)
				} else {
					if err := sm.db.DeleteDocument(doc.ID); err == nil {
						run.result.RemovedIDs = append(run.result.RemovedIDs, doc.ID)
					}
				}
				continue
			}
			walk(node.Children, parentMissing || missing)
		}
	}
	walk(tree, false)
}

// subtreeHasLocalWork reports whether a node or any descendant has content
// that exists only on this PC (a draft or unpublished edits).
func subtreeHasLocalWork(node *models.TreeNode) bool {
	if !node.Document.IsFolder && node.Document.Status == "draft" {
		return true
	}
	for _, c := range node.Children {
		if subtreeHasLocalWork(c) {
			return true
		}
	}
	return false
}

func detachMissing(sm *SyncManager, node *models.TreeNode, run *pullRun) {
	doc := node.Document
	if _, missing := run.local[doc.DriveFileID]; missing && doc.DriveFileID != "" {
		sm.db.SetDriveFileID(doc.ID, "")
		sm.db.SetDocumentStatus(doc.ID, "draft")
		run.result.DetachedIDs = append(run.result.DetachedIDs, doc.ID)
	}
	for _, c := range node.Children {
		detachMissing(sm, c, run)
	}
}

// pullFolder syncs a single Drive folder into the local DB, then recurses into
// subfolders. Any listing error aborts the pull so that files in an unlisted
// folder are never mistaken for deleted ones.
func (sm *SyncManager) pullFolder(run *pullRun, driveFolderID string, localParentID string) error {
	workspace := run.workspace
	files, err := sm.client.ListFiles(driveFolderID)
	if err != nil {
		return err
	}

	for _, f := range files {
		// A page deleted on this PC whose Drive file could not be trashed yet.
		if run.skip[f.Id] {
			continue
		}

		isFolder := f.MimeType == "application/vnd.google-apps.folder"
		isMd := strings.HasSuffix(strings.ToLower(f.Name), ".md")

		localDoc, exists := run.local[f.Id]

		if !exists {
			// New item from Drive — create locally as published
			title := f.Name
			content := ""

			if isMd {
				title = strings.TrimSuffix(f.Name, ".md")
				downloaded, dlErr := sm.client.DownloadFile(f.Id)
				if dlErr != nil {
					continue
				}
				content = rewriteImagePaths(downloaded, workspace.ID)
			}

			doc, err := sm.db.CreateDocument(title, localParentID, workspace.ID, isFolder)
			if err != nil {
				continue
			}

			if isMd || (!isFolder && !isMd) {
				sm.db.UpdateDocumentFromSync(doc.ID, title, content)
			}
			sm.db.SetDriveFileID(doc.ID, f.Id)
			sm.db.SetDocumentStatus(doc.ID, "published")
			if f.ModifiedTime != "" {
				if t, err := parseDriveTime(f.ModifiedTime); err == nil {
					sm.db.SetDriveModifiedAt(doc.ID, t)
				}
			}
			sm.db.ClearDirty(doc.ID)

			// Download binary files (images etc.) to local cache
			if !isFolder && !isMd {
				sm.downloadToImageCache(workspace.ID, f.Name, f.Id)
			}

			run.result.UpdatedIDs = append(run.result.UpdatedIDs, doc.ID)

			if isFolder {
				if err := sm.pullFolder(run, f.Id, doc.ID); err != nil {
					return err
				}
			}

		} else {
			// Seen on Drive: not a remote deletion.
			delete(run.local, f.Id)

			// Existing item — only update if it's still published locally.
			// If the user has made local edits (status = 'draft'), don't
			// overwrite their work — they'll publish when ready.
			if isMd && f.ModifiedTime != "" && localDoc.DriveModifiedAt != nil && localDoc.Status == "published" {
				remoteTime, parseErr := parseDriveTime(f.ModifiedTime)
				if parseErr == nil && remoteTime.After(*localDoc.DriveModifiedAt) {
					content, err := sm.client.DownloadFile(f.Id)
					if err == nil {
						title := strings.TrimSuffix(f.Name, ".md")
						content = rewriteImagePaths(content, workspace.ID)
						sm.db.UpdateDocumentFromSync(localDoc.ID, title, content)
						sm.db.SetDriveModifiedAt(localDoc.ID, remoteTime)
						sm.db.ClearDirty(localDoc.ID)
						run.result.UpdatedIDs = append(run.result.UpdatedIDs, localDoc.ID)
					}
				}
			}

			// Re-download binary files if missing locally
			if !isFolder && !isMd {
				sm.downloadToImageCacheIfMissing(workspace.ID, f.Name, f.Id)
			}

			// A teammate moved it to another folder. A local move that has
			// not reached Drive yet (status draft) wins until it is published.
			if localDoc.ParentID != localParentID && localDoc.Status == "published" {
				sm.db.SetParentFromSync(localDoc.ID, localParentID)
				localDoc.ParentID = localParentID
				run.result.UpdatedIDs = append(run.result.UpdatedIDs, localDoc.ID)
			}

			// A teammate renamed the folder. A local rename that has not
			// reached Drive yet (status draft) wins until it is published.
			if isFolder && f.Name != localDoc.Title && localDoc.Status == "published" {
				sm.db.UpdateDocumentFromSync(localDoc.ID, f.Name, "")
				run.result.UpdatedIDs = append(run.result.UpdatedIDs, localDoc.ID)
			}

			if isFolder {
				if err := sm.pullFolder(run, f.Id, localDoc.ID); err != nil {
					return err
				}
			}
		}
	}

	return nil
}

// rewriteImagePaths replaces image path workspace UUIDs with the local workspace ID
// and normalizes double-slash paths from older editor versions.
func rewriteImagePaths(content, localWorkspaceID string) string {
	content = strings.ReplaceAll(content, "](//images/", "](/images/")
	content = strings.ReplaceAll(content, "](//Images/", "](/images/")
	return imagePathRe.ReplaceAllString(content, "${1}"+localWorkspaceID+"/")
}

// downloadToImageCache downloads a binary file from Drive and saves it to the local image cache.
func (sm *SyncManager) downloadToImageCache(workspaceID, filename, driveFileID string) {
	data, err := sm.client.DownloadBinaryData(driveFileID)
	if err != nil {
		return
	}

	cacheDir := filepath.Join(sm.appDataDir, "image_cache", workspaceID)
	os.MkdirAll(cacheDir, 0700)

	safeFilename := filepath.Base(filename)
	localPath := filepath.Join(cacheDir, safeFilename)

	absPath, _ := filepath.Abs(localPath)
	absCacheDir, _ := filepath.Abs(cacheDir)
	if !strings.HasPrefix(absPath, absCacheDir) {
		return
	}

	os.WriteFile(localPath, data, 0644)

	existing, _ := sm.db.GetImageAsset(workspaceID, safeFilename)
	if existing == nil {
		asset, err := sm.db.CreateImageAsset(workspaceID, safeFilename)
		if err == nil && asset != nil {
			sm.db.SetImageDriveFileID(asset.ID, driveFileID)
		}
	}
}

// downloadToImageCacheIfMissing only downloads if the file doesn't already exist locally.
func (sm *SyncManager) downloadToImageCacheIfMissing(workspaceID, filename, driveFileID string) {
	safeFilename := filepath.Base(filename)
	cacheDir := filepath.Join(sm.appDataDir, "image_cache", workspaceID)
	localPath := filepath.Join(cacheDir, safeFilename)

	if _, err := os.Stat(localPath); err == nil {
		return
	}
	sm.downloadToImageCache(workspaceID, filename, driveFileID)
}

// flattenTree extracts all documents from a tree into a map keyed by DriveFileID
func flattenTree(nodes []*models.TreeNode, m map[string]*models.Document) {
	for _, node := range nodes {
		if node.Document.DriveFileID != "" {
			doc := node.Document // copy
			m[doc.DriveFileID] = &doc
		}
		if node.Children != nil {
			flattenTree(node.Children, m)
		}
	}
}
