package drive

import (
	"regexp"
	"strings"
)

// Image links exist in two forms:
//
//   - Local (in the editor and SQLite): /images/<workspace-id>/<file>, served
//     from this PC's image cache by the middleware in main.go. The workspace
//     ID is a local UUID, so this form only works on the PC that wrote it.
//   - Portable (in the .md file on Drive): a relative link to the workspace's
//     assets folder, e.g. assets/<file> for a top-level page or
//     ../assets/<file> for a page one folder down, so the file shows its
//     images in any markdown viewer and on every teammate's PC.
//
// Older versions of HexNote wrote the local form (sometimes with a double
// slash) to Drive; LocalizeContent accepts all three.

// localImageRe matches a local image path anywhere: /images/<id>/ or
// //images/<id>/ (older editor versions), case-insensitive "images".
var localImageRe = regexp.MustCompile(`/{1,2}[Ii]mages/[A-Za-z0-9-]+/`)

// linkedLocalImageRe matches a local image path used as a link target:
// ](/images/<id>/  or  src="/images/<id>/
var linkedLocalImageRe = regexp.MustCompile(`(\]\(|src=["'])/{1,2}[Ii]mages/[A-Za-z0-9-]+/`)

// relativeAssetsRe matches a relative link into the assets folder used as a
// link target: ](assets/  ](./assets/  ](../../assets/  src="assets/ ...
var relativeAssetsRe = regexp.MustCompile(`(\]\(|src=["'])(?:\./)?(?:\.\./)*assets/`)

// LocalizeContent rewrites every image link form found in markdown from
// Drive into the local form for this PC's workspace.
func LocalizeContent(content, localWorkspaceID string) string {
	local := "/images/" + localWorkspaceID + "/"
	content = relativeAssetsRe.ReplaceAllString(content, "${1}"+local)
	return localImageRe.ReplaceAllString(content, local)
}

// PortableContent rewrites local image links into links relative to a page
// that sits depth folders below the workspace root on Drive.
func PortableContent(content string, depth int) string {
	prefix := strings.Repeat("../", depth) + "assets/"
	return linkedLocalImageRe.ReplaceAllString(content, "${1}"+prefix)
}
