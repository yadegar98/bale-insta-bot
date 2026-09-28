import React, { useState, useEffect, useRef } from 'react';
import { 
  Send, Calendar, History, Bot, Sparkles, Clock, 
  Trash2, Edit, CheckCircle, XCircle, AlertTriangle, UploadCloud, 
  RefreshCw, Play, Terminal, ExternalLink, Video, Globe, Shield, 
  Zap, ArrowRight, Copy, Check, Radio, Activity, Server, Layers,
  Tv, Film, Eye, Filter
} from 'lucide-react';

interface ScheduledPost {
  id: string;
  fileId: string;
  filename: string;
  mediaType: 'video' | 'photo' | 'text' | 'round_video';
  platform: string;
  account: string;
  format: string;
  driverType: 'webhook' | 'telegram' | 'aparat' | 'direct';
  caption: string;
  scheduledTime: string;
  status: 'pending' | 'published' | 'failed' | 'draft';
  publishError?: string;
  publishedAt?: string;
  metadata?: {
    width?: number;
    height?: number;
    aspectRatioLabel?: string;
    durationSeconds?: number;
    fileSizeMb?: number;
  };
}

interface TargetChannel {
  key: string;
  platform: string;
  account: string;
  format: string;
  driverType: string;
  platformTitle: string;
  formatTitle: string;
}

interface StatusSummary {
  publicBaseUrl: string;
  renderExternalUrl: string | null;
  baleTokenConfigured: boolean;
  cloudStorageConfigured: boolean;
  telegramTokenConfigured: boolean;
  targets: TargetChannel[];
  uptimeSeconds: number;
  pendingCount: number;
  publishedCount: number;
  totalPostsCount: number;
}

interface LogItem {
  timestamp: string;
  level: 'INFO' | 'WARNING' | 'ERROR' | 'SUCCESS';
  source: string;
  message: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'create' | 'queue' | 'history' | 'targets' | 'logs'>('create');
  const [statusSummary, setStatusSummary] = useState<StatusSummary | null>(null);
  const [baleStatus, setBaleStatus] = useState<{ connected: boolean; message?: string; botName?: string; username?: string } | null>(null);
  const [isCheckingBale, setIsCheckingBale] = useState(false);

  // Lists state
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [targets, setTargets] = useState<TargetChannel[]>([]);
  const [filterPlatform, setFilterPlatform] = useState<string>('all');

  // Form states for manual post from dashboard
  const [manualFile, setManualFile] = useState<{ videoPath: string; videoUrl: string; directPublicUrl: string; filename: string; metadata?: any } | null>(null);
  const [selectedTargetKey, setSelectedTargetKey] = useState<string>('');
  const [caption, setCaption] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [isPublishingDirectly, setIsPublishingDirectly] = useState(false);
  const [isPublishingPostId, setIsPublishingPostId] = useState<string | null>(null);

  // Tehran live clock
  const [tehranClock, setTehranClock] = useState({ date: '', time: '' });

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchStatus();
    fetchPosts();
    fetchLogs();
    fetchTargets();
    checkBaleStatus();

    const updateClock = () => {
      const now = new Date();
      const date = now.toLocaleDateString('fa-IR', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric', 
        timeZone: 'Asia/Tehran' 
      });
      const time = now.toLocaleTimeString('fa-IR', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit', 
        timeZone: 'Asia/Tehran' 
      });
      setTehranClock({ date, time });
    };
    updateClock();
    const clockInterval = setInterval(updateClock, 1000);

    const refreshInterval = setInterval(() => {
      fetchStatus();
      fetchPosts();
      fetchLogs();
    }, 10000);

    return () => {
      clearInterval(clockInterval);
      clearInterval(refreshInterval);
    };
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status-summary');
      const data = await res.json();
      setStatusSummary(data);
    } catch (e) {}
  };

  const fetchTargets = async () => {
    try {
      const res = await fetch('/api/targets');
      const data = await res.json();
      setTargets(data);
      if (data.length > 0 && !selectedTargetKey) {
        setSelectedTargetKey(data[0].key);
      }
    } catch (e) {}
  };

  const fetchPosts = async () => {
    try {
      const res = await fetch('/api/posts');
      const data = await res.json();
      setPosts(data);
    } catch (e) {}
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/logs');
      const data = await res.json();
      setLogs(data);
    } catch (e) {}
  };

  const checkBaleStatus = async () => {
    setIsCheckingBale(true);
    try {
      const res = await fetch('/api/bale/status');
      const data = await res.json();
      setBaleStatus(data);
    } catch (e) {
      setBaleStatus({ connected: false, message: 'ارتباط با سرور برقرار نشد.' });
    } finally {
      setIsCheckingBale(false);
    }
  };

  const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('video', file);

    try {
      const res = await fetch('/api/upload-video', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        setManualFile(data);
      } else {
        alert(data.error || 'خطا در آپلود');
      }
    } catch (err) {
      alert('خطا در ارتباط با سرور آپلود');
    }
  };

  const handleManualPublish = async () => {
    if (!manualFile) return alert('لطفاً ابتدا فایل مدیا را انتخاب کنید.');
    if (!caption.trim()) return alert('لطفاً متن کپشن را بنویسید.');

    const target = targets.find(t => t.key === selectedTargetKey) || targets[0];
    if (!target) return alert('مقصدی انتخاب نشده است.');

    setIsPublishingDirectly(true);
    try {
      const res = await fetch('/api/test-target', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: target.platform,
          account: target.account,
          format: target.format,
          mediaUrl: manualFile.directPublicUrl,
          caption: caption.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        // Save to posts
        await fetch('/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: manualFile.filename,
            mediaType: 'video',
            platform: target.platform,
            account: target.account,
            format: target.format,
            driverType: target.driverType,
            caption: caption.trim(),
            scheduledTime: new Date().toISOString(),
            status: 'published',
            metadata: manualFile.metadata,
          }),
        });

        alert(`🎉 با موفقیت به ${target.platformTitle} ارسال شد!`);
        setManualFile(null);
        setCaption('');
        fetchPosts();
        setActiveTab('history');
      } else {
        alert(`خطا: ${data.error}`);
      }
    } catch (e: any) {
      alert(`خطای ارسال: ${e.message}`);
    } finally {
      setIsPublishingDirectly(false);
    }
  };

  const handleManualSchedule = async () => {
    if (!manualFile) return alert('لطفاً ابتدا فایل را انتخاب کنید.');
    if (!caption.trim()) return alert('لطفاً متن کپشن را بنویسید.');
    if (!scheduledTime) return alert('لطفاً تاریخ و ساعت زمان‌بندی را مشخص کنید.');

    const target = targets.find(t => t.key === selectedTargetKey) || targets[0];

    try {
      const res = await fetch('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: manualFile.filename,
          mediaType: 'video',
          platform: target?.platform || 'instagram',
          account: target?.account || 'MAIN',
          format: target?.format || 'reels',
          driverType: target?.driverType || 'webhook',
          caption: caption.trim(),
          scheduledTime: scheduledTime.replace('T', ' '),
          status: 'pending',
          metadata: manualFile.metadata,
        }),
      });

      if (res.ok) {
        alert('⏰ پست با موفقیت در صف زمان‌بندی ذخیره شد.');
        setManualFile(null);
        setCaption('');
        setScheduledTime('');
        fetchPosts();
        setActiveTab('queue');
      }
    } catch (e) {
      alert('خطا در ثبت زمان‌بندی');
    }
  };

  const handlePublishNow = async (postId: string) => {
    if (!confirm('آیا از انتشار فوری این پست اطمینان دارید؟')) return;
    setIsPublishingPostId(postId);
    try {
      const res = await fetch(`/api/posts/${postId}/publish-now`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        alert('پست با موفقیت منتشر شد!');
        fetchPosts();
      } else {
        alert(`خطا: ${data.error}`);
      }
    } catch (e: any) {
      alert(`خطا در ارتباط: ${e.message}`);
    } finally {
      setIsPublishingPostId(null);
    }
  };

  const handleDeletePost = async (postId: string) => {
    if (!confirm('آیا از حذف این پست از صف اطمینان دارید؟')) return;
    try {
      await fetch(`/api/posts/${postId}`, { method: 'DELETE' });
      fetchPosts();
    } catch (e) {}
  };

  const handleResetAllData = async () => {
    if (!confirm('⚠️ آیا از پاکسازی تمامی پست‌ها و آزادسازی حافظه موقت اطمینان دارید؟')) return;
    try {
      await fetch('/api/reset-all', { method: 'POST' });
      fetchPosts();
      fetchLogs();
      alert('کل اطلاعات و فایل‌ها با موفقیت پاکسازی شدند.');
    } catch (e) {}
  };

  const filteredPosts = posts.filter(p => {
    if (filterPlatform === 'all') return true;
    return p.platform.toLowerCase() === filterPlatform.toLowerCase();
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans" dir="rtl">
      {/* HEADER BAR */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-40 px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-gradient-to-tr from-indigo-600 to-violet-500 rounded-xl shadow-lg shadow-indigo-500/20 text-white">
            <Layers className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-black text-white tracking-tight">پلتفرم مدیریت و انتشار چندکاناله (Omni-Channel)</h1>
              <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] px-2 py-0.5 rounded-full font-bold">
                آنلاین ۲۴/۷
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">اتصال بله به اینستاگرام، یوتیوب، تلگرام، آپارات و وب‌سرویس‌ها با متادیتای هوشمند و Zero-Disk</p>
          </div>
        </div>

        {/* Dynamic Status Badges */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Bale Bot Status */}
          <button 
            onClick={checkBaleStatus}
            disabled={isCheckingBale}
            title="وضعیت اتصال به بله"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition ${
              baleStatus?.connected 
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20' 
                : 'bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20'
            }`}
          >
            {isCheckingBale ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Bot className="w-3.5 h-3.5" />}
            <span>{baleStatus?.connected ? `ربات بله: ${baleStatus.botName || 'فعال'}` : 'ربات بله: نیازمند توکن'}</span>
          </button>

          {/* JSONBin Database Status */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold bg-violet-500/10 border-violet-500/30 text-violet-300">
            <Server className="w-3.5 h-3.5 text-violet-400" />
            <span>دیتابیس ابری: {statusSummary?.cloudStorageConfigured ? 'JSONBin متصل' : 'ذخیره محلی (آماده)'}</span>
          </div>

          {/* UptimeRobot Target / Health */}
          <a 
            href="/health" 
            target="_blank" 
            rel="noreferrer"
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold bg-indigo-500/10 border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/20 transition"
            title="آدرس روت مانیتورینگ UptimeRobot"
          >
            <Activity className="w-3.5 h-3.5 text-indigo-400" />
            <span>پینگ UptimeRobot: فعال</span>
          </a>

          {/* Cleanup Button */}
          <button 
            onClick={handleResetAllData}
            className="p-2 bg-slate-800 hover:bg-red-950/40 text-slate-400 hover:text-red-400 rounded-lg transition border border-slate-700/60"
            title="پاکسازی کامل اطلاعات و فایل‌های موقت"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* SUB-HEADER TABS */}
      <div className="bg-slate-900/60 border-b border-slate-800 px-6 py-2 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1.5">
          <button 
            onClick={() => setActiveTab('create')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition ${
              activeTab === 'create' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Video className="w-4 h-4" />
            <span>استودیو و ارسال آزمایشی</span>
          </button>

          <button 
            onClick={() => setActiveTab('queue')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition relative ${
              activeTab === 'queue' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Calendar className="w-4 h-4" />
            <span>صف زمان‌بندی هوشمند</span>
            {posts.filter(p => p.status === 'pending').length > 0 && (
              <span className="absolute -top-1 -left-1 bg-amber-500 text-slate-950 text-[10px] w-4.5 h-4.5 flex items-center justify-center rounded-full font-bold">
                {posts.filter(p => p.status === 'pending').length}
              </span>
            )}
          </button>

          <button 
            onClick={() => setActiveTab('history')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition ${
              activeTab === 'history' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <History className="w-4 h-4" />
            <span>آرشیو و لاگ انتشار</span>
          </button>

          <button 
            onClick={() => setActiveTab('targets')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition ${
              activeTab === 'targets' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Tv className="w-4 h-4" />
            <span>پلتفرم‌ها و کانال‌های متصل ({targets.length})</span>
          </button>

          <button 
            onClick={() => setActiveTab('logs')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition ${
              activeTab === 'logs' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Terminal className="w-4 h-4" />
            <span>کنسول زنده سیستم</span>
          </button>
        </nav>

        <div className="flex items-center gap-3 text-xs text-slate-400">
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-indigo-400" />
            <span className="font-mono text-slate-300 font-bold">{tehranClock.time || '--:--:--'}</span>
            <span className="text-slate-500 text-[11px]">(تهران)</span>
          </div>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <main className="flex-1 p-6 max-w-7xl w-full mx-auto">
        {/* TAB 1: STUDIO */}
        {activeTab === 'create' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              
              {/* UPLOAD & MEDIA INSPECTOR */}
              <div className="lg:col-span-5 space-y-6">
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
                  <h2 className="text-sm font-bold text-slate-200 mb-3 flex items-center gap-2">
                    <UploadCloud className="w-4 h-4 text-indigo-400" />
                    <span>انتخاب فایل و اعتبارسنجی ابعاد</span>
                  </h2>

                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    onChange={handleVideoUpload} 
                    accept="video/*,image/*" 
                    className="hidden" 
                  />

                  {manualFile ? (
                    <div className="border border-indigo-500/20 bg-indigo-500/5 rounded-xl p-4">
                      <video src={manualFile.videoUrl} className="w-full max-h-48 rounded-lg object-cover bg-black shadow mb-3" controls />
                      
                      {/* INSPECTOR STATS */}
                      {manualFile.metadata && (
                        <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs space-y-1.5">
                          <div className="flex items-center justify-between text-slate-300">
                            <span>نسبت ابعاد:</span>
                            <span className="font-bold text-emerald-400">{manualFile.metadata.aspectRatioLabel || 'نامشخص'}</span>
                          </div>
                          <div className="flex items-center justify-between text-slate-400 text-[11px]">
                            <span>رزولوشن:</span>
                            <span className="font-mono">{manualFile.metadata.width}x{manualFile.metadata.height}</span>
                          </div>
                          <div className="flex items-center justify-between text-slate-400 text-[11px]">
                            <span>مدت زمان / حجم:</span>
                            <span>{manualFile.metadata.durationSeconds || '--'} ثانیه | {manualFile.metadata.fileSizeMb} مگابایت</span>
                          </div>
                        </div>
                      )}

                      <button 
                        onClick={() => setManualFile(null)} 
                        className="mt-3 text-red-400 hover:text-red-300 text-xs font-semibold"
                      >
                        تغییر فایل
                      </button>
                    </div>
                  ) : (
                    <div 
                      onClick={() => fileInputRef.current?.click()}
                      className="border-2 border-dashed border-slate-800 hover:border-indigo-500 bg-slate-950/50 rounded-xl p-8 flex flex-col items-center justify-center cursor-pointer transition text-center"
                    >
                      <UploadCloud className="w-7 h-7 text-slate-400 mb-2" />
                      <span className="text-xs font-bold text-slate-300">کلیک برای انتخاب ویدیو یا تصویر</span>
                      <span className="text-[11px] text-slate-500 mt-1">یا فایل را در چت بله بفرستید تا خودکار تحلیل شود</span>
                    </div>
                  )}
                </div>

                {/* TARGET SELECTOR */}
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm space-y-3">
                  <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                    <Tv className="w-4 h-4 text-violet-400" />
                    <span>انتخاب کانال و فرمت مقصد</span>
                  </h2>

                  <select 
                    value={selectedTargetKey}
                    onChange={(e) => setSelectedTargetKey(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 focus:border-indigo-500 rounded-lg p-2.5 text-xs text-slate-100 outline-none"
                  >
                    {targets.map(t => (
                      <option key={t.key} value={t.key}>
                        {t.platformTitle} [{t.account}] ➔ {t.formatTitle} ({t.driverType === 'webhook' ? 'Make' : 'مستقیم'})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* CAPTION & PUBLISH */}
              <div className="lg:col-span-7 space-y-6">
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm flex flex-col h-full">
                  <h2 className="text-sm font-bold text-slate-200 mb-3 flex items-center gap-2">
                    <Edit className="w-4 h-4 text-indigo-400" />
                    <span>متن کپشن و ارسال</span>
                  </h2>

                  <textarea 
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                    placeholder="کپشن، دیسکریپشن و هشتگ‌های مربوطه را بنویسید..."
                    className="w-full h-44 bg-slate-950 border border-slate-800 focus:border-indigo-500 rounded-lg p-3 text-xs text-slate-100 outline-none resize-none leading-relaxed"
                  />

                  <div className="border border-slate-800 bg-slate-950/70 p-4 rounded-xl mt-4 space-y-4">
                    <button 
                      onClick={handleManualPublish}
                      disabled={isPublishingDirectly || !manualFile}
                      className="w-full bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 disabled:opacity-50 text-white font-bold py-3 rounded-xl text-xs transition shadow flex items-center justify-center gap-2"
                    >
                      {isPublishingDirectly ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <Zap className="w-4 h-4 text-amber-300" />
                      )}
                      <span>انتشار فوری به مقصد انتخاب‌شده</span>
                    </button>

                    <div className="border-t border-slate-800 pt-3">
                      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                        <span className="text-xs font-bold text-slate-300">یا تنظیم برای زمان‌بندی:</span>
                        <input 
                          type="datetime-local" 
                          value={scheduledTime}
                          onChange={(e) => setScheduledTime(e.target.value)}
                          className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 outline-none"
                        />
                      </div>

                      <button 
                        onClick={handleManualSchedule}
                        disabled={!manualFile}
                        className="w-full bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white font-semibold py-2 rounded-lg text-xs transition border border-slate-700 flex items-center justify-center gap-2"
                      >
                        <Calendar className="w-3.5 h-3.5 text-indigo-400" />
                        <span>قرار دادن در صف زمان‌بندی ابری</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </div>
        )}

        {/* TAB 2: QUEUE */}
        {activeTab === 'queue' && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4 mb-4">
              <div className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-indigo-400" />
                <h2 className="text-base font-bold text-slate-200">صف پست‌های زمان‌بندی‌شده</h2>
                <span className="text-xs text-slate-400">({posts.filter(p => p.status === 'pending').length} مورد در صف)</span>
              </div>

              {/* Filter */}
              <div className="flex items-center gap-2 text-xs">
                <Filter className="w-3.5 h-3.5 text-slate-400" />
                <span>فیلتر پلتفرم:</span>
                <select 
                  value={filterPlatform}
                  onChange={(e) => setFilterPlatform(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1 text-xs text-slate-200 outline-none"
                >
                  <option value="all">همه پلتفرم‌ها</option>
                  <option value="instagram">اینستاگرام</option>
                  <option value="youtube">یوتیوب</option>
                  <option value="telegram">تلگرام</option>
                  <option value="aparat">آپارات</option>
                </select>
              </div>
            </div>

            {filteredPosts.filter(p => p.status === 'pending').length === 0 ? (
              <div className="py-16 text-center text-slate-500 border border-dashed border-slate-800 rounded-xl bg-slate-950/20">
                <Calendar className="w-10 h-10 text-slate-700 mx-auto mb-3" />
                <p className="text-sm font-semibold">هیچ پستی در صف این پلتفرم نیست.</p>
                <p className="text-xs text-slate-600 mt-1">با ارسال ویدیو در ربات بله، پست‌ها به صورت پایدار در دیتابیس ابری ذخیره می‌شوند.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {filteredPosts.filter(p => p.status === 'pending').map(post => (
                  <div key={post.id} className="border border-slate-800 bg-slate-950 rounded-xl p-4 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="text-xs font-bold text-indigo-300 uppercase px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20">
                          {post.platform} [{post.account}] ➔ {post.format}
                        </span>
                        <span className="text-[11px] text-amber-400 font-mono flex items-center gap-1">
                          <Clock className="w-3 h-3" /> {post.scheduledTime}
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 bg-slate-900/60 p-2.5 rounded-lg border border-slate-850 max-h-24 overflow-y-auto leading-relaxed">
                        {post.caption}
                      </p>
                    </div>

                    <div className="mt-4 pt-3 border-t border-slate-850 flex items-center justify-between">
                      <button 
                        onClick={() => handlePublishNow(post.id)}
                        disabled={isPublishingPostId === post.id}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 shadow"
                      >
                        {isPublishingPostId === post.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                        <span>انتشار همین حالا</span>
                      </button>

                      <button 
                        onClick={() => handleDeletePost(post.id)}
                        className="text-slate-400 hover:text-red-400 p-1.5 rounded-lg hover:bg-slate-800 transition"
                        title="لغو زمان‌بندی"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 3: HISTORY */}
        {activeTab === 'history' && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-4">
              <h2 className="text-base font-bold text-slate-200 flex items-center gap-2">
                <History className="w-5 h-5 text-indigo-400" />
                <span>تاریخچه و گزارش پست‌های منتشرشده</span>
              </h2>
            </div>

            {posts.filter(p => p.status === 'published' || p.status === 'failed').length === 0 ? (
              <div className="py-16 text-center text-slate-500 border border-dashed border-slate-800 rounded-xl bg-slate-950/20">
                <p className="text-sm font-semibold">هنوز پستی منتشر نشده است.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {posts.filter(p => p.status === 'published' || p.status === 'failed').map(post => (
                  <div key={post.id} className="border border-slate-800 bg-slate-950 rounded-xl p-4 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="text-xs font-bold text-indigo-300 uppercase px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20">
                          {post.platform} [{post.account}] ➔ {post.format}
                        </span>
                        {post.status === 'published' ? (
                          <span className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1">
                            <CheckCircle className="w-3 h-3" /> موفق ({post.publishedAt})
                          </span>
                        ) : (
                          <span className="text-[11px] text-red-400 font-semibold flex items-center gap-1">
                            <XCircle className="w-3 h-3" /> ناموفق
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-300 bg-slate-900/60 p-2.5 rounded-lg border border-slate-850 max-h-24 overflow-y-auto leading-relaxed">
                        {post.caption}
                      </p>
                      {post.publishError && (
                        <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-[11px] text-red-400 font-mono">
                          {post.publishError}
                        </div>
                      )}
                    </div>

                    <div className="mt-3 pt-2 border-t border-slate-850 flex items-center justify-between text-[11px] text-slate-500">
                      <span>درایور: {post.driverType}</span>
                      <button onClick={() => handleDeletePost(post.id)} className="text-slate-400 hover:text-red-400">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 4: TARGETS OVERVIEW */}
        {activeTab === 'targets' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-sm">
              <h2 className="text-base font-bold text-slate-200 mb-2 flex items-center gap-2">
                <Tv className="w-5 h-5 text-indigo-400" />
                <span>پلتفرم‌ها و کانال‌های شناخته‌شده در رندر</span>
              </h2>
              <p className="text-xs text-slate-400 mb-4">
                سرور به صورت داینامیک تمام متغیرهای با الگوی <code>TARGET_PLATFORM_ACCOUNT_FORMAT</code> را می‌شناسد.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {targets.map(t => (
                  <div key={t.key} className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-xs text-slate-200">{t.platformTitle}</span>
                      <span className="text-[10px] font-mono bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded border border-indigo-500/20">
                        {t.driverType === 'webhook' ? 'Make.com' : 'اتصال مستقیم'}
                      </span>
                    </div>
                    <div className="text-xs text-slate-300">
                      اکانت: <span className="font-mono text-emerald-400 font-bold">{t.account}</span>
                    </div>
                    <div className="text-xs text-slate-400">
                      فرمت: <span className="text-slate-200">{t.formatTitle}</span>
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono truncate" title={t.key}>
                      متغیر: {t.key}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: LOGS */}
        {activeTab === 'logs' && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-4">
              <h2 className="text-base font-bold text-slate-200 flex items-center gap-2">
                <Terminal className="w-5 h-5 text-indigo-400" />
                <span>کنسول زنده سیستم چندکاناله</span>
              </h2>
            </div>

            <div className="bg-slate-950 rounded-xl p-4 border border-slate-850 font-mono text-xs overflow-hidden flex flex-col h-[520px]">
              <div className="flex-1 overflow-y-auto space-y-2 pr-2">
                {logs.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-slate-600">هنوز لاگی ثبت نشده است...</div>
                ) : (
                  logs.map((log, idx) => (
                    <div key={idx} className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 border-b border-slate-900/50 pb-2">
                      <span className="text-slate-500 shrink-0 font-sans">{log.timestamp}</span>
                      <span className={`font-bold shrink-0 text-[10px] px-1.5 py-0.5 rounded ${
                        log.level === 'SUCCESS' ? 'bg-emerald-500/10 text-emerald-400' :
                        log.level === 'ERROR' ? 'bg-red-500/10 text-red-400' :
                        log.level === 'WARNING' ? 'bg-amber-500/10 text-amber-400' :
                        'bg-slate-800 text-slate-300'
                      }`}>
                        {log.level}
                      </span>
                      <span className="text-slate-400 font-bold shrink-0">{log.source}:</span>
                      <span className="text-slate-200 whitespace-pre-wrap">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* FOOTER */}
      <footer className="border-t border-slate-900 bg-slate-950 py-4 text-center text-xs text-slate-500">
        <p>پلتفرم چندکاناله انتشار خودکار محتوا (Omni-Channel Content Automation Platform)</p>
      </footer>
    </div>
  );
}
