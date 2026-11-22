package main

import (
	"reflect"
	"testing"

	"hexnote/internal/models"
)

func node(id, driveID string, children ...*models.TreeNode) *models.TreeNode {
	return &models.TreeNode{
		Document: models.Document{ID: id, DriveFileID: driveID},
		Children: children,
	}
}

// TestDriveIDsToTrash locks in which Drive items a delete must trash: the
// topmost published item of each branch (trashing a Drive folder trashes its
// contents), and nothing for never-published drafts.
func TestDriveIDsToTrash(t *testing.T) {
	tests := []struct {
		name string
		root *models.TreeNode
		want []string
	}{
		{"unpublished draft", node("a", ""), nil},
		{"published page", node("a", "d-a"), []string{"d-a"}},
		{"published folder skips its children", node("f", "d-f", node("a", "d-a"), node("b", "")), []string{"d-f"}},
		{"local folder collects published descendants",
			node("f", "", node("a", "d-a"), node("g", "", node("b", "d-b"), node("c", ""))),
			[]string{"d-a", "d-b"}},
		{"local folder of drafts", node("f", "", node("a", ""), node("b", "")), nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := driveIDsToTrash(tt.root); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("driveIDsToTrash() = %v, want %v", got, tt.want)
			}
		})
	}
}
