package export

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSanitizeFilename locks in filename sanitization behavior used during export.
// The function must remove filesystem-unsafe characters and truncate long names.
func TestSanitizeFilename(t *testing.T) {
	tests := []struct {
		name, input, want string
	}{
		{"normal name", "notes.md", "notes.md"},
		{"forward slash replaced", "path/to/file", "path-to-file"},
		{"backslash replaced", "path\\to\\file", "path-to-file"},
		{"colon replaced", "file:name", "file-name"},
		{"asterisk removed", "star*here", "starhere"},
		{"question mark removed", "what?", "what"},
		{"double quotes removed", "say \"hello\"", "say hello"},
		{"angle brackets removed", "<script>", "script"},
		{"pipe removed", "a|b", "ab"},
		{"leading trailing spaces trimmed", "  padded  ", "padded"},
		{"empty string", "", ""},
		{"truncated at 200", strings.Repeat("a", 300), strings.Repeat("a", 200)},
		{"combination", "My Doc: <draft> v2", "My Doc- draft v2"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeFilename(tt.input)
			if got != tt.want {
				t.Errorf("sanitizeFilename(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

// TestUniquePath verifies collision avoidance when exporting files with the same name.
func TestUniquePath(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "test.md")

	// First call — file doesn't exist, returns as-is
	got := uniquePath(base)
	if got != base {
		t.Errorf("first call = %q, want %q", got, base)
	}

	// Create the file so it exists
	if err := os.WriteFile(base, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	// Second call — collision, should return " (2)" variant
	got = uniquePath(base)
	want := filepath.Join(dir, "test (2).md")
	if got != want {
		t.Errorf("second call = %q, want %q", got, want)
	}

	// Create that too
	if err := os.WriteFile(want, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	// Third call — should return " (3)" variant
	got = uniquePath(base)
	want3 := filepath.Join(dir, "test (3).md")
	if got != want3 {
		t.Errorf("third call = %q, want %q", got, want3)
	}
}
