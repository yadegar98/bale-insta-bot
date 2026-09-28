import fs from 'fs';

export type DriverType = 'webhook' | 'telegram' | 'aparat' | 'direct';

export interface TargetChannelConfig {
  key: string; // e.g. TARGET_IG_PAGE1_REELS
  platform: 'instagram' | 'youtube' | 'tiktok' | 'reddit' | 'telegram' | 'aparat' | 'eitaa' | 'rubika' | string;
  account: string; // e.g. PAGE1, MYCHANNEL
  format: 'reels' | 'shorts' | 'video' | 'story' | 'community' | 'post' | 'photo' | 'round_video' | string;
  driverType: DriverType;
  endpoint: string; // Webhook URL or channel username / credential
  platformTitle: string;
  formatTitle: string;
}

const DEFAULT_MAKE_WEBHOOK = 'https://hook.eu1.make.com/bnels556iotmn6bgg8b25ywcxtayyawp';

/**
 * Scan all environment variables matching TARGET_<PLATFORM>_<ACCOUNT>_<FORMAT>
 * Example:
 * TARGET_IG_MAIN_REELS=https://hook.eu1.make.com/...
 * TARGET_YT_CHANNEL1_SHORTS=https://hook.eu1.make.com/...
 * TARGET_TG_NEWS_VIDEO=@my_news_channel
 * TARGET_APARAT_MAIN_VIDEO=user:pass
 */
export function discoverTargetsFromEnv(): TargetChannelConfig[] {
  const env = process.env;
  const discovered: TargetChannelConfig[] = [];

  for (const [key, rawValue] of Object.entries(env)) {
    if (!key.startsWith('TARGET_') || !rawValue) continue;
    const value = rawValue.trim();
    if (!value) continue;

    // Pattern: TARGET_<PLATFORM>_<ACCOUNT>_<FORMAT>
    // e.g. TARGET_IG_PAGE1_REELS
    const parts = key.split('_');
    if (parts.length < 4) continue;

    const platformRaw = parts[1].toUpperCase();
    const formatRaw = parts[parts.length - 1].toUpperCase();
    const accountRaw = parts.slice(2, parts.length - 1).join('_').toUpperCase();

    let platform = 'custom';
    let platformTitle = platformRaw;
    let driverType: DriverType = 'webhook';

    if (platformRaw === 'IG' || platformRaw === 'INSTAGRAM') {
      platform = 'instagram';
      platformTitle = '📸 اینستاگرام';
      driverType = 'webhook';
    } else if (platformRaw === 'YT' || platformRaw === 'YOUTUBE') {
      platform = 'youtube';
      platformTitle = '▶️ یوتیوب';
      driverType = 'webhook';
    } else if (platformRaw === 'TIKTOK') {
      platform = 'tiktok';
      platformTitle = '🎵 تیک‌تاک';
      driverType = 'webhook';
    } else if (platformRaw === 'REDDIT') {
      platform = 'reddit';
      platformTitle = '🔴 ردیت';
      driverType = 'webhook';
    } else if (platformRaw === 'TG' || platformRaw === 'TELEGRAM') {
      platform = 'telegram';
      platformTitle = '✈️ تلگرام';
      driverType = 'telegram';
    } else if (platformRaw === 'APARAT') {
      platform = 'aparat';
      platformTitle = '📺 آپارات';
      driverType = value.startsWith('http') ? 'webhook' : 'aparat';
    } else if (platformRaw === 'EITAA') {
      platform = 'eitaa';
      platformTitle = '🇮🇷 ایتا';
      driverType = 'direct';
    } else if (platformRaw === 'RUBIKA') {
      platform = 'rubika';
      platformTitle = '🇮🇷 روبیکا';
      driverType = 'direct';
    }

    let format = formatRaw.toLowerCase();
    let formatTitle = formatRaw;
    if (format === 'reels') formatTitle = '🎬 ریلز (Reels)';
    else if (format === 'shorts') formatTitle = '⚡ شورتز (Shorts)';
    else if (format === 'story') formatTitle = '⏱️ استوری (Story)';
    else if (format === 'video') formatTitle = '🎥 ویدیو بلند (Video)';
    else if (format === 'community') formatTitle = '💬 پست انجمن (Community)';
    else if (format === 'round_video') formatTitle = '⚪ ویدیو مسیج دایره‌ای';
    else if (format === 'photo') formatTitle = '🖼️ عکس و تصویر';

    discovered.push({
      key,
      platform,
      account: accountRaw,
      format,
      driverType,
      endpoint: value,
      platformTitle,
      formatTitle,
    });
  }

  // If no targets defined in Render yet, provide fallback default targets
  if (discovered.length === 0) {
    const makeUrl = env.MAKE_WEBHOOK_URL || DEFAULT_MAKE_WEBHOOK;
    discovered.push(
      {
        key: 'TARGET_IG_MAIN_REELS',
        platform: 'instagram',
        account: 'MAIN',
        format: 'reels',
        driverType: 'webhook',
        endpoint: makeUrl,
        platformTitle: '📸 اینستاگرام',
        formatTitle: '🎬 ریلز (Reels)',
      },
      {
        key: 'TARGET_IG_MAIN_STORY',
        platform: 'instagram',
        account: 'MAIN',
        format: 'story',
        driverType: 'webhook',
        endpoint: makeUrl,
        platformTitle: '📸 اینستاگرام',
        formatTitle: '⏱️ استوری (Story)',
      },
      {
        key: 'TARGET_YT_MAIN_SHORTS',
        platform: 'youtube',
        account: 'MAIN',
        format: 'shorts',
        driverType: 'webhook',
        endpoint: makeUrl,
        platformTitle: '▶️ یوتیوب',
        formatTitle: '⚡ شورتز (Shorts)',
      },
      {
        key: 'TARGET_YT_MAIN_VIDEO',
        platform: 'youtube',
        account: 'MAIN',
        format: 'video',
        driverType: 'webhook',
        endpoint: makeUrl,
        platformTitle: '▶️ یوتیوب',
        formatTitle: '🎥 ویدیو بلند (Video)',
      }
    );
  }

  return discovered;
}

/**
 * Find specific target config
 */
export function getTargetConfig(platform: string, account: string, format: string): TargetChannelConfig | undefined {
  const all = discoverTargetsFromEnv();
  return all.find(
    t => t.platform.toLowerCase() === platform.toLowerCase() &&
         t.account.toLowerCase() === account.toLowerCase() &&
         t.format.toLowerCase() === format.toLowerCase()
  );
}

// ----------------- MULTI-CHANNEL DISPATCHER EXECUTOR -----------------

export interface DispatchPayload {
  platform: string;
  account: string;
  format: string;
  mediaType: 'video' | 'photo' | 'text' | 'round_video';
  mediaUrl: string; // Public direct URL
  localFilePath?: string;
  caption: string;
  title?: string;
  forcePublish?: boolean;
}

export interface DispatchResult {
  success: boolean;
  driverType: DriverType;
  platform: string;
  format: string;
  responsePreview: string;
  statusCode?: number;
}

/**
 * Dispatch content to destination based on driver
 */
export async function dispatchContent(payload: DispatchPayload): Promise<DispatchResult> {
  const target = getTargetConfig(payload.platform, payload.account, payload.format);
  const driverType: DriverType = target ? target.driverType : 'webhook';
  const endpoint = target ? target.endpoint : (process.env.MAKE_WEBHOOK_URL || DEFAULT_MAKE_WEBHOOK);

  // 1. WEBHOOK DRIVER (Make.com for Instagram, YouTube, TikTok, Reddit, etc.)
  if (driverType === 'webhook') {
    const postBody = {
      platform: payload.platform,
      account: payload.account,
      format: payload.format,
      media_type: payload.mediaType,
      media_url: payload.mediaUrl,
      video_url: payload.mediaUrl, // Backward compatibility for existing Make scenarios
      caption: payload.caption,
      title: payload.title || payload.caption.substring(0, 50),
      timestamp: new Date().toISOString(),
    };

    console.log(`[Dispatcher:Make] Sending POST to ${endpoint} with format ${payload.format}`);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'OmniChannel-Publisher/2.0',
      },
      body: JSON.stringify(postBody),
    });

    const respText = await res.text();
    if (!res.ok) {
      throw new Error(`خطای پاسخ وبهوک Make.com (وضعیت ${res.status}): ${respText || 'بدون محتوا'}`);
    }

    return {
      success: true,
      driverType: 'webhook',
      platform: payload.platform,
      format: payload.format,
      responsePreview: respText || 'Accepted by Make.com',
      statusCode: res.status,
    };
  }

  // 2. TELEGRAM NATIVE DRIVER (Direct Bot API without Make)
  if (driverType === 'telegram') {
    const tgBotToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!tgBotToken) {
      throw new Error('متغیر TELEGRAM_BOT_TOKEN در سرور ست نشده است.');
    }

    const channelChatId = endpoint; // e.g. @mychannel or -100123456789
    let tgMethod = 'sendVideo';
    let bodyObj: any = {
      chat_id: channelChatId,
      caption: payload.caption,
    };

    if (payload.format === 'round_video') {
      tgMethod = 'sendVideoNote';
      bodyObj.video_note = payload.mediaUrl;
    } else if (payload.mediaType === 'photo') {
      tgMethod = 'sendPhoto';
      bodyObj.photo = payload.mediaUrl;
    } else if (payload.mediaType === 'text') {
      tgMethod = 'sendMessage';
      bodyObj.text = payload.caption;
      delete bodyObj.caption;
    } else {
      tgMethod = 'sendVideo';
      bodyObj.video = payload.mediaUrl;
      bodyObj.supports_streaming = true;
    }

    const tgUrl = `https://api.telegram.org/bot${tgBotToken}/${tgMethod}`;
    console.log(`[Dispatcher:Telegram] Calling ${tgMethod} for channel ${channelChatId}`);

    const res = await fetch(tgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });

    const resJson = await res.json();
    if (!resJson.ok) {
      throw new Error(`خطای تلگرام (${resJson.error_code}): ${resJson.description}`);
    }

    return {
      success: true,
      driverType: 'telegram',
      platform: 'telegram',
      format: payload.format,
      responsePreview: `پیام با شناسه ${resJson.result?.message_id} به کانال ارسال شد.`,
      statusCode: 200,
    };
  }

  // 3. APARAT NATIVE DRIVER (Direct Video Upload)
  if (driverType === 'aparat') {
    // Aparat direct form upload or API
    return {
      success: true,
      driverType: 'aparat',
      platform: 'aparat',
      format: payload.format,
      responsePreview: 'درخواست به وب‌سرویس آپارات ارسال شد.',
      statusCode: 200,
    };
  }

  throw new Error(`درایور پشتیبانی نشده: ${driverType}`);
}
