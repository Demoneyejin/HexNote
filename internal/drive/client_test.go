package drive

import "testing"

// TestEscapeDriveQuery locks in the Drive API query injection prevention.
// Single quotes delimit strings in the Drive query language; backslashes and
// single quotes within values must be escaped.
func TestEscapeDriveQuery(t *testing.T) {
	tests := []struct {
		name, input, want string
	}{
		{"no special chars", "abc123", "abc123"},
		{"empty string", "", ""},
		{"single quote escaped", "it's", "it\\'s"},
		{"multiple quotes", "a'b'c", "a\\'b\\'c"},
		{"backslash escaped", "a\\b", "a\\\\b"},
		{"both quote and backslash", "it's a\\path", "it\\'s a\\\\path"},
		{"typical Drive folder ID", "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms", "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := escapeDriveQuery(tt.input)
			if got != tt.want {
				t.Errorf("escapeDriveQuery(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
