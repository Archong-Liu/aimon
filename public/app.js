// ---------------------------------------------------------------------------
// 前端：文件庫管理 + 執行缺口分析 + 結果渲染。原生 ES module，無建置步驟。
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

const el = {
  buckets: $('#buckets'),
  dataRoot: $('#data-root'),
  modelSelect: $('#model-select'),
  keyStatus: $('#key-status'),
  context: $('#context'),
  focus: $('#focus'),
  run: $('#run'),
  status: $('#status'),
  result: $('#result'),
  runs: $('#runs'),
  fileInput: $('#file-input'),
  selectionSummary: $('#selection-summary'),
  chatFab: $('#chat-fab'),
  chat: $('#chat'),
  chatLog: $('#chat-log'),
  chatSuggest: $('#chat-suggest'),
  chatForm: $('#chat-form'),
  chatText: $('#chat-text'),
  chatSend: $('#chat-send'),
  chatScope: $('#chat-scope'),
};

const state = {
  config: null,
  catalog: {},
  selected: new Set(),   // `${bucket}/${name}`
  currentRunId: null,
  busy: false,
  chat: { messages: [], busy: false, suggestions: [] },
  collapsed: new Set(),   // 收合中的區塊 id；跨 render 保留，切換紀錄不會被重設
};

const SEVERITY_LABEL = { high: '高', medium: '中', low: '低' };
const SEVERITY_PILL = { high: 'pill-bad', medium: 'pill-warn', low: 'pill-ok' };
const COVERAGE_LABEL = {
  covered: '已涵蓋', partial: '資訊不足', orphaned: '無人承接', unknown: '無法判斷',
};
const COVERAGE_PILL = {
  covered: 'pill-ok', partial: 'pill-warn', orphaned: 'pill-bad', unknown: 'pill-muted',
};
const MOMENTUM_LABEL = {
  advancing: '推進中', stalled: '停滯', at_risk: '有風險', closed: '已結案', unknown: '不明',
};
const MOMENTUM_PILL = {
  advancing: 'pill-ok', stalled: 'pill-warn', at_risk: 'pill-bad',
  closed: 'pill-muted', unknown: 'pill-muted',
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json;
}

function setStatus(kind, html) {
  if (!kind) {
    el.status.hidden = true;
    el.status.className = 'status';
    el.status.innerHTML = '';
    return;
  }
  el.status.hidden = false;
  el.status.className = `status ${kind}`;
  el.status.innerHTML = html;
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------
async function init() {
  try {
    state.config = await api('/api/config');
  } catch (err) {
    setStatus('error', `無法連線後端：${esc(err.message)}`);
    return;
  }

  el.dataRoot.textContent = state.config.dataRoot;
  el.keyStatus.className = `pill ${state.config.hasApiKey ? 'pill-ok' : 'pill-bad'}`;
  el.keyStatus.textContent = state.config.hasApiKey ? 'API Key 已設定' : '未設定 API Key';

  setModelOptions([{ name: state.config.defaultModel }]);
  state.chat.suggestions = state.config.fallbackQuestions ?? [];
  renderChat();

  await Promise.all([refreshFiles(), refreshRuns(), loadModels()]);
  bindEvents();
}

function setModelOptions(models, selected) {
  const want = selected ?? state.config.defaultModel;
  const names = models.map((m) => m.name);
  if (!names.includes(want)) names.unshift(want);

  el.modelSelect.innerHTML = names
    .map((n) => `<option value="${esc(n)}"${n === want ? ' selected' : ''}>${esc(n)}</option>`)
    .join('');
}

async function loadModels() {
  try {
    const { models } = await api('/api/models');   // 後端已過濾成適合讀長文件的型號
    if (models.length) setModelOptions(models);
  } catch {
    /* 列不到就沿用預設型號 */
  }
}

// ---------------------------------------------------------------------------
// 文件庫
// ---------------------------------------------------------------------------
async function refreshFiles() {
  state.catalog = await api('/api/files');
  renderBuckets();
}

function renderBuckets() {
  el.buckets.innerHTML = Object.values(state.catalog).map((group) => `
    <div class="bucket" data-bucket="${esc(group.key)}">
      <div class="bucket-head">
        <span class="bucket-title">${esc(group.label)}</span>
        <button class="link-btn" data-add="${esc(group.key)}" type="button">＋ 上傳</button>
      </div>
      <p class="bucket-hint">${esc(group.hint)}</p>
      ${group.files.length === 0
        ? '<p class="empty">尚無檔案 — 可拖拉檔案到這一區</p>'
        : `<div class="file-list">${group.files.map((f) => fileRow(group.key, f)).join('')}</div>`}
    </div>
  `).join('');

  updateSelectionSummary();
}

function fileRow(bucket, file) {
  const id = `${bucket}/${file.name}`;
  const ok = file.kind !== 'unsupported';
  return `
    <div class="file-row">
      <input type="checkbox" data-file="${esc(id)}"
        ${state.selected.has(id) ? 'checked' : ''} ${ok ? '' : 'disabled'}>
      <span class="file-name" data-preview="${esc(id)}" title="${esc(file.name)}">${esc(file.name)}</span>
      <span class="file-meta">
        ${ok ? fmtSize(file.size) : '<span class="badge-unsupported">不支援</span>'}
        <button class="del" data-del="${esc(id)}" title="刪除" type="button">×</button>
      </span>
    </div>`;
}

function allFileIds() {
  return Object.values(state.catalog).flatMap((g) =>
    g.files.filter((f) => f.kind !== 'unsupported').map((f) => `${g.key}/${f.name}`));
}

function updateSelectionSummary() {
  const total = allFileIds().length;
  const picked = state.selected.size;
  el.selectionSummary.textContent = total === 0
    ? '文件庫是空的 — 先上傳或把檔案放進 data/'
    : picked === 0
      ? `未勾選任何檔案 → 將分析全部 ${total} 份文件`
      : `已選 ${picked} / ${total} 份文件`;
  el.run.disabled = state.busy || total === 0;
  updateChatScope();
}

async function uploadFiles(bucket, files) {
  for (const file of files) {
    try {
      const dataBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('讀取檔案失敗'));
        reader.readAsDataURL(file);
      });
      await api('/api/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bucket, name: file.name, dataBase64 }),
      });
      setStatus(null);
    } catch (err) {
      setStatus('error', `上傳 ${esc(file.name)} 失敗：${esc(err.message)}`);
    }
  }
  await refreshFiles();
}

async function previewFile(id) {
  const [bucket, ...rest] = id.split('/');
  const name = rest.join('/');
  const file = state.catalog[bucket]?.files.find((f) => f.name === name);
  if (!file || file.kind === 'unsupported') return;

  const dialog = document.createElement('dialog');
  dialog.className = 'preview';
  dialog.innerHTML = `
    <div class="preview-head">
      <strong>${esc(bucket)}/${esc(name)}</strong>
      <button class="ghost-btn" value="close" type="button">關閉</button>
    </div>
    <div class="preview-body"><p class="empty">載入中…</p></div>`;
  dialog.querySelector('button').onclick = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();

  const body = dialog.querySelector('.preview-body');
  const url = `/api/raw/${encodeURIComponent(bucket)}/${encodeURIComponent(name)}`;
  if (file.kind === 'image') {
    body.innerHTML = `<img src="${url}" alt="${esc(name)}">`;
  } else if (file.kind === 'doc') {
    body.innerHTML = `<iframe src="${url}" title="${esc(name)}"></iframe>`;
  } else {
    try {
      const { text } = await api(`/api/files/${encodeURIComponent(bucket)}/${encodeURIComponent(name)}`);
      body.innerHTML = `<pre>${esc(text)}</pre>`;
    } catch (err) {
      body.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    }
  }
}

// ---------------------------------------------------------------------------
// 分析
// ---------------------------------------------------------------------------
async function runAnalysis() {
  if (state.busy) return;
  if (!state.config.hasApiKey) {
    setStatus('error', '尚未設定 GEMINI_API_KEY，無法執行分析。請在專案根目錄建立 .env 後重啟伺服器。');
    return;
  }

  state.busy = true;
  el.run.disabled = true;
  const started = Date.now();
  const tick = setInterval(() => {
    setStatus('working', `<span class="spinner"></span>Gemini 正在比對 JD 與內部文件…（${Math.round((Date.now() - started) / 1000)}s）`);
  }, 500);
  setStatus('working', '<span class="spinner"></span>Gemini 正在比對 JD 與內部文件…');

  try {
    const selection = [...state.selected].map((id) => {
      const [bucket, ...rest] = id.split('/');
      return { bucket, name: rest.join('/') };
    });

    const run = await api('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selection,
        focus: el.focus.value,
        handoverContext: el.context.value,
        model: el.modelSelect.value,
      }),
    });

    setStatus(null);
    renderRun(run);
    await refreshRuns();
  } catch (err) {
    setStatus('error', `分析失敗：${esc(err.message)}`);
  } finally {
    clearInterval(tick);
    state.busy = false;
    updateSelectionSummary();
  }
}

// ---------------------------------------------------------------------------
// 結果渲染
// ---------------------------------------------------------------------------
function renderRun(run) {
  state.currentRunId = run.id;
  const r = run.result ?? {};
  const gaps = [...(r.gaps ?? [])].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
  });

  el.result.innerHTML = [
    readinessPanel(run, r, gaps),
    gapsPanel(gaps),
    customersPanel(r.customers ?? []),
    docsPanel(r.missing_documents ?? []),
    checklistPanel(r.handover_checklist ?? []),
    inputsPanel(run),
  ].join('');

  el.result.querySelector('[data-export]')?.addEventListener('click', () => exportMarkdown(run));
  el.result.querySelector('[data-toggle-all]')?.addEventListener('click', () => {
    const sections = [...el.result.querySelectorAll('details[data-section]')];
    const collapse = sections.some((d) => d.open);   // 只要還有展開的就全收，否則全開
    sections.forEach((d) => { d.open = !collapse; });
  });
  syncToggleAllLabel();
  el.result.querySelector('[data-copy]')?.addEventListener('click', async (ev) => {
    await navigator.clipboard.writeText(toMarkdown(run));
    ev.target.textContent = '已複製 ✓';
    setTimeout(() => { ev.target.textContent = '複製 Markdown'; }, 1600);
  });
  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  markActiveRun();

  // 建議問題改用模型針對這批文件生的，比預設那組具體得多。
  const suggested = r.suggested_questions ?? [];
  state.chat.suggestions = suggested.length ? suggested : (state.config.fallbackQuestions ?? []);
  renderChat({ keepScroll: true });
}

function syncToggleAllLabel() {
  const btn = el.result.querySelector('[data-toggle-all]');
  if (!btn) return;
  const sections = [...el.result.querySelectorAll('details[data-section]')];
  btn.textContent = sections.some((d) => d.open) ? '全部收合' : '全部展開';
}

/** 可收合的結果區塊。用原生 details/summary，鍵盤操作與無障礙都不用自己實作。 */
function section(id, title, bodyHtml) {
  return `
  <details class="panel section" data-section="${esc(id)}"${state.collapsed.has(id) ? '' : ' open'}>
    <summary class="panel-head section-head">
      <h2>${esc(title)}</h2>
      <span class="chev" aria-hidden="true"></span>
    </summary>
    <div class="section-body">${bodyHtml}</div>
  </details>`;
}

function readinessPanel(run, r, gaps) {
  const score = Number(r.readiness?.score ?? 0);
  const color = score >= 70 ? 'var(--low)' : score >= 40 ? 'var(--medium)' : 'var(--high)';
  const blocking = gaps.filter((g) => g.blocking).length;
  const high = gaps.filter((g) => g.severity === 'high').length;
  const orphaned = (r.customers ?? []).filter((c) => c.coverage === 'orphaned').length;

  return `
  <div class="panel">
    <div class="result-head">
      <div class="panel-head" style="margin:0"><h2>交接準備度</h2></div>
      <div class="result-tools">
        <button class="ghost-btn" data-toggle-all type="button"></button>
        <button class="ghost-btn" data-copy type="button">複製 Markdown</button>
        <button class="ghost-btn" data-export type="button">下載 .md</button>
      </div>
    </div>
    <div class="readiness">
      <div class="gauge" style="--pct:${Math.max(0, Math.min(100, score))};--gauge-color:${color}">
        <span class="gauge-num">${score}<small>/100</small></span>
      </div>
      <div>
        <div class="readiness-verdict">${esc(r.readiness?.verdict)}</div>
        <p class="readiness-headline">${esc(r.readiness?.headline)}</p>
        <div class="readiness-stats">
          <span class="pill ${blocking ? 'pill-bad' : 'pill-ok'}">阻擋交接 ${blocking} 項</span>
          <span class="pill ${high ? 'pill-warn' : 'pill-muted'}">高風險缺口 ${high} 項</span>
          <span class="pill ${orphaned ? 'pill-bad' : 'pill-muted'}">無人承接客戶 ${orphaned} 家</span>
          <span class="pill pill-muted">${esc(run.usage?.model ?? '')} · ${(run.elapsedMs / 1000).toFixed(1)}s</span>
        </div>
      </div>
    </div>
  </div>`;
}

function gapsPanel(gaps) {
  if (!gaps.length) return section('gaps', '銜接缺口', '<p class="empty">沒有找到缺口。</p>');

  return section('gaps', `銜接缺口 · ${gaps.length} 項`, `
    <div class="gap-list">
      ${gaps.map((g) => `
        <article class="gap ${esc(g.severity)}">
          <div class="gap-head">
            <span class="gap-title">${esc(g.title)}</span>
            ${g.blocking ? '<span class="pill pill-bad">阻擋交接</span>' : ''}
            <span class="pill ${SEVERITY_PILL[g.severity] ?? 'pill-muted'}">${SEVERITY_LABEL[g.severity] ?? g.severity}</span>
            <span class="pill pill-accent">${esc(g.category)}</span>
          </div>
          <p class="gap-detail">${esc(g.detail)}</p>
          <div class="gap-grid">
            <div class="gap-cell"><h4>不處理的後果</h4>${esc(g.impact)}</div>
            <div class="gap-cell"><h4>交接前動作${g.ask_from ? ` · 找 ${esc(g.ask_from)}` : ''}</h4>${esc(g.action)}</div>
          </div>
          ${(g.evidence ?? []).length ? `<ul class="evidence">${g.evidence.map((e) => `
            <li><code>${esc(e.source)}</code>${esc(e.detail)}</li>`).join('')}</ul>` : ''}
        </article>`).join('')}
    </div>`);
}

function customersPanel(customers) {
  if (!customers.length) return '';
  return section('customers', `客戶覆蓋盤點 · ${customers.length} 家`, `
    <div class="table-scroll">
      <table class="customers">
        <thead><tr>
          <th>客戶</th><th>承接狀況</th><th>交涉走向</th><th>最近一次交涉</th><th>未結事項</th><th>必補資訊</th>
        </tr></thead>
        <tbody>
          ${customers.map((c) => `
            <tr>
              <td><strong>${esc(c.name)}</strong></td>
              <td><span class="pill ${COVERAGE_PILL[c.coverage] ?? 'pill-muted'}">${COVERAGE_LABEL[c.coverage] ?? esc(c.coverage)}</span></td>
              <td><span class="pill ${MOMENTUM_PILL[c.momentum] ?? 'pill-muted'}">${MOMENTUM_LABEL[c.momentum] ?? esc(c.momentum)}</span></td>
              <td>${esc(c.last_touch)}</td>
              <td>${listCell(c.open_items)}</td>
              <td>${listCell(c.missing_info)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`);
}

function listCell(items) {
  if (!items?.length) return '<span class="footnote">—</span>';
  return `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
}

function docsPanel(docs) {
  if (!docs.length) return '';
  return section('docs', `交接前必須補齊的文件 · ${docs.length} 份`, `
    <div class="doc-list">
      ${docs.map((d) => `
        <div class="doc-item">
          <strong>${esc(d.what)}</strong>
          <span>為什麼需要：${esc(d.why)}　·　哪裡拿：${esc(d.where_to_get)}</span>
        </div>`).join('')}
    </div>`);
}

function checklistPanel(items) {
  if (!items.length) return '';
  return section('checklist', `交接檢查清單 · ${items.length} 項`, `
    <ul class="checklist">
      ${items.map((it, i) => `
        <li>
          <input type="checkbox" id="chk-${i}">
          <div>
            <div class="item-text">${esc(it.item)}</div>
            <div class="why">${esc(it.why)}</div>
          </div>
          <span class="pill pill-muted">${esc(it.owner)}</span>
        </li>`).join('')}
    </ul>`);
}

function inputsPanel(run) {
  const inputs = run.inputs ?? [];
  const skipped = run.skipped ?? [];
  return section('inputs', `本次分析依據 · ${inputs.length} 份文件`, `
    <p class="footnote">
      ${inputs.length} 份文件：${inputs.map((i) => `<code>${esc(i.bucket)}/${esc(i.name)}</code>${i.truncated ? '（截斷）' : ''}`).join('、') || '—'}
    </p>
    ${skipped.length ? `<p class="footnote">未送出：${skipped.map((s) => `<code>${esc(s.bucket)}/${esc(s.name)}</code>（${esc(s.reason)}）`).join('、')}</p>` : ''}
    <p class="footnote">
      tokens：prompt ${run.usage?.promptTokens ?? '—'} / output ${run.usage?.outputTokens ?? '—'}
      · 紀錄 id <code>${esc(run.id)}</code>
    </p>`);
}

// ---------------------------------------------------------------------------
// 匯出
// ---------------------------------------------------------------------------
function toMarkdown(run) {
  const r = run.result ?? {};
  const out = [];
  out.push('# 交接銜接缺口分析', '');
  out.push(`- 產生時間：${run.createdAt}`);
  out.push(`- 模型：${run.usage?.model ?? ''}`);
  out.push(`- 依據文件：${(run.inputs ?? []).map((i) => `${i.bucket}/${i.name}`).join('、')}`);
  if (run.handoverContext) out.push(`- 交接背景：${run.handoverContext}`);
  if (run.focus) out.push(`- 聚焦：${run.focus}`);
  out.push('');

  out.push('## 交接準備度', '');
  out.push(`**${r.readiness?.score ?? '—'}/100 — ${r.readiness?.verdict ?? ''}**`, '');
  out.push(r.readiness?.headline ?? '', '');

  out.push('## 銜接缺口', '');
  for (const g of r.gaps ?? []) {
    out.push(`### [${SEVERITY_LABEL[g.severity] ?? g.severity}]${g.blocking ? '（阻擋交接）' : ''} ${g.title}`);
    out.push(`- 類別：${g.category}`);
    out.push(`- 說明：${g.detail}`);
    out.push(`- 後果：${g.impact}`);
    out.push(`- 動作：${g.action}${g.ask_from ? `（找 ${g.ask_from}）` : ''}`);
    for (const e of g.evidence ?? []) out.push(`- 依據 \`${e.source}\`：${e.detail}`);
    out.push('');
  }

  if ((r.customers ?? []).length) {
    out.push('## 客戶覆蓋盤點', '');
    out.push('| 客戶 | 承接狀況 | 交涉走向 | 最近一次交涉 | 未結事項 | 必補資訊 |');
    out.push('|---|---|---|---|---|---|');
    for (const c of r.customers) {
      const cell = (v) => (v?.length ? v.join('；') : '—');
      out.push(`| ${c.name} | ${COVERAGE_LABEL[c.coverage] ?? c.coverage} | ${MOMENTUM_LABEL[c.momentum] ?? c.momentum} | ${c.last_touch} | ${cell(c.open_items)} | ${cell(c.missing_info)} |`);
    }
    out.push('');
  }

  if ((r.missing_documents ?? []).length) {
    out.push('## 交接前必須補齊的文件', '');
    for (const d of r.missing_documents) out.push(`- **${d.what}** — ${d.why}（來源：${d.where_to_get}）`);
    out.push('');
  }

  if ((r.handover_checklist ?? []).length) {
    out.push('## 交接檢查清單', '');
    for (const it of r.handover_checklist) out.push(`- [ ] （${it.owner}）${it.item} — ${it.why}`);
    out.push('');
  }

  return out.join('\n');
}

function exportMarkdown(run) {
  const blob = new Blob([toMarkdown(run)], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `handover-gap-${run.id}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------------------
// 歷史紀錄
// ---------------------------------------------------------------------------
async function refreshRuns() {
  const { runs } = await api('/api/runs');
  el.runs.innerHTML = runs.length === 0
    ? '<p class="empty">還沒有分析紀錄</p>'
    : runs.map((r) => `
      <div class="run-row" data-run="${esc(r.id)}">
        <div>
          <div>${r.score ?? '—'} 分 · ${r.gapCount} 個缺口</div>
          <div class="run-when">${fmtWhen(r.createdAt)} · ${r.fileCount} 份文件</div>
        </div>
        <span class="pill ${(r.score ?? 0) >= 70 ? 'pill-ok' : (r.score ?? 0) >= 40 ? 'pill-warn' : 'pill-bad'}">${esc((r.model ?? '').replace('gemini-', ''))}</span>
      </div>`).join('');
  markActiveRun();
}

function markActiveRun() {
  el.runs.querySelectorAll('.run-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.run === state.currentRunId);
  });
}

// ---------------------------------------------------------------------------
// 提問視窗
// ---------------------------------------------------------------------------

// 極簡 markdown：先跳脫再套規則，只支援模型實際會用到的 `code`、**粗體**、清單、標題。
function mdInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderMd(text) {
  const out = [];
  let list = null;

  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)$/);

    if (bullet) {
      const tag = bullet[1] ? 'ol' : 'ul';
      if (list !== tag) {
        if (list) out.push(`</${list}>`);
        out.push(`<${tag}>`);
        list = tag;
      }
      out.push(`<li>${mdInline(bullet[2])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    if (!line.trim()) continue;

    if (/^#{1,4}\s/.test(line)) {
      out.push(`<p class="md-h">${mdInline(line.replace(/^#{1,4}\s/, ''))}</p>`);
    } else {
      out.push(`<p>${mdInline(line)}</p>`);
    }
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}

function renderChat({ keepScroll = false } = {}) {
  const { messages, busy, suggestions } = state.chat;

  el.chatLog.innerHTML = messages.length === 0
    ? '<p class="chat-empty">問題會依據目前選取的文件與最新一次缺口分析來回答。<br>可以直接點下方的建議問題。</p>'
    : messages.map((m) => `
      <div class="msg ${m.role}">
        <div class="msg-bubble${m.error ? ' error' : ''}">
          ${m.role === 'user' ? esc(m.content).replace(/\n/g, '<br>') : renderMd(m.content) || '<span class="typing"></span>'}
        </div>
      </div>`).join('');

  el.chatSuggest.innerHTML = suggestions
    .map((q) => `<button class="suggest-btn" type="button" data-q="${esc(q)}" ${busy ? 'disabled' : ''}>${esc(q)}</button>`)
    .join('');

  el.chatSend.disabled = busy;
  el.chatSend.textContent = busy ? '回答中…' : '送出';
  updateChatScope();

  if (!keepScroll) el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function updateChatScope() {
  const picked = state.selected.size;
  const total = allFileIds().length;
  el.chatScope.textContent =
    `依據 ${picked === 0 ? `全部 ${total}` : picked} 份文件` +
    (state.currentRunId ? ' · 含最新分析結果' : '');
}

function openChat(prefill) {
  el.chat.hidden = false;
  el.chatFab.hidden = true;
  renderChat();
  if (prefill) {
    el.chatText.value = prefill;
    autoGrow();
  }
  el.chatText.focus();
}

function closeChat() {
  el.chat.hidden = true;
  el.chatFab.hidden = false;
}

function autoGrow() {
  el.chatText.style.height = 'auto';
  el.chatText.style.height = `${Math.min(140, el.chatText.scrollHeight)}px`;
}

async function ask(question) {
  const text = String(question ?? '').trim();
  if (!text || state.chat.busy) return;

  if (!state.config.hasApiKey) {
    state.chat.messages.push({ role: 'assistant', content: '尚未設定 GEMINI_API_KEY，無法回答。請在 .env 填入金鑰後重啟伺服器。', error: true });
    renderChat();
    return;
  }

  state.chat.messages.push({ role: 'user', content: text });
  const reply = { role: 'assistant', content: '' };
  state.chat.messages.push(reply);
  state.chat.busy = true;
  el.chatText.value = '';
  autoGrow();
  renderChat();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selection: [...state.selected].map((id) => {
          const [bucket, ...rest] = id.split('/');
          return { bucket, name: rest.join('/') };
        }),
        // 失敗訊息用佔位字串送出，才不會把錯誤內容餵回模型、又能維持 user/model 交替。
        messages: state.chat.messages.slice(0, -1).map((m) => ({
          role: m.role,
          content: m.error ? '（上一題回答失敗，略過）' : m.content,
        })),
        runId: state.currentRunId,
        model: el.modelSelect.value,
        handoverContext: el.context.value,
      }),
    });

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error ?? `${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const event of events) {
        const line = event.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        const json = JSON.parse(payload);
        if (json.error) throw new Error(json.error);
        reply.content += json.text ?? '';
        renderChat();
      }
    }

    if (!reply.content) {
      reply.content = '（沒有收到回覆內容，請再試一次）';
      reply.error = true;
    }
  } catch (err) {
    reply.content = `回答失敗：${err.message}`;
    reply.error = true;
  } finally {
    state.chat.busy = false;
    renderChat();
  }
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------
function bindEvents() {
  el.run.addEventListener('click', runAnalysis);

  $('#select-all').addEventListener('click', () => {
    state.selected = new Set(allFileIds());
    renderBuckets();
  });
  $('#select-none').addEventListener('click', () => {
    state.selected.clear();
    renderBuckets();
  });

  el.buckets.addEventListener('change', (ev) => {
    const id = ev.target.dataset?.file;
    if (!id) return;
    if (ev.target.checked) state.selected.add(id);
    else state.selected.delete(id);
    updateSelectionSummary();
  });

  el.buckets.addEventListener('click', async (ev) => {
    const add = ev.target.dataset?.add;
    if (add) {
      el.fileInput.dataset.bucket = add;
      el.fileInput.click();
      return;
    }
    const del = ev.target.dataset?.del;
    if (del) {
      const [bucket, ...rest] = del.split('/');
      const name = rest.join('/');
      if (!confirm(`確定刪除 ${bucket}/${name}?`)) return;
      await api(`/api/files/${encodeURIComponent(bucket)}/${encodeURIComponent(name)}`, { method: 'DELETE' });
      state.selected.delete(del);
      await refreshFiles();
      return;
    }
    const preview = ev.target.dataset?.preview;
    if (preview) previewFile(preview);
  });

  el.fileInput.addEventListener('change', async () => {
    const bucket = el.fileInput.dataset.bucket;
    if (bucket && el.fileInput.files.length) await uploadFiles(bucket, [...el.fileInput.files]);
    el.fileInput.value = '';
  });

  // 拖拉上傳：以滑鼠落點所在的 bucket 為目標
  el.buckets.addEventListener('dragover', (ev) => {
    const bucket = ev.target.closest?.('.bucket');
    if (!bucket) return;
    ev.preventDefault();
    el.buckets.querySelectorAll('.bucket.dragover').forEach((b) => b.classList.remove('dragover'));
    bucket.classList.add('dragover');
  });
  el.buckets.addEventListener('dragleave', (ev) => {
    ev.target.closest?.('.bucket')?.classList.remove('dragover');
  });
  el.buckets.addEventListener('drop', async (ev) => {
    const bucket = ev.target.closest?.('.bucket');
    if (!bucket) return;
    ev.preventDefault();
    bucket.classList.remove('dragover');
    const files = [...(ev.dataTransfer?.files ?? [])];
    if (files.length) await uploadFiles(bucket.dataset.bucket, files);
  });

  // toggle 事件不會冒泡，要用捕獲階段接。收合狀態記在 state，重繪或切換紀錄都保留。
  el.result.addEventListener('toggle', (ev) => {
    const id = ev.target?.dataset?.section;
    if (!id) return;
    if (ev.target.open) state.collapsed.delete(id);
    else state.collapsed.add(id);
    syncToggleAllLabel();
  }, true);

  // --- 提問視窗 ---
  el.chatFab.addEventListener('click', () => openChat());
  $('#chat-close').addEventListener('click', closeChat);
  $('#chat-clear').addEventListener('click', () => {
    state.chat.messages = [];
    renderChat();
  });

  el.chatSuggest.addEventListener('click', (ev) => {
    const q = ev.target.dataset?.q;
    if (q) ask(q);
  });

  el.chatForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    ask(el.chatText.value);
  });

  el.chatText.addEventListener('input', autoGrow);
  el.chatText.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      ask(el.chatText.value);
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !el.chat.hidden && !document.querySelector('dialog.preview[open]')) closeChat();
  });

  el.runs.addEventListener('click', async (ev) => {
    const row = ev.target.closest('.run-row');
    if (!row) return;
    try {
      renderRun(await api(`/api/runs/${encodeURIComponent(row.dataset.run)}`));
      setStatus(null);
    } catch (err) {
      setStatus('error', esc(err.message));
    }
  });
}

init();
