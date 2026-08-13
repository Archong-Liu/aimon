import fs from 'node:fs';
import path from 'node:path';

// 極簡 .env 讀取器：只支援 KEY=VALUE 與 # 註解，避免多帶一個依賴。
// 已存在的 process.env 優先，不會被 .env 覆蓋。
export function loadEnv(cwd = process.cwd()) {
  const file = path.join(cwd, '.env');
  if (!fs.existsSync(file)) return;

  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
