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
		SyncIntervalSecs:  60,
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
}

// SyncStatus represents the current sync state
type SyncStatus struct {
	State      string     `json:"state"` // "idle", "syncing", "error"
	Message    string     `json:"message"`
	LastSynced *time.Time `json:"lastSynced,omitempty"`
}
