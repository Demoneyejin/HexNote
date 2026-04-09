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

// SyncWorkspace pulls published content from Drive into the local DB.
// Returns the IDs of documents that were created or updated.
func (sm *SyncManager) SyncWorkspace(workspace *models.Workspace) ([]string, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	sm.status = models.SyncStatus{State: "syncing", Message: "Refreshing..."}

	updatedIDs, err := sm.pullFromDrive(workspace)
	if err != nil {
		sm.status = models.SyncStatus{State: "error", Message: fmt.Sprintf("Refresh failed: %v", err)}
		return nil, err
	}

	sm.db.UpdateWorkspaceSyncTime(workspace.ID)
	now := time.Now().UTC()
	sm.status = models.SyncStatus{State: "idle", Message: "Up to date", LastSynced: &now}

	return updatedIDs, nil
}

// pullFromDrive downloads published files from Drive into local DB (recursive).
func (sm *SyncManager) pullFromDrive(workspace *models.Workspace) ([]string, error) {
	tree, err := sm.db.GetDocumentTree(workspace.ID)
	if err != nil {
		return nil, err
	}
	localByDriveID := make(map[string]*models.Document)
	flattenTree(tree, localByDriveID)

	var updatedIDs []string
	err = sm.pullFolder(workspace, workspace.DriveFolderID, "", localByDriveID, &updatedIDs)
	return updatedIDs, err
}

// pullFolder syncs a single Drive folder into the local DB, then recurses into subfolders.
func (sm *SyncManager) pullFolder(workspace *models.Workspace, driveFolderID string, localParentID string, localByDriveID map[string]*models.Document, updatedIDs *[]string) error {
	files, err := sm.client.ListFiles(driveFolderID)
	if err != nil {
		return err
	}

	for _, f := range files {
		isFolder := f.MimeType == "application/vnd.google-apps.folder"
		isMd := strings.HasSuffix(strings.ToLower(f.Name), ".md")

		localDoc, exists := localByDriveID[f.Id]

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

			*updatedIDs = append(*updatedIDs, doc.ID)

			if isFolder {
				sm.pullFolder(workspace, f.Id, doc.ID, localByDriveID, updatedIDs)
			}

		} else {
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
						*updatedIDs = append(*updatedIDs, localDoc.ID)
					}
				}
			}

			// Re-download binary files if missing locally
			if !isFolder && !isMd {
				sm.downloadToImageCacheIfMissing(workspace.ID, f.Name, f.Id)
			}

			if isFolder {
				sm.pullFolder(workspace, f.Id, localDoc.ID, localByDriveID, updatedIDs)
			}

			delete(localByDriveID, f.Id)
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
