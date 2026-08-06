const fs = require('fs');
const https = require('https');

const API_KEY = 'sk-147539412f7a27979d9cdd72e98ccfeef14aca6a86ad97de';
const MODEL = 'gpt-5.5';
const PROJECT = '/Users/shmiyangkuan/Downloads/sales-enablement-demo';
const SRC_DIR = PROJECT + '/原始答疑知识库';
const KB_PATH = PROJECT + '/knowledge-base.json';

function callLLM(messages) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: MODEL,
      messages: messages,
      temperature: 0.3,
    });

    const options = {
      hostname: 'api.himodels.ai',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.error) reject(new Error(json.error.message || JSON.stringify(json.error)));
          else resolve(json.choices[0].message.content);
        } catch(e) {
          reject(new Error('Parse error: ' + e.message + ', body: ' + body.slice(0,800)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function parseQA(text) {
  let cleaned = text.trim();
  // Strip markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // Find the JSON array
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found in response');
  cleaned = cleaned.substring(start, end + 1);
  return JSON.parse(cleaned);
}

async function main() {
  // Read documents - use Chinese portions only for efficiency
  const adDocFull = fs.readFileSync(SRC_DIR + '/Advertisement Cooperation Process V4.0 （广告业务合作流程 V4.0） .md', 'utf8');
  const adDoc = adDocFull.split('# 英文（In English）')[0];

  const gameDocFull = fs.readFileSync(SRC_DIR + '/游戏联运业务运营流程_V2.1（Game Joint Operation Business Process_V2.1 ）.md', 'utf8');
  const gameDoc = gameDocFull.split('# 英文（In English）')[0];

  const systemPrompt = '你是一个知识库问答抽取助手。你需要仔细阅读文档原文，生成尽可能多的问答对，覆盖文档中所有重要信息。只输出JSON数组，不要输出任何其他文字。';

  const userPrompt = `请仔细阅读以下文档原文，生成尽可能多的问答知识条目（目标50-80条），必须覆盖文档中的所有重要信息。

严格要求：
1. 每条知识包含 q（关键词数组，5-12个不同问法）和 a（详细回答）
2. 回答 a 必须保留原文中的详细信息：人名（带@符号）、邮箱地址、链接URL、时间节点、金额、比例、系统名称等，绝对不要省略
3. 回答 a 使用HTML格式（可用<b>、<br>、<ul><li>、<a>等标签），每条回答至少100字
4. 覆盖范围必须全面，包括但不限于：
   - 业务概述、合作模式分类
   - 各环节操作步骤（报备、签约、开户、到款、投放、结算、终止）
   - 所有对接人、联系人清单（精确到人名）
   - 邮箱模板的完整内容（标题、收件人、抄送、正文要点）
   - 时间节点要求（几号出账单、几号确认等）
   - 政策要求、准入条件、分成比例
   - 材料链接（保留完整URL）
   - 常见差异对比（直客vs代理、预付vs后付等）
   - 结算流程和起结金额
   - 合作终止流程
   - 开发者平台权限开通流程
   - 增值服务合作流程
5. q 关键词要包含用户可能的多种问法，中英文都要有，包括口语化问法
6. 如果文档中有表格内容，要逐行提取为问答条目

只输出JSON数组，不要包含任何其他文字：
[{"q":["关键词1","关键词2","question in english"],"a":"详细HTML回答"},...]`;

  // Process ad document
  console.log('Processing ad document (' + adDoc.length + ' chars)...');
  const adResult = await callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt + '\n\n---文档原文---\n' + adDoc }
  ]);
  console.log('Ad doc response length:', adResult.length);

  const adItems = parseQA(adResult);
  console.log('Ad doc Q&A items:', adItems.length);

  // Process game document
  console.log('Processing game document (' + gameDoc.length + ' chars)...');
  const gameResult = await callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt + '\n\n---文档原文---\n' + gameDoc }
  ]);
  console.log('Game doc response length:', gameResult.length);

  const gameItems = parseQA(gameResult);
  console.log('Game doc Q&A items:', gameItems.length);

  // Add source info
  adItems.forEach(item => {
    item.source = 'Advertisement Cooperation Process V4.0（广告业务合作流程 V4.0）.md';
  });
  gameItems.forEach(item => {
    item.source = '游戏联运业务运营流程_V2.1（Game Joint Operation Business Process_V2.1）.md';
  });

  // Read existing knowledge base
  const db = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));

  // Keep precise entries (IAP/IAA contacts) and original handcrafted entries
  const preciseEntries = db.items.filter(x => x.section && x.section.includes('精准问答'));
  const handcrafted = db.items.filter(x => !x.source && !x.section);

  console.log('Precise entries kept:', preciseEntries.length);
  console.log('Handcrafted entries kept:', handcrafted.length);

  // Combine: precise first, then LLM generated, then handcrafted
  let allItems = [...preciseEntries, ...adItems, ...gameItems];

  // Deduplicate by first keyword (case insensitive)
  const seen = new Set();
  const deduped = [];
  for (const item of allItems) {
    if (!item.q || !Array.isArray(item.q) || item.q.length === 0) continue;
    if (!item.a || typeof item.a !== 'string') continue;
    const key = item.q[0].toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }

  // Add handcrafted at the end
  const finalItems = [...deduped, ...handcrafted];

  // Backup current file
  const backupPath = KB_PATH.replace('.json', '.backup-llm-' + Date.now() + '.json');
  fs.copyFileSync(KB_PATH, backupPath);
  console.log('Backup saved:', backupPath);

  // Write new knowledge base
  db.version = 3;
  db.name = 'Sales AI 本地知识库（LLM深度抽取版）';
  db.description = 'AI 答疑助手本地知识库。由 gpt-5.5 从原始文档全文深度抽取生成，覆盖业务流程、对接人、邮箱模板、时间节点、政策要求等详细信息。修改后刷新页面即可生效。';
  db.updatedAt = new Date().toISOString().slice(0, 19);
  db.sourceFolder = SRC_DIR;
  db.items = finalItems;

  fs.writeFileSync(KB_PATH, JSON.stringify(db, null, 2), 'utf8');

  console.log('\n=== Summary ===');
  console.log('Ad document Q&A:', adItems.length);
  console.log('Game document Q&A:', gameItems.length);
  console.log('Precise entries:', preciseEntries.length);
  console.log('Handcrafted entries:', handcrafted.length);
  console.log('Deduplicated LLM items:', deduped.length);
  console.log('Total final items:', finalItems.length);
  console.log('Backup:', backupPath);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
