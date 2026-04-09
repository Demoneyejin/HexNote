package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"hexnote/internal/drive"
	"hexnote/internal/export"
	"hexnote/internal/models"
	"hexnote/internal/storage"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx         context.Context
	db          *storage.Database
	appDataDir  string
	authMgr     *drive.AuthManager
	driveClient *drive.Client
	syncMgr     *drive.SyncManager
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	dataDir, err := appDataDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to get app data dir: %v\n", err)
		return
	}

	db, err := storage.NewDatabase(dataDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to init database: %v\n", err)
		return
	}
	a.db = db
	a.appDataDir = dataDir

	// Initialize auth manager
	a.authMgr = drive.NewAuthManager(dataDir)
	a.authMgr.SetWailsContext(ctx)
	a.authMgr.LoadCredentials() // no-op if credentials.json missing

	// If we have a valid token, connect to Drive
	if a.authMgr.HasValidToken() {
		a.initDriveClient()
	}
}

func (a *App) initDriveClient() {
	ts := a.authMgr.GetTokenSource(context.Background())
	if ts == nil {
		return
	}
	client, err := drive.NewClient(context.Background(), ts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create drive client: %v\n", err)
		return
	}
	a.driveClient = client
	a.syncMgr = drive.NewSyncManager(client, a.db, a.appDataDir)
}

func (a *App) shutdown(ctx context.Context) {
	if a.db != nil {
		a.db.Close()
	}
}

// === Auth methods ===

func (a *App) GetAuthStatus() (*models.AuthStatus, error) {
	status := &models.AuthStatus{
		HasCredentials: a.authMgr.HasCredentials(),
		IsSignedIn:     a.authMgr.HasValidToken() && a.driveClient != nil,
	}
	if status.IsSignedIn {
		email, err := a.driveClient.GetUserEmail()
		if err == nil {
			status.UserEmail = email
		}
	}
	return status, nil
}

func (a *App) ImportCredentials(jsonContent string) error {
	return a.authMgr.SaveCredentials(jsonContent)
}

func (a *App) StartOAuthFlow() error {
	// The auth flow completes asynchronously — frontend listens for auth:complete event
	// After which it should call OnAuthComplete
	return a.authMgr.StartOAuthFlow()
}

// OnAuthComplete is called by the frontend after receiving auth:complete event
func (a *App) OnAuthComplete() (*models.AuthStatus, error) {
	a.initDriveClient()
	return a.GetAuthStatus()
}

func (a *App) SignOut() error {
	a.driveClient = nil
	a.syncMgr = nil
	return a.authMgr.SignOut()
}

// === Workspace methods ===

func (a *App) GetWorkspaces() ([]models.Workspace, error) {
	return a.db.GetWorkspaces()
}

func (a *App) GetActiveWorkspace() (*models.Workspace, error) {
	return a.db.GetActiveWorkspace()
}

func (a *App) CreateWorkspace(name string, driveFolderID string) (*models.Workspace, error) {
	ws, err := a.db.CreateWorkspace(name, driveFolderID)
	if err != nil {
		return nil, err
	}
	// Auto-switch to the new workspace
	return a.db.SwitchWorkspace(ws.ID)
}

func (a *App) SwitchWorkspace(workspaceID string) (*models.Workspace, error) {
	return a.db.SwitchWorkspace(workspaceID)
}

func (a *App) DeleteWorkspace(workspaceID string) error {
	return a.db.DeleteWorkspace(workspaceID)
}

func (a *App) RenameWorkspace(workspaceID string, newName string) error {
	return a.db.RenameWorkspace(workspaceID, newName)
}

// === Drive folder browsing ===

func (a *App) ListDriveFolders(parentFolderID string) ([]models.DriveFolder, error) {
	if a.driveClient == nil {
		return nil, fmt.Errorf("not signed in")
	}
	return a.driveClient.ListFolders(parentFolderID)
}

func (a *App) CreateDriveFolder(name string, parentFolderID string) (*models.DriveFolder, error) {
	if a.driveClient == nil {
		return nil, fmt.Errorf("not signed in")
	}
	return a.driveClient.CreateFolder(name, parentFolderID)
}

func (a *App) SearchSharedFolders(query string) ([]models.DriveFolder, error) {
	if a.driveClient == nil {
		return nil, fmt.Errorf("not signed in")
	}
	return a.driveClient.SearchSharedFolders(query)
}

// ResolveFolderLink extracts a folder ID from a Google Drive URL and returns its metadata.
func (a *App) ResolveFolderLink(link string) (*models.DriveFolder, error) {
	if a.driveClient == nil {
		return nil, fmt.Errorf("not signed in")
	}
	folderID := parseDriveFolderID(link)
	if folderID == "" {
		return nil, fmt.Errorf("could not extract folder ID from the link")
	}
	return a.driveClient.GetFolderByID(folderID)
}

// === Document methods (workspace-aware) ===

func (a *App) CreateDocument(title string, parentID string, isFolder bool) (*models.Document, error) {
	ws, _ := a.db.GetActiveWorkspace()
	if ws == nil {
		return nil, fmt.Errorf("no active workspace — create or select a workspace first")
	}
	return a.db.CreateDocument(title, parentID, ws.ID, isFolder)
}

func (a *App) GetDocument(id string) (*models.Document, error) {
	return a.getValidatedDoc(id)
}

func (a *App) UpdateDocument(id string, title string, content string) (*models.Document, error) {
	if _, err := a.getValidatedDoc(id); err != nil {
		return nil, err
	}
	return a.db.UpdateDocument(id, title, content)
}

func (a *App) DeleteDocument(id string) error {
	if _, err := a.getValidatedDoc(id); err != nil {
		return err
	}
	return a.db.DeleteDocument(id)
}

func (a *App) MoveDocument(id string, newParentID string) error {
	if _, err := a.getValidatedDoc(id); err != nil {
		return err
	}
	// Validate target parent also belongs to the active workspace
	if newParentID != "" {
		if _, err := a.getValidatedDoc(newParentID); err != nil {
			return fmt.Errorf("cannot move document to a different workspace")
		}
	}
	return a.db.MoveDocument(id, newParentID)
}

// validateDocWorkspace ensures a document belongs to the active workspace.
// Blocks access to workspace-scoped documents when no workspace is active,
// and prevents cross-workspace access when a workspace is active.
func (a *App) validateDocWorkspace(doc *models.Document) error {
	ws, _ := a.db.GetActiveWorkspace()
	if ws == nil {
		// No active workspace — block access to workspace-scoped documents
		if doc.WorkspaceID != "" {
			return fmt.Errorf("no active workspace")
		}
		return nil
	}
	if doc.WorkspaceID != "" && doc.WorkspaceID != ws.ID {
		return fmt.Errorf("document does not belong to the active workspace")
	}
	return nil
}

// getValidatedDoc retrieves a document and verifies it belongs to the active workspace.
func (a *App) getValidatedDoc(id string) (*models.Document, error) {
	doc, err := a.db.GetDocument(id)
	if err != nil {
		return nil, err
	}
	if err := a.validateDocWorkspace(doc); err != nil {
		return nil, err
	}
	return doc, nil
}

func (a *App) GetDocumentTree() ([]*models.TreeNode, error) {
	ws, _ := a.db.GetActiveWorkspace()
	wsID := ""
	if ws != nil {
		wsID = ws.ID
	}
	return a.db.GetDocumentTree(wsID)
}

// === Labels ===

func (a *App) GetLabels() ([]models.Label, error) {
	return a.db.GetLabels()
}

func (a *App) CreateLabel(name string, color string) (*models.Label, error) {
	return a.db.CreateLabel(name, color)
}

func (a *App) DeleteLabel(id string) error {
	return a.db.DeleteLabel(id)
}

func (a *App) SetDocumentLabels(docID string, labelIDs []string) error {
	if _, err := a.getValidatedDoc(docID); err != nil {
		return err
	}
	return a.db.SetDocumentLabels(docID, labelIDs)
}

func (a *App) GetDocumentLabels(docID string) ([]models.Label, error) {
	if _, err := a.getValidatedDoc(docID); err != nil {
		return nil, err
	}
	return a.db.GetDocumentLabels(docID)
}

// === Search ===

func (a *App) SearchDocuments(query string) ([]models.SearchResult, error) {
	ws, _ := a.db.GetActiveWorkspace()
	if ws == nil {
		return nil, fmt.Errorf("no active workspace")
	}
	return a.db.SearchDocuments(query, ws.ID)
}

// === Sync ===

// TriggerSync pulls published content from Drive (refresh only, no push).
func (a *App) TriggerSync() error {
	if a.syncMgr == nil {
		return fmt.Errorf("not signed in")
	}
	ws, err := a.db.GetActiveWorkspace()
	if err != nil || ws == nil {
		return fmt.Errorf("no active workspace")
	}
	updatedIDs, syncErr := a.syncMgr.SyncWorkspace(ws)

	if len(updatedIDs) > 0 {
		wailsRuntime.EventsEmit(a.ctx, "sync:docs-updated", updatedIDs)
	}

	return syncErr
}

// PublishDocument pushes a document (and its parent folders) to Google Drive.
func (a *App) PublishDocument(docID string) (*models.Document, error) {
	if a.driveClient == nil {
		return nil, fmt.Errorf("not signed in")
	}
	doc, err := a.getValidatedDoc(docID)
	if err != nil {
		return nil, err
	}
	ws, err := a.db.GetActiveWorkspace()
	if err != nil || ws == nil {
		return nil, fmt.Errorf("no active workspace")
	}

	// Ensure parent folders exist on Drive (publish ancestors first)
	driveFolderID := ws.DriveFolderID
	if doc.ParentID != "" {
		driveFolderID, err = a.ensureParentFoldersPublished(doc.ParentID, ws)
		if err != nil {
			return nil, fmt.Errorf("publish parent folders: %w", err)
		}
	}

	if doc.IsFolder {
		// Publish folder
		if doc.DriveFileID == "" {
			folder, err := a.driveClient.CreateFolder(doc.Title, driveFolderID)
			if err != nil {
				return nil, fmt.Errorf("create Drive folder: %w", err)
			}
			a.db.SetDriveFileID(doc.ID, folder.ID)
		}
	} else {
		// Publish document
		fileName := doc.Title + ".md"
		if doc.DriveFileID == "" {
			fileID, err := a.driveClient.CreateFile(fileName, driveFolderID, doc.Content)
			if err != nil {
				return nil, fmt.Errorf("create Drive file: %w", err)
			}
			a.db.SetDriveFileID(doc.ID, fileID)
		} else {
			if err := a.driveClient.UpdateFile(doc.DriveFileID, fileName, doc.Content); err != nil {
				return nil, fmt.Errorf("update Drive file: %w", err)
			}
		}
	}

	// Mark as published
	now := time.Now().UTC()
	a.db.SetDocumentStatus(doc.ID, "published")
	a.db.SetDriveModifiedAt(doc.ID, now)
	a.db.ClearDirty(doc.ID)

	// Upload any images referenced in the content that haven't been synced
	if !doc.IsFolder {
		a.publishReferencedImages(doc.Content, ws)
	}

	return a.db.GetDocument(docID)
}

// ensureParentFoldersPublished walks up the parent chain and creates any
// unpublished folders on Drive. Returns the Drive folder ID of the immediate parent.
func (a *App) ensureParentFoldersPublished(parentID string, ws *models.Workspace) (string, error) {
	parent, err := a.db.GetDocument(parentID)
	if err != nil {
		return ws.DriveFolderID, nil
	}

	// If parent already has a DriveFileID, use it
	if parent.DriveFileID != "" {
		return parent.DriveFileID, nil
	}

	// Recurse to grandparent first
	grandparentDriveFolderID := ws.DriveFolderID
	if parent.ParentID != "" {
		grandparentDriveFolderID, err = a.ensureParentFoldersPublished(parent.ParentID, ws)
		if err != nil {
			return "", err
		}
	}

	// Create this folder on Drive
	folder, err := a.driveClient.CreateFolder(parent.Title, grandparentDriveFolderID)
	if err != nil {
		return "", err
	}
	a.db.SetDriveFileID(parent.ID, folder.ID)
	a.db.SetDocumentStatus(parent.ID, "published")
	return folder.ID, nil
}

// publishReferencedImages uploads any local-only images to Drive's assets folder.
// Called during PublishDocument to ensure all embedded images are available on Drive.
func (a *App) publishReferencedImages(content string, ws *models.Workspace) {
	// Upload all unsynced images for this workspace
	unsynced, err := a.db.GetUnsyncedImages(ws.ID)
	if err != nil || len(unsynced) == 0 {
		return
	}

	dataDir, err := appDataDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "publishReferencedImages: appDataDir error: %v\n", err)
		return
	}

	assetsFolderID, err := a.driveClient.EnsureFolder(ws.DriveFolderID, "assets")
	if err != nil {
		fmt.Fprintf(os.Stderr, "publishReferencedImages: EnsureFolder error: %v\n", err)
		return
	}

	for _, img := range unsynced {
		imgPath := filepath.Join(dataDir, "image_cache", ws.ID, img.Filename)
		data, err := os.ReadFile(imgPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "publishReferencedImages: read %s error: %v\n", imgPath, err)
			continue
		}
		driveFileID, err := a.driveClient.UploadBinaryFile(img.Filename, assetsFolderID, data)
		if err != nil {
			fmt.Fprintf(os.Stderr, "publishReferencedImages: upload %s error: %v\n", img.Filename, err)
			continue
		}
		a.db.SetImageDriveFileID(img.ID, driveFileID)

		// Clean up local file — it's on Drive now.
		// The middleware will re-download on-demand if needed.
		//
		// Safety: verify the path is strictly inside our image_cache dir
		// before deleting. This prevents any path traversal bug from
		// deleting files outside the app's data directory.
		absCacheRoot, _ := filepath.Abs(filepath.Join(dataDir, "image_cache"))
		absImgPath, _ := filepath.Abs(imgPath)
		if absCacheRoot != "" && absImgPath != "" &&
			strings.HasPrefix(absImgPath, absCacheRoot+string(filepath.Separator)) &&
			!strings.Contains(img.Filename, "..") {
			os.Remove(absImgPath)
		}
	}
}

// imagePathRe is used by publishReferencedImages to find image refs in content.
var imagePathRe = regexp.MustCompile(`/images/[a-f0-9][-a-f0-9]*/[^\s)]+`)

func (a *App) GetSyncStatus() (*models.SyncStatus, error) {
	if a.syncMgr == nil {
		return &models.SyncStatus{State: "idle", Message: "Not connected"}, nil
	}
	status := a.syncMgr.GetStatus()
	return &status, nil
}

// === Collaboration ===

func (a *App) ShareWorkspace(workspaceID string, email string, role string) error {
	if a.driveClient == nil {
		return fmt.Errorf("not signed in")
	}
	// Validate role against allowlist — only "reader" and "writer" are permitted
	if role != "reader" && role != "writer" {
		return fmt.Errorf("invalid role %q: must be 'reader' or 'writer'", role)
	}
	ws, err := a.db.GetActiveWorkspace()
	if err != nil || ws == nil {
		return fmt.Errorf("no active workspace")
	}
	if ws.ID != workspaceID {
		return fmt.Errorf("workspace mismatch")
	}

	perm, err := a.driveClient.AddPermission(ws.DriveFolderID, email, role)
	if err != nil {
		return err
	}

	// Cache locally
	member := &models.WorkspaceMember{
		WorkspaceID:  workspaceID,
		Email:        email,
		Role:         role,
		DisplayName:  perm.DisplayName,
		PermissionID: perm.Id,
	}
	return a.db.UpsertWorkspaceMember(member)
}

func (a *App) GetWorkspaceMembers(workspaceID string) ([]models.WorkspaceMember, error) {
	// Enforce active workspace boundary — never leak members from other workspaces
	ws, err := a.db.GetActiveWorkspace()
	if err != nil || ws == nil {
		return nil, fmt.Errorf("no active workspace")
	}
	if ws.ID != workspaceID {
		return nil, fmt.Errorf("workspace mismatch")
	}

	if a.driveClient == nil {
		return a.db.GetWorkspaceMembers(workspaceID)
	}

	// Fetch fresh from Drive and cache
	perms, err := a.driveClient.ListPermissions(ws.DriveFolderID)
	if err != nil {
		return a.db.GetWorkspaceMembers(workspaceID)
	}

	for _, p := range perms {
		if p.Type != "user" {
			continue
		}
		member := &models.WorkspaceMember{
			WorkspaceID:  workspaceID,
			Email:        p.EmailAddress,
			Role:         p.Role,
			DisplayName:  p.DisplayName,
			PermissionID: p.Id,
		}
		a.db.UpsertWorkspaceMember(member)
	}

	return a.db.GetWorkspaceMembers(workspaceID)
}

func (a *App) RemoveWorkspaceMember(workspaceID string, email string) error {
	if a.driveClient == nil {
		return fmt.Errorf("not signed in")
	}

	// Validate workspace boundary first — prevent cross-workspace permission removal
	ws, err := a.db.GetActiveWorkspace()
	if err != nil || ws == nil {
		return fmt.Errorf("no active workspace")
	}
	if ws.ID != workspaceID {
		return fmt.Errorf("workspace mismatch")
	}

	members, err := a.db.GetWorkspaceMembers(workspaceID)
	if err != nil {
		return err
	}

	for _, m := range members {
		if m.Email == email && m.PermissionID != "" {
			if err := a.driveClient.RemovePermission(ws.DriveFolderID, m.PermissionID); err != nil {
				return err
			}
			break
		}
	}

	return a.db.DeleteWorkspaceMember(workspaceID, email)
}

// === Version History ===

func (a *App) GetVersionHistory(docID string) ([]models.Revision, error) {
	if a.driveClient == nil {
		return nil, fmt.Errorf("not signed in")
	}
	doc, err := a.getValidatedDoc(docID)
	if err != nil {
		return nil, err
	}
	if doc.DriveFileID == "" {
		return nil, fmt.Errorf("document has not been synced to Drive yet")
	}
	return a.driveClient.ListRevisions(doc.DriveFileID)
}

func (a *App) PreviewRevision(docID string, revisionID string) (string, error) {
	if a.driveClient == nil {
		return "", fmt.Errorf("not signed in")
	}
	doc, err := a.getValidatedDoc(docID)
	if err != nil {
		return "", err
	}
	if doc.DriveFileID == "" {
		return "", fmt.Errorf("document has not been synced to Drive yet")
	}
	return a.driveClient.DownloadRevision(doc.DriveFileID, revisionID)
}

func (a *App) RestoreVersion(docID string, revisionID string) (*models.Document, error) {
	content, err := a.PreviewRevision(docID, revisionID)
	if err != nil {
		return nil, err
	}
	doc, err := a.db.GetDocument(docID)
	if err != nil {
		return nil, err
	}
	// Use the workspace-guarded UpdateDocument instead of a.db.UpdateDocument directly
	return a.UpdateDocument(docID, doc.Title, content)
}

// === Export ===

func (a *App) ExportWorkspace() (string, error) {
	destPath, err := wailsRuntime.OpenDirectoryDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title: "Choose Export Destination",
	})
	if err != nil {
		return "", err
	}
	if destPath == "" {
		return "", fmt.Errorf("no folder selected")
	}

	ws, err := a.db.GetActiveWorkspace()
	if err != nil || ws == nil {
		return "", fmt.Errorf("no active workspace")
	}

	// Sanitize workspace name to prevent path traversal
	safeName := filepath.Base(ws.Name)
	if safeName == "." || safeName == ".." || safeName == "" {
		safeName = "HexNote-Export"
	}
	exportDir := filepath.Join(destPath, safeName)
	if err := export.ExportWorkspace(a.db, ws.ID, exportDir); err != nil {
		return "", err
	}

	return exportDir, nil
}

// === Settings ===

func (a *App) GetSettings() (*models.Settings, error) {
	s, err := a.db.GetSettings()
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (a *App) UpdateSettings(syncIntervalSecs int, theme string, autoSaveDelaySecs int) (*models.Settings, error) {
	s := models.Settings{
		SyncIntervalSecs:  syncIntervalSecs,
		Theme:             theme,
		AutoSaveDelaySecs: autoSaveDelaySecs,
	}
	if err := a.db.UpdateSettings(s); err != nil {
		return nil, err
	}
	wailsRuntime.EventsEmit(a.ctx, "settings:changed", s)
	return &s, nil
}

// === Image Upload ===

func (a *App) UploadImage(base64Data string, filename string) (string, error) {
	ws, err := a.db.GetActiveWorkspace()
	if err != nil || ws == nil {
		return "", fmt.Errorf("no active workspace")
	}

	dataDir, err := appDataDir()
	if err != nil {
		return "", err
	}

	// Sanitize filename: strip path separators, use only the base name
	safeFilename := filepath.Base(filename)
	safeFilename = strings.ReplaceAll(safeFilename, "..", "")
	safeFilename = strings.ReplaceAll(safeFilename, "/", "")
	safeFilename = strings.ReplaceAll(safeFilename, "\\", "")
	if safeFilename == "" || safeFilename == "." {
		safeFilename = "image.png"
	}

	// Ensure filename has an extension
	if filepath.Ext(safeFilename) == "" {
		safeFilename += ".png"
	}

	// Generate unique filename — avoid doubling the img- prefix when the
	// editor pastes an already-uploaded image (blob name = "img-foo.jpg").
	dashName := strings.ReplaceAll(safeFilename, " ", "-")
	var id string
	if strings.HasPrefix(dashName, "img-") {
		id = dashName
	} else {
		id = "img-" + dashName
	}
	asset, _ := a.db.GetImageAsset(ws.ID, id)
	if asset != nil {
		// Already exists, reuse the name
		return "/images/" + ws.ID + "/" + id, nil
	}

	// Decode base64
	data, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return "", fmt.Errorf("decode image: %w", err)
	}

	// Save to local cache
	cacheDir := filepath.Join(dataDir, "image_cache", ws.ID)
	if err := os.MkdirAll(cacheDir, 0700); err != nil {
		return "", fmt.Errorf("create cache dir: %w", err)
	}
	// Tighten permissions on existing directories — MkdirAll is a no-op on existing dirs
	if err := os.Chmod(cacheDir, 0700); err != nil {
		return "", fmt.Errorf("set cache dir permissions: %w", err)
	}

	localPath := filepath.Join(cacheDir, id)
	// Verify the resolved path stays inside the cache directory
	absPath, err := filepath.Abs(localPath)
	if err != nil || !strings.HasPrefix(absPath, cacheDir) {
		return "", fmt.Errorf("invalid image filename")
	}

	// File-level dedup: if a file with the same name already exists on disk
	// AND it's already been uploaded to Drive, skip entirely.
	if _, statErr := os.Stat(localPath); statErr == nil {
		existingAsset, _ := a.db.GetImageAsset(ws.ID, id)
		if existingAsset != nil && existingAsset.DriveFileID != "" {
			// Fully deduped — on disk AND on Drive
			return "/images/" + ws.ID + "/" + id, nil
		}
		// On disk but not yet on Drive — still need to upload (fall through)
		if existingAsset == nil {
			a.db.CreateImageAsset(ws.ID, id)
		}
	} else {
		// Not on disk — write it
		if err := os.WriteFile(localPath, data, 0644); err != nil {
			return "", fmt.Errorf("write image cache: %w", err)
		}
		a.db.CreateImageAsset(ws.ID, id)
	}

	// Images stay local until the document is published.
	// PublishDocument calls publishReferencedImages to upload them to Drive.
	return "/images/" + ws.ID + "/" + id, nil
}

// === Debug ===

func (a *App) DumpLogs(logs string) (string, error) {
	dataDir, err := appDataDir()
	if err != nil {
		return "", err
	}
	logFile := filepath.Join(dataDir, "frontend.log")
	err = os.WriteFile(logFile, []byte(logs), 0600)
	if err != nil {
		return "", err
	}
	return logFile, nil
}

// Helpers

func appDataDir() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "HexNote"), nil
}

// parseDriveFolderID extracts a folder ID from a Google Drive URL or raw ID string.
// Supports: https://drive.google.com/drive/folders/FOLDER_ID?... or just FOLDER_ID
func parseDriveFolderID(input string) string {
	input = strings.TrimSpace(input)
	if input == "" {
		return ""
	}
	// Try to extract from URL: .../folders/FOLDER_ID
	const marker = "/folders/"
	if idx := strings.Index(input, marker); idx >= 0 {
		id := input[idx+len(marker):]
		// Strip query params or hash
		for _, sep := range []string{"?", "#", "/"} {
			if i := strings.Index(id, sep); i >= 0 {
				id = id[:i]
			}
		}
		return id
	}
	// If no URL pattern, treat entire input as a raw folder ID (no spaces/slashes)
	if !strings.Contains(input, "/") && !strings.Contains(input, " ") {
		return input
	}
	return ""
}
