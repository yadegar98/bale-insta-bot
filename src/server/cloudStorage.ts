import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Local fallback path in data directory
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const LOCAL_STORAGE_FILE = path.join(DATA_DIR, 'posts.json');

export interface ScheduledPostItem {
  id: string;
  fileId: string; // Bale file_id (kept permanently on Bale CDN)
  fileUniqueId?: string;
  mediaType: 'video' | 'photo' | 'text' | 'round_video';
  mimeType?: string;
  filename: string;
  platform: string; // e.g. 'instagram', 'youtube', 'telegram', 'aparat'
  account: string; // e.g. 'PAGE1', 'MYCHANNEL'
  format: string; // e.g. 'reels', 'shorts', 'video', 'story', 'community'
  targetWebhookUrl?: string; // If webhook based (Make.com)
  targetDirectDestination?: string; // If direct based (e.g. '@mychannel' for Telegram)
  driverType: 'webhook' | 'telegram' | 'aparat' | 'direct';
  caption: string;
  scheduledTime: string; // ISO string or YYYY-MM-DD HH:mm:ss (Asia/Tehran)
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
  forcePublish?: boolean;
}

export class CloudStorageManager {
  private apiKey: string;
  private binId: string;
  private inMemoryCache: ScheduledPostItem[] = [];
  private isLoaded = false;

  constructor() {
    this.apiKey = (process.env.JSONBIN_API_KEY || '').trim();
    this.binId = (process.env.JSONBIN_BIN_ID || '').trim();
    this.loadFromLocal();
  }

  public updateCredentials(apiKey: string, binId: string) {
    this.apiKey = apiKey.trim();
    this.binId = binId.trim();
  }

  public isCloudConfigured(): boolean {
    return Boolean(this.apiKey && this.binId);
  }

  private loadFromLocal(): ScheduledPostItem[] {
    try {
      if (fs.existsSync(LOCAL_STORAGE_FILE)) {
        const raw = fs.readFileSync(LOCAL_STORAGE_FILE, 'utf-8');
        this.inMemoryCache = JSON.parse(raw);
        return this.inMemoryCache;
      }
    } catch (e) {
      console.error('[Storage] Error loading local storage:', e);
    }
    this.inMemoryCache = [];
    return [];
  }

  private saveToLocal(items: ScheduledPostItem[]) {
    try {
      fs.writeFileSync(LOCAL_STORAGE_FILE, JSON.stringify(items, null, 2));
    } catch (e) {
      console.error('[Storage] Error saving to local storage:', e);
    }
  }

  /**
   * Fetch all records from JSONBin.io (or local fallback)
   */
  public async getAllPosts(forceRefresh = false): Promise<ScheduledPostItem[]> {
    if (this.isLoaded && !forceRefresh) {
      return this.inMemoryCache;
    }

    if (!this.isCloudConfigured()) {
      this.isLoaded = true;
      return this.loadFromLocal();
    }

    try {
      const url = `https://api.jsonbin.io/v3/b/${this.binId}/latest`;
      const res = await fetch(url, {
        headers: {
          'X-Master-Key': this.apiKey,
        },
      });

      if (res.ok) {
        const json = await res.json();
        // jsonbin v3 wraps content in "record"
        const records = Array.isArray(json.record) ? json.record : (Array.isArray(json) ? json : []);
        this.inMemoryCache = records;
        this.isLoaded = true;
        this.saveToLocal(records);
        return records;
      } else {
        console.warn(`[JSONBin] Fetch failed (${res.status}). Falling back to local storage.`);
        return this.loadFromLocal();
      }
    } catch (err: any) {
      console.warn(`[JSONBin] Network error: ${err.message}. Using local storage.`);
      return this.loadFromLocal();
    }
  }

  /**
   * Sync memory cache and local file up to JSONBin.io
   */
  public async syncToCloud(items: ScheduledPostItem[]): Promise<boolean> {
    this.inMemoryCache = items;
    this.saveToLocal(items);

    if (!this.isCloudConfigured()) {
      return true; // Saved locally
    }

    try {
      const url = `https://api.jsonbin.io/v3/b/${this.binId}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': this.apiKey,
        },
        body: JSON.stringify(items),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[JSONBin] Sync error (${res.status}): ${errText}`);
        return false;
      }
      return true;
    } catch (err: any) {
      console.error(`[JSONBin] Sync network error: ${err.message}`);
      return false;
    }
  }

  /**
   * Add a new post item
   */
  public async addPost(post: ScheduledPostItem): Promise<ScheduledPostItem> {
    const list = await this.getAllPosts();
    list.unshift(post);
    await this.syncToCloud(list);
    return post;
  }

  /**
   * Update an existing post item
   */
  public async updatePost(id: string, updates: Partial<ScheduledPostItem>): Promise<ScheduledPostItem | null> {
    const list = await this.getAllPosts();
    const index = list.findIndex(p => p.id === id);
    if (index === -1) return null;

    list[index] = { ...list[index], ...updates };
    await this.syncToCloud(list);
    return list[index];
  }

  /**
   * Delete a post item
   */
  public async deletePost(id: string): Promise<boolean> {
    let list = await this.getAllPosts();
    const prevLen = list.length;
    list = list.filter(p => p.id !== id);
    if (list.length === prevLen) return false;

    await this.syncToCloud(list);
    return true;
  }

  /**
   * Get all active future pending posts for server boot recovery
   */
  public async getPendingScheduledPosts(): Promise<ScheduledPostItem[]> {
    const list = await this.getAllPosts(true);
    return list.filter(p => p.status === 'pending');
  }
}

export const cloudStorage = new CloudStorageManager();
