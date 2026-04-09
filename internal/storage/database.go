package storage

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

type Database struct {
	db *sql.DB
}

func NewDatabase(appDataDir string) (*Database, error) {
	if err := os.MkdirAll(appDataDir, 0700); err != nil {
		return nil, fmt.Errorf("create app data dir: %w", err)
	}
	// Tighten permissions on existing directories — MkdirAll is a no-op on existing dirs
	if err := os.Chmod(appDataDir, 0700); err != nil {
		return nil, fmt.Errorf("set app data dir permissions: %w", err)
	}

	dbPath := filepath.Join(appDataDir, "hexnote.db")
	db, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(wal)&_pragma=foreign_keys(on)")
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	d := &Database{db: db}
	if err := d.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	return d, nil
}

func (d *Database) Close() error {
	return d.db.Close()
}

func (d *Database) migrate() error {
	schema := `
	CREATE TABLE IF NOT EXISTS workspaces (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		drive_folder_id TEXT NOT NULL,
		drive_folder_url TEXT DEFAULT '',
		last_synced_at TEXT DEFAULT NULL,
		created_at TEXT DEFAULT (datetime('now')),
		is_active INTEGER DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS documents (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		content TEXT DEFAULT '',
		parent_id TEXT DEFAULT NULL,
		workspace_id TEXT DEFAULT NULL,
		drive_file_id TEXT DEFAULT NULL,
		sort_order INTEGER DEFAULT 0,
		is_folder INTEGER DEFAULT 0,
		is_dirty INTEGER DEFAULT 1,
		created_at TEXT DEFAULT (datetime('now')),
		updated_at TEXT DEFAULT (datetime('now')),
		drive_modified_at TEXT DEFAULT NULL
	);

	CREATE TABLE IF NOT EXISTS labels (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		color TEXT DEFAULT '#6B7280'
	);

	CREATE TABLE IF NOT EXISTS document_labels (
		document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
		label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
		PRIMARY KEY (document_id, label_id)
	);

	CREATE TABLE IF NOT EXISTS workspace_members (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL,
		email TEXT NOT NULL,
		role TEXT NOT NULL DEFAULT 'reader',
		display_name TEXT DEFAULT '',
		permission_id TEXT DEFAULT '',
		UNIQUE(workspace_id, email)
	);

	CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT
	);

	CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
		title, content, id UNINDEXED
	);

	CREATE TABLE IF NOT EXISTS image_assets (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL,
		filename TEXT NOT NULL,
		drive_file_id TEXT DEFAULT NULL,
		created_at TEXT DEFAULT (datetime('now')),
		UNIQUE(workspace_id, filename)
	);
	`

	if _, err := d.db.Exec(schema); err != nil {
		return err
	}

	// Migration: add workspace_id column if it doesn't exist (Phase 1 -> Phase 2 upgrade)
	d.db.Exec("ALTER TABLE documents ADD COLUMN workspace_id TEXT DEFAULT NULL")
	// Ignore error — column already exists is fine

	// Migration: add status column for draft/published model (Phase 3.5 -> Phase 4 upgrade)
	d.db.Exec("ALTER TABLE documents ADD COLUMN status TEXT DEFAULT 'draft'")
	// Mark existing documents that are already on Drive as published
	d.db.Exec("UPDATE documents SET status = 'published' WHERE drive_file_id IS NOT NULL AND drive_file_id != ''")

	return nil
}
