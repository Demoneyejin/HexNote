package drive

import (
	"os"
	"path/filepath"
	"testing"

	gdrive "google.golang.org/api/drive/v3"
)

const teamJSON = `{"installed":{"client_id":"team.apps.googleusercontent.com","client_secret":"s"}}`

// withBundled simulates a build made with -X ...bundledClientID=...
func withBundled(t *testing.T, id string) {
	t.Helper()
	oldID, oldSecret := bundledClientID, bundledClientSecret
	bundledClientID, bundledClientSecret = id, "bundled-secret"
	t.Cleanup(func() { bundledClientID, bundledClientSecret = oldID, oldSecret })
}

func writeToken(t *testing.T, dir, scopeKey string) {
	t.Helper()
	os.WriteFile(filepath.Join(dir, "token.json"), []byte(`{"access_token":"a","refresh_token":"r"}`), 0600)
	os.WriteFile(filepath.Join(dir, "token_scope"), []byte(scopeKey), 0600)
}

func readFile(dir, name string) string {
	b, _ := os.ReadFile(filepath.Join(dir, name))
	return string(b)
}

func TestNoBundledClientBehavesAsBefore(t *testing.T) {
	withBundled(t, "")
	dir := t.TempDir()
	am := NewAuthManager(dir)
	if err := am.LoadCredentials(); err == nil || am.HasCredentials() || am.Mode() != "" {
		t.Fatalf("no JSON and no bundled client: want no credentials, got mode %q", am.Mode())
	}
	if BundledClientAvailable() {
		t.Error("BundledClientAvailable should be false")
	}
	if err := am.SaveCredentials(teamJSON); err != nil {
		t.Fatal(err)
	}
	if am.Mode() != ModeTeam || am.config.Scopes[0] != gdrive.DriveScope {
		t.Errorf("pasted JSON: mode %q scopes %v", am.Mode(), am.config.Scopes)
	}
}

func TestBundledClientGivesSoloModeWithDriveFileScope(t *testing.T) {
	withBundled(t, "bundled.apps.googleusercontent.com")
	dir := t.TempDir()
	am := NewAuthManager(dir)
	if err := am.LoadCredentials(); err != nil {
		t.Fatal(err)
	}
	if am.Mode() != ModeSolo || am.config.ClientID != "bundled.apps.googleusercontent.com" {
		t.Fatalf("mode %q client %q", am.Mode(), am.config.ClientID)
	}
	if len(am.config.Scopes) != 1 || am.config.Scopes[0] != gdrive.DriveFileScope {
		t.Errorf("solo scopes = %v, want only drive.file", am.config.Scopes)
	}
	if readFile(dir, "auth_mode") != ModeSolo {
		t.Errorf("auth_mode = %q", readFile(dir, "auth_mode"))
	}
}

func TestPastedJSONWinsOverBundledClient(t *testing.T) {
	withBundled(t, "bundled.apps.googleusercontent.com")
	dir := t.TempDir()
	am := NewAuthManager(dir)
	am.LoadCredentials()
	if err := am.SaveCredentials(teamJSON); err != nil {
		t.Fatal(err)
	}
	if am.Mode() != ModeTeam || am.config.ClientID != "team.apps.googleusercontent.com" || am.config.Scopes[0] != gdrive.DriveScope {
		t.Errorf("mode %q client %q scopes %v", am.Mode(), am.config.ClientID, am.config.Scopes)
	}
}

func TestSwitchingModesForcesSignIn(t *testing.T) {
	withBundled(t, "bundled.apps.googleusercontent.com")
	dir := t.TempDir()

	// Signed in with Team mode (scope key "drive", as written before modes existed).
	os.WriteFile(filepath.Join(dir, "oauth_credentials.json"), []byte(teamJSON), 0600)
	writeToken(t, dir, "drive")
	am := NewAuthManager(dir)
	am.LoadCredentials()
	if !am.HasValidToken() {
		t.Fatal("existing Team-mode token must stay valid")
	}

	// Switch to Solo: the drive-scope token must not be reused.
	if err := am.ClearCredentials(); err != nil {
		t.Fatal(err)
	}
	if am.Mode() != ModeSolo || am.HasValidToken() {
		t.Fatalf("after switching to solo: mode %q, token kept %v", am.Mode(), am.HasValidToken())
	}

	// A Solo token (scope key drive.file) is not used after switching back to Team.
	writeToken(t, dir, "drive.file")
	am.LoadCredentials()
	if !am.HasValidToken() {
		t.Fatal("solo token should load in solo mode")
	}
	if err := am.SaveCredentials(teamJSON); err != nil {
		t.Fatal(err)
	}
	if am.HasValidToken() {
		t.Error("switching to Team mode must require a new sign-in")
	}

	// And a leftover token with the wrong scope key is discarded on load.
	writeToken(t, dir, "drive.file")
	am2 := NewAuthManager(dir)
	am2.LoadCredentials()
	if am2.Mode() != ModeTeam || am2.HasValidToken() {
		t.Errorf("team mode loaded a drive.file token: mode %q", am2.Mode())
	}
	if _, err := os.Stat(filepath.Join(dir, "token.json")); !os.IsNotExist(err) {
		t.Error("stale token file should be deleted")
	}
}

// TestLdflagsInjection checks that build.sh's -X flags reach the variables.
// It runs only when asked:
//
//	HEXNOTE_EXPECT_BUNDLED=abc go test -ldflags "-X hexnote/internal/drive.bundledClientID=abc" -run Ldflags ./internal/drive/
func TestLdflagsInjection(t *testing.T) {
	want := os.Getenv("HEXNOTE_EXPECT_BUNDLED")
	if want == "" {
		t.Skip("set HEXNOTE_EXPECT_BUNDLED and pass -ldflags to run")
	}
	if bundledClientID != want || !BundledClientAvailable() {
		t.Errorf("bundledClientID = %q, want %q", bundledClientID, want)
	}
}
