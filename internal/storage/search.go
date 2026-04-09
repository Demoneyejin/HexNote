package storage

import (
	"html"
	"hexnote/internal/models"
	"strings"
)

func (d *Database) indexDocument(doc *models.Document) {
	// Remove old entry if exists
	d.removeFromIndex(doc.ID)

	// Insert into FTS
	d.db.Exec(
		"INSERT INTO documents_fts (id, title, content) VALUES (?, ?, ?)",
		doc.ID, doc.Title, doc.Content,
	)
}

func (d *Database) removeFromIndex(id string) {
	d.db.Exec("DELETE FROM documents_fts WHERE id = ?", id)
}

// sanitizeFTSQuery strips FTS5 special syntax characters and boolean operators
// to prevent query injection through the search box.
func sanitizeFTSQuery(query string) string {
	var b strings.Builder
	for _, r := range query {
		switch r {
		case '"', '*', ':', '^', '{', '}', '(', ')', '-':
			// Skip FTS5 special characters
		default:
			b.WriteRune(r)
		}
	}
	sanitized := b.String()

	// Filter out FTS5 boolean operator keywords
	words := strings.Fields(sanitized)
	var safe []string
	for _, w := range words {
		upper := strings.ToUpper(w)
		if upper != "AND" && upper != "OR" && upper != "NOT" && upper != "NEAR" {
			safe = append(safe, w)
		}
	}

	return strings.Join(safe, " ")
}

func (d *Database) SearchDocuments(query string, workspaceID string) ([]models.SearchResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []models.SearchResult{}, nil
	}

	// Sanitize FTS5 special characters and operators to prevent injection
	query = sanitizeFTSQuery(query)
	if query == "" {
		return []models.SearchResult{}, nil
	}

	// Add wildcard for prefix matching
	ftsQuery := query + "*"

	// Join with documents table to filter by workspace
	sqlQuery := `SELECT f.id, f.title, snippet(documents_fts, 1, '<mark>', '</mark>', '...', 32)
		 FROM documents_fts f
		 JOIN documents d ON d.id = f.id
		 WHERE documents_fts MATCH ?`
	args := []interface{}{ftsQuery}

	if workspaceID != "" {
		sqlQuery += " AND d.workspace_id = ?"
		args = append(args, workspaceID)
	}
	sqlQuery += " ORDER BY rank LIMIT 50"

	rows, err := d.db.Query(sqlQuery, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	results := make([]models.SearchResult, 0)
	for rows.Next() {
		var r models.SearchResult
		if err := rows.Scan(&r.ID, &r.Title, &r.Snippet); err != nil {
			return nil, err
		}
		// Sanitize snippet: escape all HTML, then restore only the safe <mark> tags from FTS5
		r.Snippet = html.EscapeString(r.Snippet)
		r.Snippet = strings.ReplaceAll(r.Snippet, "&lt;mark&gt;", "<mark>")
		r.Snippet = strings.ReplaceAll(r.Snippet, "&lt;/mark&gt;", "</mark>")
		r.Title = html.EscapeString(r.Title)
		results = append(results, r)
	}
	return results, nil
}

func (d *Database) RebuildIndex() error {
	_, err := d.db.Exec("DELETE FROM documents_fts")
	if err != nil {
		return err
	}

	rows, err := d.db.Query("SELECT id, title, content FROM documents WHERE is_folder = 0")
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var id, title, content string
		if err := rows.Scan(&id, &title, &content); err != nil {
			return err
		}
		_, err = d.db.Exec(
			"INSERT INTO documents_fts (id, title, content) VALUES (?, ?, ?)",
			id, title, content,
		)
		if err != nil {
			return err
		}
	}

	return nil
}
