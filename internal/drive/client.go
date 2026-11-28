package drive

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"hexnote/internal/models"

	"golang.org/x/oauth2"
	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
)

// Client wraps the Google Drive API
type Client struct {
	service *drive.Service
}

// escapeDriveQuery escapes special characters in Drive API query string values.
// The Drive API query language uses single quotes to delimit strings;
// backslashes and single quotes within values must be escaped.
func escapeDriveQuery(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `'`, `\'`)
	return s
}

func NewClient(ctx context.Context, ts oauth2.TokenSource) (*Client, error) {
	srv, err := drive.NewService(ctx, option.WithTokenSource(ts))
	if err != nil {
		return nil, fmt.Errorf("create drive service: %w", err)
	}
	return &Client{service: srv}, nil
}

// NewClientWithEndpoint builds a client that talks to a different API base
// path (for example a drivefake server in tests). Requests are authorized
// through ts, so token-refresh failures surface exactly as in production.
func NewClientWithEndpoint(ctx context.Context, ts oauth2.TokenSource, endpoint string) (*Client, error) {
	hc := &http.Client{Transport: &oauth2.Transport{Source: ts, Base: http.DefaultTransport}}
	srv, err := drive.NewService(ctx, option.WithHTTPClient(hc), option.WithEndpoint(endpoint))
	if err != nil {
		return nil, fmt.Errorf("create drive service: %w", err)
	}
	return &Client{service: srv}, nil
}

// GetUserEmail returns the authenticated user's email
func (c *Client) GetUserEmail() (string, error) {
	about, err := c.service.About.Get().Fields("user(emailAddress)").Do()
	if err != nil {
		return "", fmt.Errorf("get user info: %w", err)
	}
	return about.User.EmailAddress, nil
}

// Folder operations

func (c *Client) ListFolders(parentID string) ([]models.DriveFolder, error) {
	if parentID == "" {
		parentID = "root"
	}

	q := fmt.Sprintf("'%s' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false", escapeDriveQuery(parentID))
	folders := make([]models.DriveFolder, 0)

	pageToken := ""
	for {
		call := c.service.Files.List().
			Q(q).
			Fields("nextPageToken, files(id, name, parents)").
			OrderBy("name").
			PageSize(100)

		if pageToken != "" {
			call = call.PageToken(pageToken)
		}

		result, err := call.Do()
		if err != nil {
			return nil, fmt.Errorf("list folders: %w", err)
		}

		for _, f := range result.Files {
			pid := ""
			if len(f.Parents) > 0 {
				pid = f.Parents[0]
			}
			folders = append(folders, models.DriveFolder{
				ID:       f.Id,
				Name:     f.Name,
				ParentID: pid,
			})
		}

		pageToken = result.NextPageToken
		if pageToken == "" {
			break
		}
	}

	return folders, nil
}

func (c *Client) CreateFolder(name, parentID string) (*models.DriveFolder, error) {
	if parentID == "" {
		parentID = "root"
	}

	f := &drive.File{
		Name:     name,
		MimeType: "application/vnd.google-apps.folder",
		Parents:  []string{parentID},
	}

	created, err := c.service.Files.Create(f).Fields("id, name, parents").SupportsAllDrives(true).Do()
	if err != nil {
		return nil, fmt.Errorf("create folder: %w", err)
	}

	pid := ""
	if len(created.Parents) > 0 {
		pid = created.Parents[0]
	}

	return &models.DriveFolder{
		ID:       created.Id,
		Name:     created.Name,
		ParentID: pid,
	}, nil
}

// File operations for sync

func (c *Client) ListFiles(folderID string) ([]*drive.File, error) {
	q := fmt.Sprintf("'%s' in parents and trashed=false", escapeDriveQuery(folderID))
	var files []*drive.File

	pageToken := ""
	for {
		call := c.service.Files.List().
			Q(q).
			Fields("nextPageToken, files(id, name, mimeType, modifiedTime, size)").
			PageSize(100).
			SupportsAllDrives(true).
			IncludeItemsFromAllDrives(true)

		if pageToken != "" {
			call = call.PageToken(pageToken)
		}

		result, err := call.Do()
		if err != nil {
			return nil, fmt.Errorf("list files: %w", err)
		}

		files = append(files, result.Files...)
		pageToken = result.NextPageToken
		if pageToken == "" {
			break
		}
	}

	return files, nil
}

func (c *Client) DownloadFile(fileID string) (string, error) {
	resp, err := c.service.Files.Get(fileID).Download()
	if err != nil {
		return "", fmt.Errorf("download file: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read file body: %w", err)
	}

	return string(data), nil
}

// CreateFile uploads a new file and returns its ID and Drive's modifiedTime
// for it (Drive's clock, so later conflict checks compare like with like).
func (c *Client) CreateFile(name, folderID, content string) (string, time.Time, error) {
	f := &drive.File{
		Name:    name,
		Parents: []string{folderID},
	}

	created, err := c.service.Files.Create(f).
		Media(strings.NewReader(content)).
		Fields("id, modifiedTime").
		SupportsAllDrives(true).
		Do()
	if err != nil {
		return "", time.Time{}, fmt.Errorf("create file: %w", err)
	}

	return created.Id, parseTimeOrNow(created.ModifiedTime), nil
}

// UpdateFile replaces a file's name and content and returns Drive's new
// modifiedTime for it.
func (c *Client) UpdateFile(fileID, name, content string) (time.Time, error) {
	f := &drive.File{
		Name: name,
	}

	updated, err := c.service.Files.Update(fileID, f).
		Media(strings.NewReader(content)).
		Fields("id, modifiedTime").
		SupportsAllDrives(true).
		Do()
	if err != nil {
		return time.Time{}, fmt.Errorf("update file: %w", err)
	}

	return parseTimeOrNow(updated.ModifiedTime), nil
}

// FileInfo is the metadata used to detect conflicting edits before publishing.
type FileInfo struct {
	Name         string
	ModifiedTime time.Time
	ModifiedBy   string // display name of the last person to change the file
	Trashed      bool
	Parents      []string
}

// GetFileInfo returns a file's current name, modifiedTime, last modifying
// user and trash state.
func (c *Client) GetFileInfo(fileID string) (*FileInfo, error) {
	f, err := c.service.Files.Get(fileID).
		Fields("name, modifiedTime, trashed, parents, lastModifyingUser(displayName, emailAddress)").
		SupportsAllDrives(true).
		Do()
	if err != nil {
		return nil, fmt.Errorf("get file metadata: %w", err)
	}
	info := &FileInfo{Name: f.Name, Trashed: f.Trashed, Parents: f.Parents}
	if t, err := ParseTime(f.ModifiedTime); err == nil {
		info.ModifiedTime = t
	}
	if f.LastModifyingUser != nil {
		info.ModifiedBy = f.LastModifyingUser.DisplayName
		if info.ModifiedBy == "" {
			info.ModifiedBy = f.LastModifyingUser.EmailAddress
		}
	}
	return info, nil
}

func parseTimeOrNow(s string) time.Time {
	if t, err := ParseTime(s); err == nil {
		return t
	}
	return time.Now().UTC()
}

// RenameFile changes a file's or folder's name on Drive.
func (c *Client) RenameFile(fileID, name string) error {
	_, err := c.service.Files.Update(fileID, &drive.File{Name: name}).
		Fields("id").
		SupportsAllDrives(true).
		Do()
	if err != nil {
		return fmt.Errorf("rename file: %w", err)
	}
	return nil
}

// MoveFile moves a file or folder into newParentID, removing it from the
// given current parents.
func (c *Client) MoveFile(fileID, newParentID string, oldParents []string) error {
	call := c.service.Files.Update(fileID, &drive.File{}).
		AddParents(newParentID).
		Fields("id, parents").
		SupportsAllDrives(true)
	remove := make([]string, 0, len(oldParents))
	for _, p := range oldParents {
		if p != newParentID {
			remove = append(remove, p)
		}
	}
	if len(remove) > 0 {
		call = call.RemoveParents(strings.Join(remove, ","))
	}
	if _, err := call.Do(); err != nil {
		return fmt.Errorf("move file: %w", err)
	}
	return nil
}

// TrashFile moves a file (or folder, with its contents) to the Drive trash.
// The owner can restore it from drive.google.com for 30 days.
func (c *Client) TrashFile(fileID string) error {
	_, err := c.service.Files.Update(fileID, &drive.File{Trashed: true}).
		Fields("id").
		SupportsAllDrives(true).
		Do()
	if err != nil {
		return fmt.Errorf("trash file: %w", err)
	}
	return nil
}

// Revisions / version history

func (c *Client) ListRevisions(fileID string) ([]models.Revision, error) {
	result, err := c.service.Revisions.List(fileID).
		Fields("revisions(id, modifiedTime, size, lastModifyingUser(displayName))").
		PageSize(50).
		Do()
	if err != nil {
		return nil, fmt.Errorf("list revisions: %w", err)
	}

	revisions := make([]models.Revision, 0)
	for i := len(result.Revisions) - 1; i >= 0; i-- {
		r := result.Revisions[i]
		user := ""
		if r.LastModifyingUser != nil {
			user = r.LastModifyingUser.DisplayName
		}
		revisions = append(revisions, models.Revision{
			RevisionID:        r.Id,
			ModifiedTime:      r.ModifiedTime,
			Size:              r.Size,
			LastModifyingUser: user,
		})
	}
	return revisions, nil
}

func (c *Client) DownloadRevision(fileID, revisionID string) (string, error) {
	resp, err := c.service.Revisions.Get(fileID, revisionID).Download()
	if err != nil {
		return "", fmt.Errorf("download revision: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read revision body: %w", err)
	}
	return string(data), nil
}

// DownloadBinaryData downloads a file's raw bytes from Drive (for images, etc.)
func (c *Client) DownloadBinaryData(fileID string) ([]byte, error) {
	resp, err := c.service.Files.Get(fileID).Download()
	if err != nil {
		return nil, fmt.Errorf("download binary: %w", err)
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

// Upload binary file (for images)

// mimeFromExt returns the MIME type for common image extensions.
// Falls back to "application/octet-stream" for unknown types.
func mimeFromExt(name string) string {
	ext := strings.ToLower(name)
	if i := strings.LastIndex(ext, "."); i >= 0 {
		ext = ext[i:]
	}
	switch ext {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".svg":
		return "image/svg+xml"
	case ".bmp":
		return "image/bmp"
	case ".ico":
		return "image/x-icon"
	default:
		return "application/octet-stream"
	}
}

func (c *Client) UploadBinaryFile(name, folderID string, data []byte) (string, error) {
	f := &drive.File{
		Name:     name,
		MimeType: mimeFromExt(name),
		Parents:  []string{folderID},
	}

	created, err := c.service.Files.Create(f).
		Media(bytes.NewReader(data)).
		Fields("id").
		SupportsAllDrives(true).
		Do()
	if err != nil {
		return "", fmt.Errorf("upload binary file: %w", err)
	}
	return created.Id, nil
}

// EnsureFolder finds or creates a subfolder by name within a parent folder.
// Uses SupportsAllDrives so it works with shared workspace folders.
func (c *Client) EnsureFolder(parentID, name string) (string, error) {
	q := fmt.Sprintf("'%s' in parents and name='%s' and mimeType='application/vnd.google-apps.folder' and trashed=false", escapeDriveQuery(parentID), escapeDriveQuery(name))
	result, err := c.service.Files.List().
		Q(q).
		Fields("files(id)").
		PageSize(1).
		SupportsAllDrives(true).
		IncludeItemsFromAllDrives(true).
		Do()
	if err != nil {
		return "", fmt.Errorf("search folder: %w", err)
	}
	if len(result.Files) > 0 {
		return result.Files[0].Id, nil
	}

	folder, err := c.CreateFolder(name, parentID)
	if err != nil {
		return "", err
	}
	return folder.ID, nil
}

// SearchSharedFolders returns Drive folders shared with the current user, optionally filtered by name.
func (c *Client) SearchSharedFolders(query string) ([]models.DriveFolder, error) {
	q := "mimeType='application/vnd.google-apps.folder' and sharedWithMe=true and trashed=false"
	if query != "" {
		q += fmt.Sprintf(" and name contains '%s'", escapeDriveQuery(query))
	}

	folders := make([]models.DriveFolder, 0)
	pageToken := ""
	for {
		call := c.service.Files.List().
			Q(q).
			Fields("nextPageToken, files(id, name)").
			OrderBy("name").
			PageSize(50).
			SupportsAllDrives(true).
			IncludeItemsFromAllDrives(true)

		if pageToken != "" {
			call = call.PageToken(pageToken)
		}

		result, err := call.Do()
		if err != nil {
			return nil, fmt.Errorf("search shared folders: %w", err)
		}

		for _, f := range result.Files {
			folders = append(folders, models.DriveFolder{
				ID:   f.Id,
				Name: f.Name,
			})
		}

		pageToken = result.NextPageToken
		if pageToken == "" {
			break
		}
	}
	return folders, nil
}

// GetFolderByID returns a single folder's metadata by its ID.
// Used when a user pastes a Drive folder link.
func (c *Client) GetFolderByID(folderID string) (*models.DriveFolder, error) {
	f, err := c.service.Files.Get(folderID).
		Fields("id, name, mimeType").
		SupportsAllDrives(true).
		Do()
	if err != nil {
		return nil, fmt.Errorf("get folder: %w", err)
	}
	if f.MimeType != "application/vnd.google-apps.folder" {
		return nil, fmt.Errorf("ERR_INVALID: The link points to a file, not a folder.")
	}
	return &models.DriveFolder{
		ID:   f.Id,
		Name: f.Name,
	}, nil
}

// Permissions / sharing

func (c *Client) AddPermission(folderID, email, role string) (*drive.Permission, error) {
	perm := &drive.Permission{
		Type:         "user",
		Role:         role,
		EmailAddress: email,
	}

	created, err := c.service.Permissions.Create(folderID, perm).
		SendNotificationEmail(true).
		Fields("id, emailAddress, role, displayName").
		Do()
	if err != nil {
		return nil, fmt.Errorf("add permission: %w", err)
	}

	return created, nil
}

func (c *Client) ListPermissions(folderID string) ([]*drive.Permission, error) {
	result, err := c.service.Permissions.List(folderID).
		Fields("permissions(id, emailAddress, role, displayName, type)").
		Do()
	if err != nil {
		return nil, fmt.Errorf("list permissions: %w", err)
	}

	return result.Permissions, nil
}

func (c *Client) RemovePermission(folderID, permissionID string) error {
	err := c.service.Permissions.Delete(folderID, permissionID).Do()
	if err != nil {
		return fmt.Errorf("remove permission: %w", err)
	}
	return nil
}
