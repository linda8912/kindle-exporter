# Kindle Exporter for Obsidian

> One-click: send the current note to your Kindle as a properly-rendered EPUB.

Convert any Obsidian note → EPUB → email it directly to your Kindle in one click. Handles Obsidian wikilink embeds, downloads remote images (Medium clippings etc.), and converts WebP/AVIF to Kindle-friendly PNG automatically.

## Features

- 📖 **One-click pipeline** — ribbon button or command palette → note arrives on your Kindle in ~1 minute
- 🌐 **Auto-downloads remote images** — Medium articles, web clippings, anything with `![](https://...)`
- 🖼️ **Resolves Obsidian wikilink embeds** — `![[image.png]]` works regardless of where attachments live in your vault
- 🔍 **Magic-byte format detection** — handles CDNs that lie about file extensions (e.g. Medium serving WebP under `.png` URLs)
- 🎨 **WebP/AVIF → PNG conversion** — uses Electron's built-in Canvas, no native dependencies
- 🛡️ **Alpha-channel flattening** — works around Amazon's KFX converter silently dropping RGBA PNGs
- 🧹 **Auto-cleanup** — temp files always removed, even on failure
- 🛠️ **Debug mode** — save EPUB locally to inspect before sending

## Requirements

1. **[Pandoc](https://pandoc.org/installing.html)** installed and in your PATH
2. **Gmail account with [App Password](https://myaccount.google.com/apppasswords)** (requires 2-Step Verification enabled)
3. **Amazon Send-to-Kindle approved sender** — your Gmail address added to your [Amazon Personal Document Settings](https://www.amazon.com/hz/mycd/myx#/home/settings/payment)

> **Note:** This plugin is desktop-only. It uses Node.js APIs not available on mobile.

## Installation

### Manual install

1. Download `main.js` and `manifest.json` from the [latest release](../../releases/latest)
2. Create folder `<your-vault>/.obsidian/plugins/kindle-exporter/` and put both files inside
3. In Obsidian: **Settings → Community Plugins → Reload** → enable "Kindle Exporter"

### Via [BRAT](https://github.com/TfTHacker/obsidian42-brat) (beta plugin manager)

1. Install BRAT from Community Plugins
2. BRAT settings → Add Beta Plugin → paste this repo's URL

## Setup

After enabling the plugin, go to **Settings → Kindle Exporter** and fill in:

| Field | Where to find it |
|-------|------------------|
| **Kindle email** | [Amazon → Manage Your Content and Devices → Preferences → Personal Document Settings](https://www.amazon.com/hz/mycd/myx#/home/settings/payment) — looks like `yourname_xxxxx@kindle.com` |
| **Your Gmail address** | The Gmail you'll send FROM |
| **Gmail App Password** | Generate at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) (2-Step Verification must be enabled first) |
| **Pandoc path** | Leave as `pandoc` if it's in your PATH; otherwise full path like `C:\Program Files\Pandoc\pandoc.exe` |

**One more step in Amazon:** On the same Personal Document Settings page, under "Approved Personal Document E-mail List", **add your Gmail address**. Otherwise Amazon will reject the email.

## Usage

| Action | How |
|--------|-----|
| **Send current note to Kindle** | Click the 📖 book icon in the left ribbon — or `Ctrl+P` → "Send current note to Kindle" |
| **Save EPUB locally (debug)** | `Ctrl+P` → "Save EPUB to vault root (debug)" — useful for inspecting the output without emailing |

## How it works

```
Note (.md)
    ↓
Read raw markdown
    ↓
Preprocess images:
   - ![[image.png]]            → resolve via Obsidian metadata cache
   - ![alt](relative.png)      → resolve via Obsidian metadata cache
   - ![alt](https://...)       → download → detect format → convert WebP/AVIF→PNG
    ↓
Write preprocessed .md to a temp work directory
    ↓
Run pandoc with --resource-path=<vault>
    ↓
Email EPUB via Gmail SMTP (nodemailer)
    ↓
finally: rm -rf workDir + delete EPUB (always)
```

## Troubleshooting

### "pandoc is not recognized" / "command not found"

Pandoc isn't in your PATH. Either:
- Restart Obsidian after installing pandoc (PATH updates), OR
- Set the full pandoc path in plugin settings (e.g. `C:\Program Files\Pandoc\pandoc.exe` on Windows)

### "Invalid login: Username and Password not accepted"

You're using your normal Gmail password. You need an **App Password**:
1. Enable [2-Step Verification](https://myaccount.google.com/security)
2. Generate at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Paste the 16-character code into the plugin settings

### Email sends but doesn't arrive on Kindle

Check that your sender Gmail is in Amazon's **Approved Personal Document E-mail List**. Otherwise Amazon silently drops the email.

### Images not showing on Kindle

The plugin handles the most common causes (WebP, missing files, alpha channels). If you still see missing images:
- Use the **"Save EPUB to vault root (debug)"** command and inspect the EPUB in [Calibre](https://calibre-ebook.com)
- If images are present in Calibre but not Kindle → likely an Amazon KFX conversion issue
- Try sideloading the EPUB via USB to bypass Amazon's converter

## Development

```bash
git clone https://github.com/<your-username>/kindle-exporter
cd kindle-exporter
npm install
npm run dev    # watch mode (rebuilds on save)
# OR
npm run build  # one-off production build
```

The build outputs `main.js`. Copy `main.js` and `manifest.json` to your vault's `.obsidian/plugins/kindle-exporter/` folder, then reload Obsidian (`Ctrl+P` → "Reload app without saving") to test.

> **Tip for Google Drive / Dropbox / OneDrive vaults:** Don't `npm install` directly inside the synced vault — file-locking conflicts will fail the install. Develop in a non-synced folder and copy `main.js` over.

## Lessons learned (a.k.a. why this plugin exists)

A few non-obvious things this plugin works around:

- **Medium's Miro CDN serves WebP under `.png` URLs.** The URL extension is unreliable; always inspect the actual bytes.
- **Kindle silently drops WebP** even on firmware 5.19+. Despite Amazon claiming WebP support, the KFX converter strips them.
- **Amazon's KFX converter also drops RGBA PNGs** with alpha channels. Flatten alpha to a white background to keep them.
- **Pandoc's default behavior fetches remote images for EPUB**, but lacks WebP→PNG conversion and inherits all the issues above. Doing the work in the plugin gives full control.

## License

MIT — see [LICENSE](LICENSE)
