package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"hexnote/internal/drive"
	"hexnote/internal/export"
	"hexnote/internal/models"
	"hexnote/internal/storage"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx        context.Context
	db         *storage.Database
	appDataDir string
	authMgr    *drive.AuthManager

	// driveMu guards driveClient and syncMgr. Wails runs bound methods
	// concurrently and an expired sign-in clears both, so methods take one
	// snapshot through client()/syncer() instead of reading the fields.
	driveMu     sync.RWMutex
	driveClient *drive.Client
	syncMgr     *drive.SyncManager

	// emitFn sends an event to the frontend. It defaults to the Wails runtime
	// and is replaced in tests, where no Wails context exists.
	emitFn func(name string, data ...interface{})
}

func NewApp() *App {
	return &App{}
}

// emit sends an event to the frontend.
func (a *App) emit(name string, data ...interface{}) {
	if a.emitFn != nil {
		a.emitFn(name, data...)
		return
	}
	if a.ctx != nil {
		wailsRuntime.EventsEmit(a.ctx, name, data...)
	}
}

// notify shows a toast in the frontend (level: info, success, warning, error).
func (a *App) notify(level, message string) {
	a.emit("notification", map[string]string{"level": level, "message": message})
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
	a.setDrive(client)
}

// client returns the current Drive client, or nil when signed out.
func (a *App) client() *drive.Client {
	a.driveMu.RLock()
	defer a.driveMu.RUnlock()
	return a.driveClient
}

// syncer returns the current sync manager, or nil when signed out.
func (a *App) syncer() *drive.SyncManager {
	a.driveMu.RLock()
	defer a.driveMu.RUnlock()
	return a.syncMgr
}

// setDrive installs a Drive client (and a sync manager for it); nil clears both.
func (a *App) setDrive(client *drive.Client) {
	a.driveMu.Lock()
	defer a.driveMu.Unlock()
	a.driveClient = client
	a.syncMgr = nil
	if client != nil {
		a.syncMgr = drive.NewSyncManager(client, a.db, a.appDataDir)
	}
}

// === Errors ===
//
// Errors returned to the frontend start with a stable prefix that
// describeError() in app.js maps to a sentence and an action:
//   ERR_AUTH:      sign-in expired or missing  -> Sign in again
//   ERR_OFFLINE:   Google Drive not reachable  -> Retry
//   ERR_FORBIDDEN: no permission on Drive      -> Open folder in Drive
//   ERR_NOTFOUND:  file or folder is gone      -> Refresh
//   ERR_CONFLICT:  changed on Drive by someone else (see PublishDocument)
//   ERR_INVALID:   bad input; the rest of the message is shown as is
// The rest of the message is detail for the console and log.

var errNotSignedIn = errors.New("ERR_AUTH: not signed in to Google")

// driveErr turns a Drive failure into a prefixed error. An expired or revoked
// sign-in also ends the session, so the UI can ask the user to sign in again
// instead of failing every call with raw OAuth text.
func (a *App) driveErr(action string, err error) error {
	if err == nil {
		return nil
	}
	// Already carries a code (for example ERR_INVALID from the client).
	if strings.HasPrefix(err.Error(), "ERR_") {
		return err
	}
	switch drive.Classify(err) {
	case drive.KindAuth:
		a.expireSession(true)
		return fmt.Errorf("ERR_AUTH: %s: Google sign-in expired: %v", action, err)
	case drive.KindOffline:
		return fmt.Errorf("ERR_OFFLINE: %s: %v", action, err)
	case drive.KindForbidden:
		return fmt.Errorf("ERR_FORBIDDEN: %s: %v", action, err)
	case drive.KindNotFound:
		return fmt.Errorf("ERR_NOTFOUND: %s: %v", action, err)
	}
	return fmt.Errorf("%s: %w", action, err)
}

// expireSession forgets a sign-in that Google no longer accepts: the saved
// token is deleted, Drive access is dropped and, if notify is set, the
// frontend receives auth:expired. Local pages are not touched.
func (a *App) expireSession(notify bool) {
	a.driveMu.Lock()
	wasSignedIn := a.driveClient != nil
	a.driveClient = nil
	a.syncMgr = nil
	a.driveMu.Unlock()

	if a.authMgr != nil {
		a.authMgr.SignOut()
	}
	if notify && wasSignedIn {
		a.emit("auth:expired")
	}
}

func (a *App) shutdown(ctx context.Context) {
	if a.db != nil {
		a.db.Close()
	}
}

// === Auth methods ===

// GetAuthStatus reports whether credentials exist and whether the user is
// signed in. The sign-in is checked against Google: if the refresh token was
// revoked or expired, the session ends here and SessionExpired is set. When
// Google cannot be reached the user stays signed in (working offline) and the
// last known email is reported.
func (a *App) GetAuthStatus() (*models.AuthStatus, error) {
	client := a.client()
	status := &models.AuthStatus{
		HasCredentials:   a.authMgr.HasCredentials(),
		IsSignedIn:       a.authMgr.HasValidToken() && client != nil,
		Mode:             a.authMgr.Mode(),
		BundledAvailable: drive.BundledClientAvailable(),
	}
	if !status.IsSignedIn {
		return status, nil
	}
	email, err := client.GetUserEmail()
	switch {
	case err == nil:
		status.UserEmail = email
		a.db.SetSetting("accountEmail", email)
	case drive.Classify(err) == drive.KindAuth:
		a.expireSession(false)
		status.IsSignedIn = false
		status.SessionExpired = true
	default:
		status.UserEmail, _ = a.db.GetSetting("accountEmail")
		status.Offline = drive.Classify(err) == drive.KindOffline
	}
	return status, nil
}

// ImportCredentials stores the user's OAuth client JSON. Tokens belong to a
// client ID, so switching to a different client signs the user out.
func (a *App) ImportCredentials(jsonContent string) error {
	if err := a.authMgr.SaveCredentials(jsonContent); err != nil {
		return err
	}
	if !a.authMgr.HasValidToken() {
		a.setDrive(nil)
	}
	return nil
}

// UseBundledCredentials switches to Solo mode: the pasted Team-mode client
// is forgotten and the next sign-in uses HexNote's own client with the
// drive.file scope. Workspaces set up in Team mode stay on this PC, but
// Solo mode cannot see their Drive folders unless HexNote created them.
func (a *App) UseBundledCredentials() error {
	if !drive.BundledClientAvailable() {
		return fmt.Errorf("ERR_INVALID: This build of HexNote has no built-in sign-in. Use your team's Google Cloud credentials.")
	}
	a.setDrive(nil)
	return a.authMgr.ClearCredentials()
}

// soloMode reports whether the app runs with the drive.file scope, where
// HexNote only sees Drive files and folders it created itself.
func (a *App) soloMode() bool {
	return a.authMgr != nil && a.authMgr.Mode() == drive.ModeSolo
}

var errNeedsTeamMode = errors.New("ERR_INVALID: Opening folders that HexNote did not create needs Team mode (your own Google Cloud credentials). In Solo mode, create a new workspace instead.")

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
	a.setDrive(nil)
	return a.authMgr.SignOut()
}

// === Workspace methods ===

// GetWorkspaces lists workspaces with the user's access on each, where the
// cached member list knows it.
func (a *App) GetWorkspaces() ([]models.Workspace, error) {
	list, err := a.db.GetWorkspaces()
	if err != nil {
		return nil, err
	}
	email, _ := a.db.GetSetting("accountEmail")
	if email == "" {
		return list, nil
	}
	for i := range list {
		members, err := a.db.GetWorkspaceMembers(list[i].ID)
		if err != nil {
			continue
		}
		for _, m := range members {
			if strings.EqualFold(m.Email, email) {
				list[i].Access = m.Role
				break
			}
		}
	}
	return list, nil
}

func (a *App) GetActiveWorkspace() (*models.Workspace, error) {
	return a.db.GetActiveWorkspace()
}

// CreateSoloWorkspace creates a workspace backed by a new folder in the
// user's My Drive. Solo mode (drive.file) cannot list existing folders, so
// HexNote creates the folder itself; it works in Team mode too.
func (a *App) CreateSoloWorkspace(name string) (*models.Workspace, error) {
	client := a.client()
	if client == nil {
		return nil, errNotSignedIn
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("ERR_INVALID: Give the workspace a name.")
	}
	folder, err := client.CreateFolder(name, "root")
	if err != nil {
		return nil, a.driveErr("create the workspace folder", err)
	}
	return a.CreateWorkspace(name, folder.ID)
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
	client := a.client()
	if client == nil {
		return nil, errNotSignedIn
	}
	folders, err := client.ListFolders(parentFolderID)
	return folders, a.driveErr("list Drive folders", err)
}

func (a *App) CreateDriveFolder(name string, parentFolderID string) (*models.DriveFolder, error) {
	client := a.client()
	if client == nil {
		return nil, errNotSignedIn
	}
	folder, err := client.CreateFolder(name, parentFolderID)
	return folder, a.driveErr("create Drive folder", err)
}

func (a *App) SearchSharedFolders(query string) ([]models.DriveFolder, error) {
	client := a.client()
	if client == nil {
		return nil, errNotSignedIn
	}
	if a.soloMode() {
		return nil, errNeedsTeamMode
	}
	folders, err := client.SearchSharedFolders(query)
	return folders, a.driveErr("search shared folders", err)
}

// ResolveFolderLink extracts a folder ID from a Google Drive URL and returns its metadata.
func (a *App) ResolveFolderLink(link string) (*models.DriveFolder, error) {
	client := a.client()
	if client == nil {
		return nil, errNotSignedIn
	}
	if a.soloMode() {
		return nil, errNeedsTeamMode
	}
	folderID := parseDriveFolderID(link)
	if folderID == "" {
		return nil, fmt.Errorf("ERR_INVALID: That doesn't look like a Google Drive folder link.")
	}
	folder, err := client.GetFolderByID(folderID)
	return folder, a.driveErr("open folder link", err)
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

// RenameDocument changes only a document's title, so it can never overwrite
// body edits. A page becomes a draft (the new name reaches Drive when it is
// published). A folder has no content worth holding back, so a published
// folder's rename is pushed to Drive right away; if that is not possible now
// (offline, signed out) the folder becomes a draft and can be published later.
func (a *App) RenameDocument(id string, title string) (*models.Document, error) {
	doc, err := a.getValidatedDoc(id)
	if err != nil {
		return nil, err
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return nil, fmt.Errorf("ERR_INVALID: The name cannot be empty.")
	}
	if err := a.db.RenameDocument(id, title); err != nil {
		return nil, err
	}

	if !doc.IsFolder || doc.DriveFileID == "" {
		if !doc.IsFolder {
			a.db.SetDocumentStatus(id, "draft")
		}
		return a.db.GetDocument(id)
	}

	status := "draft"
	if client := a.client(); client != nil {
		if err := client.RenameFile(doc.DriveFileID, title); err == nil {
			status = "published"
		} else {
			// Keep the local rename; the folder shows as unpublished.
			a.driveErr("rename Drive folder", err)
		}
	}
	a.db.SetDocumentStatus(id, status)
	return a.db.GetDocument(id)
}

// DeleteDocument deletes a page (or folder and its contents) locally and moves
// its Drive file to the Drive trash, so the page does not come back on the
// next refresh here or on a teammate's PC. If the trash call cannot be made
// now, the Drive ID is recorded as a tombstone: sync skips it and retries the
// trash on every refresh.
func (a *App) DeleteDocument(id string) error {
	doc, err := a.getValidatedDoc(id)
	if err != nil {
		return err
	}
	driveIDs, err := a.db.DriveTrashRoots(id)
	if err != nil {
		return err
	}
	if err := a.db.DeleteDocument(id); err != nil {
		return err
	}
	if len(driveIDs) == 0 {
		return nil
	}

	wsID := doc.WorkspaceID
	client := a.client()
	var pending, forbidden int
	for _, fileID := range driveIDs {
		// Tombstone first: a refresh running while the trash call is in
		// flight must not re-import the page as new.
		a.db.AddDeletedDriveFile(wsID, fileID)
		if client != nil {
			err := client.TrashFile(fileID)
			if err == nil || drive.IsNotFound(err) {
				a.db.RemoveDeletedDriveFile(wsID, fileID)
				continue
			}
			switch drive.Classify(err) {
			case drive.KindForbidden:
				forbidden++
			case drive.KindAuth:
				a.driveErr("move to Drive trash", err) // ends the session
				pending++
			default:
				pending++
			}
			fmt.Fprintf(os.Stderr, "DeleteDocument: trash %s: %v\n", fileID, err)
		} else {
			pending++
		}
	}

	switch {
	case forbidden > 0:
		a.notify("warning", "Deleted on this PC. You don't have permission to move the Drive file to trash, so teammates will still see it. Ask the folder owner to delete it.")
	case pending > 0:
		a.notify("warning", "Deleted on this PC. HexNote couldn't reach Google Drive and will move the Drive file to trash on the next refresh.")
	}
	return nil
}

// MoveDocument moves a page or folder into another folder ("" = top level),
// at the end.
func (a *App) MoveDocument(id string, newParentID string) (*models.Document, error) {
	return a.MoveDocumentTo(id, newParentID, "")
}

// MoveDocumentTo moves a page or folder into newParentID ("" = top level),
// just before the sibling beforeID ("" = at the end). A published item is
// moved on Drive too; an unpublished one only locally. If the Drive move
// cannot be made now, the item becomes a draft and Publish completes it.
// The order among siblings is kept on this PC only.
func (a *App) MoveDocumentTo(id, newParentID, beforeID string) (*models.Document, error) {
	doc, err := a.getValidatedDoc(id)
	if err != nil {
		return nil, err
	}
	if newParentID != "" {
		parent, err := a.getValidatedDoc(newParentID)
		if err != nil {
			return nil, fmt.Errorf("ERR_INVALID: Pages can only be moved within the same workspace.")
		}
		if !parent.IsFolder {
			return nil, fmt.Errorf("ERR_INVALID: Pages can only be moved into a folder.")
		}
		if a.db.IsDescendant(newParentID, id) {
			return nil, fmt.Errorf("ERR_INVALID: A folder cannot be moved into itself.")
		}
	}
	if beforeID != "" {
		if _, err := a.getValidatedDoc(beforeID); err != nil {
			beforeID = ""
		}
	}

	parentChanged := doc.ParentID != newParentID
	if err := a.db.PlaceDocument(id, newParentID, beforeID); err != nil {
		return nil, err
	}
	if !parentChanged || doc.DriveFileID == "" {
		return a.db.GetDocument(id)
	}

	if err := a.moveOnDrive(doc, newParentID); err != nil {
		a.driveErr("move on Drive", err) // ends the session if the sign-in expired
		a.db.SetDocumentStatus(id, "draft")
		a.notify("warning", "Moved on this PC. HexNote couldn't move it on Google Drive; publish it to finish the move.")
	}
	return a.db.GetDocument(id)
}

// moveOnDrive puts a published item's Drive file into the Drive folder of
// localParentID ("" = the workspace folder), creating that folder on Drive
// if needed.
func (a *App) moveOnDrive(doc *models.Document, localParentID string) error {
	client := a.client()
	if client == nil {
		return errNotSignedIn
	}
	ws, err := a.db.GetActiveWorkspace()
	if err != nil || ws == nil {
		return fmt.Errorf("no active workspace")
	}
	target := ws.DriveFolderID
	if localParentID != "" {
		target, err = a.ensureParentFoldersPublished(client, localParentID, ws)
		if err != nil {
			return err
		}
	}
	info, err := client.GetFileInfo(doc.DriveFileID)
	if err != nil {
		return err
	}
	for _, p := range info.Parents {
		if p == target {
			return nil // already there
		}
	}
	return client.MoveFile(doc.DriveFileID, target, info.Parents)
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
// It returns what changed, so the frontend can stay quiet when nothing did.
func (a *App) TriggerSync() (*models.SyncSummary, error) {
	syncMgr := a.syncer()
	if syncMgr == nil {
		return nil, errNotSignedIn
	}
	ws, err := a.db.GetActiveWorkspace()
	if err != nil || ws == nil {
		return nil, fmt.Errorf("no active workspace")
	}
	result, syncErr := syncMgr.SyncWorkspace(ws)
	if syncErr != nil {
		return nil, a.driveErr("refresh from Drive", syncErr)
	}

	if len(result.UpdatedIDs) > 0 {
		a.emit("sync:docs-updated", result.UpdatedIDs)
	}
	if len(result.RemovedIDs) > 0 || len(result.DetachedIDs) > 0 {
		a.emit("sync:docs-removed", map[string][]string{
			"removed":  result.RemovedIDs,
			"detached": result.DetachedIDs,
		})
	}
	return &models.SyncSummary{Updated: result.UpdatedIDs, Removed: result.RemovedIDs, Detached: result.DetachedIDs}, nil
}

// PublishDocument pushes a document (and its parent folders) to Google Drive.
// If someone else changed the page on Drive since this PC last saw it, it
// returns an ERR_CONFLICT error instead of overwriting their work; the UI
// then offers ForcePublishDocument, DiscardLocalChanges or KeepBothVersions.
func (a *App) PublishDocument(docID string) (*models.Document, error) {
	return a.publish(docID, false)
}

// ForcePublishDocument publishes even if the Drive file changed since this
// PC last saw it (the user chose to overwrite). Drive keeps the replaced
// text as a revision in version history.
func (a *App) ForcePublishDocument(docID string) (*models.Document, error) {
	return a.publish(docID, true)
}

// conflictSkew absorbs clock differences in timestamps recorded before
// DriveModifiedAt came from Drive itself.
const conflictSkew = 2 * time.Second

// conflictError describes a newer version on Drive as
// ERR_CONFLICT: {"by": "<name>", "at": "<RFC3339 time>"}.
func conflictError(info *drive.FileInfo) error {
	payload, _ := json.Marshal(map[string]string{
		"by": info.ModifiedBy,
		"at": info.ModifiedTime.UTC().Format(time.RFC3339),
	})
	return fmt.Errorf("ERR_CONFLICT: %s", payload)
}

func (a *App) publish(docID string, force bool) (*models.Document, error) {
	client := a.client()
	if client == nil {
		return nil, errNotSignedIn
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
		driveFolderID, err = a.ensureParentFoldersPublished(client, doc.ParentID, ws)
		if err != nil {
			return nil, a.driveErr("publish parent folders", err)
		}
	}

	if doc.IsFolder {
		// Publish folder
		if doc.DriveFileID == "" {
			folder, err := client.CreateFolder(doc.Title, driveFolderID)
			if err != nil {
				return nil, a.driveErr("create Drive folder", err)
			}
			a.db.SetDriveFileID(doc.ID, folder.ID)
		} else {
			// A published folder is only a draft after a rename or move that
			// could not be pushed; publishing pushes both.
			if err := client.RenameFile(doc.DriveFileID, doc.Title); err != nil {
				return nil, a.driveErr("rename Drive folder", err)
			}
			if err := a.moveOnDrive(doc, doc.ParentID); err != nil {
				return nil, a.driveErr("move Drive folder", err)
			}
		}
	} else {
		// Publish document. The file on Drive gets relative image links
		// (see drive.PortableContent) so it works outside this PC.
		fileName := doc.Title + ".md"
		fileID := doc.DriveFileID
		driveContent := drive.PortableContent(doc.Content, a.folderDepth(doc))

		if fileID != "" {
			info, err := client.GetFileInfo(fileID)
			switch {
			case err != nil && drive.IsNotFound(err):
				fileID = "" // deleted on Drive: publish as a new file
			case err != nil:
				return nil, a.driveErr("check the Drive file", err)
			case info.Trashed:
				fileID = "" // writing into the trash would hide the edit
			case !force && doc.DriveModifiedAt != nil && info.ModifiedTime.After(doc.DriveModifiedAt.Add(conflictSkew)):
				return nil, conflictError(info)
			default:
				// Finish a move that could not reach Drive earlier.
				if !containsString(info.Parents, driveFolderID) {
					if err := client.MoveFile(fileID, driveFolderID, info.Parents); err != nil {
						return nil, a.driveErr("move the Drive file", err)
					}
				}
			}
		}

		var modified time.Time
		if fileID == "" {
			newID, mt, err := client.CreateFile(fileName, driveFolderID, driveContent)
			if err != nil {
				return nil, a.driveErr("create Drive file", err)
			}
			a.db.SetDriveFileID(doc.ID, newID)
			modified = mt
		} else {
			mt, err := client.UpdateFile(fileID, fileName, driveContent)
			if err != nil {
				return nil, a.driveErr("update Drive file", err)
			}
			modified = mt
		}
		a.db.SetDriveModifiedAt(doc.ID, modified)
	}

	// Mark as published
	a.db.SetDocumentStatus(doc.ID, "published")
	if doc.IsFolder {
		a.db.SetDriveModifiedAt(doc.ID, time.Now().UTC())
	}
	a.db.ClearDirty(doc.ID)

	// Upload any images referenced in the content that haven't been synced
	if !doc.IsFolder {
		a.publishReferencedImages(client, doc.Content, ws)
	}

	return a.db.GetDocument(docID)
}

// KeepEditBase records that the open page's unsaved edits were based on the
// Drive version from driveModifiedAt (RFC 3339), after a refresh brought in
// a newer one underneath them. Publish then reports the conflict instead of
// silently replacing the newer version. Only moves the timestamp back, and
// only for drafts.
func (a *App) KeepEditBase(docID string, driveModifiedAt string) error {
	doc, err := a.getValidatedDoc(docID)
	if err != nil {
		return err
	}
	base, err := time.Parse(time.RFC3339Nano, driveModifiedAt)
	if err != nil {
		return fmt.Errorf("ERR_INVALID: bad timestamp %q", driveModifiedAt)
	}
	if doc.Status != "draft" || doc.DriveModifiedAt == nil || !base.Before(*doc.DriveModifiedAt) {
		return nil
	}
	return a.db.SetDriveModifiedAt(docID, base)
}

// DiscardLocalChanges replaces the local page with the current version on
// Drive ("Load theirs" after a publish conflict). Unpublished local edits
// are lost.
func (a *App) DiscardLocalChanges(docID string) (*models.Document, error) {
	client := a.client()
	if client == nil {
		return nil, errNotSignedIn
	}
	doc, err := a.getValidatedDoc(docID)
	if err != nil {
		return nil, err
	}
	if doc.DriveFileID == "" || doc.IsFolder {
		return nil, fmt.Errorf("ERR_INVALID: This page has no published version to load.")
	}
	info, err := client.GetFileInfo(doc.DriveFileID)
	if err != nil {
		return nil, a.driveErr("load the Drive version", err)
	}
	content, err := client.DownloadFile(doc.DriveFileID)
	if err != nil {
		return nil, a.driveErr("load the Drive version", err)
	}
	title := strings.TrimSuffix(info.Name, ".md")
	if title == "" {
		title = doc.Title
	}
	if err := a.db.UpdateDocumentFromSync(doc.ID, title, drive.LocalizeContent(content, doc.WorkspaceID)); err != nil {
		return nil, err
	}
	a.db.SetDocumentStatus(doc.ID, "published")
	a.db.SetDriveModifiedAt(doc.ID, info.ModifiedTime)
	a.db.ClearDirty(doc.ID)
	return a.db.GetDocument(doc.ID)
}

// KeepBothVersions resolves a publish conflict without losing anything: the
// local text is saved as a new draft page "<title> (my version)" next to the
// original, and the original takes the version on Drive. Returns the copy.
func (a *App) KeepBothVersions(docID string) (*models.Document, error) {
	doc, err := a.getValidatedDoc(docID)
	if err != nil {
		return nil, err
	}
	copyDoc, err := a.db.CreateDocument(doc.Title+" (my version)", doc.ParentID, doc.WorkspaceID, false)
	if err != nil {
		return nil, err
	}
	if _, err := a.db.UpdateDocument(copyDoc.ID, copyDoc.Title, doc.Content); err != nil {
		return nil, err
	}
	// The copy exists before the original is touched, so a failure below
	// loses nothing.
	if _, err := a.DiscardLocalChanges(docID); err != nil {
		return nil, err
	}
	return a.db.GetDocument(copyDoc.ID)
}

// ensureParentFoldersPublished walks up the parent chain and creates any
// unpublished folders on Drive. Returns the Drive folder ID of the immediate parent.
func (a *App) ensureParentFoldersPublished(client *drive.Client, parentID string, ws *models.Workspace) (string, error) {
	parent, err := a.db.GetDocument(parentID)
	if err != nil {
		return ws.DriveFolderID, nil
	}

	// If parent already has a DriveFileID, use it. A draft folder has a
	// rename or a move that has not reached Drive; push both (best effort:
	// the child can be published either way) and only then mark it
	// published, or the next refresh would undo the pending move.
	if parent.DriveFileID != "" {
		if parent.Status == "draft" {
			if err := client.RenameFile(parent.DriveFileID, parent.Title); err == nil {
				if err := a.moveOnDrive(parent, parent.ParentID); err == nil {
					a.db.SetDocumentStatus(parent.ID, "published")
				}
			}
		}
		return parent.DriveFileID, nil
	}

	// Recurse to grandparent first
	grandparentDriveFolderID := ws.DriveFolderID
	if parent.ParentID != "" {
		grandparentDriveFolderID, err = a.ensureParentFoldersPublished(client, parent.ParentID, ws)
		if err != nil {
			return "", err
		}
	}

	// Create this folder on Drive
	folder, err := client.CreateFolder(parent.Title, grandparentDriveFolderID)
	if err != nil {
		return "", err
	}
	a.db.SetDriveFileID(parent.ID, folder.ID)
	a.db.SetDocumentStatus(parent.ID, "published")
	return folder.ID, nil
}

// publishReferencedImages uploads any local-only images to Drive's assets folder.
// Called during PublishDocument to ensure all embedded images are available on Drive.
func (a *App) publishReferencedImages(client *drive.Client, content string, ws *models.Workspace) {
	// Upload all unsynced images for this workspace
	unsynced, err := a.db.GetUnsyncedImages(ws.ID)
	if err != nil || len(unsynced) == 0 {
		return
	}

	dataDir := a.appDataDir

	assetsFolderID, err := client.EnsureFolder(ws.DriveFolderID, "assets")
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
		driveFileID, err := client.UploadBinaryFile(img.Filename, assetsFolderID, data)
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

func (a *App) GetSyncStatus() (*models.SyncStatus, error) {
	syncMgr := a.syncer()
	if syncMgr == nil {
		return &models.SyncStatus{State: "idle", Message: "Not connected"}, nil
	}
	status := syncMgr.GetStatus()
	return &status, nil
}

// === Collaboration ===

func (a *App) ShareWorkspace(workspaceID string, email string, role string) error {
	client := a.client()
	if client == nil {
		return errNotSignedIn
	}
	// Validate role against allowlist — only "reader" and "writer" are permitted
	if role != "reader" && role != "writer" {
		return fmt.Errorf("ERR_INVALID: Choose Viewer or Editor (got %q).", role)
	}
	ws, err := a.db.GetActiveWorkspace()
	if err != nil || ws == nil {
		return fmt.Errorf("no active workspace")
	}
	if ws.ID != workspaceID {
		return fmt.Errorf("workspace mismatch")
	}

	perm, err := client.AddPermission(ws.DriveFolderID, email, role)
	if err != nil {
		return a.driveErr("share workspace", err)
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
	client := a.client()
	// Enforce active workspace boundary — never leak members from other workspaces
	ws, err := a.db.GetActiveWorkspace()
	if err != nil || ws == nil {
		return nil, fmt.Errorf("no active workspace")
	}
	if ws.ID != workspaceID {
		return nil, fmt.Errorf("workspace mismatch")
	}

	if client == nil {
		return a.db.GetWorkspaceMembers(workspaceID)
	}

	// Fetch fresh from Drive and cache
	perms, err := client.ListPermissions(ws.DriveFolderID)
	if err != nil {
		a.driveErr("list members", err) // ends the session if the sign-in expired
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
	client := a.client()
	if client == nil {
		return errNotSignedIn
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
			if err := client.RemovePermission(ws.DriveFolderID, m.PermissionID); err != nil {
				return a.driveErr("remove member", err)
			}
			break
		}
	}

	return a.db.DeleteWorkspaceMember(workspaceID, email)
}

// === Version History ===

func (a *App) GetVersionHistory(docID string) ([]models.Revision, error) {
	client := a.client()
	if client == nil {
		return nil, errNotSignedIn
	}
	doc, err := a.getValidatedDoc(docID)
	if err != nil {
		return nil, err
	}
	if doc.DriveFileID == "" {
		return nil, fmt.Errorf("document has not been synced to Drive yet")
	}
	revs, err := client.ListRevisions(doc.DriveFileID)
	return revs, a.driveErr("load version history", err)
}

func (a *App) PreviewRevision(docID string, revisionID string) (string, error) {
	client := a.client()
	if client == nil {
		return "", errNotSignedIn
	}
	doc, err := a.getValidatedDoc(docID)
	if err != nil {
		return "", err
	}
	if doc.DriveFileID == "" {
		return "", fmt.Errorf("document has not been synced to Drive yet")
	}
	content, err := client.DownloadRevision(doc.DriveFileID, revisionID)
	if err != nil {
		return "", a.driveErr("load version", err)
	}
	return drive.LocalizeContent(content, doc.WorkspaceID), nil
}

// RestoreVersion replaces a page's text with an earlier Drive revision. The
// text it replaces stays recoverable: if the page is published and up to
// date, that text is already the newest revision on Drive; if it has
// unpublished edits, they are first saved as a draft page
// "<title> (before restore)" next to it. The restored text is a draft until
// published.
func (a *App) RestoreVersion(docID string, revisionID string) (*models.RestoreResult, error) {
	content, err := a.PreviewRevision(docID, revisionID)
	if err != nil {
		return nil, err
	}
	doc, err := a.getValidatedDoc(docID)
	if err != nil {
		return nil, err
	}

	result := &models.RestoreResult{}
	if doc.Status == "draft" && doc.Content != content {
		backup, err := a.db.CreateDocument(doc.Title+" (before restore)", doc.ParentID, doc.WorkspaceID, false)
		if err != nil {
			return nil, err
		}
		if _, err := a.db.UpdateDocument(backup.ID, backup.Title, doc.Content); err != nil {
			return nil, err
		}
		result.BackupID = backup.ID
		result.BackupTitle = backup.Title
	}

	updated, err := a.UpdateDocument(docID, doc.Title, content)
	if err != nil {
		return nil, err
	}
	result.Document = updated
	return result, nil
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

// UpdateSettings stores the user's settings. syncIntervalSecs is how often
// the open workspace refreshes from Drive: 0 turns it off, anything else is
// at least 30 seconds.
func (a *App) UpdateSettings(syncIntervalSecs int, theme string, autoSaveDelaySecs int) (*models.Settings, error) {
	if syncIntervalSecs < 0 {
		syncIntervalSecs = 0
	} else if syncIntervalSecs > 0 && syncIntervalSecs < 30 {
		syncIntervalSecs = 30
	}
	if autoSaveDelaySecs < 1 {
		autoSaveDelaySecs = 1
	}
	s := models.Settings{
		SyncIntervalSecs:  syncIntervalSecs,
		Theme:             theme,
		AutoSaveDelaySecs: autoSaveDelaySecs,
	}
	if err := a.db.UpdateSettings(s); err != nil {
		return nil, err
	}
	a.emit("settings:changed", s)
	return &s, nil
}

// === UI state ===

// uiKeyRe limits the keys the frontend may read and write to small UI flags
// (for example a dismissed hint), stored in the settings table as "ui.<key>".
var uiKeyRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,40}$`)

// GetUIState returns a stored UI flag ("" when unset).
func (a *App) GetUIState(key string) (string, error) {
	if !uiKeyRe.MatchString(key) {
		return "", fmt.Errorf("ERR_INVALID: bad UI state key")
	}
	return a.db.GetSetting("ui." + key)
}

// SetUIState stores a UI flag. Values are capped at 1 KB.
func (a *App) SetUIState(key, value string) error {
	if !uiKeyRe.MatchString(key) {
		return fmt.Errorf("ERR_INVALID: bad UI state key")
	}
	if len(value) > 1024 {
		return fmt.Errorf("ERR_INVALID: UI state value too long")
	}
	return a.db.SetSetting("ui."+key, value)
}

// === Image Upload ===

func (a *App) UploadImage(base64Data string, filename string) (string, error) {
	ws, err := a.db.GetActiveWorkspace()
	if err != nil || ws == nil {
		return "", fmt.Errorf("no active workspace")
	}

	dataDir := a.appDataDir

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

// folderDepth counts the folders above a document (0 = top level).
func (a *App) folderDepth(doc *models.Document) int {
	depth := 0
	seen := map[string]bool{}
	for p := doc.ParentID; p != "" && !seen[p] && depth < 100; depth++ {
		seen[p] = true
		parent, err := a.db.GetDocument(p)
		if err != nil {
			break
		}
		p = parent.ParentID
	}
	return depth
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

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
