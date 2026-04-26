'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const line = require('@line/bot-sdk');
const OpenAI = require('openai');

// =====================================================
// 基本設定
// =====================================================
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

// 建議正式使用 gpt-4.1，翻譯品質明顯比 mini 穩定
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';

// =====================================================
// 授權 / 管理設定
// =====================================================
const REQUIRE_AUTHORIZATION = true;
const AUTH_ALLOW_USER_CHAT = String(process.env.AUTH_ALLOW_USER_CHAT || 'false').toLowerCase() === 'true';

const ADMIN_USER_IDS = new Set(
  String(process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

const SEED_ALLOWED_SOURCE_IDS = String(process.env.ALLOWED_SOURCE_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const DEFAULT_TRANSLATION_MODE = String(process.env.TRANSLATION_MODE || 'zh-th').toLowerCase();

const COMMAND_PREFIXES = ['/', '!', '！', '／'];

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

const GLOBAL_DICTIONARY = [
  // 可自行增加常用詞
  // {
  //   from: '藍白色',
  //   toZh: '藍白色',
  //   toTh: 'สีฟ้าขาว',
  //   toEn: 'blue and white',
  //   toMy: 'အပြာဖြူ'
  // },
];

// =====================================================
// 資料儲存
// =====================================================
const DATA_DIR = path.join(__dirname, 'data');
const AUTH_FILE = path.join(DATA_DIR, 'authorized-sources.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`readJsonSafe error (${filePath}):`, err);
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  try {
    ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`writeJsonSafe error (${filePath}):`, err);
    return false;
  }
}

function loadAuthStore() {
  const initial = readJsonSafe(AUTH_FILE, { sources: {} });

  if (!initial || typeof initial !== 'object' || !initial.sources || typeof initial.sources !== 'object') {
    const fresh = { sources: {} };

    for (const sourceId of SEED_ALLOWED_SOURCE_IDS) {
      fresh.sources[sourceId] = {
        authorized: true,
        mode: DEFAULT_TRANSLATION_MODE,
        updatedAt: new Date().toISOString(),
        note: 'seed from env',
      };
    }

    writeJsonSafe(AUTH_FILE, fresh);
    return fresh;
  }

  for (const sourceId of SEED_ALLOWED_SOURCE_IDS) {
    if (!initial.sources[sourceId]) {
      initial.sources[sourceId] = {
        authorized: true,
        mode: DEFAULT_TRANSLATION_MODE,
        updatedAt: new Date().toISOString(),
        note: 'seed from env',
      };
    }
  }

  writeJsonSafe(AUTH_FILE, initial);
  return initial;
}

let authStore = loadAuthStore();

// =====================================================
// 工具函式
// =====================================================
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

function hasMyanmar(text) {
  return /[\u1000-\u109F\uA9E0-\uA9FF\uAA60-\uAA7F]/.test(text);
}

function hasEnglish(text) {
  return /[A-Za-z]/.test(text);
}

function countChinese(text) {
  return (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
}

function countThai(text) {
  return (text.match(/[\u0E00-\u0E7F]/g) || []).length;
}

function countMyanmar(text) {
  return (text.match(/[\u1000-\u109F\uA9E0-\uA9FF\uAA60-\uAA7F]/g) || []).length;
}

function countEnglishWords(text) {
  return (text.match(/[A-Za-z]+/g) || []).length;
}

function isCommand(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (!COMMAND_PREFIXES.some(p => t.startsWith(p))) return false;
  return /^([/!！／])[A-Za-z0-9_-]+(?:\s+[A-Za-z0-9:_-]+)*$/u.test(t);
}

function isSystemControlText(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (/^UI_[A-Z0-9_:.-]+$/u.test(t)) return true;
  if (/^SYS_[A-Z0-9_:.-]+$/u.test(t)) return true;
  if (/^CMD_[A-Z0-9_:.-]+$/u.test(t)) return true;
  return false;
}

function getSourceId(event) {
  const source = event?.source || {};
  return source.groupId || source.roomId || source.userId || '';
}

function getSourceType(event) {
  return event?.source?.type || 'unknown';
}

function getUserIdFromEvent(event) {
  return event?.source?.userId || '';
}

function isAllowedSourceType(event) {
  const type = getSourceType(event);
  return type === 'group' || type === 'room' || type === 'user';
}

function isAdmin(event) {
  const userId = getUserIdFromEvent(event);
  if (!userId) return false;
  return ADMIN_USER_IDS.has(userId);
}

function getAuthorizedRecord(sourceId) {
  return authStore.sources[sourceId] || null;
}

function isSourceAuthorized(event) {
  const sourceType = getSourceType(event);
  const sourceId = getSourceId(event);

  if (!sourceId) return false;

  if (sourceType === 'user') {
    return AUTH_ALLOW_USER_CHAT;
  }

  const rec = getAuthorizedRecord(sourceId);
  return !!(rec && rec.authorized === true);
}

function authorizeSource(sourceId, mode = DEFAULT_TRANSLATION_MODE, note = 'manual auth') {
  authStore.sources[sourceId] = {
    authorized: true,
    mode,
    updatedAt: new Date().toISOString(),
    note,
  };
  writeJsonSafe(AUTH_FILE, authStore);
}

function unauthorizeSource(sourceId) {
  if (!authStore.sources[sourceId]) {
    authStore.sources[sourceId] = {
      authorized: false,
      mode: DEFAULT_TRANSLATION_MODE,
      updatedAt: new Date().toISOString(),
      note: 'manual unauth',
    };
  } else {
    authStore.sources[sourceId].authorized = false;
    authStore.sources[sourceId].updatedAt = new Date().toISOString();
    authStore.sources[sourceId].note = 'manual unauth';
  }

  writeJsonSafe(AUTH_FILE, authStore);
}

function getSourceMode(sourceId) {
  const rec = getAuthorizedRecord(sourceId);
  return rec?.mode || DEFAULT_TRANSLATION_MODE;
}

function setSourceMode(sourceId, mode) {
  const rec = getAuthorizedRecord(sourceId) || {
    authorized: false,
    mode: DEFAULT_TRANSLATION_MODE,
    updatedAt: new Date().toISOString(),
    note: 'created by mode update',
  };

  rec.mode = mode;
  rec.updatedAt = new Date().toISOString();

  authStore.sources[sourceId] = rec;
  writeJsonSafe(AUTH_FILE, authStore);
}

function isValidMode(mode) {
  return ['zh-th', 'zh-en', 'zh-my'].includes(String(mode || '').toLowerCase());
}

function modeDisplayName(mode) {
  const m = String(mode || '').toLowerCase();
  if (m === 'zh-th') return '中泰雙向翻譯';
  if (m === 'zh-en') return '中英雙向翻譯';
  if (m === 'zh-my') return '中緬雙向翻譯';
  return `未知模式：${m}`;
}

function containsEnoughHumanText(text) {
  if (!text) return false;
  if (hasChinese(text) || hasThai(text) || hasMyanmar(text)) return true;

  // 英文單字 1 個也允許翻譯，避免短英文不翻
  return countEnglishWords(text) >= 1;
}

function shouldSkipBecausePureCode(text) {
  if (hasChinese(text) || hasThai(text) || hasMyanmar(text)) return false;

  const stripped = text.replace(/\s+/g, '');
  if (!stripped) return true;

  // 純網址、純代碼、純符號才跳過
  if (/^[0-9\-_/.:#+()&\[\]%]+$/.test(stripped)) return true;

  // 單一很短英文代碼，例如 A1、B2、AB123
  if (/^#?[A-Za-z]{1,4}\d{1,10}$/.test(stripped)) return true;
  if (/^\d{1,10}[A-Za-z]{1,4}$/.test(stripped)) return true;

  return false;
}

function shouldTranslateText(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (isCommand(t)) return false;
  if (isSystemControlText(t)) return false;
  if (shouldSkipBecausePureCode(t)) return false;
  if (containsEnoughHumanText(t)) return true;
  return false;
}

function isLikelyUntranslated(originalText, translatedText, targetLang) {
  const original = normalizeText(originalText);
  const translated = normalizeText(translatedText);

  if (!original || !translated) return false;

  // 短字詞可能本來就是品牌、代碼，不要太容易重試
  if (original === translated && original.length > 8) return true;

  if (targetLang === '繁體中文') {
    if ((hasThai(translated) || hasMyanmar(translated)) && !hasChinese(translated)) return true;
    if (hasEnglish(original) && translated === original && original.length > 8) return true;
  }

  if (targetLang === 'ไทย') {
    if (hasChinese(translated) && !hasThai(translated)) return true;
    if (hasEnglish(original) && translated === original && original.length > 8) return true;
  }

  if (targetLang === 'English') {
    if (hasChinese(translated) && !hasEnglish(translated)) return true;
  }

  if (targetLang === 'မြန်မာဘာသာ') {
    if (hasChinese(translated) && !hasMyanmar(translated)) return true;
    if (hasEnglish(original) && translated === original && original.length > 8) return true;
  }

  return false;
}

function createPlaceholder(type, idx) {
  return `[[[${type}_${idx}]]]`;
}

// =====================================================
// Placeholder 保護
// =====================================================
function protectMentions(text, mention) {
  if (!mention || !Array.isArray(mention.mentionees) || mention.mentionees.length === 0) {
    return { text, map: {} };
  }

  const sorted = [...mention.mentionees]
    .filter(m => Number.isInteger(m.index) && Number.isInteger(m.length))
    .sort((a, b) => a.index - b.index);

  let result = '';
  let cursor = 0;
  let idx = 0;
  const map = {};

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
  const map = {};
  let idx = 0;

  const out = text.replace(emojiRegex, (m) => {
    const ph = createPlaceholder('EMOJI', idx++);
    map[ph] = m;
    return ph;
  });

  return { text: out, map };
}

function protectUrls(text) {
  const urlRegex = /https?:\/\/[^\s]+/gi;
  const map = {};
  let idx = 0;

  const out = text.replace(urlRegex, (m) => {
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
    const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi');
    out = out.replace(re, (m) => {
      const ph = createPlaceholder('KEEP', idx++);
      map[ph] = m;
      return ph;
    });
  }

  // 保護 1430/40/2300 這種規格碼
  out = out.replace(/\b\d+(?:\/\d+){1,}\b/g, (m) => {
    const ph = createPlaceholder('CODE', idx++);
    map[ph] = m;
    return ph;
  });

  // 只保護明顯代碼，不再過度保護普通英文單字
  out = out.replace(/\b(?:#?[A-Za-z]{1,6}\d{1,10}|\d{1,10}[A-Za-z]{1,6}|[A-Za-z]{1,6}-\d{1,10})\b/g, (m) => {
    if (hasChinese(m) || hasThai(m) || hasMyanmar(m)) return m;

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

// =====================================================
// 全域辭典
// =====================================================
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

    let replacement = '';
    if (targetLang === '繁體中文') replacement = item.toZh || '';
    if (targetLang === 'ไทย') replacement = item.toTh || '';
    if (targetLang === 'English') replacement = item.toEn || '';
    if (targetLang === 'မြန်မာဘာသာ') replacement = item.toMy || '';

    if (!replacement) continue;

    const re = new RegExp(escapeRegExp(item.from), 'g');
    out = out.replace(re, replacement);
  }

  return out;
}

// =====================================================
// 多語模式判斷
// =====================================================
function detectTranslationDirection(text, mode) {
  const m = String(mode || DEFAULT_TRANSLATION_MODE).toLowerCase();

  const zh = hasChinese(text);
  const th = hasThai(text);
  const my = hasMyanmar(text);
  const en = hasEnglish(text);

  const zhCount = countChinese(text);
  const thCount = countThai(text);
  const myCount = countMyanmar(text);
  const enCount = countEnglishWords(text);

  if (m === 'zh-th') {
    if (zh && !th) return { sourceLang: '繁體中文', targetLang: 'ไทย' };
    if (th && !zh) return { sourceLang: 'ไทย', targetLang: '繁體中文' };

    // 優化：中泰模式下，純英文改翻泰文
    if (en && !zh && !th && !my) {
      return { sourceLang: 'English', targetLang: 'ไทย' };
    }

    if (zh && th) {
      if (zhCount >= thCount) return { sourceLang: '繁體中文（含部分ไทย）', targetLang: 'ไทย' };
      return { sourceLang: 'ไทย（含部分中文）', targetLang: '繁體中文' };
    }

    if (zh && en && !th) return { sourceLang: '繁體中文（含部分English）', targetLang: 'ไทย' };
    if (th && en && !zh) return { sourceLang: 'ไทย（含部分English）', targetLang: '繁體中文' };

    if (zh && th && en) {
      if (zhCount >= thCount) return { sourceLang: '繁體中文（含部分ไทย/English）', targetLang: 'ไทย' };
      return { sourceLang: 'ไทย（含部分中文/English）', targetLang: '繁體中文' };
    }

    return null;
  }

  if (m === 'zh-en') {
    if (zh && !en) return { sourceLang: '繁體中文', targetLang: 'English' };
    if (en && !zh && !th && !my) return { sourceLang: 'English', targetLang: '繁體中文' };

    if (zh && en && !th && !my) {
      if (zhCount >= enCount) return { sourceLang: '繁體中文（含部分English）', targetLang: 'English' };
      return { sourceLang: 'English（含部分中文）', targetLang: '繁體中文' };
    }

    if (th && !zh && !en) return { sourceLang: 'ไทย', targetLang: '繁體中文' };
    if (my && !zh && !en) return { sourceLang: 'မြန်မာဘာသာ', targetLang: '繁體中文' };
    if (th && en && !zh) return { sourceLang: 'ไทย（含部分English）', targetLang: '繁體中文' };
    if (my && en && !zh) return { sourceLang: 'မြန်မာဘာသာ（含部分English）', targetLang: '繁體中文' };

    return null;
  }

  if (m === 'zh-my') {
    if (zh && !my) return { sourceLang: '繁體中文', targetLang: 'မြန်မာဘာသာ' };
    if (my && !zh) return { sourceLang: 'မြန်မာဘာသာ', targetLang: '繁體中文' };

    // 中緬模式下，純英文維持翻中文
    if (en && !zh && !my && !th) return { sourceLang: 'English', targetLang: '繁體中文' };

    if (zh && my) {
      if (zhCount >= myCount) return { sourceLang: '繁體中文（含部分မြန်မာဘာသာ）', targetLang: 'မြန်မာဘာသာ' };
      return { sourceLang: 'မြန်မာဘာသာ（含部分中文）', targetLang: '繁體中文' };
    }

    if (zh && en && !my) return { sourceLang: '繁體中文（含部分English）', targetLang: 'မြန်မာဘာသာ' };
    if (my && en && !zh) return { sourceLang: 'မြန်မာဘာသာ（含部分English）', targetLang: '繁體中文' };

    if (zh && my && en) {
      if (zhCount >= myCount) return { sourceLang: '繁體中文（含部分မြန်မာဘာသာ/English）', targetLang: 'မြန်မာဘာသာ' };
      return { sourceLang: 'မြန်မာဘာသာ（含部分中文/English）', targetLang: '繁體中文' };
    }

    return null;
  }

  return null;
}

// =====================================================
// OpenAI 翻譯
// =====================================================
function buildTranslationPrompt(sourceLang, targetLang) {
  return `
You are a professional multilingual translator.

Goal:
Translate the user's message from ${sourceLang} into ${targetLang} accurately and naturally.

Rules:
1. Preserve the original meaning, tone, intention, and context.
2. Translate naturally, not word-by-word.
3. Mixed-language sentences must become fluent ${targetLang}.
4. Do not explain anything.
5. Do not add labels, quotation marks, notes, or comments.
6. Keep line breaks as much as possible.
7. Preserve these placeholders exactly:
   [[[MENTION_*]]], [[[EMOJI_*]]], [[[URL_*]]], [[[KEEP_*]]], [[[CODE_*]]], [[[TOKEN_*]]]
8. Never translate, remove, or alter placeholders.
9. Keep numbers, IDs, URLs, codes, room numbers, product specs, and protected tokens unchanged.
10. Translate all natural human-readable words.

Language quality requirements:
- Thai output must sound natural to native Thai speakers.
- Traditional Chinese output must sound fluent and natural to native Traditional Chinese readers.
- English output must sound natural and clear.
- Myanmar output must sound natural to native Myanmar speakers.
- Avoid stiff, literal, or machine-like wording.

Special:
- If the source contains short product specs, colors, sizes, or mixed codes, preserve the codes but translate the normal words.
- If the source contains casual chat, translate it like a natural chat message.
- Output ONLY the translated result.
`.trim();
}

async function translateWithOpenAI(protectedText, sourceLang, targetLang, strictRetry = false) {
  const systemPrompt = strictRetry
    ? `${buildTranslationPrompt(sourceLang, targetLang)}

Extra strict retry:
The previous output may have been untranslated or too literal.
Translate again into ${targetLang}.
Do NOT return the original source language unchanged.
Output only the final translation.`
    : buildTranslationPrompt(sourceLang, targetLang);

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

async function translateText(text, mention, mode) {
  const normalized = normalizeText(text);
  if (!shouldTranslateText(normalized)) return null;

  const direction = detectTranslationDirection(normalized, mode);
  if (!direction) return null;

  const beforeDict = applyGlobalDictionaryBefore(normalized);
  const protectedPack = protectText(beforeDict, mention);

  let translatedProtected = await translateWithOpenAI(
    protectedPack.text,
    direction.sourceLang,
    direction.targetLang,
    false
  );

  if (!translatedProtected) return null;

  let restored = restorePlaceholders(translatedProtected, protectedPack.map);
  restored = applyGlobalDictionaryAfter(restored, direction.targetLang);
  restored = restored.trim();

  if (!restored) return null;

  // 若看起來像沒翻，再重試一次
  if (isLikelyUntranslated(normalized, restored, direction.targetLang)) {
    translatedProtected = await translateWithOpenAI(
      protectedPack.text,
      direction.sourceLang,
      direction.targetLang,
      true
    );

    if (translatedProtected) {
      let retryRestored = restorePlaceholders(translatedProtected, protectedPack.map);
      retryRestored = applyGlobalDictionaryAfter(retryRestored, direction.targetLang);
      retryRestored = retryRestored.trim();

      if (retryRestored) {
        restored = retryRestored;
      }
    }
  }

  return restored || null;
}

// =====================================================
// 回覆工具
// =====================================================
async function replyText(replyToken, text) {
  if (!replyToken || !text) return null;

  return client.replyMessage(replyToken, {
    type: 'text',
    text,
  });
}

// =====================================================
// 指令處理
// =====================================================
async function handleCommand(event, text) {
  const t = normalizeText(text);
  const lower = t.toLowerCase();

  const sourceId = getSourceId(event);
  const sourceType = getSourceType(event);

  if (lower === '/ping' || lower === '!ping') {
    return replyText(event.replyToken, 'pong');
  }

  if (lower === '/id' || lower === '!id') {
    return replyText(
      event.replyToken,
      `sourceType: ${sourceType}\nsourceId: ${sourceId || 'unknown'}`
    );
  }

  if (lower === '/help' || lower === '!help') {
    return replyText(
      event.replyToken,
`可用指令：
/help
/ping
/id
/status
/auth
/unauth
/mode zh-th
/mode zh-en
/mode zh-my

重點：
- 不需要先 /id，管理員可直接 /auth
- 必須先授權群組/聊天室，才能翻譯
- 只有 ADMIN_USER_IDS 內的管理員可執行 /auth /unauth /mode
- zh-th：中文→泰文，泰文→中文，英文→泰文
- zh-en：中文→英文，英文→中文
- zh-my：中文→緬文，緬文→中文，英文→中文
- 已優化翻譯自然度與長句準確度
- mention / emoji / URL 保留
- sticker / 圖片 / 影片 / 音訊 / 檔案不翻
- UI_SET_LANG:my:zh 這類系統字串一律跳過`
    );
  }

  if (lower === '/status') {
    const authorized = isSourceAuthorized(event);
    const mode = sourceId ? getSourceMode(sourceId) : DEFAULT_TRANSLATION_MODE;
    const admin = isAdmin(event);
    const userId = getUserIdFromEvent(event) || 'unknown';

    return replyText(
      event.replyToken,
      `授權狀態：${authorized ? '已授權' : '未授權'}\n模式：${mode}（${modeDisplayName(mode)}）\n管理員：${admin ? '是' : '否'}\n你的 userId：${userId}`
    );
  }

  if (lower === '/auth') {
    if (!isAdmin(event)) {
      return replyText(event.replyToken, '你沒有授權權限。');
    }

    if (!(sourceType === 'group' || sourceType === 'room')) {
      return replyText(event.replyToken, '只能在群組或多人聊天室內執行 /auth。');
    }

    const currentMode = getSourceMode(sourceId);
    authorizeSource(sourceId, currentMode, 'authorized by admin command');

    return replyText(
      event.replyToken,
      `已授權此${sourceType === 'group' ? '群組' : '聊天室'}可使用翻譯。\n目前模式：${currentMode}（${modeDisplayName(currentMode)}）`
    );
  }

  if (lower === '/unauth') {
    if (!isAdmin(event)) {
      return replyText(event.replyToken, '你沒有授權權限。');
    }

    if (!(sourceType === 'group' || sourceType === 'room')) {
      return replyText(event.replyToken, '只能在群組或多人聊天室內執行 /unauth。');
    }

    unauthorizeSource(sourceId);
    return replyText(event.replyToken, '已取消此群組/聊天室的翻譯授權。');
  }

  if (lower === '/mode zh-th' || lower === '/mode zh-en' || lower === '/mode zh-my') {
    if (!isAdmin(event)) {
      return replyText(event.replyToken, '你沒有切換模式的權限。');
    }

    if (!(sourceType === 'group' || sourceType === 'room')) {
      return replyText(event.replyToken, '只能在群組或多人聊天室內切換模式。');
    }

    const mode = lower.replace('/mode ', '').trim();

    if (!isValidMode(mode)) {
      return replyText(event.replyToken, '模式錯誤，只能使用：zh-th / zh-en / zh-my');
    }

    if (!isSourceAuthorized(event)) {
      return replyText(event.replyToken, '此群組/聊天室尚未授權，請先執行 /auth。');
    }

    setSourceMode(sourceId, mode);
    return replyText(event.replyToken, `已切換為：${modeDisplayName(mode)}`);
  }

  return null;
}

// =====================================================
// 文字訊息處理
// =====================================================
async function handleTextMessage(event) {
  const msg = event.message;
  const originalText = msg.text || '';

  if (!isAllowedSourceType(event)) return null;

  if (isCommand(originalText)) {
    return handleCommand(event, originalText);
  }

  if (isSystemControlText(originalText)) {
    return null;
  }

  if (REQUIRE_AUTHORIZATION && !isSourceAuthorized(event)) {
    const sourceType = getSourceType(event);

    if (sourceType === 'group' || sourceType === 'room') {
      return replyText(
        event.replyToken,
        '此群組/聊天室尚未授權使用翻譯功能。請由管理員在本群直接輸入 /auth 進行授權。'
      );
    }

    if (sourceType === 'user' && !AUTH_ALLOW_USER_CHAT) {
      return replyText(event.replyToken, '目前未開放私聊翻譯功能。');
    }

    return null;
  }

  const sourceId = getSourceId(event);
  const mode = getSourceMode(sourceId);

  const translated = await translateText(originalText, msg.mention, mode);

  if (!translated) return null;

  return replyText(event.replyToken, translated);
}

// =====================================================
// 事件處理
// =====================================================
async function handleEvent(event) {
  try {
    if (event.type !== 'message') return null;
    if (event.message.type !== 'text') return null;
    return await handleTextMessage(event);
  } catch (err) {
    console.error('handleEvent error:', err);

    try {
      return await replyText(event.replyToken, '翻譯時發生錯誤，請稍後再試。');
    } catch (replyErr) {
      console.error('reply error:', replyErr);
      return null;
    }
  }
}

// =====================================================
// 路由
// =====================================================
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    requireAuthorization: REQUIRE_AUTHORIZATION,
    allowUserChat: AUTH_ALLOW_USER_CHAT,
    defaultMode: DEFAULT_TRANSLATION_MODE,
    model: OPENAI_MODEL,
    authorizedCount: Object.values(authStore.sources).filter(v => v && v.authorized).length,
  });
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
  console.log(`✅ REQUIRE_AUTHORIZATION = ${REQUIRE_AUTHORIZATION}`);
  console.log(`✅ AUTH_ALLOW_USER_CHAT = ${AUTH_ALLOW_USER_CHAT}`);
  console.log(`✅ DEFAULT_TRANSLATION_MODE = ${DEFAULT_TRANSLATION_MODE}`);
  console.log(`✅ OPENAI_MODEL = ${OPENAI_MODEL}`);
  console.log(`✅ ADMIN_USER_IDS count = ${ADMIN_USER_IDS.size}`);
});
