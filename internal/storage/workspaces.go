package storage

import (
	"database/sql"
	"fmt"
	"time"

	"hexnote/internal/models"

	"github.com/google/uuid"
)

func (d *Database) CreateWorkspace(name, driveFolderID string) (*models.Workspace, error) {
	id := uuid.New().String()
	now := time.Now().UTC()
	url := "https://drive.google.com/drive/folders/" + driveFolderID

	_, err := d.db.Exec(
		`INSERT INTO workspaces (id, name, drive_folder_id, drive_folder_url, created_at, is_active)
		 VALUES (?, ?, ?, ?, ?, 0)`,
		id, name, driveFolderID, url, formatTime(now),
	)
	if err != nil {
		return nil, fmt.Errorf("insert workspace: %w", err)
	}

	return &models.Workspace{
		ID:             id,
		Name:           name,
		DriveFolderID:  driveFolderID,
		DriveFolderURL: url,
		CreatedAt:      now,
		IsActive:       false,
	}, nil
}

func (d *Database) GetWorkspaces() ([]models.Workspace, error) {
	rows, err := d.db.Query(
		`SELECT id, name, drive_folder_id, drive_folder_url, last_synced_at, created_at, is_active
		 FROM workspaces ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	workspaces := make([]models.Workspace, 0)
	for rows.Next() {
		w, err := scanWorkspaceRow(rows)
		if err != nil {
			return nil, err
		}
		workspaces = append(workspaces, *w)
	}
	return workspaces, nil
}

func (d *Database) GetActiveWorkspace() (*models.Workspace, error) {
	row := d.db.QueryRow(
		`SELECT id, name, drive_folder_id, drive_folder_url, last_synced_at, created_at, is_active
		 FROM workspaces WHERE is_active = 1 LIMIT 1`,
	)
	w, err := scanWorkspaceRow(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return w, err
}

func (d *Database) SwitchWorkspace(workspaceID string) (*models.Workspace, error) {
	tx, err := d.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// Deactivate all workspaces
	_, err = tx.Exec("UPDATE workspaces SET is_active = 0")
	if err != nil {
		return nil, err
	}

	// Activate the chosen one
	_, err = tx.Exec("UPDATE workspaces SET is_active = 1 WHERE id = ?", workspaceID)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return d.GetActiveWorkspace()
}

func (d *Database) DeleteWorkspace(workspaceID string) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Delete all documents in this workspace
	_, err = tx.Exec("DELETE FROM documents WHERE workspace_id = ?", workspaceID)
	if err != nil {
		return err
	}

	// Delete workspace members
	_, err = tx.Exec("DELETE FROM workspace_members WHERE workspace_id = ?", workspaceID)
	if err != nil {
		return err
	}

	// Delete the workspace itself
	_, err = tx.Exec("DELETE FROM workspaces WHERE id = ?", workspaceID)
	if err != nil {
		return err
	}

	return tx.Commit()
}

func (d *Database) RenameWorkspace(workspaceID, newName string) error {
	_, err := d.db.Exec("UPDATE workspaces SET name = ? WHERE id = ?", newName, workspaceID)
	return err
}

func (d *Database) UpdateWorkspaceSyncTime(workspaceID string) error {
	_, err := d.db.Exec(
		"UPDATE workspaces SET last_synced_at = ? WHERE id = ?",
		formatTime(time.Now().UTC()), workspaceID,
	)
	return err
}

// Workspace members

func (d *Database) GetWorkspaceMembers(workspaceID string) ([]models.WorkspaceMember, error) {
	rows, err := d.db.Query(
		`SELECT id, workspace_id, email, role, display_name, permission_id
		 FROM workspace_members WHERE workspace_id = ? ORDER BY email`,
		workspaceID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	members := make([]models.WorkspaceMember, 0)
	for rows.Next() {
		var m models.WorkspaceMember
		if err := rows.Scan(&m.ID, &m.WorkspaceID, &m.Email, &m.Role, &m.DisplayName, &m.PermissionID); err != nil {
			return nil, err
		}
		members = append(members, m)
	}
	return members, nil
}

func (d *Database) UpsertWorkspaceMember(m *models.WorkspaceMember) error {
	if m.ID == "" {
		m.ID = uuid.New().String()
	}
	_, err := d.db.Exec(
		`INSERT INTO workspace_members (id, workspace_id, email, role, display_name, permission_id)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(workspace_id, email) DO UPDATE SET role=?, display_name=?, permission_id=?`,
		m.ID, m.WorkspaceID, m.Email, m.Role, m.DisplayName, m.PermissionID,
		m.Role, m.DisplayName, m.PermissionID,
	)
	return err
}

func (d *Database) DeleteWorkspaceMember(workspaceID, email string) error {
	_, err := d.db.Exec(
		"DELETE FROM workspace_members WHERE workspace_id = ? AND email = ?",
		workspaceID, email,
	)
	return err
}

// Helpers

func scanWorkspaceRow(s scanner) (*models.Workspace, error) {
	var w models.Workspace
	var lastSynced, createdAt sql.NullString
	var isActive int

	err := s.Scan(&w.ID, &w.Name, &w.DriveFolderID, &w.DriveFolderURL, &lastSynced, &createdAt, &isActive)
	if err != nil {
		return nil, err
	}

	w.IsActive = isActive == 1
	if createdAt.Valid {
		w.CreatedAt = parseTime(createdAt.String)
	}
	if lastSynced.Valid && lastSynced.String != "" {
		t := parseTime(lastSynced.String)
		w.LastSyncedAt = &t
	}

	return &w, nil
}
