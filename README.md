# r34-dl

A small desktop app that fetches images, videos, and metadata from rule34.xxx by search tag, using the site's official public API. No browser automation, no scraping.

![r34-dl screenshot](screenshot.png)

## Features

- Paste your API credentials once, then just type a tag and download
- Search first to see the result count and a preview before committing to a full download
- Find who posted a specific image (no artist tag needed) and jump straight to everything else they've posted
- Cancel a search or download at any time
- Native folder picker to choose where downloads go
- Downloads images and/or videos, with metadata saved to JSON
- Automatically paginates through all results for a tag
- Skips files already downloaded, even across app restarts
- Sorts everything into `<your folder>/<tag>/images`, `<your folder>/<tag>/videos`, `<your folder>/<tag>/<tag>_data.json`
- Live progress bar with an ETA, and a thumbnail preview as results come in
- Handles API rate limiting automatically
- Dark theme matching rule34.xxx's own color scheme

## For users: just run the app

Grab the latest installer from [Releases](https://github.com/AiintNoWayy/r34-dl/releases) (or ask whoever built it for the `.exe`/`.msi` file), run it, and skip to [First run](#first-run) below. No Node.js or Rust needed to just use the app.

## For developers: build from source

### Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- On Windows, [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on most Windows 10/11 systems)
- A free rule34.xxx account (needed for API access)

### Setup

```bash
git clone https://github.com/AiintNoWayy/r34-dl.git
cd r34-dl
npm install
```

Run in development mode (hot-reloads on save):
```bash
npm run tauri dev
```

Or build a standalone installer:
```bash
npm run tauri build
```
The installer lands in `src-tauri/target/release/bundle/` (`.msi` and `.exe` on Windows).

## First run

The app will ask for your API credentials the first time it opens:

1. Log in to your account at [rule34.xxx](https://rule34.xxx)
2. Go to **My Account → Options** (`https://rule34.xxx/index.php?page=account&s=options`)
3. Under **API Access Credentials**, tick **"Generate New Key?"** and save. This reveals a box with `&api_key=...&user_id=...`
   - ⚠️ Only generate a key once. Requesting multiple keys can get your account suspended.
4. Paste that whole box content into the app's setup screen as-is. It parses out both values for you.

## Usage

Type your search tags, pick what to grab (images / videos / JSON), optionally change the download folder, then either:

- Hit **Search** to see the result count and a preview first, or
- Hit **Download** to go straight to fetching everything.

Progress, ETA, and a thumbnail preview update live as items come in. Hit **Cancel** at any time to stop. Re-running the same tag later only fetches what's new.

No artist tag on an image? Paste its post link or ID into the "Find who posted it" field to look up the uploader, then use the "Use as search" button to fetch everything else they've posted (searches `user:<name>` under the hood).

## Disclaimer

rule34.xxx hosts NSFW (not safe for work) content. This tool is provided for personal, educational use. You're responsible for using it in a way that respects rule34.xxx's terms of service and applicable law.

## License

MIT. See [LICENSE](LICENSE).

## Credits

Built by [AiintNoWayy](https://github.com/AiintNoWayy).
