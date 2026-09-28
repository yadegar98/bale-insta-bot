import fs from 'fs';
import path from 'path';
import { inspectMediaFile, validateMediaForTarget, buildMetadataFromSpecs, MediaMetadata, ValidationResult } from './mediaValidator.js';
import { cloudStorage, ScheduledPostItem } from './cloudStorage.js';
import { discoverTargetsFromEnv, getTargetConfig, dispatchContent, TargetChannelConfig } from './dispatcher.js';
import { leaseMediaFromBale } from './zeroDiskManager.js';

// Draft state for user conversation in Bale
export interface BaleDraftSession {
  chatId: string;
  step: 'AWAIT_TARGET' | 'AWAIT_CAPTION' | 'AWAIT_TIME' | 'CONFIRM_WARNING' | 'AWAIT_DOC_ASPECT';
  fileId: string;
  fileUniqueId: string;
  filename: string;
  tempLocalPath?: string;
  mediaType: 'video' | 'photo' | 'text' | 'round_video';
  metadata?: MediaMetadata;
  selectedPlatform?: string;
  selectedAccount?: string;
  selectedFormat?: string;
  caption?: string;
  validation?: ValidationResult;
  updatedAt: number;
}

const userSessions: Record<string, BaleDraftSession> = {};

// Helper to send message with optional inline keyboard to Bale
export async function sendBaleMsg(botToken: string, chatId: string, text: string, replyMarkup?: any) {
  if (!botToken) return;
  const url = `https://tapi.bale.ai/bot${botToken}/sendMessage`;
  try {
    const payload: any = {
      chat_id: chatId,
      text,
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (e: any) {
    console.error(`[Bale] Send message error to ${chatId}:`, e.message);
  }
}

/**
 * Handle incoming callback query from inline buttons
 */
export async function handleBaleCallbackQuery(
  botToken: string,
  callbackQuery: any,
  publicBaseUrl: string
) {
  const data = callbackQuery.data || '';
  const chatId = String(callbackQuery.message?.chat?.id || callbackQuery.from?.id);
  const session = userSessions[chatId];

  console.log(`[Bale Callback] from ${chatId}: ${data}`);

  // Answer callback query so loading stops in Bale client
  try {
    await fetch(`https://tapi.bale.ai/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQuery.id }),
    });
  } catch (e) {}

  // 1. Menu: List Active Queues
  if (data === 'action:list_queues') {
    const posts = await cloudStorage.getAllPosts();
    const pending = posts.filter(p => p.status === 'pending');
    if (pending.length === 0) {
      await sendBaleMsg(botToken, chatId, '📋 در حال حاضر هیچ پستی در صف زمان‌بندی قرار ندارد.');
      return;
    }

    let text = `📋 *لیست پست‌های در صف زمان‌بندی (${pending.length} مورد):*\n\n`;
    for (let i = 0; i < Math.min(pending.length, 6); i++) {
      const p = pending[i];
      text += `🔹 *${i + 1}. ${p.platform.toUpperCase()} [${p.format}]* - پیج: ${p.account}\n` +
              `⏰ زمان انتشار: ${p.scheduledTime}\n` +
              `📝 کپشن: ${p.caption.substring(0, 45)}...\n` +
              `شناسه: #${p.id}\n\n`;
    }

    const inlineKeyboard: any[][] = [];
    for (const p of pending.slice(0, 5)) {
      inlineKeyboard.push([
        { text: `✏️ ویرایش کپشن #${p.id.slice(-4)}`, callback_data: `edit_cap:${p.id}` },
        { text: `❌ لغو #${p.id.slice(-4)}`, callback_data: `del_post:${p.id}` },
      ]);
    }

    await sendBaleMsg(botToken, chatId, text, { inline_keyboard: inlineKeyboard });
    return;
  }

  // 2. Action: Delete a queued post
  if (data.startsWith('del_post:')) {
    const id = data.replace('del_post:', '');
    const success = await cloudStorage.deletePost(id);
    if (success) {
      await sendBaleMsg(botToken, chatId, `✅ پست شماره #${id.slice(-4)} با موفقیت از صف لغو و حذف شد.`);
    } else {
      await sendBaleMsg(botToken, chatId, `⚠️ پست مورد نظر یافت نشد.`);
    }
    return;
  }

  // 2.5 Action: Set aspect ratio for Document video without download
  if (data.startsWith('doc_aspect:')) {
    if (!session) return;
    const aspect = data.replace('doc_aspect:', '');
    if (aspect === '9:16') {
      session.metadata = buildMetadataFromSpecs({
        isImage: session.mediaType === 'photo',
        width: 1080,
        height: 1920,
        fileSizeBytes: session.metadata?.fileSizeBytes || 0,
      });
    } else if (aspect === '16:9') {
      session.metadata = buildMetadataFromSpecs({
        isImage: session.mediaType === 'photo',
        width: 1920,
        height: 1080,
        fileSizeBytes: session.metadata?.fileSizeBytes || 0,
      });
    } else if (aspect === '1:1') {
      session.metadata = buildMetadataFromSpecs({
        isImage: session.mediaType === 'photo',
        width: 1080,
        height: 1080,
        fileSizeBytes: session.metadata?.fileSizeBytes || 0,
      });
    }
    await promptTargetSelection(botToken, chatId, session);
    return;
  }

  // 3. Selection of Target (Format/Channel)
  if (data.startsWith('target:')) {
    if (!session) {
      await sendBaleMsg(botToken, chatId, '⚠️ نشست منقضی شده است. لطفاً ابتدا ویدیوی خود را مجدداً ارسال کنید.');
      return;
    }

    // Format: target:<KEY>
    const targetKey = data.replace('target:', '');
    const targets = discoverTargetsFromEnv();
    const selected = targets.find(t => t.key === targetKey);

    if (!selected) {
      await sendBaleMsg(botToken, chatId, '⚠️ کانال مقصد یافت نشد.');
      return;
    }

    session.selectedPlatform = selected.platform;
    session.selectedAccount = selected.account;
    session.selectedFormat = selected.format;

    // Run Smart Validator against this target
    if (session.metadata) {
      const val = validateMediaForTarget(session.metadata, selected.platform, selected.format);
      session.validation = val;

      if (!val.isValid) {
        // Warning message with Force Publish option
        const warningMsg =
          `⚠️ *هشدار بررسی مشخصات و ابعاد:*\n` +
          `مقصد انتخابی: ${selected.platformTitle} ➔ ${selected.formatTitle}\n\n` +
          `🔍 *نتیجه بررسی هوشمند:*\n` +
          `${val.feedbackMessage}\n\n` +
          `📐 رزولوشن استاندارد: *${val.recommendedResolution}*\n` +
          `📏 ابعاد فایل شما: *${session.metadata.width || '--'}x${session.metadata.height || '--'} (${session.metadata.aspectRatioLabel})*\n\n` +
          `آیا تمایل دارید با وجود این هشدار ادامه دهید؟`;

        const keyboard = {
          inline_keyboard: [
            [{ text: '🚀 انتشار اجباری (مشکلی نیست، ادامه بده)', callback_data: 'force_continue' }],
            [{ text: '🔙 انتخاب یک پلتفرم دیگر', callback_data: 'back_to_targets' }],
            [{ text: '❌ انصراف کامل', callback_data: 'cancel_draft' }],
          ],
        };

        await sendBaleMsg(botToken, chatId, warningMsg, keyboard);
        session.step = 'CONFIRM_WARNING';
        return;
      }
    }

    // If valid, proceed to caption
    await proceedToCaption(botToken, chatId, session);
    return;
  }

  // 4. Force continue after warning
  if (data === 'force_continue') {
    if (!session) return;
    await proceedToCaption(botToken, chatId, session);
    return;
  }

  // 5. Back to targets
  if (data === 'back_to_targets') {
    if (!session) return;
    await promptTargetSelection(botToken, chatId, session);
    return;
  }

  // 6. Cancel draft
  if (data === 'cancel_draft') {
    if (session?.tempLocalPath && fs.existsSync(session.tempLocalPath)) {
      try { fs.unlinkSync(session.tempLocalPath); } catch (e) {}
    }
    delete userSessions[chatId];
    await sendBaleMsg(botToken, chatId, '❌ عملیات لغو شد. می‌توانید هر زمان فایل جدیدی بفرستید.');
    return;
  }

  // 7. Publish Now immediately
  if (data === 'publish_now') {
    if (!session || !session.caption) return;
    await executePublishNow(botToken, chatId, session, publicBaseUrl);
    return;
  }

  // 8. Schedule
  if (data === 'schedule_later') {
    if (!session) return;
    session.step = 'AWAIT_TIME';
    await sendBaleMsg(
      botToken,
      chatId,
      `⏰ لطفاً ساعت انتشار را بفرستید:\n` +
      `مثال:\n` +
      `• فقط ساعت: *21:30*\n` +
      `• یا تاریخ و ساعت: *1403/07/07 20:00*`
    );
    return;
  }
}

/**
 * Prompt user to choose target destination from discovered targets
 */
export async function promptTargetSelection(botToken: string, chatId: string, session: BaleDraftSession) {
  const targets = discoverTargetsFromEnv();
  session.step = 'AWAIT_TARGET';

  let text =
    `🎯 *مرحله ۱: انتخاب پلتفرم و فرمت انتشار*\n\n` +
    `📊 *مشخصات فایل شما:*\n` +
    `• نسبت تصویر: *${session.metadata?.aspectRatioLabel || 'معمولی'}*\n` +
    `• رزولوشن: *${session.metadata?.width || '--'}x${session.metadata?.height || '--'}*\n` +
    `• مدت زمان: *${session.metadata?.durationSeconds || '--'} ثانیه*\n` +
    `• حجم فایل: *${session.metadata?.fileSizeMb || '--'} مگابایت*\n\n` +
    `لطفاً مقصد انتشار را از گزینه‌های زیر انتخاب کنید:`;

  const inlineKeyboard: any[][] = [];
  for (const t of targets) {
    inlineKeyboard.push([
      {
        text: `${t.platformTitle} [${t.account}] ➔ ${t.formatTitle}`,
        callback_data: `target:${t.key}`,
      },
    ]);
  }

  inlineKeyboard.push([
    { text: '❌ انصراف', callback_data: 'cancel_draft' },
  ]);

  await sendBaleMsg(botToken, chatId, text, { inline_keyboard: inlineKeyboard });
}

/**
 * Move conversation to caption entry step
 */
async function proceedToCaption(botToken: string, chatId: string, session: BaleDraftSession) {
  session.step = 'AWAIT_CAPTION';

  if (session.caption) {
    // Caption was already provided with video
    await promptPublishOrSchedule(botToken, chatId, session);
    return;
  }

  await sendBaleMsg(
    botToken,
    chatId,
    `✍️ *مرحله ۲: متن کپشن*\n\n` +
    `لطفاً متن کامل کپشن، هشتگ‌ها و توضیحات این پست را در پیام بعدی بفرستید:`
  );
}

/**
 * Prompt user to choose between Immediate Publish or Schedule
 */
export async function promptPublishOrSchedule(botToken: string, chatId: string, session: BaleDraftSession) {
  const keyboard = {
    inline_keyboard: [
      [{ text: '🚀 انتشار فوری همین حالا', callback_data: 'publish_now' }],
      [{ text: '⏰ زمان‌بندی برای ساعت آینده', callback_data: 'schedule_later' }],
      [{ text: '❌ انصراف', callback_data: 'cancel_draft' }],
    ],
  };

  const text =
    `✨ *تایید نهایی انتشار:*\n\n` +
    `🎯 مقصد: *${session.selectedPlatform?.toUpperCase()} [${session.selectedAccount}]* ➔ *${session.selectedFormat}*\n` +
    `📝 کپشن: ${session.caption?.substring(0, 100)}...\n\n` +
    `چگونه می‌خواهید منتشر شود؟`;

  await sendBaleMsg(botToken, chatId, text, keyboard);
}

/**
 * Execute immediate publish
 */
async function executePublishNow(
  botToken: string,
  chatId: string,
  session: BaleDraftSession,
  publicBaseUrl: string
) {
  await sendBaleMsg(botToken, chatId, '⏳ در حال هاست مستقیم و ارسال به مقصد نهایی...');

  try {
    // Zero-Disk lease
    const lease = await leaseMediaFromBale(
      botToken,
      session.fileId,
      session.filename,
      publicBaseUrl
    );

    const result = await dispatchContent({
      platform: session.selectedPlatform || 'instagram',
      account: session.selectedAccount || 'MAIN',
      format: session.selectedFormat || 'reels',
      mediaType: session.mediaType,
      mediaUrl: lease.publicUrl,
      localFilePath: lease.filePath,
      caption: session.caption || '',
      forcePublish: true,
    });

    // Clean up temporary local file immediately (Zero-Disk)
    // Keep media available for 2.5 hours for Meta/Instagram/YouTube download
    // lease.cleanup() runs automatically after 2.5 hours retention period

    // Clean up session inspect file
    if (session.tempLocalPath && fs.existsSync(session.tempLocalPath)) {
      try { fs.unlinkSync(session.tempLocalPath); } catch (e) {}
    }

    // Save record to cloudStorage
    await cloudStorage.addPost({
      id: Date.now().toString(),
      fileId: session.fileId,
      filename: session.filename,
      mediaType: session.mediaType,
      platform: session.selectedPlatform || 'instagram',
      account: session.selectedAccount || 'MAIN',
      format: session.selectedFormat || 'reels',
      driverType: result.driverType,
      caption: session.caption || '',
      scheduledTime: new Date().toISOString(),
      status: 'published',
      publishedAt: new Date().toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }),
      metadata: session.metadata ? {
        width: session.metadata.width,
        height: session.metadata.height,
        aspectRatioLabel: session.metadata.aspectRatioLabel,
        durationSeconds: session.metadata.durationSeconds,
        fileSizeMb: session.metadata.fileSizeMb,
      } : undefined,
    });

    delete userSessions[chatId];

    await sendBaleMsg(
      botToken,
      chatId,
      `🎉 *تبریک! محتوا با موفقیت ارسال شد.*\n\n` +
      `🎯 مقصد: ${result.platform.toUpperCase()} (${result.format})\n` +
      `📡 روش ارسال: ${result.driverType === 'webhook' ? 'Make.com' : 'اتصال مستقیم'}\n` +
      `✅ پاسخ: ${result.responsePreview}`
    );
  } catch (err: any) {
    await sendBaleMsg(botToken, chatId, `❌ خطا در ارسال محتوا:\n${err.message}`);
  }
}

/**
 * Handle incoming text in conversation session
 */
export async function handleBaleSessionText(
  botToken: string,
  chatId: string,
  text: string,
  publicBaseUrl: string
): Promise<boolean> {
  const session = userSessions[chatId];
  if (!session) return false;

  // Step: AWAIT_CAPTION
  if (session.step === 'AWAIT_CAPTION') {
    session.caption = text.trim();
    await promptPublishOrSchedule(botToken, chatId, session);
    return true;
  }

  // Step: AWAIT_TIME
  if (session.step === 'AWAIT_TIME') {
    const rawTime = text.trim();
    let scheduledTime = rawTime;

    // Check if user entered just HH:mm e.g. 21:30
    const timeOnlyMatch = rawTime.match(/^(\d{1,2}):(\d{2})$/);
    if (timeOnlyMatch) {
      const now = new Date();
      const tehranDate = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' });
      scheduledTime = `${tehranDate} ${timeOnlyMatch[1].padStart(2, '0')}:${timeOnlyMatch[2]}:00`;
    }

    // Save scheduled post to JSONBin Cloud Storage
    await cloudStorage.addPost({
      id: Date.now().toString(),
      fileId: session.fileId,
      filename: session.filename,
      mediaType: session.mediaType,
      platform: session.selectedPlatform || 'instagram',
      account: session.selectedAccount || 'MAIN',
      format: session.selectedFormat || 'reels',
      driverType: 'webhook',
      caption: session.caption || '',
      scheduledTime,
      status: 'pending',
      metadata: session.metadata ? {
        width: session.metadata.width,
        height: session.metadata.height,
        aspectRatioLabel: session.metadata.aspectRatioLabel,
        durationSeconds: session.metadata.durationSeconds,
        fileSizeMb: session.metadata.fileSizeMb,
      } : undefined,
    });

    // Clean inspect file
    if (session.tempLocalPath && fs.existsSync(session.tempLocalPath)) {
      try { fs.unlinkSync(session.tempLocalPath); } catch (e) {}
    }

    delete userSessions[chatId];

    await sendBaleMsg(
      botToken,
      chatId,
      `⏰ *پست با موفقیت در صف زمان‌بندی ذخیره شد.*\n\n` +
      `🎯 مقصد: ${session.selectedPlatform?.toUpperCase()} [${session.selectedAccount}] ➔ ${session.selectedFormat}\n` +
      `🗓️ زمان انتشار: *${scheduledTime}*\n` +
      `💾 ذخیره‌شده در دیتابیس ابری (ضد ری‌استارت).\n` +
      `در زمان مقرر، سرور خودکار فایل را پردازش و ارسال خواهد کرد.`
    );
    return true;
  }

  return false;
}

/**
 * Handle new incoming media (Video/Photo/Document) from Bale with zero memory/download overhead
 */
export async function handleIncomingMediaFile(
  botToken: string,
  chatId: string,
  fileId: string,
  fileUniqueId: string,
  isPhoto: boolean,
  captionText?: string,
  specs?: {
    width?: number;
    height?: number;
    duration?: number;
    file_size?: number;
    file_name?: string;
  }
) {
  const fileExt = isPhoto ? '.jpg' : '.mp4';
  const filename = specs?.file_name || `bale_${fileUniqueId}${fileExt}`;

  // If Bale already provided width/height (Regular Video / Photo)
  if (specs && specs.width && specs.height) {
    const metadata = buildMetadataFromSpecs({
      isImage: isPhoto,
      width: specs.width,
      height: specs.height,
      durationSeconds: specs.duration,
      fileSizeBytes: specs.file_size,
    });

    const session: BaleDraftSession = {
      chatId,
      step: 'AWAIT_TARGET',
      fileId,
      fileUniqueId,
      filename,
      mediaType: isPhoto ? 'photo' : 'video',
      metadata,
      caption: captionText ? captionText.trim() : undefined,
      updatedAt: Date.now(),
    };

    userSessions[chatId] = session;
    await promptTargetSelection(botToken, chatId, session);
    return;
  }

  // If sent as Document (no width/height provided by Bale):
  // Do NOT download huge file to avoid server freeze! Ask user aspect ratio directly!
  const session: BaleDraftSession = {
    chatId,
    step: 'AWAIT_DOC_ASPECT',
    fileId,
    fileUniqueId,
    filename,
    mediaType: isPhoto ? 'photo' : 'video',
    metadata: buildMetadataFromSpecs({
      isImage: isPhoto,
      fileSizeBytes: specs?.file_size,
    }),
    caption: captionText ? captionText.trim() : undefined,
    updatedAt: Date.now(),
  };
  userSessions[chatId] = session;

  const docAspectText =
    `📁 *فایل دریافتی (سند بدون افت کیفیت)*\n\n` +
    `نام فایل: \`${filename}\`\n` +
    `حجم فایل: *${session.metadata?.fileSizeMb || '--'} مگابایت*\n\n` +
    `برای بررسی انطباق با اینستاگرام/یوتیوب، لطفاً کادر ویدیوی خود را مشخص کنید:`;

  const inlineKeyboard = [
    [{ text: '📱 عمودی (۹:۱۶ - ریلز / استوری)', callback_data: 'doc_aspect:9:16' }],
    [{ text: '🖥 افقی (۱۶:۹ - پست معمولی)', callback_data: 'doc_aspect:16:9' }],
    [{ text: '⏹ مربعی (۱:۱ - پست اسلایدی/فید)', callback_data: 'doc_aspect:1:1' }],
    [{ text: '❌ انصراف', callback_data: 'cancel_draft' }],
  ];

  await sendBaleMsg(botToken, chatId, docAspectText, { inline_keyboard: inlineKeyboard });
}
