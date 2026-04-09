# HexNote

### A free, open-source alternative to Confluence — built out of spite

Fuck Confluence. Fuck Atlassian. They deleted my shit and now the best revenge I can get is by providing people an alternative to their fuck ass platform. I'm not gonna lie I vibe-slopped this together out of pure rage and also as a giant middle finger to Atlassian to show that they're charging for something that can just be generated at nearly a push of a button. Below you're going to find a vibe-slopped instruction of how to use this application.

---

## What is HexNote?

HexNote is a **free desktop wiki/knowledge base** that replaces Confluence, Notion, and other overpriced documentation tools. Your documents are **markdown files stored on your own Google Drive** — you own your data, forever. No subscriptions. No vendor lock-in. No surprise deletions.

**If Atlassian can delete your entire workspace for not logging in within a certain amount of time, you don't own your data. HexNote fixes that.**

### Features

- **Rich text editor** — headings, bold, italic, code blocks, tables, task lists, images
- **Google Drive storage** — your docs are `.md` files on YOUR Drive, not someone else's server
- **Publish/Draft workflow** — edit locally, publish when ready
- **Workspace sharing** — share a Drive folder, everyone sees published pages
- **Image support** — paste or drag images, stored in Drive's assets folder
- **Version history** — every publish creates a Drive revision you can preview and restore
- **Full-text search** — instant search across all your pages
- **Dark mode** — because of course
- **Offline capable** — local SQLite cache means you can work without internet
- **Cross-platform** — Windows now, Mac and Linux coming

---

## Quick Start (Using the Pre-built App)

1. Download `hexnote.exe` from [Releases](../../releases)
2. Launch it
3. Sign in with your Google account
4. Create a workspace (picks a Google Drive folder)
5. Start writing

That's it. Your docs are on your Drive.

---

## DIY Setup (Bring Your Own Google Cloud Credentials)

Don't want to wait for our GCP verification? Set up your own OAuth credentials in 5 minutes. It's free.

### Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click **Select a project** > **New Project**
3. Name it anything (e.g., "HexNote") > **Create**

### Step 2: Enable the Google Drive API

1. Go to **APIs & Services** > **Library**
2. Search for **Google Drive API**
3. Click it > **Enable**

### Step 3: Create OAuth Credentials

1. Go to **APIs & Services** > **Credentials**
2. Click **+ Create Credentials** > **OAuth client ID**
3. If prompted, configure the **OAuth consent screen**:
   - User type: **External**
   - App name: anything (e.g., "My HexNote")
   - User support email: your email
   - Developer contact: your email
   - Click through the rest, no scopes needed here
4. Back to **Create OAuth client ID**:
   - Application type: **Desktop app**
   - Name: anything
   - Click **Create**
5. **Download the JSON** file (click the download icon)

### Step 4: Load Credentials in HexNote

1. Launch HexNote
2. Click **"Use your own API credentials"** on the sign-in screen
3. Paste the contents of the downloaded JSON file
4. Click **Save & Continue**
5. Sign in with your Google account

### Step 5: Add Test Users (Optional)

Your GCP project starts in "Testing" mode, which means only users you explicitly add can sign in. To add users:

1. Go to **APIs & Services** > **OAuth consent screen** > **Test users**
2. Click **+ Add users**
3. Enter email addresses (up to 100)

To remove this restriction, submit your app for verification (free, takes 2-6 weeks).

---

## Sharing a Workspace

1. Open your workspace in HexNote
2. Click the **Share** button (or right-click workspace > Permissions)
3. Enter your collaborator's email and role (reader/writer)
4. They get access to the Google Drive folder
5. They open HexNote > **Join shared workspace** > paste the Drive folder link or search for it
6. They see all published pages

---

## How It Works

```
You write in HexNote
    > Saved locally (SQLite + local files)
    > Click "Publish" > pushed to Google Drive as .md files
    > Collaborators click "Refresh" > see your published pages

Your data lives in:
    1. Your machine (local cache - works offline)
    2. Your Google Drive (published pages - you own it)
    3. Nowhere else (no HexNote servers, no telemetry, no analytics)
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Desktop framework | [Wails v2](https://wails.io/) (Go + WebView2) |
| Editor | [TipTap](https://tiptap.dev/) (ProseMirror-based) |
| Database | SQLite via [modernc.org/sqlite](https://pkg.go.dev/modernc.org/sqlite) |
| Storage | Google Drive API v3 |
| Auth | OAuth 2.0 with PKCE |
| Frontend | Vanilla JS (zero npm in the build pipeline) |

---

## Building from Source

### Prerequisites

- [Go 1.22+](https://go.dev/dl/)
- [Wails CLI v2](https://wails.io/docs/gettingstarted/installation)
- [Node.js](https://nodejs.org/) (only needed if rebuilding the TipTap vendor bundle)

### Build

```bash
# Clone the repo
git clone https://github.com/Demoneyejin/HexNote.git
cd hexnote

# Create your credentials file (see DIY Setup above for getting the values)
cat > internal/drive/credentials.go << 'EOF'
package drive

func init() {
    bundledClientID = "your-client-id.apps.googleusercontent.com"
    bundledClientSecret = "your-client-secret"
}
EOF

# Build
wails build -ldflags "-s -w"
```

The binary is at `build/bin/hexnote.exe`.

---

## FAQ

**Q: Is this really free?**
Yes. Google Drive API is free at any scale. HexNote is MIT licensed. No hidden costs.

**Q: What happens if I uninstall HexNote?**
Your documents are still on Google Drive as regular `.md` files. Open them with any text editor.

**Q: Can Atlassian delete my data?**
No. Your data is on YOUR Google Drive. The only person who can delete it is you.

**Q: Is this production-ready?**
It's vibe-slopped software born from rage. It works. It might have bugs. File issues and I'll fix them.

**Q: Why not just use Google Docs?**
You could. But HexNote gives you a wiki-style sidebar tree, markdown support, offline access, and the satisfaction of not paying Atlassian.

---

## Keywords

confluence alternative, free confluence replacement, open source confluence, self-hosted wiki, knowledge base software, team documentation tool, google drive wiki, markdown wiki, desktop wiki app, atlassian alternative, free team wiki, document management, offline wiki, notion alternative free, confluence free replacement, open source knowledge base

---

## License

[MIT](LICENSE) — do whatever you want with it.

---

*Built with mass amounts of salt, mass amounts of Claude, and mass amounts of mass. Vibe-slopped into existence on April 6th, 2026.*
