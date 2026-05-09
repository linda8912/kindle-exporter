import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
} from "obsidian";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";
import * as nodemailer from "nodemailer";

const execAsync = promisify(exec);

// ─── Settings ────────────────────────────────────────────────────────────────

interface KindleExporterSettings {
  kindleEmail: string;
  senderEmail: string;
  appPassword: string;
  pandocPath: string;
}

const DEFAULT_SETTINGS: KindleExporterSettings = {
  kindleEmail: "",
  senderEmail: "",
  appPassword: "",
  pandocPath: "pandoc",
};

// ─── Main Plugin ─────────────────────────────────────────────────────────────

export default class KindleExporterPlugin extends Plugin {
  settings: KindleExporterSettings;

  async onload() {
    await this.loadSettings();

    // Ribbon button (book icon in the left sidebar)
    this.addRibbonIcon("book-open", "Send to Kindle", async () => {
      await this.exportToKindle("send");
    });

    // Command palette entry (Ctrl/Cmd + P → "Send to Kindle")
    this.addCommand({
      id: "send-to-kindle",
      name: "Send current note to Kindle",
      callback: async () => {
        await this.exportToKindle("send");
      },
    });

    // Debug command: save the EPUB to the vault root without sending
    this.addCommand({
      id: "save-epub-to-vault",
      name: "Save EPUB to vault root (debug)",
      callback: async () => {
        await this.exportToKindle("save");
      },
    });

    // Settings tab in Obsidian → Settings → Kindle Exporter
    this.addSettingTab(new KindleExporterSettingTab(this.app, this));
  }

  // ─── Core Logic ────────────────────────────────────────────────────────────

  async exportToKindle(mode: "send" | "save" = "send") {
    const activeFile = this.app.workspace.getActiveFile();

    // Guard: must have an open file
    if (!activeFile) {
      new Notice("❌ No file is open. Open a note first.");
      return;
    }

    // Guard: must be a markdown file
    if (activeFile.extension !== "md") {
      new Notice("❌ This only works on Markdown (.md) files.");
      return;
    }

    // Guard: settings must be filled in (only required for "send" mode)
    if (
      mode === "send" &&
      (!this.settings.kindleEmail ||
        !this.settings.senderEmail ||
        !this.settings.appPassword)
    ) {
      new Notice(
        "❌ Please fill in your email settings:\nSettings → Kindle Exporter"
      );
      return;
    }

    new Notice("📖 Converting to EPUB…");

    // Track temp paths so we can guarantee cleanup in `finally`
    let workDir: string | null = null;
    let outputPath: string | null = null;

    try {
      // Resolve full file paths
      const vaultPath = (this.app.vault.adapter as any).getBasePath();

      const exportsDir = path.join(
        vaultPath,
        ".obsidian",
        "plugins",
        "kindle-exporter",
        "exports"
      );
      if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir, { recursive: true });
      }

      // Per-export work directory holds the temp .md + downloaded remote images.
      // We rm -rf this whole folder in `finally` for clean cleanup.
      workDir = path.join(exportsDir, `_work_${Date.now()}`);
      fs.mkdirSync(workDir, { recursive: true });

      // Step 1a: Read & preprocess the markdown
      //   - resolve  ![[image.png]]  → absolute paths
      //   - resolve  ![alt](relative.png)  → absolute paths
      //   - download ![alt](https://...)  → local copies in workDir
      const rawContent = await this.app.vault.read(activeFile);
      const processedContent = await this.preprocessImages(
        rawContent,
        activeFile.path,
        vaultPath,
        workDir
      );

      // Write preprocessed content to a temp .md file inside workDir
      const tempMdPath = path.join(workDir, "_temp_" + activeFile.name);
      fs.writeFileSync(tempMdPath, processedContent, "utf8");

      const epubName = activeFile.basename + ".epub";
      // In "save" mode, output the EPUB next to the source note in the vault
      // so the user can find it easily. In "send" mode, use the temp exports
      // folder so we can clean up afterwards.
      outputPath =
        mode === "save"
          ? path.join(vaultPath, epubName)
          : path.join(exportsDir, epubName);

      // Step 1b: Run pandoc on the preprocessed file
      const pandocCmd = [
        `"${this.settings.pandocPath}"`,
        `"${tempMdPath}"`,
        `-o "${outputPath}"`,
        `--metadata title="${activeFile.basename}"`,
        `--resource-path="${vaultPath}"`,
      ].join(" ");

      await execAsync(pandocCmd);

      if (mode === "save") {
        new Notice(`💾 Saved: ${epubName} (vault root)`);
        // Don't delete the EPUB in finally
        outputPath = null;
        return;
      }

      new Notice("📧 Sending to Kindle…");

      // Step 2: Send email with EPUB attachment
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: this.settings.senderEmail,
          pass: this.settings.appPassword,
        },
      });

      await transporter.sendMail({
        from: this.settings.senderEmail,
        to: this.settings.kindleEmail,
        subject: activeFile.basename,           // Amazon uses subject as the book title
        text: `Sent from Obsidian — ${activeFile.basename}`,
        attachments: [
          {
            filename: epubName,
            path: outputPath,
          },
        ],
      });

      new Notice(`✅ "${activeFile.basename}" sent to your Kindle!`);
    } catch (err: any) {
      console.error("[Kindle Exporter]", err);
      new Notice(`❌ Failed: ${err.message ?? err}`);
    } finally {
      // Guaranteed cleanup — runs even if pandoc/email throws
      try {
        if (workDir && fs.existsSync(workDir)) {
          fs.rmSync(workDir, { recursive: true, force: true });
        }
      } catch (e) {
        console.warn("[Kindle Exporter] workDir cleanup failed:", e);
      }
      try {
        if (outputPath && fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
      } catch (e) {
        console.warn("[Kindle Exporter] epub cleanup failed:", e);
      }
    }
  }

  // ─── Image preprocessing ───────────────────────────────────────────────────
  // Make every image in the markdown a local absolute file path so pandoc
  // can embed it into the EPUB:
  //   1. ![[image.png]]            → resolve via Obsidian metadata cache
  //   2. ![alt](relative/pic.png)  → resolve via Obsidian metadata cache
  //   3. ![alt](https://...)       → download to workDir, point to local copy
  async preprocessImages(
    content: string,
    sourcePath: string,
    vaultPath: string,
    workDir: string
  ): Promise<string> {
    const toAbsPath = (filePath: string): string =>
      path.join(vaultPath, filePath).replace(/\\/g, "/");

    // 1) Wikilink embeds:  ![[image.png]]  or  ![[image.png|alt text]]
    content = content.replace(/!\[\[([^\]]+)\]\]/g, (match, link: string) => {
      const [linkpath, alias] = link.split("|").map((s) => s.trim());
      const file = this.app.metadataCache.getFirstLinkpathDest(
        linkpath,
        sourcePath
      );
      if (!file) return match;
      const altText = alias || file.basename;
      return `![${altText}](${toAbsPath(file.path)})`;
    });

    // 2 + 3) Standard markdown images: ![alt](link)
    // We need async work for remote downloads, so collect matches first then process sequentially.
    const matches = [
      ...content.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
    ];

    let downloadCount = 0;
    let failedDownloads = 0;

    for (const m of matches) {
      const [fullMatch, alt, link] = m;

      // Already absolute file path → leave alone
      if (path.isAbsolute(link)) continue;
      // Data URIs → leave alone (already inline)
      if (/^data:/i.test(link)) continue;

      // Remote URL → download
      if (/^https?:\/\//i.test(link)) {
        try {
          const response = await requestUrl({ url: link, throw: true });
          let buffer = Buffer.from(response.arrayBuffer);
          // Detect format from actual bytes — many CDNs (e.g. Medium's Miro)
          // serve WebP under URLs that end in .png/.jpg.
          let ext = this.detectImageExt(
            buffer,
            response.headers?.["content-type"] ?? "",
            link
          );

          // Kindle support is spotty for WebP and AVIF — convert to PNG.
          if (ext === ".webp" || ext === ".avif") {
            try {
              buffer = await this.convertToPng(buffer, ext);
              ext = ".png";
            } catch (convErr) {
              console.warn(
                "[Kindle Exporter] format conversion failed, keeping original:",
                link,
                convErr
              );
            }
          }

          const filename = `remote_${downloadCount++}${ext}`;
          const localPath = path.join(workDir, filename);
          fs.writeFileSync(localPath, buffer);
          const replacement = `![${alt}](${localPath.replace(/\\/g, "/")})`;
          content = content.replace(fullMatch, replacement);
        } catch (e) {
          failedDownloads++;
          console.warn("[Kindle Exporter] failed to download image:", link, e);
        }
        continue;
      }

      // Relative vault path → resolve via metadata cache
      const decoded = decodeURIComponent(link);
      const file = this.app.metadataCache.getFirstLinkpathDest(
        decoded,
        sourcePath
      );
      if (file) {
        const replacement = `![${alt}](${toAbsPath(file.path)})`;
        content = content.replace(fullMatch, replacement);
      }
    }

    if (downloadCount > 0) {
      new Notice(
        `🌐 Downloaded ${downloadCount} remote image${downloadCount === 1 ? "" : "s"}` +
          (failedDownloads ? ` (${failedDownloads} failed)` : "")
      );
    }

    return content;
  }

  // Convert a WebP/AVIF/etc. image buffer to PNG using Electron's built-in
  // Canvas API. Obsidian runs in Chromium so Image + canvas decode every
  // format the browser supports — no native dependencies needed.
  async convertToPng(buffer: Buffer, sourceExt: string): Promise<Buffer> {
    const mime =
      sourceExt === ".webp"
        ? "image/webp"
        : sourceExt === ".avif"
          ? "image/avif"
          : "application/octet-stream";

    const blob = new Blob([buffer], { type: mime });
    const url = URL.createObjectURL(blob);

    try {
      // Decode via <img>
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Image decode failed"));
        img.src = url;
      });

      // Draw onto an offscreen canvas
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2d context unavailable");
      // Fill white first so any alpha channel from the source (e.g. WebP w/ transparency)
      // is flattened against white. Amazon's Send-to-Kindle KFX converter has been known
      // to silently drop RGBA PNGs — this gives us flat RGB output instead.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      // Re-encode as PNG
      const pngBlob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/png");
      });
      if (!pngBlob) throw new Error("toBlob returned null");

      const arrayBuffer = await pngBlob.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Detect image extension by inspecting magic bytes first (most reliable),
  // then falling back to HTTP Content-Type, then the URL.
  detectImageExt(buffer: Buffer, contentType: string, url: string): string {
    // 1) Magic bytes — definitive
    if (buffer.length >= 12) {
      // PNG: 89 50 4E 47 0D 0A 1A 0A
      if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
      )
        return ".png";
      // JPEG: FF D8 FF
      if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
        return ".jpg";
      // GIF: "GIF87a" or "GIF89a"
      if (
        buffer[0] === 0x47 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46
      )
        return ".gif";
      // WebP: "RIFF" .... "WEBP"
      if (
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP"
      )
        return ".webp";
      // BMP: "BM"
      if (buffer[0] === 0x42 && buffer[1] === 0x4d) return ".bmp";
      // AVIF: contains "ftypavif" near start
      if (buffer.length >= 32 && buffer.toString("ascii", 4, 12) === "ftypavif")
        return ".avif";
    }

    // 2) HTTP Content-Type
    const ct = contentType.toLowerCase();
    if (ct.includes("png")) return ".png";
    if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
    if (ct.includes("webp")) return ".webp";
    if (ct.includes("gif")) return ".gif";
    if (ct.includes("svg")) return ".svg";
    if (ct.includes("avif")) return ".avif";
    if (ct.includes("bmp")) return ".bmp";

    // 3) URL extension
    const urlMatch = url.match(/\.(png|jpe?g|gif|webp|svg|bmp|avif)(?:[?#]|$)/i);
    if (urlMatch) return "." + urlMatch[1].toLowerCase().replace("jpeg", "jpg");

    return ".png"; // last-ditch fallback
  }

  // ─── Settings persistence ──────────────────────────────────────────────────

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ─── Settings UI ─────────────────────────────────────────────────────────────

class KindleExporterSettingTab extends PluginSettingTab {
  plugin: KindleExporterPlugin;

  constructor(app: App, plugin: KindleExporterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "📚 Kindle Exporter" });

    // ── Kindle email ───────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Kindle email address")
      .setDesc(
        "Your @kindle.com address. Find it: Amazon → Account → Manage Your Content and Devices → Preferences → Personal Document Settings."
      )
      .addText((text) =>
        text
          .setPlaceholder("yourname@kindle.com")
          .setValue(this.plugin.settings.kindleEmail)
          .onChange(async (value) => {
            this.plugin.settings.kindleEmail = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── Sender Gmail ───────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Your Gmail address")
      .setDesc(
        "The Gmail you'll send FROM. Add it as an approved sender in Amazon (same page as above)."
      )
      .addText((text) =>
        text
          .setPlaceholder("you@gmail.com")
          .setValue(this.plugin.settings.senderEmail)
          .onChange(async (value) => {
            this.plugin.settings.senderEmail = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── App Password ───────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Gmail App Password")
      .setDesc(
        "Not your normal password! Generate one at: myaccount.google.com → Security → 2-Step Verification → App passwords."
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("xxxx xxxx xxxx xxxx")
          .setValue(this.plugin.settings.appPassword)
          .onChange(async (value) => {
            this.plugin.settings.appPassword = value.trim();
            await this.plugin.saveSettings();
          });
      });

    // ── Pandoc path ────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Pandoc path")
      .setDesc(
        'Leave as "pandoc" if it\'s installed normally. Change to full path if needed (e.g. /usr/local/bin/pandoc).'
      )
      .addText((text) =>
        text
          .setPlaceholder("pandoc")
          .setValue(this.plugin.settings.pandocPath)
          .onChange(async (value) => {
            this.plugin.settings.pandocPath = value.trim() || "pandoc";
            await this.plugin.saveSettings();
          })
      );

    // ── Help section ───────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "How to use" });
    const helpEl = containerEl.createEl("ol");
    [
      "Fill in the 3 fields above.",
      "Open any note in Obsidian.",
      'Click the 📖 book icon in the left ribbon — or use Ctrl/Cmd+P → "Send to Kindle".',
      "The note arrives on your Kindle in ~1 minute.",
    ].forEach((step) => helpEl.createEl("li", { text: step }));
  }
}
