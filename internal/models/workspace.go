package models

import "time"

type Label struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type Settings struct {
	SyncIntervalSecs  int    `json:"syncIntervalSecs"`
	Theme             string `json:"theme"`
	AutoSaveDelaySecs int    `json:"autoSaveDelaySecs"`
}

func DefaultSettings() Settings {
	return Settings{
		SyncIntervalSecs:  120,
		Theme:             "system",
		AutoSaveDelaySecs: 2,
	}
}

// Workspace represents a Google Drive folder used as a knowledge base root
type Workspace struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	DriveFolderID  string     `json:"driveFolderId"`
	DriveFolderURL string     `json:"driveFolderUrl"`
	LastSyncedAt   *time.Time `json:"lastSyncedAt,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
	IsActive       bool       `json:"isActive"`
	// Access is the signed-in user's role on the Drive folder ("owner",
	// "writer", "reader"), or "" when not known yet. It comes from the
	// cached member list, filled whenever members are loaded.
	Access string `json:"access,omitempty"`
}

// WorkspaceMember represents a collaborator with Drive permissions
type WorkspaceMember struct {
	ID           string `json:"id"`
	WorkspaceID  string `json:"workspaceId"`
	Email        string `json:"email"`
	Role         string `json:"role"` // "reader", "writer", "owner"
	DisplayName  string `json:"displayName"`
	PermissionID string `json:"permissionId"`
}

// DriveFolder is a lightweight representation for the folder picker
type DriveFolder struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ParentID string `json:"parentId,omitempty"`
}

// AuthStatus represents the current authentication state
type AuthStatus struct {
	HasCredentials bool   `json:"hasCredentials"`
	IsSignedIn     bool   `json:"isSignedIn"`
	UserEmail      string `json:"userEmail,omitempty"`
	// SessionExpired is set when Google rejected the saved sign-in (revoked
	// or expired refresh token); the token has been cleared.
	SessionExpired bool `json:"sessionExpired,omitempty"`
	// Offline is set when the sign-in could not be checked because Google
	// was unreachable; the user stays signed in.
	Offline bool `json:"offline,omitempty"`
	// Mode is "builtin" (HexNote's own sign-in), "own-key" (an OAuth client
	// the user pasted) or "" (none yet). Both ask for the full drive scope.
	Mode string `json:"mode,omitempty"`
	// BundledAvailable is set when this build carries HexNote's own OAuth
	// client, so signing in needs no Cloud project.
	BundledAvailable bool `json:"bundledAvailable,omitempty"`
}

// SyncSummary reports what one refresh from Drive changed on this PC.
type SyncSummary struct {
	Updated  []string `json:"updated"`  // pages created or updated from Drive
	Removed  []string `json:"removed"`  // pages deleted here because they were deleted on Drive
	Detached []string `json:"detached"` // pages deleted on Drive but kept here as drafts (local edits)
}

// SyncStatus represents the current sync state
type SyncStatus struct {
	State      string     `json:"state"` // "idle", "syncing", "error"
	Message    string     `json:"message"`
	LastSynced *time.Time `json:"lastSynced,omitempty"`
}
