import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './store.js';

// 分析結果落地存檔，重開瀏覽器還看得到上次的缺口分析。
const RUNS_DIR = path.resolve(process.env.RUNS_DIR ?? 'runs');
const KEEP = 50;

const ID_RE = /^[0-9a-z_-]+$/i;

export async function saveRun(run) {
  await fs.mkdir(RUNS_DIR, { recursive: true });
  const file = path.join(RUNS_DIR, `${run.id}.json`);
  await fs.writeFile(file, JSON.stringify(run, null, 2), 'utf8');
  await prune();
  return run;
}

async function prune() {
  const entries = (await fs.readdir(RUNS_DIR)).filter((f) => f.endsWith('.json')).sort();
  for (const stale of entries.slice(0, Math.max(0, entries.length - KEEP))) {
    await fs.rm(path.join(RUNS_DIR, stale), { force: true });
  }
}

export async function listRuns() {
  try {
    const entries = (await fs.readdir(RUNS_DIR)).filter((f) => f.endsWith('.json'));
    const runs = [];
    for (const entry of entries) {
      const raw = await fs.readFile(path.join(RUNS_DIR, entry), 'utf8');
      const run = JSON.parse(raw);
      runs.push({
        id: run.id,
        createdAt: run.createdAt,
        label: run.label ?? '',
        model: run.usage?.model ?? '',
        score: run.result?.readiness?.score ?? null,
        gapCount: run.result?.gaps?.length ?? 0,
        fileCount: run.inputs?.length ?? 0,
      });
    }
    return runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function getRun(id) {
  if (!ID_RE.test(String(id ?? ''))) throw new HttpError(400, 'run id 不合法');
  try {
    return JSON.parse(await fs.readFile(path.join(RUNS_DIR, `${id}.json`), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new HttpError(404, '找不到這筆分析紀錄');
    throw err;
  }
}

export function newRunId(date = new Date()) {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${iso}-${Math.random().toString(36).slice(2, 6)}`;
}
