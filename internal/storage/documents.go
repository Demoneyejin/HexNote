package storage

import (
	"database/sql"
	"fmt"
	"time"

	"hexnote/internal/models"

	"github.com/google/uuid"
)

func (d *Database) CreateDocument(title, parentID, workspaceID string, isFolder bool) (*models.Document, error) {
	id := uuid.New().String()
	now := time.Now().UTC()

	sqlParentID := nullIfEmpty(parentID)
	sqlWorkspaceID := nullIfEmpty(workspaceID)

	var maxOrder int
	err := d.db.QueryRow(
		"SELECT COALESCE(MAX(sort_order), -1) FROM documents WHERE parent_id IS ? AND workspace_id IS ?",
		sqlParentID, sqlWorkspaceID,
	).Scan(&maxOrder)
	if err != nil {
		return nil, fmt.Errorf("get max sort order: %w", err)
	}

	doc := &models.Document{
		ID:          id,
		Title:       title,
		Content:     "",
		ParentID:    parentID,
		WorkspaceID: workspaceID,
		SortOrder:   maxOrder + 1,
		IsFolder:    isFolder,
		IsDirty:     true,
		Status:      "draft",
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	_, err = d.db.Exec(
		`INSERT INTO documents (id, title, content, parent_id, workspace_id, sort_order, is_folder, is_dirty, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?)`,
		doc.ID, doc.Title, doc.Content, sqlParentID, sqlWorkspaceID,
		doc.SortOrder, boolToInt(doc.IsFolder), formatTime(now), formatTime(now),
	)
	if err != nil {
		return nil, fmt.Errorf("insert document: %w", err)
	}

	d.indexDocument(doc)
	return doc, nil
}

func (d *Database) GetDocument(id string) (*models.Document, error) {
	row := d.db.QueryRow(
		`SELECT id, title, content, parent_id, workspace_id, drive_file_id, sort_order, is_folder, is_dirty, created_at, updated_at, drive_modified_at, status
		 FROM documents WHERE id = ?`, id,
	)
	return scanDocumentRow(row)
}

func (d *Database) UpdateDocument(id, title, content string) (*models.Document, error) {
	now := time.Now().UTC()

	// Editing sets dirty flag and reverts published docs to draft status
	// (local changes haven't been published yet)
	_, err := d.db.Exec(
		`UPDATE documents SET title = ?, content = ?, is_dirty = 1, status = 'draft', updated_at = ? WHERE id = ?`,
		title, content, formatTime(now), id,
	)
	if err != nil {
		return nil, fmt.Errorf("update document: %w", err)
	}

	doc, err := d.GetDocument(id)
	if err != nil {
		return nil, err
	}

	d.indexDocument(doc)
	return doc, nil
}

// RenameDocument changes only the title. The caller decides the status.
func (d *Database) RenameDocument(id, title string) error {
	res, err := d.db.Exec(
		`UPDATE documents SET title = ?, is_dirty = 1, updated_at = ? WHERE id = ?`,
		title, formatTime(time.Now().UTC()), id,
	)
	if err != nil {
		return fmt.Errorf("rename document: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	if doc, err := d.GetDocument(id); err == nil {
		d.indexDocument(doc)
	}
	return nil
}

func (d *Database) DeleteDocument(id string) error {
	// Recursively delete children first
	rows, err := d.db.Query("SELECT id FROM documents WHERE parent_id = ?", id)
	if err != nil {
		return fmt.Errorf("query children: %w", err)
	}
	defer rows.Close()

	var childIDs []string
	for rows.Next() {
		var childID string
		if err := rows.Scan(&childID); err != nil {
			return fmt.Errorf("scan child: %w", err)
		}
		childIDs = append(childIDs, childID)
	}

	for _, childID := range childIDs {
		if err := d.DeleteDocument(childID); err != nil {
			return err
		}
	}

	d.removeFromIndex(id)

	_, err = d.db.Exec("DELETE FROM documents WHERE id = ?", id)
	return err
}

func (d *Database) MoveDocument(id, newParentID string) error {
	var sqlParentID interface{}
	if newParentID == "" {
		sqlParentID = nil
	} else {
		sqlParentID = newParentID
	}

	var maxOrder int
	err := d.db.QueryRow(
		"SELECT COALESCE(MAX(sort_order), -1) FROM documents WHERE parent_id IS ?",
		sqlParentID,
	).Scan(&maxOrder)
	if err != nil {
		return fmt.Errorf("get max sort order: %w", err)
	}

	_, err = d.db.Exec(
		`UPDATE documents SET parent_id = ?, sort_order = ?, is_dirty = 1, updated_at = ? WHERE id = ?`,
		sqlParentID, maxOrder+1, formatTime(time.Now().UTC()), id,
	)
	return err
}

// PlaceDocument puts a document under newParentID ("" = top level) at the
// position just before beforeID ("" = at the end) and renumbers that
// folder's children. It changes neither the dirty flag nor the status:
// ordering is local to this PC.
func (d *Database) PlaceDocument(id, newParentID, beforeID string) error {
	doc, err := d.GetDocument(id)
	if err != nil {
		return err
	}
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`UPDATE documents SET parent_id = ?, updated_at = ? WHERE id = ?`,
		nullIfEmpty(newParentID), formatTime(time.Now().UTC()), id); err != nil {
		return fmt.Errorf("move document: %w", err)
	}

	rows, err := tx.Query(
		`SELECT id FROM documents WHERE parent_id IS ? AND workspace_id IS ? AND id != ? ORDER BY sort_order, created_at`,
		nullIfEmpty(newParentID), nullIfEmpty(doc.WorkspaceID), id,
	)
	if err != nil {
		return err
	}
	var siblings []string
	for rows.Next() {
		var sid string
		if err := rows.Scan(&sid); err != nil {
			rows.Close()
			return err
		}
		siblings = append(siblings, sid)
	}
	rows.Close()

	ordered := make([]string, 0, len(siblings)+1)
	placed := false
	for _, sid := range siblings {
		if sid == beforeID && !placed {
			ordered = append(ordered, id)
			placed = true
		}
		ordered = append(ordered, sid)
	}
	if !placed {
		ordered = append(ordered, id)
	}
	for i, sid := range ordered {
		if _, err := tx.Exec(`UPDATE documents SET sort_order = ? WHERE id = ?`, i, sid); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SetParentFromSync moves a document to another folder because it moved on
// Drive, appending it to the end of that folder.
func (d *Database) SetParentFromSync(id, parentID string) error {
	doc, err := d.GetDocument(id)
	if err != nil {
		return err
	}
	var maxOrder int
	d.db.QueryRow(
		"SELECT COALESCE(MAX(sort_order), -1) FROM documents WHERE parent_id IS ? AND workspace_id IS ?",
		nullIfEmpty(parentID), nullIfEmpty(doc.WorkspaceID),
	).Scan(&maxOrder)
	_, err = d.db.Exec(`UPDATE documents SET parent_id = ?, sort_order = ? WHERE id = ?`,
		nullIfEmpty(parentID), maxOrder+1, id)
	return err
}

// IsDescendant reports whether id is ancestorID itself or sits below it.
func (d *Database) IsDescendant(id, ancestorID string) bool {
	seen := map[string]bool{}
	for cur := id; cur != "" && !seen[cur]; {
		if cur == ancestorID {
			return true
		}
		seen[cur] = true
		doc, err := d.GetDocument(cur)
		if err != nil {
			return false
		}
		cur = doc.ParentID
	}
	return false
}

func (d *Database) GetDocumentTree(workspaceID string) ([]*models.TreeNode, error) {
	sqlWID := nullIfEmpty(workspaceID)
	rows, err := d.db.Query(
		`SELECT id, title, content, parent_id, workspace_id, drive_file_id, sort_order, is_folder, is_dirty, created_at, updated_at, drive_modified_at, status
		 FROM documents WHERE workspace_id IS ? ORDER BY sort_order ASC`,
		sqlWID,
	)
	if err != nil {
		return nil, fmt.Errorf("query documents: %w", err)
	}
	defer rows.Close()

	allDocs := make(map[string]*models.Document)
	var order []string
	for rows.Next() {
		doc, err := scanDocumentRow(rows)
		if err != nil {
			return nil, err
		}
		allDocs[doc.ID] = doc
		order = append(order, doc.ID)
	}

	// Build tree
	nodeMap := make(map[string]*models.TreeNode)
	for _, id := range order {
		nodeMap[id] = &models.TreeNode{Document: *allDocs[id]}
	}

	var roots []*models.TreeNode
	for _, id := range order {
		node := nodeMap[id]
		parentID := node.Document.ParentID
		if parentID == "" {
			roots = append(roots, node)
		} else if parent, ok := nodeMap[parentID]; ok {
			parent.Children = append(parent.Children, node)
		} else {
			// Orphan — treat as root
			roots = append(roots, node)
		}
	}

	return roots, nil
}

// Labels

func (d *Database) GetLabels() ([]models.Label, error) {
	rows, err := d.db.Query("SELECT id, name, color FROM labels ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	labels := make([]models.Label, 0)
	for rows.Next() {
		var l models.Label
		if err := rows.Scan(&l.ID, &l.Name, &l.Color); err != nil {
			return nil, err
		}
		labels = append(labels, l)
	}
	return labels, nil
}

func (d *Database) CreateLabel(name, color string) (*models.Label, error) {
	id := uuid.New().String()
	_, err := d.db.Exec("INSERT INTO labels (id, name, color) VALUES (?, ?, ?)", id, name, color)
	if err != nil {
		return nil, err
	}
	return &models.Label{ID: id, Name: name, Color: color}, nil
}

func (d *Database) DeleteLabel(id string) error {
	_, err := d.db.Exec("DELETE FROM labels WHERE id = ?", id)
	return err
}

func (d *Database) SetDocumentLabels(docID string, labelIDs []string) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	_, err = tx.Exec("DELETE FROM document_labels WHERE document_id = ?", docID)
	if err != nil {
		return err
	}

	for _, lid := range labelIDs {
		_, err = tx.Exec("INSERT INTO document_labels (document_id, label_id) VALUES (?, ?)", docID, lid)
		if err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (d *Database) GetDocumentLabels(docID string) ([]models.Label, error) {
	rows, err := d.db.Query(
		`SELECT l.id, l.name, l.color FROM labels l
		 JOIN document_labels dl ON dl.label_id = l.id
		 WHERE dl.document_id = ?
		 ORDER BY l.name`, docID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	labels := make([]models.Label, 0)
	for rows.Next() {
		var l models.Label
		if err := rows.Scan(&l.ID, &l.Name, &l.Color); err != nil {
			return nil, err
		}
		labels = append(labels, l)
	}
	return labels, nil
}

// Helpers

// scanner is satisfied by both *sql.Row and *sql.Rows, allowing a single scan
// function for QueryRow and Query result paths.
type scanner interface {
	Scan(dest ...any) error
}

func scanDocumentRow(s scanner) (*models.Document, error) {
	var doc models.Document
	var parentID, workspaceID, driveFileID, driveModAt, status sql.NullString
	var createdAt, updatedAt string
	var isFolder, isDirty int

	err := s.Scan(
		&doc.ID, &doc.Title, &doc.Content, &parentID, &workspaceID, &driveFileID,
		&doc.SortOrder, &isFolder, &isDirty, &createdAt, &updatedAt, &driveModAt, &status,
	)
	if err != nil {
		return nil, err
	}

	doc.ParentID = parentID.String
	doc.WorkspaceID = workspaceID.String
	doc.DriveFileID = driveFileID.String
	doc.IsFolder = isFolder == 1
	doc.IsDirty = isDirty == 1
	doc.Status = status.String
	if doc.Status == "" {
		doc.Status = "draft"
	}
	doc.CreatedAt = parseTime(createdAt)
	doc.UpdatedAt = parseTime(updatedAt)
	if driveModAt.Valid && driveModAt.String != "" {
		t := parseTime(driveModAt.String)
		doc.DriveModifiedAt = &t
	}

	return &doc, nil
}

func nullIfEmpty(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// UpdateDocumentFromSync updates a document's title and content without setting
// the dirty flag. Used by the sync pull phase so that remotely-pulled content
// doesn't get re-pushed on the next sync cycle.
func (d *Database) UpdateDocumentFromSync(id, title, content string) error {
	now := time.Now().UTC()
	_, err := d.db.Exec(
		`UPDATE documents SET title = ?, content = ?, updated_at = ? WHERE id = ?`,
		title, content, formatTime(now), id,
	)
	if err != nil {
		return fmt.Errorf("sync update document: %w", err)
	}
	doc, _ := d.GetDocument(id)
	if doc != nil {
		d.indexDocument(doc)
	}
	return nil
}

// UpdatePublishedFromSync applies a newer Drive version to a document only
// if it is still published, in one statement. A local edit saved while the
// refresh was running (which makes the page a draft) is never overwritten.
// Reports whether the document was updated.
func (d *Database) UpdatePublishedFromSync(id, title, content string, driveModifiedAt time.Time) (bool, error) {
	res, err := d.db.Exec(
		`UPDATE documents SET title = ?, content = ?, updated_at = ?, drive_modified_at = ?, is_dirty = 0
		 WHERE id = ? AND status = 'published'`,
		title, content, formatTime(time.Now().UTC()), formatTime(driveModifiedAt), id,
	)
	if err != nil {
		return false, fmt.Errorf("sync update document: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return false, nil
	}
	if doc, _ := d.GetDocument(id); doc != nil {
		d.indexDocument(doc)
	}
	return true, nil
}

func (d *Database) SetDocumentStatus(docID, status string) error {
	_, err := d.db.Exec("UPDATE documents SET status = ? WHERE id = ?", status, docID)
	return err
}

// Sync helpers

func (d *Database) SetDriveFileID(docID, driveFileID string) error {
	_, err := d.db.Exec("UPDATE documents SET drive_file_id = ? WHERE id = ?", driveFileID, docID)
	return err
}

func (d *Database) SetDriveModifiedAt(docID string, t time.Time) error {
	_, err := d.db.Exec("UPDATE documents SET drive_modified_at = ? WHERE id = ?", formatTime(t), docID)
	return err
}

func (d *Database) ClearDirty(docID string) error {
	_, err := d.db.Exec("UPDATE documents SET is_dirty = 0 WHERE id = ?", docID)
	return err
}

func (d *Database) GetDirtyDocuments(workspaceID string) ([]models.Document, error) {
	rows, err := d.db.Query(
		`SELECT id, title, content, parent_id, workspace_id, drive_file_id, sort_order, is_folder, is_dirty, created_at, updated_at, drive_modified_at, status
		 FROM documents WHERE is_dirty = 1 AND workspace_id IS ?`,
		nullIfEmpty(workspaceID),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	docs := make([]models.Document, 0)
	for rows.Next() {
		doc, err := scanDocumentRow(rows)
		if err != nil {
			return nil, err
		}
		docs = append(docs, *doc)
	}
	return docs, nil
}

func formatTime(t time.Time) string {
	return t.Format(time.RFC3339)
}

func parseTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return t
}
