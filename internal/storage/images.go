package storage

import (
	"github.com/google/uuid"
)

type ImageAsset struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	Filename    string `json:"filename"`
	DriveFileID string `json:"driveFileId,omitempty"`
	CreatedAt   string `json:"createdAt"`
}

func (d *Database) CreateImageAsset(workspaceID, filename string) (*ImageAsset, error) {
	id := uuid.New().String()
	_, err := d.db.Exec(
		"INSERT INTO image_assets (id, workspace_id, filename) VALUES (?, ?, ?)",
		id, workspaceID, filename,
	)
	if err != nil {
		return nil, err
	}
	return &ImageAsset{ID: id, WorkspaceID: workspaceID, Filename: filename}, nil
}

func (d *Database) SetImageDriveFileID(id, driveFileID string) error {
	_, err := d.db.Exec("UPDATE image_assets SET drive_file_id = ? WHERE id = ?", driveFileID, id)
	return err
}

func (d *Database) GetUnsyncedImages(workspaceID string) ([]ImageAsset, error) {
	rows, err := d.db.Query(
		"SELECT id, workspace_id, filename, COALESCE(drive_file_id, ''), created_at FROM image_assets WHERE workspace_id = ? AND (drive_file_id IS NULL OR drive_file_id = '')",
		workspaceID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	images := make([]ImageAsset, 0)
	for rows.Next() {
		var img ImageAsset
		if err := rows.Scan(&img.ID, &img.WorkspaceID, &img.Filename, &img.DriveFileID, &img.CreatedAt); err != nil {
			return nil, err
		}
		images = append(images, img)
	}
	return images, nil
}

func (d *Database) GetImageAsset(workspaceID, filename string) (*ImageAsset, error) {
	var img ImageAsset
	err := d.db.QueryRow(
		"SELECT id, workspace_id, filename, COALESCE(drive_file_id, ''), created_at FROM image_assets WHERE workspace_id = ? AND filename = ?",
		workspaceID, filename,
	).Scan(&img.ID, &img.WorkspaceID, &img.Filename, &img.DriveFileID, &img.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &img, nil
}
