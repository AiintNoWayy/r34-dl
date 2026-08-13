# r34-dl

A small local web app that fetches images, videos, and metadata from rule34.xxx by search tag, using the site's official public API. No browser automation, no scraping.

## Features

- Search by tag straight from a simple web UI (no command line prompts)
- Downloads images and/or videos, with metadata saved to JSON
- Automatically paginates through all results for a tag
- Skips duplicates on repeated runs
- Sorts everything into `downloads/<tag>/images`, `downloads/<tag>/videos`, `downloads/<tag>/<tag>_data.json`
- Handles API rate limiting automatically

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- A free rule34.xxx account (needed for API access)

## Setup

1. Clone this repository and install dependencies:
   ```bash
   cd r34-dl
   npm install
   ```

2. Get your API credentials:
   - Log in to your account at [rule34.xxx](https://rule34.xxx)
   - Go to **My Account → Options** (`https://rule34.xxx/index.php?page=account&s=options`)
   - Under **API Access Credentials**, tick **"Generate New Key?"** and save. This reveals your `user_id` and `api_key`
   - ⚠️ Only generate a key once. Requesting multiple keys can get your account suspended.

3. Copy `.env.example` to `.env` and fill in the values you just got:
   ```bash
   cp .env.example .env
   ```
   ```
   RULE34_USER_ID=your_user_id
   RULE34_API_KEY=your_api_key
   ```

## Usage

```bash
npm start
```

Then open [http://localhost:3000](http://localhost:3000), enter your search tags, pick what you want (images / videos / JSON), and click **Download**. Progress and a thumbnail preview show up live; files land in `downloads/<tag>/` in the project folder.

## Disclaimer

rule34.xxx hosts NSFW (not safe for work) content. This tool is provided for personal, educational use. You're responsible for using it in a way that respects rule34.xxx's terms of service and applicable law.

## License

MIT. See [LICENSE](LICENSE).

## Credits

Built by [AiintNoWayy](https://github.com/AiintNoWayy).
