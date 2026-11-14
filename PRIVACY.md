# Privacy Policy

**HexNote** — Last updated: November 2026

## Summary

HexNote does not collect, store, or transmit any of your personal data to its authors. There is no HexNote server. Your documents live on your own PC and in your own Google Drive, and HexNote talks only to Google.

## How HexNote signs in to Google

You sign in on Google's own page in your browser, with your normal Google account. HexNote uses its own Google sign-in ("Sign in with Google"); if you prefer, you can instead connect a Google Cloud project that **you** create (the "bring your own key" setup) by pasting its OAuth client file into HexNote. Either way, the sign-in token Google issues is stored only on your PC. The HexNote authors never see your password, credentials or tokens.

## What Google Drive access HexNote asks for

HexNote requests the Google Drive scope `https://www.googleapis.com/auth/drive`. Google describes it as permission to *"see, edit, create, and delete all of your Google Drive files"*. That is broader than HexNote needs for any single action, and we want to be exact about how it is used. HexNote uses it only to:

- **List folder names** in your My Drive and folders shared with you, when you choose or join a workspace folder
- **Create, read, update and rename** the `.md` files, subfolders and images inside your workspace folders
- **Move to the Drive trash** the files of pages you delete in HexNote
- **Read the revision history** of workspace files, to show and restore earlier versions
- **View and change who can access a workspace folder**, when you use Share (adding or removing a collaborator)
- **Read your email address**, to show which account you are signed in with

HexNote does not open, read or change the contents of files outside your workspace folders. Because it is open source, you can check this in the code (`internal/drive/client.go` holds every Drive call).

## What is stored on your PC

In your application data folder (`%APPDATA%\HexNote` on Windows, `~/Library/Application Support/HexNote` on macOS):

- `hexnote.db`: your pages (including drafts that were never published), the page tree, search index, settings and the member list of shared workspaces
- `image_cache/`: images you added to pages
- `oauth_credentials.json`: the OAuth client file you pasted, if you use your own Cloud project
- `auth_mode` and `token_scope`: which sign-in mode and permission the saved token belongs to
- `token.json`: your Google sign-in token. Signing out in HexNote deletes it.

None of this leaves your PC except what you publish to Google Drive.

## What HexNote does NOT do

- We do not collect analytics or telemetry
- We do not track usage patterns
- We do not have a server; there is no backend that receives your data
- We do not sell, share, or transfer any user data to third parties

## Revoking access

Sign out from HexNote's Settings, and revoke the app at any time from your [Google Account permissions page](https://myaccount.google.com/permissions). Revoking does not delete anything on your PC or in your Drive.

## Data deletion

To remove all HexNote data from your machine:

1. Uninstall the application
2. Delete the `HexNote` folder from your application data directory
3. Revoke access from your Google Account permissions page

Your Google Drive files are not affected by uninstalling HexNote.

## How Google user data is used and shared

The data HexNote reads from Google Drive is used only to provide the features you see in the app: showing, editing, publishing, restoring and sharing your pages. It stays on your PC and in your own Drive. HexNote does not transfer it to the HexNote authors or to any third party, does not use it for advertising, and does not use it to develop, improve or train AI or machine-learning models. The only sharing that happens is sharing you perform yourself, when you use Share to give someone access to a workspace folder.

HexNote's use and transfer of information received from Google APIs to any other app will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Contact

If you have questions about this privacy policy, please open an issue on the [HexNote GitHub repository](https://github.com/Demoneyejin/HexNote/issues).
