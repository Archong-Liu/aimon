import { HttpError } from './store.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

// 用 alias 而非固定版號：Google 會下架舊型號（gemini-2.5-pro 已對新用戶回 404），
// alias 會自己指向當代模型，不會哪天突然壞掉。
export const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-latest';

function apiKey() {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new HttpError(
      500,
      '找不到 GEMINI_API_KEY。請複製 .env.example 成 .env 並填入金鑰後重啟。',
    );
  }
  return key;
}

export function hasApiKey() {
  return Boolean(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY);
}

// Google 的原始訊息不會告訴你「換一個模型就好」，這裡補上可執行的下一步。
function explain(status, message) {
  const base = `Gemini API ${status}: ${message}`;
  if (status === 404 && /no longer available|not found/i.test(message)) {
    return `${base}\n→ 這個型號已下架。請在上方模型下拉改選 gemini-flash-latest 或其他 flash 型號。`;
  }
  if (status === 429) {
    return `${base}\n→ 配額不足。免費方案通常沒有 pro 系列配額，改用 flash 系列；或稍後再試。`;
  }
  if (status === 400 && /API key/i.test(message)) {
    return `${base}\n→ 金鑰無效，請檢查 .env 的 GEMINI_API_KEY。`;
  }
  return base;
}

async function callApi(pathname, { method = 'GET', body, timeoutMs = 300_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${API_ROOT}${pathname}`, {
      method,
      headers: {
        'x-goog-api-key': apiKey(),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      throw new HttpError(res.status, explain(res.status, json?.error?.message ?? json.raw ?? res.statusText));
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new HttpError(504, 'Gemini API 逾時，請減少送出的文件量或改用 flash 模型。');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 這些型號雖然支援 generateContent，但不是拿來讀長文件做推理的，別讓它們塞滿下拉選單。
const OFF_TASK = /image|tts|audio|robotics|lyria|nano-banana|computer-use|embedding|omni|customtools|antigravity|deep-research/;

/**
 * 列出適合本工具的模型。
 * 注意：ListModels 會列出帳號實際不能呼叫的型號（例如已對新用戶下架的 gemini-2.5-pro，
 * 或免費額度沒有配額的 pro 系列），所以清單只是候選，真正能不能跑要看呼叫結果。
 */
export async function listModels() {
  const json = await callApi('/models?pageSize=200');
  const models = (json.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => ({
      name: m.name?.replace(/^models\//, '') ?? '',
      displayName: m.displayName ?? '',
      inputTokenLimit: m.inputTokenLimit ?? 0,
    }))
    .filter((m) => m.name.startsWith('gemini-') && !OFF_TASK.test(m.name) && m.inputTokenLimit >= 200_000);

  // alias（-latest）排最前面，其餘版號由新到舊。
  return models.sort((a, b) => {
    const aliasA = a.name.endsWith('-latest') ? 0 : 1;
    const aliasB = b.name.endsWith('-latest') ? 0 : 1;
    return aliasA - aliasB || b.name.localeCompare(a.name, 'en', { numeric: true });
  });
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** 呼叫 generateContent 並取回結構化 JSON。429/5xx 退避重試兩次。 */
export async function generateJson({ model, parts, systemInstruction, schema, temperature = 0.2 }) {
  const body = {
    contents: [{ role: 'user', parts }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      temperature,
      responseMimeType: 'application/json',
      responseSchema: schema,
      maxOutputTokens: 32_768,
    },
  };

  const target = model || DEFAULT_MODEL;
  let lastErr;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const json = await callApi(`/models/${encodeURIComponent(target)}:generateContent`, {
        method: 'POST',
        body,
      });
      return parseResult(json, target);
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE.has(err.status) || attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

/**
 * 串流版：逐段吐出文字。問答用這條，使用者不必對著轉圈等十幾秒。
 * 走 SSE（alt=sse），每個 data: 是一個 GenerateContentResponse。
 */
export async function* streamText({ model, contents, systemInstruction, temperature = 0.3 }) {
  const target = model || DEFAULT_MODEL;
  const res = await fetch(
    `${API_ROOT}/models/${encodeURIComponent(target)}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey(), 'content-type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemInstruction }] },
        generationConfig: { temperature, maxOutputTokens: 8192 },
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      message = JSON.parse(text)?.error?.message ?? text;
    } catch { /* 保留原文 */ }
    throw new HttpError(res.status, explain(res.status, message));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // Gemini 的 SSE 用 CRLF，先正規化再切；\r\n 也可能跨 chunk 斷開，所以整個 buffer 一起處理。
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

    // SSE 以空行分隔事件；最後一段可能不完整，留在 buffer 等下一批。
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const event of events) {
      const line = event.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }

      if (json.promptFeedback?.blockReason) {
        throw new HttpError(422, `Gemini 拒絕回答：${json.promptFeedback.blockReason}`);
      }
      const text = (json.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('');
      if (text) yield text;
    }
  }
}

function parseResult(json, model) {
  const blocked = json.promptFeedback?.blockReason;
  if (blocked) throw new HttpError(422, `Gemini 拒絕處理這批內容：${blocked}`);

  const candidate = json.candidates?.[0];
  if (!candidate) throw new HttpError(502, 'Gemini 沒有回傳任何結果。');

  const text = (candidate.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();

  if (!text) {
    const reason = candidate.finishReason ?? 'UNKNOWN';
    throw new HttpError(
      502,
      reason === 'MAX_TOKENS'
        ? 'Gemini 輸出被長度上限截斷，請減少送出的文件量。'
        : `Gemini 回傳空內容 (finishReason=${reason})。`,
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // responseSchema 下極少發生；留個兜底以免整次分析白跑。
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new HttpError(502, 'Gemini 回傳的內容不是合法 JSON。');
    }
    data = JSON.parse(text.slice(start, end + 1));
  }

  return {
    data,
    usage: {
      model,
      promptTokens: json.usageMetadata?.promptTokenCount ?? null,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? null,
      totalTokens: json.usageMetadata?.totalTokenCount ?? null,
      finishReason: candidate.finishReason ?? null,
    },
  };
}
