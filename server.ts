import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import dotenv from 'dotenv';

import { cloudStorage, ScheduledPostItem } from './src/server/cloudStorage.js';
import { discoverTargetsFromEnv, dispatchContent } from './src/server/dispatcher.js';
import { leaseMediaFromBale, sweepOldTempFiles } from './src/server/zeroDiskManager.js';
import { 
  handleIncomingMediaFile, 
  handleBaleCallbackQuery, 
  handleBaleSessionText,
  sendBaleMsg
} from './src/server/baleTreeMenu.js';
import { inspectMediaFile } from './src/server/mediaValidator.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Disable caching for dynamic API responses
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Storage folders: public videos and data
const VIDEOS_DIR = path.join(__dirname, 'public', 'videos');
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Host videos directly under /videos with streaming headers
app.use('/videos', express.static(VIDEOS_DIR, {
  setHeaders: (res) => {
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

const LOGS_PATH = path.join(DATA_DIR, 'logs.json');

// Log management
export interface LogItem {
  timestamp: string;
  level: 'INFO' | 'WARNING' | 'ERROR' | 'SUCCESS';
  source: string;
  message: string;
}

function addLog(level: 'INFO' | 'WARNING' | 'ERROR' | 'SUCCESS', source: string, message: string) {
  const timestamp = new Date().toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' });
  const logItem: LogItem = { timestamp, level, source, message };
  console.log(`[${timestamp}] [${level}] [${source}] ${message}`);

  let logs: LogItem[] = [];
  if (fs.existsSync(LOGS_PATH)) {
    try {
      logs = JSON.parse(fs.readFileSync(LOGS_PATH, 'utf-8'));
    } catch (e) {
      logs = [];
    }
  }
  logs.unshift(logItem);
  if (logs.length > 500) logs = logs.slice(0, 500);
  fs.writeFileSync(LOGS_PATH, JSON.stringify(logs, null, 2));
}

// Multer storage for manual file uploads from dashboard
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, VIDEOS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

const PORT = Number(process.env.PORT) || 3000;

function getPublicBaseUrl(req?: express.Request): string {
  if (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.trim()) {
    return process.env.PUBLIC_BASE_URL.trim().replace(/\/$/, '');
  }
  if (process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL.trim()) {
    return process.env.RENDER_EXTERNAL_URL.trim().replace(/\/$/, '');
  }
  if (req) {
    const host = req.get('x-forwarded-host') || req.get('host');
    const protocol = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
    if (host) {
      return `${protocol}://${host}`;
    }
  }
  return `http://localhost:${PORT}`;
}

// ---------------- BALE MESSENGER BOT ENGINE ----------------
let lastBaleUpdateId = 0;
let isBaleInitialized = false;

async function pollBaleUpdates() {
  const baleToken = (process.env.BALE_BOT_TOKEN || '').trim();
  if (!baleToken) {
    setTimeout(pollBaleUpdates, 5000);
    return;
  }

  try {
    if (!isBaleInitialized) {
      addLog('INFO', 'Bale', 'بررسی اتصال اولیه به ربات بله...');
      const url = `https://tapi.bale.ai/bot${baleToken}/getUpdates?offset=-1&limit=1`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.ok && data.result && data.result.length > 0) {
        lastBaleUpdateId = data.result[0].update_id;
        addLog('INFO', 'Bale', `اتصال با بله برقرار شد. شناسه آخرین رویداد: ${lastBaleUpdateId}`);
      } else if (data.ok) {
        addLog('INFO', 'Bale', 'اتصال به بله برقرار شد. صف آپدیت‌ها خالی است.');
      } else {
        addLog('ERROR', 'Bale', `پاسخ ناموفق از بله: ${data.description}`);
      }
      isBaleInitialized = true;
    }

    const url = `https://tapi.bale.ai/bot${baleToken}/getUpdates?offset=${lastBaleUpdateId + 1}&limit=10`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.ok && data.result && data.result.length > 0) {
      for (const update of data.result) {
        lastBaleUpdateId = update.update_id;
        await processBaleUpdate(baleToken, update);
      }
    }
  } catch (err: any) {
    // transient network error
  }

  setTimeout(pollBaleUpdates, 3000);
}

pollBaleUpdates();

async function processBaleUpdate(botToken: string, update: any) {
  const adminChatId = (process.env.ADMIN_CHAT_ID || '').trim();
  const publicBaseUrl = getPublicBaseUrl();

  // 1. Handle Inline Keyboards (Callback Queries)
  if (update.callback_query) {
    const cb = update.callback_query;
    const fromId = String(cb.from?.id || cb.message?.chat?.id);
    if (adminChatId && fromId !== adminChatId) {
      return;
    }
    await handleBaleCallbackQuery(botToken, cb, publicBaseUrl);
    return;
  }

  // 2. Handle Messages
  const message = update.message;
  if (!message) return;

  const chatId = String(message.chat.id);
  const text = (message.text || '').trim();

  // Admin access check
  if (adminChatId && chatId !== adminChatId) {
    await sendBaleMsg(botToken, chatId, '⛔ دسترسی غیرمجاز. این ربات برای مدیر سیستم پیکربندی شده است.');
    return;
  }

  // /start or /help
  if (text === '/start' || text === '/help') {
    const targets = discoverTargetsFromEnv();
    const targetsList = targets.map(t => `• ${t.platformTitle} [${t.account}] ➔ ${t.formatTitle}`).join('\n');

    const startMsg =
      `سلام و درود! 🎬✨\n` +
      `به پلتفرم چندکاناله انتشار خودکار محتوا خوش آمدید.\n\n` +
      `📌 *پلتفرم‌ها و کانال‌های فعال:*\n${targetsList}\n\n` +
      `🚀 *نحوه استفاده:* ویدیو یا عکس خود را در همین چت بفرستید تا ابعاد بررسی شده و منوی انتخاب پلتفرم ظاهر شود.`;

    const startKeyboard = {
      inline_keyboard: [
        [{ text: '📋 مشاهده صف‌های زمان‌بندی', callback_data: 'action:list_queues' }]
      ]
    };

    await sendBaleMsg(botToken, chatId, startMsg, startKeyboard);
    return;
  }

  // Check if user is typing text inside active session (caption, time)
  const isHandledBySession = await handleBaleSessionText(botToken, chatId, text, publicBaseUrl);
  if (isHandledBySession) return;

  // Handle Video / Document Video
  if (message.video) {
    const v = message.video;
    const fileId = v.file_id;
    const fileUniqueId = v.file_unique_id || String(Date.now());
    await handleIncomingMediaFile(botToken, chatId, fileId, fileUniqueId, false, message.caption, {
      width: v.width,
      height: v.height,
      duration: v.duration,
      file_size: v.file_size,
    });
    return;
  }

  // Handle Document (Video as file without compression)
  if (message.document && (message.document.mime_type?.startsWith('video/') || message.document.file_name?.match(/\.(mp4|mov|mkv|avi)$/i))) {
    const doc = message.document;
    const fileId = doc.file_id;
    const fileUniqueId = doc.file_unique_id || String(Date.now());
    await handleIncomingMediaFile(botToken, chatId, fileId, fileUniqueId, false, message.caption, {
      file_size: doc.file_size,
      file_name: doc.file_name,
    });
    return;
  }

  // Handle Photo
  const photos = message.photo;
  if (photos && photos.length > 0) {
    // Get highest resolution photo
    const bestPhoto = photos[photos.length - 1];
    const fileId = bestPhoto.file_id;
    const fileUniqueId = bestPhoto.file_unique_id || String(Date.now());
    await handleIncomingMediaFile(botToken, chatId, fileId, fileUniqueId, true, message.caption, {
      width: bestPhoto.width,
      height: bestPhoto.height,
      file_size: bestPhoto.file_size,
    });
    return;
  }

  // Generic fallback
  if (text) {
    await sendBaleMsg(
      botToken,
      chatId,
      'سلام! ✋ لطفاً فایل ویدیویی یا عکس خود را ارسال کنید تا بررسی مشخصات و منوی انتخاب پلتفرم فعال شود.'
    );
  }
}

// ---------------- SCHEDULER & RECOVERY LOOP (Every 60s) ----------------
setInterval(async () => {
  try {
    const pendingPosts = await cloudStorage.getPendingScheduledPosts();
    if (pendingPosts.length === 0) return;

    const now = new Date();
    const tehranTimeStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' }) + ' ' +
                          now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' });

    const currentTime = tehranTimeStr.substring(0, 16);
    const baleToken = (process.env.BALE_BOT_TOKEN || '').trim();
    const adminChatId = (process.env.ADMIN_CHAT_ID || '').trim();
    const publicBaseUrl = getPublicBaseUrl();

    for (const post of pendingPosts) {
      const targetTime = post.scheduledTime.replace('T', ' ').substring(0, 16);

      if (targetTime <= currentTime) {
        addLog('INFO', 'Scheduler', `پست #${post.id} برای ${post.platform} [${post.format}] فعال شد. شروع فرآیند انتشار Zero-Disk...`);

        try {
          // Zero-Disk lease from Bale
          const lease = await leaseMediaFromBale(
            baleToken,
            post.fileId,
            post.filename,
            publicBaseUrl
          );

          const result = await dispatchContent({
            platform: post.platform,
            account: post.account,
            format: post.format,
            mediaType: post.mediaType,
            mediaUrl: lease.publicUrl,
            localFilePath: lease.filePath,
            caption: post.caption,
            forcePublish: true,
          });

          // Keep media available for 2.5 hours for Meta/Instagram
          // lease.cleanup();

          // Update Cloud Storage
          await cloudStorage.updatePost(post.id, {
            status: 'published',
            publishedAt: new Date().toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }),
          });

          addLog('SUCCESS', 'Scheduler', `پست #${post.id} با موفقیت در ${post.platform} منتشر شد.`);

          if (baleToken && adminChatId) {
            await sendBaleMsg(
              baleToken,
              adminChatId,
              `⏰ *پست زمان‌بندی شده با موفقیت منتشر شد!*\n\n` +
              `🎯 مقصد: ${post.platform.toUpperCase()} (${post.format})\n` +
              `✅ وضعیت: ${result.responsePreview}`
            );
          }
        } catch (err: any) {
          await cloudStorage.updatePost(post.id, {
            status: 'failed',
            publishError: err.message,
          });
          addLog('ERROR', 'Scheduler', `خطا در انتشار زمان‌بندی شده #${post.id}: ${err.message}`);

          if (baleToken && adminChatId) {
            await sendBaleMsg(
              baleToken,
              adminChatId,
              `⚠️ *خطا در انتشار پست زمان‌بندی شده #${post.id}:*\n${err.message}`
            );
          }
        }
      }
    }
  } catch (error: any) {
    console.error('Error in scheduler loop:', error);
  }
}, 60000);

// Sweep aged temporary files every 30 minutes
setInterval(() => {
  sweepOldTempFiles(30);
}, 30 * 60 * 1000);

// ---------------- REST API ROUTES ----------------

// 1. Health route (target for UptimeRobot)
app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    tehranTime: new Date().toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }),
    cloudStorageConfigured: cloudStorage.isCloudConfigured(),
    targetsCount: discoverTargetsFromEnv().length,
  });
});

// 2. Status summary
app.get('/api/status-summary', async (req, res) => {
  const baseUrl = getPublicBaseUrl(req);
  const targets = discoverTargetsFromEnv();
  const posts = await cloudStorage.getAllPosts();

  res.json({
    publicBaseUrl: baseUrl,
    renderExternalUrl: process.env.RENDER_EXTERNAL_URL || null,
    baleTokenConfigured: Boolean(process.env.BALE_BOT_TOKEN),
    cloudStorageConfigured: cloudStorage.isCloudConfigured(),
    telegramTokenConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    targets,
    uptimeSeconds: Math.floor(process.uptime()),
    pendingCount: posts.filter(p => p.status === 'pending').length,
    publishedCount: posts.filter(p => p.status === 'published').length,
    totalPostsCount: posts.length,
  });
});

// 3. Targets endpoint
app.get('/api/targets', (req, res) => {
  res.json(discoverTargetsFromEnv());
});

// 4. Bale status check
app.get('/api/bale/status', async (req, res) => {
  const token = (process.env.BALE_BOT_TOKEN || '').trim();
  if (!token) {
    return res.json({ connected: false, message: 'توکن بله در متغیرهای محیطی ست نشده است.' });
  }

  try {
    const response = await fetch(`https://tapi.bale.ai/bot${token}/getMe`);
    const data = await response.json();
    if (data.ok && data.result) {
      res.json({
        connected: true,
        botName: data.result.first_name,
        username: data.result.username || '',
        botId: data.result.id,
      });
    } else {
      res.json({ connected: false, message: data.description || 'توکن نامعتبر است.' });
    }
  } catch (err: any) {
    res.json({ connected: false, message: `خطا در اتصال به بله: ${err.message}` });
  }
});

// 5. Posts CRUD
app.get('/api/posts', async (req, res) => {
  const posts = await cloudStorage.getAllPosts(true);
  res.json(posts);
});

app.post('/api/posts', async (req, res) => {
  const newPost = await cloudStorage.addPost({
    id: Date.now().toString(),
    fileId: req.body.fileId || '',
    filename: req.body.filename || 'manual_upload.mp4',
    mediaType: req.body.mediaType || 'video',
    platform: req.body.platform || 'instagram',
    account: req.body.account || 'MAIN',
    format: req.body.format || 'reels',
    driverType: req.body.driverType || 'webhook',
    caption: req.body.caption || '',
    scheduledTime: req.body.scheduledTime || new Date().toISOString(),
    status: req.body.status || 'draft',
    metadata: req.body.metadata,
  });
  res.json({ success: true, post: newPost });
});

app.post('/api/posts/:id/publish-now', async (req, res) => {
  const posts = await cloudStorage.getAllPosts();
  const post = posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'پست یافت نشد.' });

  const baleToken = (process.env.BALE_BOT_TOKEN || '').trim();
  const publicBaseUrl = getPublicBaseUrl(req);

  try {
    // If file is from Bale, lease it
    let mediaUrl = '';
    let cleanupFn = () => {};

    if (post.fileId && baleToken) {
      const lease = await leaseMediaFromBale(baleToken, post.fileId, post.filename, publicBaseUrl);
      mediaUrl = lease.publicUrl;
      cleanupFn = lease.cleanup;
    } else {
      mediaUrl = `${publicBaseUrl}/videos/${post.filename}`;
    }

    const result = await dispatchContent({
      platform: post.platform,
      account: post.account,
      format: post.format,
      mediaType: post.mediaType,
      mediaUrl,
      caption: post.caption,
      forcePublish: true,
    });

    // Keep media available for 3 hours for Meta/Instagram
    // cleanupFn();

    await cloudStorage.updatePost(post.id, {
      status: 'published',
      publishedAt: new Date().toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }),
    });

    res.json({ success: true, result });
  } catch (err: any) {
    await cloudStorage.updatePost(post.id, {
      status: 'failed',
      publishError: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/posts/:id', async (req, res) => {
  const success = await cloudStorage.deletePost(req.params.id);
  res.json({ success });
});

// 6. Manual upload from studio
app.post('/api/upload-video', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'فایلی ارسال نشده است.' });
  }

  const relativeUrl = `/videos/${req.file.filename}`;
  const baseUrl = getPublicBaseUrl(req);
  const directPublicUrl = `${baseUrl}${relativeUrl}`;

  // Run inspector
  const metadata = await inspectMediaFile(req.file.path, false);

  res.json({
    videoPath: req.file.path,
    videoUrl: relativeUrl,
    directPublicUrl,
    filename: req.file.filename,
    metadata,
  });
});

// 7. Test target dispatch
app.post('/api/test-target', async (req, res) => {
  const { platform, account, format, mediaUrl, caption } = req.body;
  try {
    const result = await dispatchContent({
      platform: platform || 'instagram',
      account: account || 'MAIN',
      format: format || 'reels',
      mediaType: 'video',
      mediaUrl: mediaUrl || `${getPublicBaseUrl(req)}/videos/sample.mp4`,
      caption: caption || 'تست دستی انتشار از داشبورد چندکاناله',
      forcePublish: true,
    });
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Logs
app.get('/api/logs', (req, res) => {
  if (fs.existsSync(LOGS_PATH)) {
    try {
      res.json(JSON.parse(fs.readFileSync(LOGS_PATH, 'utf-8')));
    } catch (e) {
      res.json([]);
    }
  } else {
    res.json([]);
  }
});

app.delete('/api/logs', (req, res) => {
  fs.writeFileSync(LOGS_PATH, JSON.stringify([], null, 2));
  res.json({ success: true });
});

// 9. Reset and clear data
app.post('/api/reset-all', async (req, res) => {
  try {
    await cloudStorage.syncToCloud([]);
    if (fs.existsSync(VIDEOS_DIR)) {
      const files = fs.readdirSync(VIDEOS_DIR);
      for (const file of files) {
        if (file !== '.gitkeep') {
          try { fs.unlinkSync(path.join(VIDEOS_DIR, file)); } catch (e) {}
        }
      }
    }
    addLog('SUCCESS', 'System', 'تمامی پست‌ها و فایل‌های موقت پاکسازی شدند.');
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- SERVER INITIALIZATION & VITE MOUNT ----------------
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';

  if (!isProd && fs.existsSync(path.resolve(__dirname, 'index.html')) && !fs.existsSync(path.resolve(__dirname, 'dist', 'index.html'))) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'custom',
    });

    app.use(vite.middlewares);

    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        let template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    } else {
      app.get('*', (req, res) => {
        res.send('سرور چندکاناله فعال است.');
      });
    }
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    addLog('INFO', 'System', `سرور مدیریت محتوا روی پورت ${PORT} آماده به کار است.`);
    console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
  });

  server.on('error', (err: any) => {
    console.error('Server error:', err);
  });
}

startServer();
