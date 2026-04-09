'use strict';

require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const OpenAI = require('openai');

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret || !process.env.OPENAI_API_KEY) {
  console.error('❌ 缺少必要環境變數：LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET / OPENAI_API_KEY');
  process.exit(1);
}

const client = new line.Client(config);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = Number(process.env.PORT || 3000);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// 這版改成雙向自動翻譯
const LANG_ZH = '繁體中文';
const LANG_TH = 'ไทย';

// 是否啟用群組授權（true / false）
const ENABLE_GROUP_AUTH = String(process.env.ENABLE_GROUP_AUTH || 'false').toLowerCase() === 'true';

// 允許的群組 / 房間 ID（逗號分隔）
const ALLOWED_SOURCE_IDS = new Set(
  String(process.env.ALLOWED_SOURCE_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

// 指令前綴
const COMMAND_PREFIXES = ['/', '!', '！', '／'];

// 固定不翻字詞
const ALWAYS_KEEP_WORDS = new Set([
  'UP',
  'DOWN',
  'IN',
  'OUT',
  'ON',
  'OFF',
  'VIP',
  'KTV',
  'LINE',
  'TG',
  'DM',
  'PM',
  'AM',
  'OK',
  'PC',
  'IOS',
  'ANDROID',
  'XS',
  'S',
  'M',
  'L',
  'XL',
  'XXL',
  '2XL',
  '3XL',
]);

// 全域辭典：可自行擴充
const GLOBAL_DICTIONARY = [
  // { from: '藍白色', toZh: '藍白色', toTh: 'สีฟ้าขาว' },
  // { from: '混色', toZh: '混色', toTh: 'ผสมสี' },
];

// =========================
// 工具
// =========================
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(text) {
  return (text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .trim();
}

function hasChinese(text) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

function hasThai(text) {
  return /[\u0E00-\u0E7F]/.test(text);
}

function hasLatin(text) {
  return /[A-Za-z]/.test(text);
}

function isOnlyWhitespace(text) {
  return !text || !text.trim();
}

function isCommand(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (!COMMAND_PREFIXES.some(p => t.startsWith(p))) return false;
  return /^([/!！／])[A-Za-z\u0E00-\u0E7F\u4e00-\u9fff][^\n]*$/.test(t);
}

function isAllowedSource(event) {
  if (!ENABLE_GROUP_AUTH) return true;
  const source = event.source || {};
  const sourceId = source.groupId || source.roomId || source.userId || '';
  if (!sourceId) return false;
  return ALLOWED_SOURCE_IDS.has(sourceId);
}

function containsEnoughHumanText(text) {
  if (!text) return false;

  // 只要有中文或泰文，就視為有人類語言內容
  if (hasChinese(text) || hasThai(text)) return true;

  // 一般英文字至少有 2 個單字再算
  const words = text.match(/[A-Za-z]+/g) || [];
  return words.length >= 2;
}

function shouldSkipBecausePureCode(text) {
  // 只在完全沒有中泰文時才考慮略過
  if (hasChinese(text) || hasThai(text)) return false;

  const stripped = text.replace(/\s+/g, '');
  if (!stripped) return true;

  // 純規格、數字、代碼
  if (/^[A-Za-z0-9\-_/.:#+()&\[\]%]+$/.test(stripped)) {
    const words = text.match(/[A-Za-z]+/g) || [];
    if (words.length <= 2) return true;
  }

  return false;
}

function shouldTranslateText(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (isCommand(t)) return false;
  if (shouldSkipBecausePureCode(t)) return false;
  if (containsEnoughHumanText(t)) return true;
  return false;
}

function detectTranslationDirection(text) {
  const zh = hasChinese(text);
  const th = hasThai(text);

  // 純中文 -> 泰文
  if (zh && !th) {
    return {
      sourceLang: LANG_ZH,
      targetLang: LANG_TH,
    };
  }

  // 純泰文 -> 中文
  if (th && !zh) {
    return {
      sourceLang: LANG_TH,
      targetLang: LANG_ZH,
    };
  }

  // 中泰混合：以句中較主要語言決定方向
  const zhCount = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const thCount = (text.match(/[\u0E00-\u0E7F]/g) || []).length;

  if (zh && th) {
    if (zh >= th) {
      return {
        sourceLang: `${LANG_ZH}（含部分ไทย）`,
        targetLang: LANG_TH,
      };
    }
    return {
      sourceLang: `${LANG_TH}（含部分中文）`,
      targetLang: LANG_ZH,
    };
  }

  // 若沒有中泰文，但有一般英文，預設不處理
  return null;
}

function createPlaceholder(type, idx) {
  return `[[[${type}_${idx}]]]`;
}

// =========================
// Placeholder 保護
// =========================
function protectMentions(text, mention) {
  if (!mention || !Array.isArray(mention.mentionees) || mention.mentionees.length === 0) {
    return { text, map: {} };
  }

  const sorted = [...mention.mentionees]
    .filter(m => Number.isInteger(m.index) && Number.isInteger(m.length))
    .sort((a, b) => a.index - b.index);

  let result = '';
  let cursor = 0;
  const map = {};
  let idx = 0;

  for (const m of sorted) {
    const start = m.index;
    const end = m.index + m.length;
    if (start < cursor) continue;

    result += text.slice(cursor, start);
    const original = text.slice(start, end);
    const ph = createPlaceholder('MENTION', idx++);
    map[ph] = original;
    result += ph;
    cursor = end;
  }

  result += text.slice(cursor);
  return { text: result, map };
}

function protectEmojis(text) {
  const emojiRegex = /(\p{Extended_Pictographic}(?:\uFE0F)?)/gu;
  let idx = 0;
  const map = {};

  const out = text.replace(emojiRegex, (m) => {
    const ph = createPlaceholder('EMOJI', idx++);
    map[ph] = m;
    return ph;
  });

  return { text: out, map };
}

function protectUrls(text) {
  const regex = /https?:\/\/[^\s]+/gi;
  let idx = 0;
  const map = {};

  const out = text.replace(regex, (m) => {
    const ph = createPlaceholder('URL', idx++);
    map[ph] = m;
    return ph;
  });

  return { text: out, map };
}

function protectAlwaysKeepWords(text) {
  let out = text;
  const map = {};
  let idx = 0;

  for (const word of ALWAYS_KEEP_WORDS) {
    const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'g');
    out = out.replace(re, (m) => {
      const ph = createPlaceholder('KEEP', idx++);
      map[ph] = m;
      return ph;
    });
  }

  // 保護 1430/40/2300 這類型
  out = out.replace(/\b\d+(?:\/\d+){1,}\b/g, (m) => {
    const ph = createPlaceholder('CODE', idx++);
    map[ph] = m;
    return ph;
  });

  // 保護價格 / 房號 / 規格 / 貨號 / 尺寸代碼
  out = out.replace(/\b(?:#?[A-Za-z]{1,6}\d{1,8}|\d{1,8}[A-Za-z]{1,6}|[A-Za-z]{1,6}-\d{1,8}|#?[A-Za-z0-9_-]{3,})\b/g, (m) => {
    if (hasChinese(m) || hasThai(m)) return m;

    // 一般英文單字不全部保護，避免像 mixed 這種失去翻譯機會
    if (/^[A-Za-z]{3,}$/.test(m) && !ALWAYS_KEEP_WORDS.has(m.toUpperCase())) {
      return m;
    }

    const ph = createPlaceholder('TOKEN', idx++);
    map[ph] = m;
    return ph;
  });

  return { text: out, map };
}

function protectText(text, mention) {
  const p1 = protectMentions(text, mention);
  const p2 = protectEmojis(p1.text);
  const p3 = protectUrls(p2.text);
  const p4 = protectAlwaysKeepWords(p3.text);

  return {
    text: p4.text,
    map: {
      ...p1.map,
      ...p2.map,
      ...p3.map,
      ...p4.map,
    },
  };
}

function restorePlaceholders(text, map) {
  let out = text || '';

  for (let i = 0; i < 10; i++) {
    let changed = false;
    for (const [ph, original] of Object.entries(map)) {
      if (out.includes(ph)) {
        out = out.split(ph).join(original);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return out;
}

// =========================
// 字典
// =========================
function applyGlobalDictionaryBefore(text) {
  let out = text;
  for (const item of GLOBAL_DICTIONARY) {
    if (!item || !item.from) continue;
    const re = new RegExp(escapeRegExp(item.from), 'g');
    out = out.replace(re, item.from);
  }
  return out;
}

function applyGlobalDictionaryAfter(text, targetLang) {
  let out = text;
  for (const item of GLOBAL_DICTIONARY) {
    if (!item || !item.from) continue;

    const replacement = targetLang === LANG_TH ? item.toTh : item.toZh;
    if (!replacement) continue;

    const re = new RegExp(escapeRegExp(item.from), 'g');
    out = out.replace(re, replacement);
  }
  return out;
}

// =========================
// OpenAI 翻譯
// =========================
function buildTranslationPrompt(sourceLang, targetLang) {
  return `
You are a high-accuracy chat translation engine.

Task:
Translate the user's message from ${sourceLang} into ${targetLang}.

Critical rules:
1. Preserve placeholders exactly, including [[[MENTION_0]]], [[[EMOJI_0]]], [[[URL_0]]], [[[KEEP_0]]], [[[CODE_0]]], [[[TOKEN_0]]].
2. Never translate or alter placeholders.
3. Translate only the natural-language parts.
4. Mixed strings like "1430/40/2300藍白色 [[[KEEP_0]]] mixed" must still be translated for the human-language parts.
5. Preserve codes, IDs, room numbers, stock/spec strings, slash-separated numbers, and protected English tokens.
6. Keep line breaks as much as possible.
7. Do not add explanations, notes, quotation marks, labels, or extra text.
8. Return only the translated text.
9. If the source message is already mostly in the target language but still includes source-language fragments, translate those fragments and keep the rest natural.
10. Keep chat tone natural.

Examples:
- "1430/40/2300藍白色 [[[KEEP_0]]] mixed" -> keep 1430/40/2300 and [[[KEEP_0]]] exactly, translate 藍白色 and mixed appropriately.
- Thai sentence -> Chinese.
- Chinese sentence -> Thai.
`.trim();
}

async function translateWithOpenAI(protectedText, sourceLang, targetLang) {
  const systemPrompt = buildTranslationPrompt(sourceLang, targetLang);

  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.1,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: protectedText },
    ],
  });

  return response.choices?.[0]?.message?.content?.trim() || '';
}

async function translateText(text, mention) {
  const normalized = normalizeText(text);
  if (!shouldTranslateText(normalized)) return null;

  const direction = detectTranslationDirection(normalized);
  if (!direction) return null;

  const beforeDict = applyGlobalDictionaryBefore(normalized);
  const protectedPack = protectText(beforeDict, mention);

  // 只要有中文或泰文，絕不因代碼混合而跳過
  if (!hasChinese(normalized) && !hasThai(normalized) && shouldSkipBecausePureCode(protectedPack.text)) {
    return null;
  }

  const translatedProtected = await translateWithOpenAI(
    protectedPack.text,
    direction.sourceLang,
    direction.targetLang
  );

  if (!translatedProtected) return null;

  let restored = restorePlaceholders(translatedProtected, protectedPack.map);
  restored = applyGlobalDictionaryAfter(restored, direction.targetLang);

  restored = restored.trim();
  if (!restored) return null;

  return restored;
}

// =========================
// 事件處理
// =========================
async function handleTextMessage(event) {
  const msg = event.message;
  const originalText = msg.text || '';

  if (!isAllowedSource(event)) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '此群組/聊天室尚未授權使用翻譯機器人。',
    });
  }

  if (isCommand(originalText)) {
    const t = normalizeText(originalText).toLowerCase();

    if (t === '/ping' || t === '!ping') {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'pong',
      });
    }

    if (t === '/id' || t === '!id') {
      const source = event.source || {};
      const sourceId = source.groupId || source.roomId || source.userId || 'unknown';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `sourceId: ${sourceId}`,
      });
    }

    if (t === '/help' || t === '!help') {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text:
`可用指令：
/help
/ping
/id

目前功能：
- 中文 → 泰文
- 泰文 → 中文
- mention 保留
- sticker 不翻
- emoji 保留
- URL 保留
- 1430/40/2300藍白色 UP mixed 這類混合字串可翻
- 指令不誤判`,
      });
    }

    return null;
  }

  const translated = await translateText(originalText, msg.mention);

  if (!translated) return null;
  if (translated === normalizeText(originalText)) return null;

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: translated,
  });
}

async function handleEvent(event) {
  try {
    if (event.type !== 'message') return null;

    // sticker / image / video / audio / file 不翻
    if (event.message.type !== 'text') return null;

    return await handleTextMessage(event);
  } catch (err) {
    console.error('handleEvent error:', err);

    try {
      return await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '翻譯時發生錯誤，請稍後再試。',
      });
    } catch (replyErr) {
      console.error('reply error:', replyErr);
      return null;
    }
  }
}

// =========================
// 路由
// =========================
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).send('OK');
  } catch (err) {
    console.error('webhook error:', err);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(PORT, () => {
  console.log(`✅ LINE bot server running on port ${PORT}`);
});
