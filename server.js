import path from 'node:path';
import express from 'express';
import { loadEnv } from './lib/env.js';

loadEnv();

// 這些模組在 top-level 讀 process.env（DATA_ROOT、上限值、模型名），
// 所以要在 loadEnv() 之後才 import，不能用會被提升的 static import。
const {
  BUCKETS, DATA_ROOT, HttpError, buildCorpus, deleteFile,
  ensureDirs, listFiles, readTextFile, resolveRaw, saveUpload,
} = await import('./lib/store.js');
const { DEFAULT_MODEL, generateJson, hasApiKey, listModels, streamText } = await import('./lib/gemini.js');
const {
  CHAT_SYSTEM_INSTRUCTION, FALLBACK_QUESTIONS, GAP_SCHEMA, SYSTEM_INSTRUCTION,
  buildChatContents, buildParts,
} = await import('./lib/prompts.js');
const { getRun, listRuns, newRunId, saveRun } = await import('./lib/runs.js');

const app = express();
const PORT = Number(process.env.PORT ?? 5173);

app.use(express.json({ limit: process.env.JSON_LIMIT ?? '32mb' }));
app.use(express.static(path.resolve('public'), { extensions: ['html'] }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/config', wrap(async (_req, res) => {
  res.json({
    hasApiKey: hasApiKey(),
    defaultModel: DEFAULT_MODEL,
    dataRoot: DATA_ROOT,
    fallbackQuestions: FALLBACK_QUESTIONS,
    buckets: Object.entries(BUCKETS).map(([key, meta]) => ({ key, ...meta })),
  });
}));

app.get('/api/files', wrap(async (_req, res) => {
  res.json(await listFiles());
}));

app.get('/api/files/:bucket/:name', wrap(async (req, res) => {
  const text = await readTextFile(req.params.bucket, req.params.name);
  res.json({ bucket: req.params.bucket, name: req.params.name, text });
}));

// 原檔內容（圖檔、PDF 預覽用）。data/ 不在 public/ 底下，所以走這條而非 static。
app.get('/api/raw/:bucket/:name', wrap(async (req, res) => {
  const { full, mimeType } = await resolveRaw(req.params.bucket, req.params.name);
  res.type(mimeType).sendFile(full);
}));

app.post('/api/files', wrap(async (req, res) => {
  const { bucket, name, dataBase64 } = req.body ?? {};
  res.json(await saveUpload(bucket, name, dataBase64));
}));

app.delete('/api/files/:bucket/:name', wrap(async (req, res) => {
  res.json(await deleteFile(req.params.bucket, req.params.name));
}));

app.get('/api/models', wrap(async (_req, res) => {
  if (!hasApiKey()) return res.json({ models: [], reason: 'no-api-key' });
  try {
    res.json({ models: await listModels() });
  } catch (err) {
    // 列不到模型不該擋住分析，前端會退回預設型號。
    res.json({ models: [], reason: err.message });
  }
}));

app.post('/api/analyze', wrap(async (req, res) => {
  const { selection, focus, handoverContext, model, label } = req.body ?? {};

  const corpus = await buildCorpus(Array.isArray(selection) ? selection : []);
  if (corpus.texts.length === 0 && corpus.media.length === 0) {
    throw new HttpError(400, '沒有可分析的文件。請先在 data/ 放檔案或從網頁上傳。');
  }

  const parts = buildParts({ ...corpus, focus, handoverContext });
  const started = Date.now();
  const { data, usage } = await generateJson({
    model,
    parts,
    systemInstruction: SYSTEM_INSTRUCTION,
    schema: GAP_SCHEMA,
  });

  const run = {
    id: newRunId(),
    createdAt: new Date().toISOString(),
    label: label ?? '',
    focus: focus ?? '',
    handoverContext: handoverContext ?? '',
    elapsedMs: Date.now() - started,
    usage,
    inputs: [...corpus.texts, ...corpus.media].map((d) => ({
      bucket: d.bucket,
      name: d.name,
      truncated: Boolean(d.truncated),
    })),
    skipped: corpus.skipped,
    result: data,
  };

  await saveRun(run);
  res.json(run);
}));

// 問答。回覆以 SSE 串流，前端邊收邊顯示。
app.post('/api/chat', wrap(async (req, res) => {
  const { selection, messages, runId, model, handoverContext } = req.body ?? {};

  const history = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .slice(-20);                       // 只帶最近 20 則，避免對話越長越貴
  if (history.length === 0) throw new HttpError(400, '沒有問題內容。');

  const corpus = await buildCorpus(Array.isArray(selection) ? selection : []);
  if (corpus.texts.length === 0 && corpus.media.length === 0) {
    throw new HttpError(400, '沒有可參考的文件。請先在 data/ 放檔案或從網頁上傳。');
  }

  // 帶上先前的分析結果當背景；找不到就純粹問文件。
  let analysis = null;
  if (runId) {
    try {
      analysis = (await getRun(runId)).result;
    } catch { /* 紀錄被清掉了就略過 */ }
  }

  const contents = buildChatContents({ ...corpus, handoverContext, analysis, messages: history });

  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders();

  try {
    for await (const chunk of streamText({
      model,
      contents,
      systemInstruction: CHAT_SYSTEM_INSTRUCTION,
    })) {
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    // 標頭已送出，錯誤只能走事件流回報。
    res.write(`data: ${JSON.stringify({ error: err.message ?? '回答失敗' })}\n\n`);
  }
  res.end();
}));

app.get('/api/runs', wrap(async (_req, res) => {
  res.json({ runs: await listRuns() });
}));

app.get('/api/runs/:id', wrap(async (req, res) => {
  res.json(await getRun(req.params.id));
}));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  // 預期內的錯誤（設定缺失、上游回應）只印訊息；沒帶 status 的才是真的 bug，印堆疊。
  if (err.status === undefined) console.error('[error]', err);
  else if (status >= 500) console.error(`[error] ${err.message}`);
  res.status(status).json({ error: err.message ?? '未預期的錯誤' });
});

await ensureDirs();
app.listen(PORT, () => {
  console.log(`\n  交接缺口分析系統  →  http://localhost:${PORT}`);
  console.log(`  資料夾            →  ${DATA_ROOT}`);
  console.log(`  模型              →  ${DEFAULT_MODEL}`);
  if (!hasApiKey()) {
    console.log('\n  ⚠ 尚未設定 GEMINI_API_KEY：可以瀏覽與上傳文件，但無法執行分析。');
    console.log('    cp .env.example .env  然後填入金鑰，再重新啟動。\n');
  } else {
    console.log('');
  }
});
