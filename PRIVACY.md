# Privacy Policy

**HexNote** — Last updated: April 2026

## Summary

HexNote does not collect, store, or transmit any of your personal data. Your documents live on your own machine and your own Google Drive account. We have zero access to your content.

## What HexNote accesses

- **Google Drive**: HexNote reads and writes markdown files and images to folders you explicitly choose in your own Google Drive. This requires Google OAuth sign-in with the `drive` scope.
- **Local storage**: HexNote stores a local SQLite database and image cache in your system's application data directory (`%APPDATA%/HexNote` on Windows, `~/Library/Application Support/HexNote` on macOS). This data never leaves your machine.

## What HexNote does NOT do

- We do not collect analytics or telemetry
- We do not track usage patterns
- We do not store your Google account credentials (OAuth tokens are stored locally on your machine only)
- We do not have a server — there is no backend that receives your data
- We do not sell, share, or transfer any user data to third parties
- We do not access any Google Drive files or folders beyond the ones you explicitly select as workspaces

## Google OAuth

HexNote uses Google OAuth 2.0 to authenticate with your Google account. When you sign in:

1. A browser window opens to Google's official sign-in page
2. You authorize HexNote to access your Google Drive
3. An OAuth token is stored locally on your machine
4. HexNote uses this token to read/write files in your chosen Drive folders

You can revoke access at any time from your [Google Account permissions page](https://myaccount.google.com/permissions).

## Data deletion

To remove all HexNote data from your machine:

1. Uninstall the application
2. Delete the `HexNote` folder from your application data directory
3. Revoke access from your Google Account permissions page

Your Google Drive files are not affected by uninstalling HexNote.

## Contact

If you have questions about this privacy policy, please open an issue on the [HexNote GitHub repository](https://github.com/Demoneyejin/HexNote/issues).
