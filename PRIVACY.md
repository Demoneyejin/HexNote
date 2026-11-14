# Privacy Policy

**HexNote** — Last updated: November 2026

## Summary

HexNote is a desktop application. It has no server: the developer of HexNote does not collect, receive, or store any of your personal data or your Google user data. Your documents live on your own machine and in your own Google Drive account, and everything HexNote reads from Google stays on your device.

## Google user data HexNote accesses

When you sign in with Google, HexNote requests the Google Drive scope (`https://www.googleapis.com/auth/drive`). With it, the app running on your computer accesses:

- **Folder names**: the names and IDs of folders in your Drive and of folders shared with you, so you can choose or join a workspace folder.
- **Files in your workspace folders**: the names, modification times, contents, and revision history of the markdown files and images inside the folders you select as workspaces.
- **Sharing information for workspace folders**: the names, email addresses, and roles of the people a workspace folder is shared with, so you can view and manage collaborators.
- **Your Google account email address**: shown in the app so you can see which account is signed in.

## How HexNote uses this data

Google user data is used only to provide the features you see in the app:

- Listing folders so you can pick a workspace
- Downloading pages and images from your workspace folders so you can read and edit them
- Uploading pages and images to your workspace folders when you click Publish
- Showing and restoring earlier versions of a page
- Adding or removing collaborators on a workspace folder when you ask it to

HexNote reads and writes file contents only inside the folders you select as workspaces. It does not use your data for advertising, analytics, profiling, or training AI or machine-learning models.

## How this data is stored

- **On your device only**: HexNote keeps a local SQLite database (your pages, workspace list, and workspace collaborator list) and an image cache in your system's application data directory (`%APPDATA%/HexNote` on Windows, `~/Library/Application Support/HexNote` on macOS).
- **OAuth tokens**: the token Google issues when you sign in is stored in that same directory on your machine and is sent only to Google.
- **No developer servers**: there is no HexNote backend. Data travels directly between your computer and Google's APIs over HTTPS.

## How this data is shared

HexNote does not share, sell, or transfer your Google user data to anyone. The only sharing that happens is sharing you perform yourself: when you add a collaborator to a workspace, HexNote asks Google Drive to share that folder with the email address you entered.

## Limited Use

HexNote's use and transfer of information received from Google APIs to any other app will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## What HexNote does NOT do

- We do not collect analytics or telemetry
- We do not track usage patterns
- We do not store your Google account password (sign-in happens on Google's own page, in your browser)
- We do not have a server — there is no backend that receives your data
- We do not sell, share, or transfer any user data to third parties
- We do not read or modify the contents of Drive files outside the folders you select as workspaces
- No human other than you (and the collaborators you invite) can read your data through HexNote

## Google OAuth

HexNote uses Google OAuth 2.0 to authenticate with your Google account. When you sign in:

1. A browser window opens to Google's official sign-in page
2. You authorize HexNote to access your Google Drive
3. An OAuth token is stored locally on your machine
4. HexNote uses this token to read/write files in your chosen Drive folders

You can revoke access at any time from your [Google Account permissions page](https://myaccount.google.com/permissions).

## Data retention and deletion

HexNote keeps its local data until you remove it. Because nothing is stored on a developer server, there is nothing for us to retain or delete on your behalf. To remove all HexNote data from your machine:

1. Uninstall the application
2. Delete the `HexNote` folder from your application data directory
3. Revoke access from your Google Account permissions page

Your Google Drive files are not affected by uninstalling HexNote.

## Contact

If you have questions about this privacy policy, please open an issue on the [HexNote GitHub repository](https://github.com/Demoneyejin/HexNote/issues).
