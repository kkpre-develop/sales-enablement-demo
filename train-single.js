const fs = require('fs');
const https = require('https');

const API_KEY = 'sk-147539412f7a27979d9cdd72e98ccfeef14aca6a86ad97de';
const MODEL = 'gpt-5.5';
const PROJECT = '/Users/shmiyangkuan/Downloads/sales-enablement-demo';
const SRC_DIR = PROJECT + '/原始答疑知识库';

function callLLM(messages) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ model: MODEL, messages: messages, temperature: 0.3 });
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
        } catch(e) { reject(new Error('Parse: ' + e.message + ' body: ' + body.slice(0,500))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function parseQA(text) {
  let cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found');
  return JSON.parse(cleaned.substring(start, end + 1));
}

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
   - 时间节点要求
   - 政策要求、准入条件、分成比例
   - 材料链接（保留完整URL）
   - 常见差异对比
   - 结算流程和起结金额
   - 合作终止流程
5. q 关键词要包含用户可能的多种问法，中英文都要有，包括口语化问法
6. 如果文档中有表格内容，要逐行提取为问答条目

只输出JSON数组：
[{"q":["关键词1","关键词2"],"a":"详细HTML回答"},...]`;

async function main() {
  const docName = process.argv[2];
  const outFile = process.argv[3];

  const files = {
    'ad': {
      path: SRC_DIR + '/Advertisement Cooperation Process V4.0 （广告业务合作流程 V4.0） .md',
      source: 'Advertisement Cooperation Process V4.0（广告业务合作流程 V4.0）.md'
    },
    'game': {
      path: SRC_DIR + '/游戏联运业务运营流程_V2.1（Game Joint Operation Business Process_V2.1 ）.md',
      source: '游戏联运业务运营流程_V2.1（Game Joint Operation Business Process_V2.1）.md'
    }
  };

  const doc = files[docName];
  if (!doc) { console.error('Unknown doc:', docName); process.exit(1); }

  const fullText = fs.readFileSync(doc.path, 'utf8');
  const cnText = fullText.split('# 英文（In English）')[0];

  console.log('Processing ' + docName + ' (' + cnText.length + ' chars)...');
  const result = await callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt + '\n\n---文档原文---\n' + cnText }
  ]);
  console.log('Response length:', result.length);

  const items = parseQA(result);
  items.forEach(item => { item.source = doc.source; });

  fs.writeFileSync(outFile, JSON.stringify(items, null, 2), 'utf8');
  console.log('Saved ' + items.length + ' items to ' + outFile);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
