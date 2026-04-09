package main

import (
	"embed"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

// makeImageMiddleware creates an image-serving middleware that:
// 1. Serves images from the local cache if available
// 2. Falls back to downloading from Google Drive if the local file is missing
//    (happens after publish cleans up local copies)
// 3. Re-caches the downloaded file for future requests
func makeImageMiddleware(app *App) assetserver.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Normalize double-slash from older editor versions
			urlPath := strings.Replace(r.URL.Path, "//images/", "/images/", 1)
			if !strings.HasPrefix(urlPath, "/images/") {
				next.ServeHTTP(w, r)
				return
			}

			parts := strings.SplitN(strings.TrimPrefix(urlPath, "/images/"), "/", 2)
			if len(parts) != 2 {
				next.ServeHTTP(w, r)
				return
			}

			wsID := filepath.Base(parts[0])
			filename := filepath.Base(parts[1])
			if wsID != parts[0] || filename != parts[1] || strings.Contains(parts[0], "..") || strings.Contains(parts[1], "..") {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}

			configDir, err := os.UserConfigDir()
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}

			cacheRoot := filepath.Join(configDir, "HexNote", "image_cache")
			imgPath := filepath.Join(cacheRoot, wsID, filename)

			resolved, err := filepath.Abs(imgPath)
			if err != nil || !strings.HasPrefix(resolved, cacheRoot) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}

			// Serve from local cache if available
			if _, statErr := os.Stat(resolved); statErr == nil {
				http.ServeFile(w, r, resolved)
				return
			}

			// Local file missing — try to download from Drive on-demand
			if app.db != nil && app.driveClient != nil {
				imgAsset, _ := app.db.GetImageAsset(wsID, filename)
				if imgAsset != nil && imgAsset.DriveFileID != "" {
					data, dlErr := app.driveClient.DownloadBinaryData(imgAsset.DriveFileID)
					if dlErr == nil && len(data) > 0 {
						// Re-cache locally for future requests
						cacheDir := filepath.Join(cacheRoot, wsID)
						os.MkdirAll(cacheDir, 0700)
						os.WriteFile(resolved, data, 0644)
						http.ServeFile(w, r, resolved)
						return
					}
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "HexNote",
		Width:     1280,
		Height:    800,
		MinWidth:  900,
		MinHeight: 600,
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Middleware: assetserver.ChainMiddleware(makeImageMiddleware(app)),
		},
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
		},
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
