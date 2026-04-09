package storage

import "testing"

// TestSanitizeFTSQuery locks in the FTS5 injection prevention behavior.
// The function must strip all FTS5 special syntax characters and boolean operators
// while preserving normal search terms.
func TestSanitizeFTSQuery(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"plain text passes through", "hello world", "hello world"},
		{"strips double quotes", "say \"hello\" now", "say hello now"},
		{"strips asterisk", "prefix*", "prefix"},
		{"strips colon (column filter)", "title:secret", "titlesecret"},
		{"strips dash (NOT shorthand)", "hello -world", "hello world"},
		{"strips caret (initial token)", "^first", "first"},
		{"strips curly braces (NEAR group)", "{grouped}", "grouped"},
		{"strips parentheses", "(grouped)", "grouped"},
		{"removes AND operator", "hello AND world", "hello world"},
		{"removes OR operator", "hello OR world", "hello world"},
		{"removes NOT operator", "hello NOT world", "hello world"},
		{"removes NEAR operator", "hello NEAR world", "hello world"},
		{"case insensitive operators", "hello and world", "hello world"},
		{"mixed case operator", "hello Or world", "hello world"},
		{"only operators returns empty", "AND OR NOT NEAR", ""},
		{"empty input", "", ""},
		{"only special chars", "\"*:^{}()-", ""},
		{"preserves numbers and letters", "v2 golang sqlite3", "v2 golang sqlite3"},
		{"mixed attack vector", "title:\"admin\" NOT secret*", "titleadmin secret"},
		{"multiple spaces collapse", "hello   world", "hello world"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeFTSQuery(tt.input)
			if got != tt.want {
				t.Errorf("sanitizeFTSQuery(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

// TestSearchWorkspaceFilter verifies that search results are scoped to the
// specified workspace, not leaked across workspaces.
func TestSearchWorkspaceFilter(t *testing.T) {
	db := newTestDB(t)

	doc1, _ := db.CreateDocument("Alpha topic", "", "ws-1", false)
	db.UpdateDocument(doc1.ID, "Alpha topic", "Content about alpha project")

	doc2, _ := db.CreateDocument("Beta topic", "", "ws-2", false)
	db.UpdateDocument(doc2.ID, "Beta topic", "Content about beta project")

	results, err := db.SearchDocuments("topic", "ws-1")
	if err != nil {
		t.Fatalf("SearchDocuments: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result for ws-1, got %d", len(results))
	}
	if results[0].ID != doc1.ID {
		t.Errorf("expected doc1 ID %q, got %q", doc1.ID, results[0].ID)
	}
}

// TestSearchEmptyResult verifies that searching with no matches returns an
// empty slice (not nil), which the frontend depends on.
func TestSearchEmptyResult(t *testing.T) {
	db := newTestDB(t)

	results, err := db.SearchDocuments("nonexistent", "ws-1")
	if err != nil {
		t.Fatalf("SearchDocuments: %v", err)
	}
	if results == nil {
		t.Error("SearchDocuments returned nil, want empty slice")
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}
}
