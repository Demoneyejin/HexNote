package models

import "time"

type Document struct {
	ID              string     `json:"id"`
	Title           string     `json:"title"`
	Content         string     `json:"content"`
	ParentID        string     `json:"parentId"`
	WorkspaceID     string     `json:"workspaceId,omitempty"`
	DriveFileID     string     `json:"driveFileId,omitempty"`
	SortOrder       int        `json:"sortOrder"`
	IsFolder        bool       `json:"isFolder"`
	IsDirty         bool       `json:"isDirty"`
	Status          string     `json:"status"` // "draft" or "published"
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	DriveModifiedAt *time.Time `json:"driveModifiedAt,omitempty"`
}

type TreeNode struct {
	Document Document    `json:"document"`
	Children []*TreeNode `json:"children"`
}

type SearchResult struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Snippet string `json:"snippet"`
}

type Revision struct {
	RevisionID        string `json:"revisionId"`
	ModifiedTime      string `json:"modifiedTime"`
	Size              int64  `json:"size"`
	LastModifyingUser string `json:"lastModifyingUser,omitempty"`
}
