package storage

import (
	"fmt"
	"time"
)

// AddDeletedDriveFile records that a Drive file belongs to a page the user
// deleted, so sync must not re-create it. Recording the same ID twice is a no-op.
func (d *Database) AddDeletedDriveFile(workspaceID, driveFileID string) error {
	_, err := d.db.Exec(
		`INSERT INTO deleted_drive_files (workspace_id, drive_file_id, deleted_at) VALUES (?, ?, ?)
		 ON CONFLICT(workspace_id, drive_file_id) DO NOTHING`,
		workspaceID, driveFileID, formatTime(time.Now().UTC()),
	)
	if err != nil {
		return fmt.Errorf("record deleted drive file: %w", err)
	}
	return nil
}

// GetDeletedDriveFiles returns the tombstoned Drive file IDs of a workspace,
// oldest first.
func (d *Database) GetDeletedDriveFiles(workspaceID string) ([]string, error) {
	rows, err := d.db.Query(
		"SELECT drive_file_id FROM deleted_drive_files WHERE workspace_id = ? ORDER BY deleted_at, drive_file_id",
		workspaceID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// RemoveDeletedDriveFile clears a tombstone once the Drive file is trashed.
func (d *Database) RemoveDeletedDriveFile(workspaceID, driveFileID string) error {
	_, err := d.db.Exec(
		"DELETE FROM deleted_drive_files WHERE workspace_id = ? AND drive_file_id = ?",
		workspaceID, driveFileID,
	)
	return err
}

// DriveTrashRoots returns the Drive file IDs that must be trashed to remove a
// document and all its descendants from Drive. Trashing a Drive folder trashes
// its contents, so a published node's descendants are not listed separately;
// below an unpublished node the search continues into its children.
func (d *Database) DriveTrashRoots(docID string) ([]string, error) {
	doc, err := d.GetDocument(docID)
	if err != nil {
		return nil, err
	}
	if doc.DriveFileID != "" {
		return []string{doc.DriveFileID}, nil
	}
	childIDs, err := d.childIDs(docID)
	if err != nil {
		return nil, err
	}
	roots := make([]string, 0)
	for _, id := range childIDs {
		r, err := d.DriveTrashRoots(id)
		if err != nil {
			return nil, err
		}
		roots = append(roots, r...)
	}
	return roots, nil
}

func (d *Database) childIDs(parentID string) ([]string, error) {
	rows, err := d.db.Query("SELECT id FROM documents WHERE parent_id = ? ORDER BY sort_order", parentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
