const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;
// ===== DUIX 配置（可通过环境变量覆盖）=====
// 当前使用：【新账号】
const DUIX_APP_ID = process.env.DUIX_APP_ID || '1534880283902480384';
const DUIX_APP_KEY = process.env.DUIX_APP_KEY || '48ef4297-0a0e-48a4-a799-3a04c58aba14';
// 备选：【旧账号】需要切换时取消下面注释并注释上面两行
// const DUIX_APP_ID = process.env.DUIX_APP_ID || '1534647758940672000';
// const DUIX_APP_KEY = process.env.DUIX_APP_KEY || 'f3ef7a0b-85ea-4636-a2a9-e1e2758c72df';
const DIR = __dirname;
const HIMODELS_BASE_URL = process.env.HIMODELS_BASE_URL || 'https://api.himodels.ai/v1';
const HIMODELS_API_KEY = process.env.HIMODELS_API_KEY || '';
const HIMODELS_MODEL = process.env.HIMODELS_MODEL || 'gpt-5.5';

// UI language → LLM instruction language name
const LANG_NAMES = {
  zh: '简体中文',
  en: 'English',
  fr: 'Français',
  es: 'Español',
  ha: 'Hausa',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ---- Duix JWT Sign Generation ----
function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function generateDuixSign(appId, appKey, sigExp) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { appId, iat: now, exp: now + sigExp };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = headerB64 + '.' + payloadB64;

  const signature = crypto.createHmac('sha256', appKey).update(signingInput).digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return signingInput + '.' + signature;
}

function handleDuixSign(req, res) {
  const expiresIn = 1800;
  const sign = generateDuixSign(DUIX_APP_ID, DUIX_APP_KEY, expiresIn);
  sendJson(res, 200, {
    sign,
    appId: DUIX_APP_ID,
    platform: 'duix.com',
    expiresIn,
  });
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function loadKnowledgeBase() {
  const filePath = path.join(DIR, 'knowledge-base.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  const db = JSON.parse(raw);
  return Array.isArray(db) ? db : (Array.isArray(db.items) ? db.items : []);
}

function retrieveKnowledge(query, limit = 10) {
  const items = loadKnowledgeBase();
  const queryLower = String(query || '').toLowerCase();
  const queryCompact = queryLower.replace(/\s+/g, '');

  // Clean query: remove common question words/phrases (whole words, not individual chars)
  const cleaned = queryLower
    .replace(/[？?！!，,。.]/g, ' ')
    .replace(/的/g, ' ')
    .replace(/是什/g, ' ')
    .replace(/什么/g, ' ')
    .replace(/怎么/g, ' ')
    .replace(/如何/g, ' ')
    .replace(/是谁/g, ' ')
    .replace(/请问/g, ' ')
    .replace(/一下/g, ' ')
    .replace(/整个/g, ' ')
    .replace(/告诉我/g, ' ')
    .replace(/流程是/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract meaningful terms from cleaned query
  const chineseTerms = cleaned.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const latinTerms = (queryLower.match(/[a-z0-9]{2,}/gi) || []).map(t => t.toLowerCase());
  const allTerms = [...chineseTerms, ...latinTerms];

  // Also extract bigrams from the full query for fuzzy matching
  const queryBigrams = new Set();
  const queryChinese = queryLower.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const phrase of queryChinese) {
    for (let i = 0; i <= phrase.length - 2; i++) {
      queryBigrams.add(phrase.substring(i, i + 2));
    }
  }

  const scored = items.map((item, index) => {
    const keywords = Array.isArray(item.q) ? item.q : [];
    const answerText = stripHtml(item.a || '');
    const section = item.section || '';
    const haystack = (keywords.join(' ') + ' ' + section + ' ' + answerText).toLowerCase();
    const haystackCompact = haystack.replace(/\s+/g, '');
    let score = 0;

    // 1. Keyword exact/contains matching (high score)
    for (const kw of keywords) {
      const k = String(kw || '').toLowerCase();
      const kc = k.replace(/\s+/g, '');
      if (!k) continue;
      if (queryLower === k || queryCompact === kc) score += 120;
      else if (queryLower.includes(k) || queryCompact.includes(kc)) score += Math.min(80, k.length * 4);
      else if (k.includes(queryLower) || kc.includes(queryCompact)) score += Math.min(50, queryLower.length * 3);
    }

    // 2. Term matching (medium score) - match cleaned terms against full haystack
    for (const term of allTerms) {
      if (haystack.includes(term)) {
        score += term.length >= 4 ? 15 : 8;
      }
    }

    // 3. Bigram matching (low score, for fuzzy matching)
    let bigramMatches = 0;
    for (const bg of queryBigrams) {
      if (haystackCompact.includes(bg)) bigramMatches++;
    }
    score += Math.min(bigramMatches * 3, 30);

    // 4. Intent-based bonuses
    if (/对接|联系人|联系|谁|负责人|contact|owner/.test(queryLower) && /对接|联系人|运营|contact|owner|@/.test(haystack)) score += 50;
    if (/\biap\b|iap|应用内购买|混变/.test(queryLower) && /iap|应用内购买|混变/i.test(haystack)) score += 35;
    if (/\biaa\b|iaa|应用内广告/.test(queryLower) && /iaa|应用内广告/i.test(haystack)) score += 35;
    if (/ee1/i.test(queryLower) && /ee1/i.test(haystack)) score += 25;

    return { item, index, score };
  });

  // Return top items: prefer positive scores, fallback to top by score
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const positive = scored.filter(x => x.score > 0);
  const result = positive.length > 0 ? positive.slice(0, limit) : scored.slice(0, Math.min(limit, 5));
  return result.map(x => ({
    q: x.item.q,
    a: x.item.a,
    source: x.item.source,
    section: x.item.section,
    score: x.score,
  }));
}

async function callLLM(question, contexts, lang) {
  const knowledgeText = contexts.map((ctx, idx) => {
    const title = Array.isArray(ctx.q) && ctx.q.length ? ctx.q[0] : (ctx.section || `知识片段${idx + 1}`);
    return `【资料${idx + 1}】${title}\n来源：${ctx.source || '本地知识库'}${ctx.section ? ` / ${ctx.section}` : ''}\n内容：${stripHtml(ctx.a).slice(0, 3000)}`;
  }).join('\n\n');

  const replyLang = LANG_NAMES[lang] || '简体中文';

  const response = await fetch(`${HIMODELS_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${HIMODELS_API_KEY}`,
    },
    body: JSON.stringify({
      model: HIMODELS_MODEL,
      messages: [
        {
          role: 'system',
          content: '你是 Sales AI 销售赋能平台的AI答疑助手。你必须优先基于用户提供的本地知识库资料回答。回答时请尽量保留原文中的人名（带@）、邮箱、链接URL、时间节点、金额、比例等详细信息。\n\n请使用以下 Markdown 格式组织回答，让内容清晰可读：\n- 使用 **粗体** 标记关键术语、人名、金额、比例\n- 使用 `- ` 或 `1. ` 开头的列表来列举步骤、对接人、材料等\n- 使用 `### ` 小标题分隔不同主题（如：### 对接人、### 流程步骤、### 所需材料）\n- 引用原文中的邮箱、链接时，使用 `[描述](URL)` 格式\n- 重要提醒用 `> ` 引用块突出\n- 不要使用表格格式\n\n若提供的资料与问题相关，请基于资料详细回答；若资料完全无关，则说明"本地知识库暂未覆盖"。不要编造联系人、流程、链接或政策。请使用' + replyLang + '回答。',
        },
        {
          role: 'user',
          content: `用户问题：${question}\n\n本地知识库检索结果：\n${knowledgeText || '无相关资料'}`,
        },
      ],
      temperature: 0.2,
      stream: false,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || data.message || `HTTP ${response.status}`;
    throw new Error(message);
  }
  const answer = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
  if (!answer) throw new Error('LLM response is empty');
  return answer;
}

async function handleAsk(req, res) {
  try {
    const rawBody = await readRequestBody(req);
    const body = rawBody ? JSON.parse(rawBody) : {};
    const question = String(body.question || '').trim();
    const lang = body.lang || 'zh';
    if (!question) return sendJson(res, 400, { error: 'Question is required' });

    const contexts = retrieveKnowledge(question, 10);
    const answer = await callLLM(question, contexts, lang);
    sendJson(res, 200, {
      answer,
      model: HIMODELS_MODEL,
      matched: contexts.map(ctx => ({ q: ctx.q, source: ctx.source, section: ctx.section, score: ctx.score })),
    });
  } catch (err) {
    console.error('Ask API error:', err);
    sendJson(res, 500, {
      error: 'AI答疑接口调用失败',
      detail: err.message,
    });
  }
}

const PRACTICE_SYSTEM_PROMPTS = {
  caleb: '你是 Caleb，一个尼日利亚电信运营商的市场合作总监。你正在与传音（Transsion）的销售代表进行商务会议。\n你的性格：友好但精明，对价格敏感，会追问细节和ROI数据。你喜欢用具体的数字说话。\n你的目标：了解对方的方案是否真的适合自己的公司，争取最优价格和合作条件。\n\n规则：\n- 用英文回答，偶尔可以插入简短的本地表达\n- 每次回复控制在2-4句话，保持对话节奏\n- 可以提出质疑、追问细节、要求更多数据\n- 不要一次性把所有信息都说完\n- 如果对方表现好，可以逐渐展示兴趣；如果对方含糊，可以表示疑虑\n- 用第一人称对话，自然流畅',

  emma: '你是 Emma，一家欧洲大型企业的市场营销副总裁。你正在评估传音（Transsion）的广告合作方案。\n你的性格：专业、优雅但高标准。你对流程合规和数据隐私非常重视。\n你的目标：确保合作方案在数据安全、品牌调性和商业回报上都符合欧洲标准。\n\n规则：\n- 用英文回答，保持专业礼貌\n- 每次回复控制在2-4句话\n- 关注合规性、数据保护、品牌匹配度\n- 会要求对方提供具体的案例和数据\n- 不要一次性同意所有条款\n- 用第一人称对话，专业且自然',

  kai: '你是 Kai，中国某大型企业的市场部总监。你正在与传音（Transsion）的销售代表谈广告投放合作。\n你的性格：务实、直接，看中结果和性价比。对行业比较了解，不容易被忽悠。\n你的目标：找到最适合自己预算和目标的广告方案，同时建立可靠的合作关系。\n\n规则：\n- 用简体中文回答\n- 每次回复控制在2-4句话\n- 关注投放效果、费用明细、服务保障\n- 可以直接指出对方方案的不足或疑虑\n- 如果方案合理，也会爽快表示认可\n- 用第一人称对话，自然流畅',

  sofia: '你是 Sofia，一个法语区电信运营商的商务总监。你正在评估传音（Transsion）的市场合作提案。\n你的性格：优雅而精明，注重长期合作关系。对非洲市场非常了解。\n你的目标：确保合作能为你的运营商带来差异化竞争优势，同时控制成本。\n\n规则：\n- 用法语回答，保持优雅礼貌\n- 每次回复控制在2-4句话\n- 关注市场差异化、用户增长、长期价值\n- 会追问竞品对比和本地化方案\n- 如果方案有吸引力，会表达兴趣但保持谈判余地\n- 用第一人称对话，自然流畅',
};

async function handlePractice(req, res) {
  try {
    const rawBody = await readRequestBody(req);
    const body = rawBody ? JSON.parse(rawBody) : {};
    const message = String(body.message || '').trim();
    const avatar = body.avatar || 'caleb';
    const scenario = String(body.scenario || '').trim();
    const history = Array.isArray(body.history) ? body.history : [];
    const lang = body.lang || 'en';
    const uiLang = body.uiLang || '';

    const systemPrompt = PRACTICE_SYSTEM_PROMPTS[avatar] || PRACTICE_SYSTEM_PROMPTS['caleb'];
    let fullSystemPrompt = systemPrompt + '\n\n当前演练场景：' + scenario + '\n\n请以这个角色身份开始或继续对话。';
    // Override response language to match the UI language selected by user
    if (uiLang && LANG_NAMES[uiLang]) {
      fullSystemPrompt += '\n\n重要：无论你的角色设定中指定了什么语言，请始终使用' + LANG_NAMES[uiLang] + '回复用户。';
    }

    // If no message and no history, generate an opening line
    const effectiveMsg = message || (history.length === 0 ? '你好，我们今天来聊一下合作。' : '');

    if (!effectiveMsg && history.length === 0) return sendJson(res, 400, { error: 'Message or history is required' });

    const messages = [
      { role: 'system', content: fullSystemPrompt },
      ...history,
    ];
    if (effectiveMsg) {
      messages.push({ role: 'user', content: effectiveMsg });
    }

    const response = await fetch(`${HIMODELS_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HIMODELS_API_KEY}`,
      },
      body: JSON.stringify({
        model: HIMODELS_MODEL,
        messages,
        temperature: 0.8,
        stream: false,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data.error?.message || data.message || `HTTP ${response.status}`;
      throw new Error(msg);
    }
    const reply = data.choices?.[0]?.message?.content || '';

    sendJson(res, 200, { reply, model: HIMODELS_MODEL });
  } catch (err) {
    console.error('Practice API error:', err);
    sendJson(res, 500, { error: '演练接口调用失败', detail: err.message });
  }
}

async function handlePracticeScore(req, res) {
  try {
    const rawBody = await readRequestBody(req);
    const body = rawBody ? JSON.parse(rawBody) : {};
    const history = Array.isArray(body.history) ? body.history : [];
    const scenario = String(body.scenario || '').trim();
    const avatar = body.avatar || 'caleb';
    const lang = body.lang || 'zh';
    const scoreLang = LANG_NAMES[lang] || '简体中文';

    if (history.length === 0) return sendJson(res, 400, { error: 'History is required' });

    const systemPrompt = `你是一个销售演练评分专家。根据以下对话记录对销售代表的表现进行评分和反馈。
评分维度（每项20分，总分100分）：
1. 开场与建立关系 (rapport)
2. 需求挖掘 (discovery)
3. 方案呈现 (presentation)
4. 异议处理 (objection_handling)
5. 促成闭环 (closing)

请用 JSON 格式返回，所有评语和总结请使用${scoreLang}：
{
  "total": 85,
  "dimensions": {
    "rapport": { "score": 18, "comment": "开场友好，快速建立联系" },
    "discovery": { "score": 15, "comment": "需求挖掘可以更深入" },
    "presentation": { "score": 17, "comment": "方案表达清晰" },
    "objection_handling": { "score": 17, "comment": "能较好应对客户质疑" },
    "closing": { "score": 18, "comment": "有明确的下一步行动计划" }
  },
  "summary": "总体表现出色，展现了良好的销售素养...",
  "tips": ["可以提前准备更多数据支持论点", "在客户表达疑虑时多使用确认性语言"]
}`;

    const convoText = history.map(h => (h.role === 'user' ? '销售代表' : '客户') + '：' + h.content).join('\n');

    const response = await fetch(`${HIMODELS_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HIMODELS_API_KEY}`,
      },
      body: JSON.stringify({
        model: HIMODELS_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `演练场景：${scenario}\n\n对话记录：\n${convoText}` },
        ],
        temperature: 0.3,
        stream: false,
      }),
    });

    const data = await response.json().catch(() => ({}));
    const content = data.choices?.[0]?.message?.content || '{}';
    // Try to parse JSON from response
    let scoreData;
    try {
      scoreData = JSON.parse(content);
    } catch {
      scoreData = { total: 80, summary: '评估生成异常，默认评分。', dimensions: {}, tips: [] };
    }
    sendJson(res, 200, scoreData);
  } catch (err) {
    console.error('Practice score API error:', err);
    sendJson(res, 500, { error: '评分接口调用失败', detail: err.message });
  }
}

function handleRequest(req, res) {
  const proto = req.socket.encrypted ? 'https' : 'http';
  const parsedUrl = new URL(req.url, `${proto}://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && parsedUrl.pathname === '/api/ask') {
    handleAsk(req, res);
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/practice') {
    handlePractice(req, res);
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/practice/score') {
    handlePracticeScore(req, res);
    return;
  }

  if (parsedUrl.pathname === '/api/duix/sign') {
    handleDuixSign(req, res);
    return;
  }

  if (parsedUrl.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, model: HIMODELS_MODEL });
    return;
  }

  const requestPath = parsedUrl.pathname === '/' ? '/sales-enablement-demo.html' : parsedUrl.pathname;
  const filePath = path.normalize(path.join(DIR, requestPath));
  if (!filePath.startsWith(DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

const server = http.createServer(handleRequest);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server running at http://0.0.0.0:${PORT}/`);
  console.log(`LLM proxy enabled: ${HIMODELS_BASE_URL}, model=${HIMODELS_MODEL}`);
});

const certDir = path.join(DIR, 'certs');
const keyPath = path.join(certDir, 'localhost-key.pem');
const certPath = path.join(certDir, 'localhost-cert.pem');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const httpsServer = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  }, handleRequest);

  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`HTTPS server running at https://0.0.0.0:${HTTPS_PORT}/`);
  });
} else {
  console.warn('HTTPS certificate not found. Run openssl generation first to enable HTTPS.');
}

// Keep-alive heartbeat
setInterval(() => process.stdout.write('.'), 30000);
