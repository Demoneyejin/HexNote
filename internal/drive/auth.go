package drive

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/drive/v3"
)

// bundledClientID and bundledClientSecret are the default OAuth credentials
// shipped with the binary. These are injected at build time via -ldflags so
// they never appear in source code. In dev builds without injection, they
// remain as placeholders and the user must provide their own credentials.json.
var (
	bundledClientID     = "PLACEHOLDER_CLIENT_ID"
	bundledClientSecret = "PLACEHOLDER_CLIENT_SECRET"
)

// AuthManager handles OAuth2 authentication with Google
type AuthManager struct {
	appDataDir string
	config     *oauth2.Config
	token      *oauth2.Token
	wailsCtx   context.Context
}

// credentialsJSON is the expected format of the user-provided credentials file
type credentialsJSON struct {
	Installed struct {
		ClientID     string   `json:"client_id"`
		ClientSecret string   `json:"client_secret"`
		RedirectURIs []string `json:"redirect_uris"`
	} `json:"installed"`
}

// hasBundledCredentials returns true if real OAuth credentials are compiled into the binary.
func hasBundledCredentials() bool {
	return bundledClientID != "" && bundledClientID != "PLACEHOLDER_CLIENT_ID"
}

func NewAuthManager(appDataDir string) *AuthManager {
	return &AuthManager{appDataDir: appDataDir}
}

func (am *AuthManager) SetWailsContext(ctx context.Context) {
	am.wailsCtx = ctx
}

// LoadCredentials configures OAuth2. Priority: user-provided credentials.json, then bundled defaults.
func (am *AuthManager) LoadCredentials() error {
	// 1. Try user-provided credentials file
	if data, err := os.ReadFile(am.credentialsPath()); err == nil {
		var creds credentialsJSON
		if err := json.Unmarshal(data, &creds); err == nil && creds.Installed.ClientID != "" {
			am.config = &oauth2.Config{
				ClientID:     creds.Installed.ClientID,
				ClientSecret: creds.Installed.ClientSecret,
				Scopes:       []string{drive.DriveScope},
				Endpoint:     google.Endpoint,
			}
			am.loadToken()
			return nil
		}
	}

	// 2. Fall back to bundled credentials compiled into the binary
	if hasBundledCredentials() {
		am.config = &oauth2.Config{
			ClientID:     bundledClientID,
			ClientSecret: bundledClientSecret,
			Scopes:       []string{drive.DriveScope},
			Endpoint:     google.Endpoint,
		}
		am.loadToken()
		return nil
	}

	// Neither user-provided nor bundled credentials available
	return fmt.Errorf("no credentials available")
}

// SaveCredentials writes credentials JSON content to the app data dir
func (am *AuthManager) SaveCredentials(jsonContent string) error {
	// Validate it's valid JSON with the expected structure
	var creds credentialsJSON
	if err := json.Unmarshal([]byte(jsonContent), &creds); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	if creds.Installed.ClientID == "" {
		return fmt.Errorf("missing installed.client_id field")
	}

	if err := os.MkdirAll(am.appDataDir, 0700); err != nil {
		return err
	}

	if err := os.WriteFile(am.credentialsPath(), []byte(jsonContent), 0600); err != nil {
		return err
	}

	return am.LoadCredentials()
}

func (am *AuthManager) HasCredentials() bool {
	return am.config != nil
}

func (am *AuthManager) HasValidToken() bool {
	return am.token != nil && am.token.RefreshToken != ""
}

func (am *AuthManager) GetTokenSource(ctx context.Context) oauth2.TokenSource {
	if am.config == nil || am.token == nil {
		return nil
	}
	return am.config.TokenSource(ctx, am.token)
}

// StartOAuthFlow launches the OAuth2 loopback redirect flow
func (am *AuthManager) StartOAuthFlow() error {
	if am.config == nil {
		return fmt.Errorf("no credentials loaded — import credentials.json first")
	}

	// Start a listener on a random port
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("start listener: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	redirectURL := fmt.Sprintf("http://127.0.0.1:%d/callback", port)
	am.config.RedirectURL = redirectURL

	// Generate CSRF state
	stateBytes := make([]byte, 16)
	rand.Read(stateBytes)
	state := hex.EncodeToString(stateBytes)

	// Generate PKCE code verifier + challenge (RFC 7636)
	// Even if the client_secret is extracted from the binary, PKCE ensures
	// that intercepted authorization codes cannot be exchanged for tokens
	// without the original verifier — which only lives in this process's memory.
	verifierBytes := make([]byte, 32)
	rand.Read(verifierBytes)
	codeVerifier := base64.RawURLEncoding.EncodeToString(verifierBytes)
	challengeHash := sha256.Sum256([]byte(codeVerifier))
	codeChallenge := base64.RawURLEncoding.EncodeToString(challengeHash[:])

	// Channel to receive the auth code
	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)

	// Start HTTP server to handle the callback
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("state") != state {
			errCh <- fmt.Errorf("state mismatch")
			http.Error(w, "State mismatch", http.StatusBadRequest)
			return
		}
		if errMsg := r.URL.Query().Get("error"); errMsg != "" {
			errCh <- fmt.Errorf("auth error: %s", errMsg)
			fmt.Fprintf(w, "<html><body><h2>Authentication failed: %s</h2><p>You can close this tab.</p></body></html>", errMsg)
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			errCh <- fmt.Errorf("no code in callback")
			http.Error(w, "No code", http.StatusBadRequest)
			return
		}
		codeCh <- code
		fmt.Fprint(w, `<html><body>
			<h2 style="font-family:sans-serif;color:#16a34a;">Authenticated successfully!</h2>
			<p style="font-family:sans-serif;">You can close this tab and return to HexNote.</p>
			<script>window.close()</script>
		</body></html>`)
	})

	server := &http.Server{Handler: mux}

	go func() {
		if err := server.Serve(listener); err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	// Open the auth URL in the system browser (with PKCE challenge)
	authURL := am.config.AuthCodeURL(state,
		oauth2.AccessTypeOffline,
		oauth2.ApprovalForce,
		oauth2.SetAuthURLParam("code_challenge", codeChallenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
	)
	if am.wailsCtx != nil {
		wailsRuntime.BrowserOpenURL(am.wailsCtx, authURL)
	}

	// Wait for the callback (with 5-minute timeout to prevent hanging)
	go func() {
		select {
		case code := <-codeCh:
			// Exchange the code for a token (with PKCE verifier)
			token, err := am.config.Exchange(context.Background(), code,
				oauth2.SetAuthURLParam("code_verifier", codeVerifier),
			)
			if err != nil {
				if am.wailsCtx != nil {
					wailsRuntime.EventsEmit(am.wailsCtx, "auth:error", err.Error())
				}
			} else {
				am.token = token
				am.saveToken()
				if am.wailsCtx != nil {
					wailsRuntime.EventsEmit(am.wailsCtx, "auth:complete", "")
				}
			}
		case err := <-errCh:
			if am.wailsCtx != nil {
				wailsRuntime.EventsEmit(am.wailsCtx, "auth:error", err.Error())
			}
		case <-time.After(5 * time.Minute):
			if am.wailsCtx != nil {
				wailsRuntime.EventsEmit(am.wailsCtx, "auth:error", "authentication timed out — please try again")
			}
		}
		server.Close()
	}()

	return nil
}

func (am *AuthManager) SignOut() error {
	am.token = nil
	// Only remove files that are strictly inside our app data dir
	safeRemoveInDir(am.appDataDir, am.tokenPath())
	safeRemoveInDir(am.appDataDir, am.scopePath())
	return nil
}

// safeRemoveInDir deletes a file only if its resolved path is strictly inside
// the given root directory. Prevents accidental deletion outside the app data dir.
func safeRemoveInDir(root, path string) {
	absRoot, err1 := filepath.Abs(root)
	absPath, err2 := filepath.Abs(path)
	if err1 != nil || err2 != nil || absRoot == "" || absPath == "" {
		return
	}
	if !strings.HasPrefix(absPath, absRoot+string(filepath.Separator)) {
		return
	}
	os.Remove(absPath)
}

// Token persistence

// currentScopeKey is written alongside the token so we can detect scope changes
// across app updates and automatically invalidate stale tokens.
const currentScopeKey = "drive" // matches drive.DriveScope

func (am *AuthManager) loadToken() {
	// Check if the token was obtained with the current scope
	scopeData, _ := os.ReadFile(am.scopePath())
	savedScope := strings.TrimSpace(string(scopeData))
	if savedScope != "" && savedScope != currentScopeKey {
		// Scope changed since last auth — token is stale, force re-auth
		safeRemoveInDir(am.appDataDir, am.tokenPath())
		safeRemoveInDir(am.appDataDir, am.scopePath())
		return
	}

	data, err := os.ReadFile(am.tokenPath())
	if err != nil {
		return
	}
	var token oauth2.Token
	if err := json.Unmarshal(data, &token); err != nil {
		return
	}
	am.token = &token
}

func (am *AuthManager) saveToken() error {
	data, err := json.MarshalIndent(am.token, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(am.tokenPath(), data, 0600); err != nil {
		return err
	}
	// Record which scope this token was obtained with
	return os.WriteFile(am.scopePath(), []byte(currentScopeKey), 0600)
}

func (am *AuthManager) credentialsPath() string {
	return filepath.Join(am.appDataDir, "oauth_credentials.json")
}

func (am *AuthManager) tokenPath() string {
	return filepath.Join(am.appDataDir, "token.json")
}

func (am *AuthManager) scopePath() string {
	return filepath.Join(am.appDataDir, "token_scope")
}
