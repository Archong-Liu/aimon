import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 資料夾即資料庫。data/ 下四個 bucket 對應交接分析的四種輸入。
// ---------------------------------------------------------------------------
export const BUCKETS = {
  jd: {
    dir: 'jd',
    label: '職務說明 (JD)',
    hint: '這個職位該負責什麼 — 交接的「應該」那一半',
  },
  product: {
    dir: 'product',
    label: '產品架構',
    hint: '架構圖、模組說明。支援圖檔與 PDF',
  },
  'customer-list': {
    dir: 'customer-list',
    label: '客戶名單',
    hint: '誰是客戶、規模、負責人、合約狀態',
  },
  'customer-status': {
    dir: 'customer-status',
    label: '客戶狀態與交涉紀錄',
    hint: '近幾次交涉成果、卡點、下一步',
  },
};

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
]);
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const DOC_MIME = { '.pdf': 'application/pdf' };

const MAX_FILE_CHARS = Number(process.env.MAX_FILE_CHARS ?? 60_000);
const MAX_TOTAL_CHARS = Number(process.env.MAX_TOTAL_CHARS ?? 400_000);
const MAX_BINARY_BYTES = Number(process.env.MAX_BINARY_BYTES ?? 12 * 1024 * 1024);

export const DATA_ROOT = path.resolve(process.env.DATA_DIR ?? 'data');

export function bucketKeys() {
  return Object.keys(BUCKETS);
}

function bucketDir(bucket) {
  const meta = BUCKETS[bucket];
  if (!meta) throw new HttpError(400, `未知的資料分類: ${bucket}`);
  return path.join(DATA_ROOT, meta.dir);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 上傳與刪除都只認 basename，並在解析後再確認仍落在 bucket 內，擋掉 ../ 與絕對路徑。
function safeJoin(bucket, name) {
  const base = path.basename(String(name ?? '').trim());
  if (!base || base === '.' || base === '..' || base.startsWith('.')) {
    throw new HttpError(400, `檔名不合法: ${name}`);
  }
  const dir = bucketDir(bucket);
  const full = path.resolve(dir, base);
  if (path.dirname(full) !== path.resolve(dir)) {
    throw new HttpError(400, `檔名不合法: ${name}`);
  }
  return { base, full };
}

export function classify(name) {
  const ext = path.extname(name).toLowerCase();
  if (TEXT_EXT.has(ext)) return { kind: 'text', mimeType: 'text/plain' };
  if (IMAGE_MIME[ext]) return { kind: 'image', mimeType: IMAGE_MIME[ext] };
  if (DOC_MIME[ext]) return { kind: 'doc', mimeType: DOC_MIME[ext] };
  return { kind: 'unsupported', mimeType: null };
}

export async function ensureDirs() {
  for (const key of bucketKeys()) {
    await fs.mkdir(bucketDir(key), { recursive: true });
  }
}

export async function listFiles() {
  await ensureDirs();
  const out = {};

  for (const [key, meta] of Object.entries(BUCKETS)) {
    const dir = bucketDir(key);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const stat = await fs.stat(path.join(dir, entry.name));
      const { kind, mimeType } = classify(entry.name);
      files.push({
        bucket: key,
        name: entry.name,
        size: stat.size,
        mtime: stat.mtimeMs,
        kind,
        mimeType,
      });
    }

    files.sort((a, b) => a.name.localeCompare(b.name));
    out[key] = { ...meta, key, files };
  }

  return out;
}

export async function readTextFile(bucket, name) {
  const { full } = safeJoin(bucket, name);
  const { kind } = classify(name);
  if (kind !== 'text') throw new HttpError(400, '這個檔案不是純文字，無法預覽');
  return await fs.readFile(full, 'utf8');
}

/** 解析出原檔的絕對路徑與 MIME，供 raw 預覽路由使用。 */
export async function resolveRaw(bucket, name) {
  const { full, base } = safeJoin(bucket, name);
  const { kind, mimeType } = classify(base);
  if (kind === 'unsupported') throw new HttpError(400, '不支援預覽這個格式');

  try {
    await fs.access(full);
  } catch {
    throw new HttpError(404, `找不到檔案: ${bucket}/${base}`);
  }
  return { full, mimeType: kind === 'text' ? 'text/plain; charset=utf-8' : mimeType };
}

export async function saveUpload(bucket, name, base64) {
  const { base, full } = safeJoin(bucket, name);
  const { kind } = classify(base);
  if (kind === 'unsupported') {
    throw new HttpError(400, `不支援的檔案格式: ${path.extname(base) || base}`);
  }

  const buf = Buffer.from(String(base64 ?? ''), 'base64');
  if (buf.length === 0) throw new HttpError(400, '檔案是空的');
  if (buf.length > MAX_BINARY_BYTES) {
    throw new HttpError(413, `檔案超過 ${(MAX_BINARY_BYTES / 1024 / 1024).toFixed(0)}MB 上限`);
  }

  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buf);
  return { bucket, name: base, size: buf.length, kind };
}

export async function deleteFile(bucket, name) {
  const { full, base } = safeJoin(bucket, name);
  await fs.rm(full, { force: true });
  return { bucket, name: base };
}

/**
 * 把選定的檔案讀成 Gemini 要的兩種 part：文字與 inline binary。
 * selection 為 [{bucket, name}]；傳空則代表全選。
 */
export async function buildCorpus(selection) {
  const catalog = await listFiles();
  const wanted = new Set(
    (selection ?? []).map((f) => `${f.bucket}/${f.name}`),
  );
  const takeAll = wanted.size === 0;

  const texts = [];
  const media = [];
  const skipped = [];
  let totalChars = 0;

  for (const [key, group] of Object.entries(catalog)) {
    for (const file of group.files) {
      if (!takeAll && !wanted.has(`${key}/${file.name}`)) continue;

      const { full } = safeJoin(key, file.name);

      if (file.kind === 'text') {
        let text = await fs.readFile(full, 'utf8');
        let truncated = false;

        if (text.length > MAX_FILE_CHARS) {
          text = text.slice(0, MAX_FILE_CHARS);
          truncated = true;
        }
        if (totalChars + text.length > MAX_TOTAL_CHARS) {
          const room = Math.max(0, MAX_TOTAL_CHARS - totalChars);
          if (room < 500) {
            skipped.push({ ...file, reason: '超過總文字量上限，未送出' });
            continue;
          }
          text = text.slice(0, room);
          truncated = true;
        }

        totalChars += text.length;
        texts.push({
          bucket: key,
          bucketLabel: group.label,
          name: file.name,
          text,
          truncated,
        });
        continue;
      }

      if (file.kind === 'image' || file.kind === 'doc') {
        const buf = await fs.readFile(full);
        if (buf.length > MAX_BINARY_BYTES) {
          skipped.push({ ...file, reason: '檔案過大，未送出' });
          continue;
        }
        media.push({
          bucket: key,
          bucketLabel: group.label,
          name: file.name,
          mimeType: file.mimeType,
          data: buf.toString('base64'),
        });
        continue;
      }

      skipped.push({ ...file, reason: '不支援的格式' });
    }
  }

  return { texts, media, skipped, totalChars };
}
