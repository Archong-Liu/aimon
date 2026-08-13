// ---------------------------------------------------------------------------
// 缺口分析的 prompt 與輸出 schema。
// 產出刻意做成結構化 JSON，前端才能把嚴重度、客戶覆蓋狀況排版出來。
// ---------------------------------------------------------------------------

export const GAP_CATEGORIES = [
  '職責無人承接',
  '客戶無人負責',
  '資料缺漏',
  '產品知識斷點',
  '客戶關係風險',
  '流程與權限未移轉',
];

const SEVERITIES = ['high', 'medium', 'low'];
const COVERAGE = ['covered', 'partial', 'orphaned', 'unknown'];
const MOMENTUM = ['advancing', 'stalled', 'at_risk', 'closed', 'unknown'];

// Gemini responseSchema（OpenAPI 子集）。propertyOrdering 讓輸出欄位順序穩定。
export const GAP_SCHEMA = {
  type: 'object',
  properties: {
    readiness: {
      type: 'object',
      properties: {
        score: {
          type: 'integer',
          description: '0-100，交接準備度。資料越缺、孤兒客戶越多，分數越低。',
        },
        verdict: {
          type: 'string',
          description: '一句話結論，例如「可交接但需補三份文件」或「尚不可交接」。',
        },
        headline: {
          type: 'string',
          description: '兩到三句話的整體風險摘要，講清楚最致命的斷點是什麼。',
        },
      },
      required: ['score', 'verdict', 'headline'],
      propertyOrdering: ['score', 'verdict', 'headline'],
    },
    gaps: {
      type: 'array',
      description: 'JD 職責與內部文件對照後找到的缺口，依嚴重度由高到低排列。',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '缺口標題，具體到可以直接當待辦。' },
          category: { type: 'string', enum: GAP_CATEGORIES },
          severity: { type: 'string', enum: SEVERITIES },
          blocking: {
            type: 'boolean',
            description: 'true 代表這個缺口沒補完就不該正式交接。',
          },
          detail: { type: 'string', description: '缺口本身的說明：缺什麼、為什麼算缺。' },
          evidence: {
            type: 'array',
            description: '判斷依據。source 用實際檔名；沒有任何文件提到時，source 填「無文件涵蓋」。',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string' },
                detail: { type: 'string' },
              },
              required: ['source', 'detail'],
              propertyOrdering: ['source', 'detail'],
            },
          },
          impact: { type: 'string', description: '不處理會怎樣，講具體後果。' },
          action: { type: 'string', description: '交接前該做的一件具體動作。' },
          ask_from: {
            type: 'string',
            description: '該向誰要這份資訊或決策（角色名即可，例如「原負責人」「PM」）。',
          },
        },
        required: ['title', 'category', 'severity', 'blocking', 'detail', 'evidence', 'impact', 'action'],
        propertyOrdering: [
          'title', 'category', 'severity', 'blocking', 'detail',
          'evidence', 'impact', 'action', 'ask_from',
        ],
      },
    },
    customers: {
      type: 'array',
      description: '客戶名單逐一盤點，含名單上有但狀態文件沒提到的客戶。',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          coverage: {
            type: 'string',
            enum: COVERAGE,
            description: 'covered=JD 職責明確涵蓋且交接資訊齊全；partial=有涵蓋但資訊不足；orphaned=沒人承接或名單外；unknown=文件不足以判斷。',
          },
          momentum: {
            type: 'string',
            enum: MOMENTUM,
            description: '近幾次交涉的走向。',
          },
          last_touch: {
            type: 'string',
            description: '最近一次交涉的時間與結果摘要；文件未提供則填「文件未載明」。',
          },
          open_items: { type: 'array', items: { type: 'string' }, description: '未結的承諾或待辦。' },
          missing_info: {
            type: 'array',
            items: { type: 'string' },
            description: '接手前一定要補的資訊（決策者、報價歷史、合約到期日等）。',
          },
        },
        required: ['name', 'coverage', 'momentum', 'last_touch', 'open_items', 'missing_info'],
        propertyOrdering: ['name', 'coverage', 'momentum', 'last_touch', 'open_items', 'missing_info'],
      },
    },
    missing_documents: {
      type: 'array',
      description: '為了完成這次交接必須補齊的文件或資料。',
      items: {
        type: 'object',
        properties: {
          what: { type: 'string' },
          why: { type: 'string' },
          where_to_get: { type: 'string' },
        },
        required: ['what', 'why', 'where_to_get'],
        propertyOrdering: ['what', 'why', 'where_to_get'],
      },
    },
    handover_checklist: {
      type: 'array',
      description: '交接會議前後要逐項確認的清單，依先後順序排。',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string' },
          why: { type: 'string' },
          owner: { type: 'string', description: '該由誰負責，例如「移交人」「接手人」「主管」。' },
        },
        required: ['item', 'why', 'owner'],
        propertyOrdering: ['item', 'why', 'owner'],
      },
    },
    suggested_questions: {
      type: 'array',
      description:
        '接手人看完這份分析後最該追問的問題，5 到 6 題。每題都要針對這批文件的具體內容（點名客戶、模組或條款），' +
        '不要問「有什麼風險」這種通用問題。長度控制在 30 字內，能直接當按鈕文字。',
      items: { type: 'string' },
    },
  },
  required: [
    'readiness', 'gaps', 'customers', 'missing_documents',
    'handover_checklist', 'suggested_questions',
  ],
  propertyOrdering: [
    'readiness', 'gaps', 'customers', 'missing_documents',
    'handover_checklist', 'suggested_questions',
  ],
};

export const SYSTEM_INSTRUCTION = `你是一位資深的業務交接稽核員。你的工作不是寫漂亮的摘要，而是找出交接會出事的地方。

分析方法：
1. 先從 JD 抽出這個職位的每一項具體職責。
2. 逐項去內部文件裡找「誰、對哪個客戶、用什麼產品知識」在支撐這項職責。
3. 找不到支撐的，就是缺口。找到但資訊不完整的，也是缺口（標 partial / medium）。
4. 客戶名單要逐一比對客戶狀態文件：名單上有、狀態文件沒提到的客戶，一律視為 orphaned 或 unknown，不可略過。
5. 產品架構文件（含圖片）用來判斷接手人需要哪些產品知識；客戶用到的模組在架構文件裡沒有說明，就是產品知識斷點。

鐵則：
- 只根據提供的文件推論。文件沒寫的，說「文件未載明」，不要補想像的細節。
- evidence 的 source 必須是實際檔名（例如 customer-status/acme-2024Q4.md）。完全沒有文件涵蓋時，source 寫「無文件涵蓋」。
- 嚴重度看業務損失：營收大的客戶沒人接、快到期的合約沒人知道、談判中途斷線 → high。
- blocking=true 只給「沒補完就不該交接」的項目，寧少不濫。
- readiness.score 要對得起 gaps：有 blocking 缺口就不該給 70 分以上。
- 全部輸出用繁體中文（台灣用語），除了 enum 值與檔名。
- 只輸出符合 schema 的 JSON，不要 markdown 圍籬、不要額外說明。`;

/**
 * 把 corpus 攤平成 Gemini parts。
 * 檔名與分類都明確標出來，模型才能在 evidence／引用裡指到正確的檔案。
 * 缺口分析與問答共用這段，兩邊看到的資料才會一致。
 */
export function buildDocParts({ texts, media, handoverContext }) {
  const parts = [];
  const lines = ['以下是這次交接的所有輸入文件。每份文件都標明分類與檔名，引用時請使用「分類/檔名」。'];

  if (handoverContext?.trim()) {
    lines.push('', '## 交接背景（由使用者提供）', handoverContext.trim());
  }

  parts.push({ text: lines.join('\n') });

  for (const doc of texts) {
    const header = `## [${doc.bucket}] ${doc.bucket}/${doc.name}（${doc.bucketLabel}）` +
      (doc.truncated ? '（內容過長，已截斷）' : '');
    parts.push({ text: `${header}\n\n${doc.text}` });
  }

  for (const item of media) {
    parts.push({
      text: `## [${item.bucket}] ${item.bucket}/${item.name}（${item.bucketLabel}，以下為附件內容）`,
    });
    parts.push({ inlineData: { mimeType: item.mimeType, data: item.data } });
  }

  return parts;
}

export function buildParts({ texts, media, focus, handoverContext }) {
  const parts = buildDocParts({ texts, media, handoverContext });

  const task = [
    '---',
    '任務：對照 JD 職責與上述內部文件，產出「交接銜接缺口分析」。',
    '',
    '必須完成：',
    '- 逐條 JD 職責找出無人承接或資訊不足的部分。',
    '- 客戶名單逐一盤點覆蓋狀況，不可只挑重點客戶。',
    '- 指出客戶狀態文件裡談判中斷、承諾未結、決策者不明的風險。',
    '- 列出交接前必須補齊的文件，以及交接檢查清單。',
  ];

  if (focus?.trim()) {
    task.push('', `使用者特別要求聚焦：${focus.trim()}`);
  }

  const provided = new Set([...texts, ...media].map((d) => d.bucket));
  const absent = ['jd', 'product', 'customer-list', 'customer-status'].filter((b) => !provided.has(b));
  if (absent.length) {
    task.push(
      '',
      `注意：本次沒有提供這些分類的文件：${absent.join('、')}。` +
      '請直接把它視為最高優先的資料缺漏缺口，不要假裝有資料。',
    );
  }

  parts.push({ text: task.join('\n') });
  return parts;
}

// ---------------------------------------------------------------------------
// 問答
// ---------------------------------------------------------------------------

export const CHAT_SYSTEM_INSTRUCTION = `你是交接顧問，正在協助「接手人」讀懂前一位負責人留下的文件。

回答規則：
- 只根據提供的文件回答。文件沒寫就直說「文件裡沒有寫」，並指出該去問誰或去哪找，絕不臆測細節。
- 每個具體事實後面用反引號標出來源檔名，例如「續約談判卡在預算凍漲（\`customer-status/henglong-manufacturing.md\`）」。
- 先給結論再給依據。預設 200 字以內，使用者要求詳細時才展開。
- 涉及金額、日期、聯絡人時務必精確照抄文件，不要四捨五入或改寫。
- 對方是剛接手的人，遇到內部縮寫或產品模組名稱時順帶解釋一句。
- 若問題與交接無關，簡短說明你只能回答這批文件相關的問題。
- 一律用繁體中文（台灣用語）。`;

// 還沒跑過分析時用這組；跑過之後改用模型針對實際文件生成的問題。
export const FALLBACK_QUESTIONS = [
  '哪些客戶沒有人接手？',
  '最近要到期的合約是哪一個？',
  '有哪些沒有結案的承諾？',
  '接手人最該先讀哪幾份文件？',
  '哪些客戶的談判正卡住？',
];

/**
 * 問答的 contents。文件放在第一輪 user turn，之後接真正的對話歷史，
 * 這樣多輪對話不必每輪重貼文件（同一組 parts 也比較容易命中快取）。
 */
export function buildChatContents({ texts, media, handoverContext, analysis, messages }) {
  const parts = buildDocParts({ texts, media, handoverContext });

  if (analysis) {
    parts.push({
      text: '---\n以下是先前針對這批文件跑出來的缺口分析結果（JSON）。' +
        '回答時可以引用它的判斷，但使用者若追問細節，仍以原始文件為準。\n\n' +
        JSON.stringify(analysis),
    });
  }

  const contents = [
    { role: 'user', parts },
    { role: 'model', parts: [{ text: '我已讀完這些文件，請開始提問。' }] },
  ];

  for (const msg of messages) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(msg.content ?? '') }],
    });
  }

  return contents;
}
