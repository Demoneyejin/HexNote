package drive

import (
	"os"
	"path/filepath"
	"testing"

	gdrive "google.golang.org/api/drive/v3"
)

const ownJSON = `{"installed":{"client_id":"own.apps.googleusercontent.com","client_secret":"s"}}`

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
	if err := am.SaveCredentials(ownJSON); err != nil {
		t.Fatal(err)
	}
	if am.Mode() != ModeOwnKey || am.config.Scopes[0] != gdrive.DriveScope {
		t.Errorf("pasted JSON: mode %q scopes %v", am.Mode(), am.config.Scopes)
	}
}

// The built-in sign-in asks for full Drive access: drive.file cannot see pages
// a teammate created in a shared workspace folder.
func TestBundledClientSignsInWithFullDriveScope(t *testing.T) {
	withBundled(t, "bundled.apps.googleusercontent.com")
	dir := t.TempDir()
	am := NewAuthManager(dir)
	if err := am.LoadCredentials(); err != nil {
		t.Fatal(err)
	}
	if am.Mode() != ModeBuiltIn || am.config.ClientID != "bundled.apps.googleusercontent.com" {
		t.Fatalf("mode %q client %q", am.Mode(), am.config.ClientID)
	}
	if len(am.config.Scopes) != 1 || am.config.Scopes[0] != gdrive.DriveScope {
		t.Errorf("built-in scopes = %v, want only drive", am.config.Scopes)
	}
	if readFile(dir, "auth_mode") != ModeBuiltIn {
		t.Errorf("auth_mode = %q", readFile(dir, "auth_mode"))
	}
}

// Earlier builds signed in through the bundled client with drive.file. Such a
// token cannot open shared folders, so it is dropped and the user signs in again.
func TestOldDriveFileTokenIsDiscarded(t *testing.T) {
	withBundled(t, "bundled.apps.googleusercontent.com")
	dir := t.TempDir()
	writeToken(t, dir, "drive.file")
	am := NewAuthManager(dir)
	am.LoadCredentials()
	if am.Mode() != ModeBuiltIn || am.HasValidToken() {
		t.Fatalf("mode %q, drive.file token kept %v", am.Mode(), am.HasValidToken())
	}
	if _, err := os.Stat(filepath.Join(dir, "token.json")); !os.IsNotExist(err) {
		t.Error("stale token file should be deleted")
	}
}

func TestPastedJSONWinsOverBundledClient(t *testing.T) {
	withBundled(t, "bundled.apps.googleusercontent.com")
	dir := t.TempDir()
	am := NewAuthManager(dir)
	am.LoadCredentials()
	if err := am.SaveCredentials(ownJSON); err != nil {
		t.Fatal(err)
	}
	if am.Mode() != ModeOwnKey || am.config.ClientID != "own.apps.googleusercontent.com" || am.config.Scopes[0] != gdrive.DriveScope {
		t.Errorf("mode %q client %q scopes %v", am.Mode(), am.config.ClientID, am.config.Scopes)
	}
}

// A token belongs to the client that issued it, so it is never carried over
// when the user switches between the built-in client and their own.
func TestSwitchingClientsForcesSignIn(t *testing.T) {
	withBundled(t, "bundled.apps.googleusercontent.com")
	dir := t.TempDir()

	// Signed in through their own client (scope key "drive", as written before modes existed).
	os.WriteFile(filepath.Join(dir, "oauth_credentials.json"), []byte(ownJSON), 0600)
	writeToken(t, dir, "drive")
	am := NewAuthManager(dir)
	am.LoadCredentials()
	if !am.HasValidToken() {
		t.Fatal("existing own-client token must stay valid")
	}

	// Switch to the built-in client: the other client's token must not be reused.
	if err := am.ClearCredentials(); err != nil {
		t.Fatal(err)
	}
	if am.Mode() != ModeBuiltIn || am.HasValidToken() {
		t.Fatalf("after switching to built-in: mode %q, token kept %v", am.Mode(), am.HasValidToken())
	}

	// A built-in token is not used after switching back to the user's own client.
	writeToken(t, dir, scopeKeys[ModeBuiltIn])
	am.LoadCredentials()
	if !am.HasValidToken() {
		t.Fatal("built-in token should load in built-in mode")
	}
	if err := am.SaveCredentials(ownJSON); err != nil {
		t.Fatal(err)
	}
	if am.HasValidToken() {
		t.Error("switching to the user's own client must require a new sign-in")
	}

	// And a leftover token from the other client is discarded on load.
	writeToken(t, dir, scopeKeys[ModeBuiltIn])
	am2 := NewAuthManager(dir)
	am2.LoadCredentials()
	if am2.Mode() != ModeOwnKey || am2.HasValidToken() {
		t.Errorf("own-client mode loaded a built-in token: mode %q", am2.Mode())
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
