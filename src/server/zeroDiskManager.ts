import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_MEDIA_DIR = path.resolve(__dirname, '..', '..', 'public', 'videos');
if (!fs.existsSync(TEMP_MEDIA_DIR)) {
  fs.mkdirSync(TEMP_MEDIA_DIR, { recursive: true });
}

export interface ZeroDiskLease {
  filePath: string;
  publicUrl: string;
  filename: string;
  cleanup: () => void;
}

/**
 * Download a file from Bale bot on-the-fly and return a temporary lease
 * Once publishing is complete, calling cleanup() immediately removes the file from disk.
 */
export async function leaseMediaFromBale(
  botToken: string,
  fileId: string,
  targetFilename: string,
  publicBaseUrl: string
): Promise<ZeroDiskLease> {
  const getFileUrl = `https://tapi.bale.ai/bot${botToken}/getFile?file_id=${fileId}`;
  const res = await fetch(getFileUrl);
  const data = await res.json();

  if (!data.ok || !data.result?.file_path) {
    throw new Error(`دریافت مسیر فایل از سرور بله ناموفق بود: ${data.description || 'نامشخص'}`);
  }

  const filePathOnBale = data.result.file_path;
  const fileDownloadUrl = `https://tapi.bale.ai/file/bot${botToken}/${filePathOnBale}`;

  const destination = path.join(TEMP_MEDIA_DIR, targetFilename);
  const fileRes = await fetch(fileDownloadUrl);
  if (!fileRes.ok) {
    throw new Error(`خطا در دانلود محتوای فایل از بله (کد وضعیت: ${fileRes.status})`);
  }

  const buffer = await fileRes.arrayBuffer();
  fs.writeFileSync(destination, Buffer.from(buffer));

  const cleanBase = publicBaseUrl.replace(/\/$/, '');
  const publicUrl = `${cleanBase}/videos/${targetFilename}`;

  // Retain media file for 2.5 hours so Instagram / Meta / YouTube / Make have plenty of time to download
  let isCleaned = false;
  const cleanup = (immediate = false) => {
    if (isCleaned) return;
    const delayMs = immediate ? 0 : 2.5 * 60 * 60 * 1000; // 2.5 hours (150 minutes) retention
    setTimeout(() => {
      try {
        if (fs.existsSync(destination)) {
          fs.unlinkSync(destination);
          console.log(`[MediaRetention] Cleaned up media file after 2.5 hours: ${targetFilename}`);
        }
      } catch (e) {
        console.warn(`[MediaRetention] Could not delete temp file ${targetFilename}:`, e);
      }
      isCleaned = true;
    }, delayMs);
  };

  // Safety fallback: auto cleanup after 2.5 hours
  cleanup(false);

  return {
    filePath: destination,
    publicUrl,
    filename: targetFilename,
    cleanup,
  };
}

/**
 * Sweep any orphaned media files older than 2.5 hours (150 minutes) in temp directory
 */
export function sweepOldTempFiles(maxAgeMinutes = 150) {
  try {
    if (!fs.existsSync(TEMP_MEDIA_DIR)) return;
    const now = Date.now();
    const files = fs.readdirSync(TEMP_MEDIA_DIR);
    for (const f of files) {
      if (f === '.gitkeep') continue;
      const fullPath = path.join(TEMP_MEDIA_DIR, f);
      try {
        const stat = fs.statSync(fullPath);
        const ageMs = now - stat.mtimeMs;
        if (ageMs > maxAgeMinutes * 60 * 1000) {
          fs.unlinkSync(fullPath);
          console.log(`[Zero-Disk] Swept aged file: ${f}`);
        }
      } catch (err) {}
    }
  } catch (err) {
    console.error('[Zero-Disk] Sweep error:', err);
  }
}
