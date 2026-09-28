import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';

const execAsync = util.promisify(exec);

export interface MediaMetadata {
  mediaType: 'video' | 'photo' | 'audio' | 'text' | 'document';
  width?: number;
  height?: number;
  aspectRatioLabel?: '9:16 (عمودی)' | '16:9 (افقی)' | '1:1 (مربعی)' | '4:5 (پرتره فید)' | 'نامتعارف';
  ratio?: number;
  durationSeconds?: number;
  fileSizeBytes: number;
  fileSizeMb: number;
  fps?: number;
  codec?: string;
}

export interface ValidationResult {
  isValid: boolean;
  severity: 'SUCCESS' | 'WARNING' | 'ERROR';
  badge: string;
  feedbackMessage: string;
  recommendedResolution: string;
  canForcePublish: boolean;
}

/**
 * Build MediaMetadata directly from width/height/duration/size without downloading! (Zero-Overhead)
 */
export function buildMetadataFromSpecs(params: {
  isImage: boolean;
  width?: number;
  height?: number;
  durationSeconds?: number;
  fileSizeBytes?: number;
}): MediaMetadata {
  const width = params.width;
  const height = params.height;
  const fileSizeBytes = params.fileSizeBytes || 0;
  const fileSizeMb = Number((fileSizeBytes / (1024 * 1024)).toFixed(2));
  let aspectRatioLabel: MediaMetadata['aspectRatioLabel'] = 'نامتعارف';
  let ratio: number | undefined = undefined;

  if (width && height && height > 0) {
    ratio = width / height;
    if (ratio >= 0.50 && ratio <= 0.62) {
      aspectRatioLabel = '9:16 (عمودی)';
    } else if (ratio >= 1.65 && ratio <= 1.90) {
      aspectRatioLabel = '16:9 (افقی)';
    } else if (ratio >= 0.95 && ratio <= 1.05) {
      aspectRatioLabel = '1:1 (مربعی)';
    } else if (ratio >= 0.75 && ratio <= 0.85) {
      aspectRatioLabel = '4:5 (پرتره فید)';
    }
  }

  return {
    mediaType: params.isImage ? 'photo' : 'video',
    width,
    height,
    aspectRatioLabel,
    ratio,
    durationSeconds: params.durationSeconds ? Math.round(params.durationSeconds) : undefined,
    fileSizeBytes,
    fileSizeMb,
  };
}

/**
 * Inspect video or image file using ffprobe (with fast JSON metadata extraction)
 */
export async function inspectMediaFile(filePath: string, isImage = false): Promise<MediaMetadata> {
  const stats = fs.statSync(filePath);
  const fileSizeBytes = stats.size;
  const fileSizeMb = Number((fileSizeBytes / (1024 * 1024)).toFixed(2));

  if (!fs.existsSync(filePath)) {
    throw new Error('فایل در مسیر مشخص شده یافت نشد.');
  }

  // Run ffprobe command to extract streams and format
  try {
    const cmd = `ffprobe -v error -select_streams ${isImage ? 'v:0' : 'v:0'} -show_entries stream=width,height,r_frame_rate,codec_name,duration -show_entries format=duration,size -of json "${filePath}"`;
    const { stdout } = await execAsync(cmd, { timeout: 10000 });
    const data = JSON.parse(stdout || '{}');
    const stream = data.streams && data.streams[0] ? data.streams[0] : null;
    const format = data.format || {};

    const width = stream?.width;
    const height = stream?.height;

    let durationSeconds: number | undefined = undefined;
    if (stream?.duration) {
      durationSeconds = parseFloat(stream.duration);
    } else if (format?.duration) {
      durationSeconds = parseFloat(format.duration);
    }

    let fps: number | undefined = undefined;
    if (stream?.r_frame_rate && stream.r_frame_rate.includes('/')) {
      const [num, den] = stream.r_frame_rate.split('/').map(Number);
      if (den > 0) fps = Math.round(num / den);
    }

    let aspectRatioLabel: MediaMetadata['aspectRatioLabel'] = 'نامتعارف';
    let ratio: number | undefined = undefined;

    if (width && height && height > 0) {
      ratio = width / height;

      // 9:16 is ~0.5625 (tolerance 0.50 to 0.62)
      if (ratio >= 0.50 && ratio <= 0.62) {
        aspectRatioLabel = '9:16 (عمودی)';
      }
      // 16:9 is ~1.777 (tolerance 1.65 to 1.90)
      else if (ratio >= 1.65 && ratio <= 1.90) {
        aspectRatioLabel = '16:9 (افقی)';
      }
      // 1:1 is 1.0 (tolerance 0.95 to 1.05)
      else if (ratio >= 0.95 && ratio <= 1.05) {
        aspectRatioLabel = '1:1 (مربعی)';
      }
      // 4:5 is 0.8 (tolerance 0.75 to 0.85)
      else if (ratio >= 0.75 && ratio <= 0.85) {
        aspectRatioLabel = '4:5 (پرتره فید)';
      }
    }

    return {
      mediaType: isImage ? 'photo' : 'video',
      width,
      height,
      aspectRatioLabel,
      ratio,
      durationSeconds: durationSeconds ? Math.round(durationSeconds) : undefined,
      fileSizeBytes,
      fileSizeMb,
      fps,
      codec: stream?.codec_name,
    };
  } catch (err: any) {
    // Basic fallback if ffprobe fails
    return {
      mediaType: isImage ? 'photo' : 'video',
      fileSizeBytes,
      fileSizeMb,
      aspectRatioLabel: 'نامتعارف',
    };
  }
}

/**
 * Validate media specs against target platform and format
 */
export function validateMediaForTarget(
  meta: MediaMetadata,
  platform: string,
  format: string
): ValidationResult {
  const normPlatform = (platform || '').toLowerCase();
  const normFormat = (format || '').toLowerCase();

  // 1. Instagram Reels & YouTube Shorts & TikTok
  if (normFormat === 'reels' || normFormat === 'shorts' || (normPlatform === 'tiktok' && normFormat === 'video')) {
    if (!meta.width || !meta.height) {
      return {
        isValid: true,
        severity: 'SUCCESS',
        badge: '✅ اطلاعات تایید شد',
        feedbackMessage: 'فایل آماده ارسال است.',
        recommendedResolution: '1080x1920 (9:16)',
        canForcePublish: true,
      };
    }

    const isVertical = meta.aspectRatioLabel === '9:16 (عمودی)';
    const isHorizontal = meta.aspectRatioLabel === '16:9 (افقی)';
    const isOver60s = (meta.durationSeconds || 0) > 60;
    const isOver90s = (meta.durationSeconds || 0) > 90;

    if (normFormat === 'shorts' && isOver60s) {
      return {
        isValid: false,
        severity: 'WARNING',
        badge: '⚠️ مدت زمان بیش از ۶۰ ثانیه',
        feedbackMessage: `یوتیوب ویدیوهای بالاتر از ۶۰ ثانیه (${meta.durationSeconds} ثانیه) را به عنوان Shorts قبول نمی‌کند و به عنوان ویدیوی معمولی منتشر خواهد کرد.`,
        recommendedResolution: '1080x1920 عمودی و زیر ۶۰ ثانیه',
        canForcePublish: true,
      };
    }

    if (normFormat === 'reels' && isOver90s) {
      return {
        isValid: false,
        severity: 'WARNING',
        badge: '⚠️ مدت زمان ریلز بیش از ۹۰ ثانیه',
        feedbackMessage: `ریلز اینستاگرام معمولاً تا ۹۰ ثانیه استاندارد است. ویدیوی شما ${meta.durationSeconds} ثانیه است.`,
        recommendedResolution: '1080x1920 عمودی و زیر ۹۰ ثانیه',
        canForcePublish: true,
      };
    }

    if (isHorizontal) {
      return {
        isValid: false,
        severity: 'WARNING',
        badge: '⚠️ نسبت تصویر افقی است',
        feedbackMessage: `این ویدیو افقی (16:9 با رزولوشن ${meta.width}x${meta.height}) است! در ریلز یا شورتز، کناره‌های تصویر سیاه شده و دید مخاطب کم می‌شود. استاندارد مناسب ۹:۱۶ عمودی است.`,
        recommendedResolution: '1080x1920 (9:16 عمودی)',
        canForcePublish: true,
      };
    }

    if (!isVertical) {
      return {
        isValid: false,
        severity: 'WARNING',
        badge: '⚠️ نسبت تصویر غیراستاندارد',
        feedbackMessage: `نسبت تصویر این ویدیو ${meta.aspectRatioLabel} (${meta.width}x${meta.height}) است. برای بهترین کیفیت ریلز، نسبت 9:16 عمودی توصیه می‌شود.`,
        recommendedResolution: '1080x1920 (9:16 عمودی)',
        canForcePublish: true,
      };
    }

    return {
      isValid: true,
      severity: 'SUCCESS',
      badge: '✅ ابعاد و مشخصات کاملاً استاندارد',
      feedbackMessage: `رزولوشن ${meta.width}x${meta.height} (9:16 عمودی) و مدت ${meta.durationSeconds || '--'} ثانیه کاملاً مطابق با الگوریتم‌های ریلز و شورتز است.`,
      recommendedResolution: '1080x1920 (9:16 عمودی)',
      canForcePublish: true,
    };
  }

  // 2. YouTube regular video & Aparat video
  if ((normPlatform === 'youtube' && normFormat === 'video') || normPlatform === 'aparat') {
    const isVertical = meta.aspectRatioLabel === '9:16 (عمودی)';
    const isHorizontal = meta.aspectRatioLabel === '16:9 (افقی)';

    if (isVertical) {
      return {
        isValid: false,
        severity: 'WARNING',
        badge: '⚠️ ویدیو عمودی در پلتفرم افقی',
        feedbackMessage: `شما در حال ارسال یک ویدیوی عمودی (9:16) به عنوان ویدیوی بلند یوتیوب/آپارات هستید. این پلتفرم‌ها برای ویدیوهای استاندارد نیاز به نسبت 16:9 افقی دارند.`,
        recommendedResolution: '1920x1080 (16:9 افقی)',
        canForcePublish: true,
      };
    }

    if (isHorizontal) {
      return {
        isValid: true,
        severity: 'SUCCESS',
        badge: '✅ ابعاد کاملاً استاندارد یوتیوب/آپارات',
        feedbackMessage: `رزولوشن ${meta.width}x${meta.height} (16:9 افقی) کیفیت مطلوبی برای انتشار در این پلتفرم دارد.`,
        recommendedResolution: '1920x1080 (16:9 افقی)',
        canForcePublish: true,
      };
    }
  }

  // 3. Instagram Story
  if (normFormat === 'story') {
    if (meta.aspectRatioLabel === '16:9 (افقی)') {
      return {
        isValid: false,
        severity: 'WARNING',
        badge: '⚠️ استوری افقی',
        feedbackMessage: 'استوری به صورت تمام‌صفحه عمودی نمایش داده می‌شود. ویدیوی افقی دارای حاشیه زیاد خواهد بود.',
        recommendedResolution: '1080x1920 (9:16 عمودی)',
        canForcePublish: true,
      };
    }
  }

  // 4. Telegram Round Video
  if (normFormat === 'round_video') {
    if (meta.aspectRatioLabel !== '1:1 (مربعی)') {
      return {
        isValid: false,
        severity: 'WARNING',
        badge: '⚠️ ویدیو مسیج دایره‌ای باید مربعی باشد',
        feedbackMessage: 'ویدیو مسیج‌های تلگرام (ویدیو نوت) به نسبت 1:1 مربعی نیاز دارند.',
        recommendedResolution: '640x640 (1:1 مربعی)',
        canForcePublish: true,
      };
    }
    if ((meta.durationSeconds || 0) > 60) {
      return {
        isValid: false,
        severity: 'ERROR',
        badge: '❌ فراتر از ۶۰ ثانیه تلگرام',
        feedbackMessage: 'تلگرام اجازه ارسال ویدیو مسیج دایره‌ای بیش از ۶۰ ثانیه را نمی‌دهد.',
        recommendedResolution: 'زیر ۶۰ ثانیه',
        canForcePublish: false,
      };
    }
  }

  // Default: OK
  return {
    isValid: true,
    severity: 'SUCCESS',
    badge: '✅ سازگار',
    feedbackMessage: `فایل با نسبت ${meta.aspectRatioLabel || 'معمولی'} آماده پردازش است.`,
    recommendedResolution: 'استاندارد',
    canForcePublish: true,
  };
}
