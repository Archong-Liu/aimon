// 把 samples/ 的假資料複製進 data/，方便直接看到系統怎麼跑。
// 已存在的同名檔案會保留，不會覆蓋你自己放的文件。
import fs from 'node:fs/promises';
import path from 'node:path';

const SRC = path.resolve('samples');
const DEST = path.resolve(process.env.DATA_DIR ?? 'data');

let copied = 0;
let skipped = 0;

async function walk(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await walk(from, to);
      continue;
    }
    try {
      await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      copied += 1;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      skipped += 1;
    }
  }
}

try {
  await fs.access(SRC);
} catch {
  console.error(`找不到 ${SRC}`);
  process.exit(1);
}

await walk(SRC, DEST);
console.log(`已複製 ${copied} 個範例檔到 ${DEST}${skipped ? `（${skipped} 個已存在，跳過）` : ''}`);
