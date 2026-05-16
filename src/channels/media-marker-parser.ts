import { resolve, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';

export type MediaKind = 'photo' | 'document' | 'video' | 'audio';

export type MediaAttachment = {
  kind: MediaKind;
  path: string;
  /** Optional caption text on the same marker line, after `|` */
  caption?: string;
};

/**
 * Markers Claude emits to send files back through the channel.
 * Syntax (each on its own line):
 *   [[SEND_PHOTO: C:\path\to\image.png]]
 *   [[SEND_PHOTO: image.png | optional caption]]
 *   [[SEND_DOCUMENT: ./report.pdf]]
 *   [[SEND_VIDEO: D:\clip.mp4]]
 *   [[SEND_AUDIO: voice.ogg]]
 */
const MARKER_RE = /\[\[SEND_(PHOTO|DOCUMENT|VIDEO|AUDIO)\s*:\s*([^\]]+?)\]\]/gi;

const KIND_MAP: Record<string, MediaKind> = {
  PHOTO: 'photo',
  DOCUMENT: 'document',
  VIDEO: 'video',
  AUDIO: 'audio',
};

/**
 * Extracts media markers from Claude's response.
 * Returns the cleaned text (markers removed) plus the attachments to send.
 * Paths are resolved against `baseDir` if relative.
 */
export function extractMediaMarkers(
  text: string,
  baseDir: string,
): { cleanedText: string; attachments: MediaAttachment[] } {
  const attachments: MediaAttachment[] = [];

  const cleanedText = text.replace(MARKER_RE, (_match, kindRaw: string, payload: string) => {
    const kind = KIND_MAP[kindRaw.toUpperCase()];
    if (!kind) return '';

    const [rawPath, ...captionParts] = payload.split('|').map((s) => s.trim());
    const fullPath = isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);

    if (!existsSync(fullPath)) {
      // Leave a visible hint where the marker was so the user/operator knows it failed
      return `\n⚠ file not found: ${fullPath}\n`;
    }

    attachments.push({
      kind,
      path: fullPath,
      caption: captionParts.length > 0 ? captionParts.join(' | ') : undefined,
    });
    return '';
  });

  return {
    cleanedText: cleanedText.replace(/\n{3,}/g, '\n\n').trim(),
    attachments,
  };
}

/**
 * System-prompt fragment teaching Claude how to send media via markers.
 * Appended via `--append-system-prompt`.
 */
export const MEDIA_MARKER_SYSTEM_PROMPT = `
You are responding through a Telegram bot, not a plain terminal. The bot does NOT see files you write to disk unless you explicitly mark them for upload.

To send images, screenshots, files, videos, or audio BACK to the user via Telegram, output a marker on its own line in your final response:

  [[SEND_PHOTO: <absolute-or-relative-path>]]
  [[SEND_PHOTO: <path> | optional caption text]]
  [[SEND_DOCUMENT: <path>]]
  [[SEND_VIDEO: <path>]]
  [[SEND_AUDIO: <path>]]

Rules:
- Markers are STRIPPED from your reply before the user sees them — do not explain them.
- Always emit a marker when the user asked for a screenshot, image, file, etc. Just saving to disk is NOT enough; the user cannot see your filesystem.
- Use absolute paths when possible. Relative paths resolve against the working directory.
- Telegram limits: photo ≤10 MB, document ≤50 MB. For larger files, compress first.
- You may emit multiple markers (one per file).

Screenshots on Windows — use this PowerShell snippet (captures ALL monitors at true pixel resolution; PrimaryScreen.Bounds misses extended displays and DPI-unaware processes get a downscaled crop):

  Add-Type -AssemblyName System.Windows.Forms,System.Drawing
  try { Add-Type -Name DPI -Namespace W -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -ErrorAction Stop } catch {}
  [W.DPI]::SetProcessDPIAware() | Out-Null
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.Location, [System.Drawing.Point]::Empty, $vs.Size)
  $out = "<absolute-path>.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()

Then emit [[SEND_PHOTO: <out>]].

Example user request: "chụp màn hình gửi tôi"
Your response should END with a [[SEND_PHOTO: ...]] marker after taking the screenshot.
`.trim();
