package export

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"hexnote/internal/models"
	"hexnote/internal/storage"
)

// ExportWorkspace writes all documents in a workspace to a local folder as .md files.
// Folder hierarchy is preserved. Documents get optional YAML frontmatter.
func ExportWorkspace(db *storage.Database, workspaceID, destPath string) error {
	tree, err := db.GetDocumentTree(workspaceID)
	if err != nil {
		return fmt.Errorf("get document tree: %w", err)
	}

	if err := os.MkdirAll(destPath, 0755); err != nil {
		return fmt.Errorf("create destination: %w", err)
	}

	return exportNodes(db, tree, destPath)
}

func exportNodes(db *storage.Database, nodes []*models.TreeNode, parentPath string) error {
	for _, node := range nodes {
		doc := node.Document
		safeName := sanitizeFilename(doc.Title)
		if safeName == "" {
			safeName = "Untitled"
		}

		if doc.IsFolder {
			folderPath := filepath.Join(parentPath, safeName)
			if err := os.MkdirAll(folderPath, 0755); err != nil {
				return fmt.Errorf("create folder %q: %w", safeName, err)
			}
			if node.Children != nil {
				if err := exportNodes(db, node.Children, folderPath); err != nil {
					return err
				}
			}
		} else {
			filePath := filepath.Join(parentPath, safeName+".md")
			// Avoid overwriting if same name exists
			filePath = uniquePath(filePath)

			content := buildMarkdown(db, &doc)
			if err := os.WriteFile(filePath, []byte(content), 0644); err != nil {
				return fmt.Errorf("write %q: %w", safeName, err)
			}
		}
	}
	return nil
}

func buildMarkdown(db *storage.Database, doc *models.Document) string {
	var sb strings.Builder

	// YAML frontmatter
	sb.WriteString("---\n")
	sb.WriteString(fmt.Sprintf("id: %q\n", doc.ID))
	sb.WriteString(fmt.Sprintf("created: %q\n", doc.CreatedAt.Format(time.RFC3339)))
	sb.WriteString(fmt.Sprintf("updated: %q\n", doc.UpdatedAt.Format(time.RFC3339)))

	// Include labels if available
	labels, err := db.GetDocumentLabels(doc.ID)
	if err == nil && len(labels) > 0 {
		names := make([]string, len(labels))
		for i, l := range labels {
			names[i] = fmt.Sprintf("%q", l.Name)
		}
		sb.WriteString(fmt.Sprintf("labels: [%s]\n", strings.Join(names, ", ")))
	}

	sb.WriteString("---\n\n")
	sb.WriteString(doc.Content)

	return sb.String()
}

func sanitizeFilename(name string) string {
	// Remove characters not allowed in filenames
	replacer := strings.NewReplacer(
		"/", "-", "\\", "-", ":", "-", "*", "", "?", "",
		"\"", "", "<", "", ">", "", "|", "",
	)
	result := replacer.Replace(strings.TrimSpace(name))
	if len(result) > 200 {
		result = result[:200]
	}
	return result
}

func uniquePath(path string) string {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return path
	}
	ext := filepath.Ext(path)
	base := strings.TrimSuffix(path, ext)
	for i := 2; i < 1000; i++ {
		candidate := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
	return path
}
