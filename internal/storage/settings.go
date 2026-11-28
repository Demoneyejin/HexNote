package storage

import (
	"database/sql"
	"strconv"

	"hexnote/internal/models"
)

// syncIntervalSetKey marks that syncIntervalSecs was chosen by the user.
const syncIntervalSetKey = "syncIntervalSecs.set"

func (d *Database) GetSettings() (models.Settings, error) {
	s := models.DefaultSettings()

	rows, err := d.db.Query("SELECT key, value FROM settings")
	if err != nil {
		return s, err
	}
	defer rows.Close()

	var intervalSet bool
	var interval int
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			continue
		}
		switch key {
		case "syncIntervalSecs":
			if v, err := strconv.Atoi(value); err == nil {
				interval = v
			}
		case syncIntervalSetKey:
			intervalSet = value == "1"
		case "theme":
			s.Theme = value
		case "autoSaveDelaySecs":
			if v, err := strconv.Atoi(value); err == nil {
				s.AutoSaveDelaySecs = v
			}
		}
	}
	// Before auto-refresh existed, the Settings modal always stored 0 here
	// and nothing read it. Only honour a value saved since then.
	if intervalSet {
		s.SyncIntervalSecs = interval
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
	if _, err := tx.Exec(upsert, syncIntervalSetKey, "1"); err != nil {
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

// GetSetting returns a free-form setting ("" when unset). Used for small
// pieces of app state that are not user preferences, such as the last known
// account email.
func (d *Database) GetSetting(key string) (string, error) {
	var value string
	err := d.db.QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return value, err
}

// SetSetting stores a free-form setting.
func (d *Database) SetSetting(key, value string) error {
	_, err := d.db.Exec(
		"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		key, value,
	)
	return err
}
