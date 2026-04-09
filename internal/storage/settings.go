package storage

import (
	"strconv"

	"hexnote/internal/models"
)

func (d *Database) GetSettings() (models.Settings, error) {
	s := models.DefaultSettings()

	rows, err := d.db.Query("SELECT key, value FROM settings")
	if err != nil {
		return s, err
	}
	defer rows.Close()

	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			continue
		}
		switch key {
		case "syncIntervalSecs":
			if v, err := strconv.Atoi(value); err == nil {
				s.SyncIntervalSecs = v
			}
		case "theme":
			s.Theme = value
		case "autoSaveDelaySecs":
			if v, err := strconv.Atoi(value); err == nil {
				s.AutoSaveDelaySecs = v
			}
		}
	}

	return s, nil
}

func (d *Database) UpdateSettings(s models.Settings) error {
	upsert := "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"

	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(upsert, "syncIntervalSecs", strconv.Itoa(s.SyncIntervalSecs)); err != nil {
		return err
	}
	if _, err := tx.Exec(upsert, "theme", s.Theme); err != nil {
		return err
	}
	if _, err := tx.Exec(upsert, "autoSaveDelaySecs", strconv.Itoa(s.AutoSaveDelaySecs)); err != nil {
		return err
	}

	return tx.Commit()
}
