'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
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
  timeout: Number(process.env.OPENAI_TIMEOUT_MS || 30000),
  maxRetries: 2,
});

const PORT = Number(process.env.PORT || 3000);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

const REQUIRE_AUTHORIZATION = true;
const AUTH_ALLOW_USER_CHAT = String(process.env.AUTH_ALLOW_USER_CHAT || 'false').toLowerCase() === 'true';
const DEFAULT_TRANSLATION_MODE = String(process.env.TRANSLATION_MODE || 'zh-th').toLowerCase();

const CONTEXT_ENABLED = String(process.env.CONTEXT_ENABLED || 'true').toLowerCase() !== 'false';
const CONTEXT_MAX_MESSAGES = Math.max(2, Math.min(30, Number(process.env.CONTEXT_MAX_MESSAGES || 12)));
const CONTEXT_MAX_CHARS = Math.max(500, Math.min(12000, Number(process.env.CONTEXT_MAX_CHARS || 4000)));
const CONTEXT_TTL_HOURS = Math.max(1, Number(process.env.CONTEXT_TTL_HOURS || 72));

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

const COMMAND_PREFIXES = ['/', '!', '！', '／'];

const ALWAYS_KEEP_WORDS = new Set([
  'UP', 'DOWN', 'IN', 'OUT', 'ON', 'OFF',
  'VIP', 'KTV', 'LINE', 'TG', 'DM',
  'PM', 'AM', 'OK', 'PC',
  'IOS', 'ANDROID',
  'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL',
]);

const GLOBAL_DICTIONARY = [];

const CHAT_PHRASE_HINTS = [
  { phrase: 'ไม่ยุ่งแล้วคะ', meaningZh: '不忙了 / 現在有空了' },
  { phrase: 'ไม่ยุ่งแล้วค่ะ', meaningZh: '不忙了 / 現在有空了' },
  { phrase: 'ว่างแล้ว', meaningZh: '有空了 / 現在有空' },
  { phrase: 'ไม่ว่าง', meaningZh: '沒空 / 不方便' },
  { phrase: 'ได้ค่ะ', meaningZh: '可以 / 好的' },
  { phrase: 'ไม่ได้มีพิรุธ', meaningZh: '沒有可疑 / 沒什麼怪怪的' },
  { phrase: 'ไม่ให้ห่วงคุณจะให้ห่วงหมาที่ไหนละ', meaningZh: '不擔心你，難道要去擔心狗嗎？' },
  { phrase: 'จะให้ห่วงหมาที่ไหนละ', meaningZh: '難道要去擔心狗嗎？' },
];

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_FILE = path.join(DATA_DIR, 'authorized-sources.json');
const CONTEXT_FILE = path.join(DATA_DIR, 'conversation-context.json');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

  if (!initial || typeof initial !== 'object') return { sources: {} };
  if (!initial.sources || typeof initial.sources !== 'object') initial.sources = {};

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


function loadContextStore() {
  const initial = readJsonSafe(CONTEXT_FILE, { conversations: {} });
  if (!initial || typeof initial !== 'object') return { conversations: {} };
  if (!initial.conversations || typeof initial.conversations !== 'object') {
    initial.conversations = {};
  }
  return initial;
}

let contextStore = loadContextStore();
let contextWriteTimer = null;

function scheduleContextWrite() {
  if (contextWriteTimer) clearTimeout(contextWriteTimer);
  contextWriteTimer = setTimeout(() => {
    contextWriteTimer = null;
    writeJsonSafe(CONTEXT_FILE, contextStore);
  }, 300);
  if (typeof contextWriteTimer.unref === 'function') contextWriteTimer.unref();
}

function getConversationKey(event) {
  const sourceId = getSourceId(event);
  return sourceId ? `${getSourceType(event)}:${sourceId}` : '';
}

function pruneConversationEntries(entries) {
  const cutoff = Date.now() - CONTEXT_TTL_HOURS * 60 * 60 * 1000;
  const cleaned = (Array.isArray(entries) ? entries : []).filter(item => {
    const ts = Date.parse(item?.createdAt || '');
    return item && typeof item.original === 'string' && typeof item.translation === 'string' && (!Number.isFinite(ts) || ts >= cutoff);
  });
  return cleaned.slice(-CONTEXT_MAX_MESSAGES);
}

function getConversationEntries(event) {
  if (!CONTEXT_ENABLED) return [];
  const key = getConversationKey(event);
  if (!key) return [];
  const cleaned = pruneConversationEntries(contextStore.conversations[key]);
  contextStore.conversations[key] = cleaned;
  return cleaned;
}

function addConversationEntry(event, entry) {
  if (!CONTEXT_ENABLED) return;
  const key = getConversationKey(event);
  if (!key) return;

  const current = getConversationEntries(event);
  current.push({
    userId: getUserIdFromEvent(event) || '',
    sourceLang: entry.sourceLang,
    targetLang: entry.targetLang,
    original: normalizeText(entry.original),
    translation: normalizeText(entry.translation),
    createdAt: new Date().toISOString(),
  });
  contextStore.conversations[key] = pruneConversationEntries(current);
  scheduleContextWrite();
}

function clearConversationEntries(event) {
  const key = getConversationKey(event);
  if (!key) return false;
  delete contextStore.conversations[key];
  scheduleContextWrite();
  return true;
}

function buildConversationContext(entries) {
  if (!CONTEXT_ENABLED || !Array.isArray(entries) || entries.length === 0) return '';

  const lines = [];
  let totalChars = 0;
  for (const item of entries.slice().reverse()) {
    const block = [
      `Previous original (${item.sourceLang || 'unknown'}): ${item.original}`,
      `Previous translation (${item.targetLang || 'unknown'}): ${item.translation}`,
    ].join('\n');

    if (totalChars + block.length > CONTEXT_MAX_CHARS) break;
    lines.unshift(block);
    totalChars += block.length;
  }

  return lines.join('\n\n');
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  return (
    /^UI_[A-Z0-9_:.-]+$/u.test(t) ||
    /^SYS_[A-Z0-9_:.-]+$/u.test(t) ||
    /^CMD_[A-Z0-9_:.-]+$/u.test(t)
  );
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
  return ['group', 'room', 'user'].includes(getSourceType(event));
}

function isAdmin(event) {
  const userId = getUserIdFromEvent(event);
  return !!userId && ADMIN_USER_IDS.has(userId);
}

function getAuthorizedRecord(sourceId) {
  return authStore.sources[sourceId] || null;
}

function isSourceAuthorized(event) {
  const sourceType = getSourceType(event);
  const sourceId = getSourceId(event);

  if (!sourceId) return false;
  if (sourceType === 'user') return AUTH_ALLOW_USER_CHAT;

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
  authStore.sources[sourceId] = {
    ...(authStore.sources[sourceId] || {}),
    authorized: false,
    mode: authStore.sources[sourceId]?.mode || DEFAULT_TRANSLATION_MODE,
    updatedAt: new Date().toISOString(),
    note: 'manual unauth',
  };
  writeJsonSafe(AUTH_FILE, authStore);
}

function getSourceMode(sourceId) {
  return getAuthorizedRecord(sourceId)?.mode || DEFAULT_TRANSLATION_MODE;
}

function setSourceMode(sourceId, mode) {
  authStore.sources[sourceId] = {
    ...(authStore.sources[sourceId] || {}),
    authorized: authStore.sources[sourceId]?.authorized === true,
    mode,
    updatedAt: new Date().toISOString(),
    note: 'mode updated',
  };
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

function shouldSkipBecausePureCode(text) {
  if (hasChinese(text) || hasThai(text) || hasMyanmar(text)) return false;

  const stripped = text.replace(/\s+/g, '');
  if (!stripped) return true;

  if (/^[?!？！，。….,~～]+$/.test(stripped)) return true;
  if (/^[0-9\-_/.:#+()&\[\]%]+$/.test(stripped)) return true;
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

  if (hasChinese(t) || hasThai(t) || hasMyanmar(t)) return true;
  return countEnglishWords(t) >= 1;
}

function createPlaceholder(type, idx) {
  return `[[[${type}_${idx}]]]`;
}

function protectMentions(text, mention) {
  if (!mention || !Array.isArray(mention.mentionees)) {
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
  const map = {};
  let idx = 0;

  const out = text.replace(/(\p{Extended_Pictographic}(?:\uFE0F)?)/gu, (m) => {
    const ph = createPlaceholder('EMOJI', idx++);
    map[ph] = m;
    return ph;
  });

  return { text: out, map };
}

function protectUrls(text) {
  const map = {};
  let idx = 0;

  const out = text.replace(/https?:\/\/[^\s]+/gi, (m) => {
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

  out = out.replace(/\b\d+(?:\/\d+){1,}\b/g, (m) => {
    const ph = createPlaceholder('CODE', idx++);
    map[ph] = m;
    return ph;
  });

  out = out.replace(/\b(?:#?[A-Za-z]{1,6}\d{1,10}|\d{1,10}[A-Za-z]{1,6}|[A-Za-z]{1,6}-\d{1,10})\b/g, (m) => {
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

function applyGlobalDictionaryBefore(text) {
  return text;
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
    out = out.replace(new RegExp(escapeRegExp(item.from), 'g'), replacement);
  }

  return out;
}

function buildChatPhraseHints(text, targetLang) {
  const hints = [];

  for (const item of CHAT_PHRASE_HINTS) {
    if (!item || !item.phrase) continue;

    if (text.includes(item.phrase) && targetLang === '繁體中文' && item.meaningZh) {
      hints.push(`- "${item.phrase}" in casual Thai chat usually means "${item.meaningZh}".`);
    }
  }

  return hints.join('\n');
}

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
    if (en && !zh && !th && !my) return { sourceLang: 'English', targetLang: '繁體中文' };

    if (zh && th) {
      if (zhCount >= thCount) return { sourceLang: '繁體中文（含部分ไทย）', targetLang: 'ไทย' };
      return { sourceLang: 'ไทย（含部分中文）', targetLang: '繁體中文' };
    }

    if (zh && en && !th) return { sourceLang: '繁體中文（含部分English）', targetLang: 'ไทย' };
    if (th && en && !zh) return { sourceLang: 'ไทย（含部分English）', targetLang: '繁體中文' };

    return null;
  }

  if (m === 'zh-en') {
    if (zh && !en) return { sourceLang: '繁體中文', targetLang: 'English' };
    if (en && !zh && !th && !my) return { sourceLang: 'English', targetLang: '繁體中文' };

    if (zh && en && !th && !my) {
      if (zhCount >= enCount) return { sourceLang: '繁體中文（含部分English）', targetLang: 'English' };
      return { sourceLang: 'English（含部分中文）', targetLang: '繁體中文' };
    }

    if (th && !zh) return { sourceLang: 'ไทย', targetLang: '繁體中文' };
    if (my && !zh) return { sourceLang: 'မြန်မာဘာသာ', targetLang: '繁體中文' };

    return null;
  }

  if (m === 'zh-my') {
    if (zh && !my) return { sourceLang: '繁體中文', targetLang: 'မြန်မာဘာသာ' };
    if (my && !zh) return { sourceLang: 'မြန်မာဘာသာ', targetLang: '繁體中文' };
    if (en && !zh && !my && !th) return { sourceLang: 'English', targetLang: '繁體中文' };

    if (zh && my) {
      if (zhCount >= myCount) return { sourceLang: '繁體中文（含部分မြန်မာဘာသာ）', targetLang: 'မြန်မာဘာသာ' };
      return { sourceLang: 'မြန်မာဘာသာ（含部分中文）', targetLang: '繁體中文' };
    }

    if (zh && en && !my) return { sourceLang: '繁體中文（含部分English）', targetLang: 'မြန်မာဘာသာ' };
    if (my && en && !zh) return { sourceLang: 'မြန်မာဘာသာ（含部分English）', targetLang: '繁體中文' };

    return null;
  }

  return null;
}

function isLikelyUntranslated(originalText, translatedText, targetLang) {
  const original = normalizeText(originalText);
  const translated = normalizeText(translatedText);

  if (!original || !translated) return false;
  if (original === translated && original.length > 8) return true;

  if (targetLang === '繁體中文') {
    if ((hasThai(translated) || hasMyanmar(translated)) && !hasChinese(translated)) return true;
  }

  if (targetLang === 'ไทย') {
    if (hasChinese(translated) && !hasThai(translated)) return true;
  }

  if (targetLang === 'English') {
    if (hasChinese(translated) && !hasEnglish(translated)) return true;
  }

  if (targetLang === 'မြန်မာဘာသာ') {
    if (hasChinese(translated) && !hasMyanmar(translated)) return true;
  }

  return false;
}

function needsThaiRefine(text) {
  return /เขา|คุณ|ฉัน|ผม|เรา|ยุ่ง|ว่าง|ที่ไหนละ|ห่วง|หมา|พิรุธ|บอกอะไร|หมายถึง|แจ้ง|ตำรวจ|ลูกค้า|เพื่อน|ก่อน|หลัง|ไม่ได้|ไม่ใช่|ไม่มี|ยัง|แล้ว|กำลัง|จะ|เคย|เพิ่ง|หรอ|เหรอ|ไหม|มั้ย/.test(text);
}

function needsMyanmarPolish(text) {
  return normalizeText(text).length >= 30;
}


function buildThaiSemanticHints(text, sourceLang, targetLang) {
  if (!String(sourceLang || '').includes('ไทย')) return '';

  const t = normalizeText(text);
  const hints = [];

  // 時間方向：這兩個詞翻反會造成實質意思相反。
  if (/ก่อน\s*\d{1,2}(?::\d{2})?/u.test(t) || /ก่อนเวลา/u.test(t)) {
    hints.push('- ก่อน + time = before that time / 在該時間之前；絕對不能翻成之後。');
  }
  if (/หลัง\s*\d{1,2}(?::\d{2})?/u.test(t) || /หลังเวลา/u.test(t)) {
    hints.push('- หลัง + time = after that time / 在該時間之後；絕對不能翻成之前。');
  }

  // 否定、時態、體貌。
  if (/ไม่ได้/u.test(t)) hints.push('- ไม่ได้ = cannot / not possible / did not（依句意）；必須保留否定。');
  if (/ไม่ใช่/u.test(t)) hints.push('- ไม่ใช่ = is not / 不是；必須保留否定。');
  if (/ไม่มี/u.test(t)) hints.push('- ไม่มี = do not have / there is no / 沒有；必須保留否定。');
  if (/(^|\s)ไม่/u.test(t)) hints.push('- ไม่ is a negator；不可漏譯或翻成肯定。');
  if (/ยัง/u.test(t)) hints.push('- ยัง may mean still / yet；依句型保留「還／尚未」的時間關係。');
  if (/แล้ว/u.test(t)) hints.push('- แล้ว often marks already / completion；不可無故翻成「還沒」。');
  if (/กำลัง/u.test(t)) hints.push('- กำลัง marks an action in progress（正在）。');
  if (/เพิ่ง/u.test(t)) hints.push('- เพิ่ง = just recently / 剛剛。');
  if (/เคย/u.test(t)) hints.push('- เคย = ever / 曾經。');
  if (/จะ/u.test(t)) hints.push('- จะ usually marks intention or future（要／將會），依上下文翻譯。');

  // 常見疑問與語氣。
  if (/(?:หรอ|เหรอ|ไหม|มั้ย|หรือเปล่า)(?:คะ|ค่ะ|ครับ|จ๊ะ|จ้ะ)?[\s.!！。…]*$/u.test(t)) {
    hints.push('- 句尾疑問詞加禮貌詞仍是疑問句；中文通常保留「嗎／呢／是不是」。');
  }
  if (/ก่อน\s*02:00\s*ไม่ได้\s*(?:หรอ|เหรอ)/u.test(t.replace(/\s+/g, ''))) {
    hints.push('- 本句結構是「02:00 之前不行嗎？」／「不能在 02:00 前嗎？」。');
  }

  if (!hints.length) return '';
  return `THAI SEMANTIC ANCHORS (must preserve):\n${hints.join('\n')}`;
}

function hasThaiSemanticViolation(originalText, translatedText, sourceLang, targetLang) {
  if (!String(sourceLang || '').includes('ไทย') || targetLang !== '繁體中文') return false;

  const src = normalizeText(originalText).replace(/\s+/g, '');
  const out = normalizeText(translatedText);

  const srcBeforeTime = /ก่อน\d{1,2}(?::\d{2})?/u.test(src);
  const srcAfterTime = /หลัง\d{1,2}(?::\d{2})?/u.test(src);
  const outBefore = /(之前|以前|前\b|前面)/u.test(out);
  const outAfter = /(之後|以後|後\b|後面)/u.test(out);

  if (srcBeforeTime && outAfter && !outBefore) return true;
  if (srcAfterTime && outBefore && !outAfter) return true;

  const srcNegative = /ไม่ได้|ไม่ใช่|ไม่มี|(^|[^ก-๙])ไม่/u.test(src);
  const outNegative = /(不|沒|無|未|不能|不行|不可以|不是|沒有|尚未)/u.test(out);
  if (srcNegative && !outNegative) return true;

  return false;
}


function detectSentenceType(text, sourceLang = '') {
  const t = normalizeText(text);
  if (!t) return 'unknown';

  const hasQuestionMark = /[?？]/u.test(t);
  const lang = String(sourceLang || '');

  if (hasQuestionMark) return 'question';

  if (lang.includes('繁體中文')) {
    if (/(嗎|么|呢|是不是|可不可以|有沒有|能不能|要不要|好不好|對不對|對嗎|是嗎|真的嗎|怎麼|為什麼|哪裡|哪個|多少|幾點|誰|什麼|何時|何處)[。！!…]*$/u.test(t)) return 'question';
  }

  if (lang.includes('ไทย')) {
    // 泰文口語疑問詞後面常接禮貌語氣詞：คะ / ค่ะ / ครับ / จ๊ะ / จ้ะ
    // 例如：หรอคะ、เหรอค่ะ、ไหมครับ、หรือคะ，都必須判定為疑問句。
    if (/(?:ไหม|มั้ย|หรือไม่|หรือเปล่า|รึเปล่า|หรือยัง|หรือ|เหรอ|หรอ|ใช่ไหม|ได้ไหม)(?:คะ|ค่ะ|ครับ|จ๊ะ|จ้ะ)?[\s.!！。…]*$/u.test(t)) return 'question';
    if (/^(ใคร|อะไร|ที่ไหน|เมื่อไหร่|ทำไม|อย่างไร|ยังไง|เท่าไหร่|กี่)/u.test(t)) return 'question';
  }

  if (lang.includes('English')) {
    if (/^(who|what|when|where|why|how|which|whose|is|are|am|was|were|do|does|did|can|could|will|would|shall|should|have|has|had|may|might)\b/iu.test(t)) return 'question';
  }

  if (lang.includes('မြန်မာ')) {
    if (/(လား|လဲ|လေား|မလား|ဘူးလား|သလား|နည်း|ဘာ|ဘယ်|ဘယ်မှာ|ဘယ်သူ|ဘယ်တော့|ဘာကြောင့်)[။!！…]*$/u.test(t)) return 'question';
  }

  if (/^[\s]*(?:請|麻煩|幫我|不要|別|記得|快點|過來|下來|上來|回來|出去|進來)/u.test(t)) return 'command';
  if (/^[\s]*(?:ไป|อย่า|ช่วย|กรุณา)(?:\s|$)/u.test(t)) return 'command';
  if (/^[\s]*(?:please|do not|don't)\b/iu.test(t)) return 'command';
  // 中文句尾「吧」通常表示建議、邀請或較柔和的祈使，不是疑問句。
  if (lang.includes('繁體中文') && /吧[。！!…]*$/u.test(t)) return 'command';
  if (/[!！]+$/u.test(t)) return 'exclamation';
  return 'statement';
}

function outputLooksLikeQuestion(text, targetLang = '') {
  const t = normalizeText(text);
  if (!t) return false;
  if (/[?？]/u.test(t)) return true;

  const lang = String(targetLang || '');
  if (lang === '繁體中文') {
    return /(嗎|么|呢|是不是|可以嗎|好嗎|對嗎|是嗎|有嗎|要嗎|行嗎)[。！!…]*$/u.test(t);
  }
  if (lang === 'ไทย') {
    return /(?:ไหม|มั้ย|หรือไม่|หรือเปล่า|รึเปล่า|หรือยัง|หรือ|เหรอ|หรอ|ใช่ไหม|ได้ไหม)(?:คะ|ค่ะ|ครับ|จ๊ะ|จ้ะ)?[\s.!！。…]*$/u.test(t);
  }
  if (lang === 'English') {
    return /^(who|what|when|where|why|how|which|whose|is|are|am|was|were|do|does|did|can|could|will|would|shall|should|have|has|had|may|might)\b/iu.test(t);
  }
  if (lang === 'မြန်မာဘာသာ') {
    return /(လား|မလား|ဘူးလား|သလား)[။!！…]*$/u.test(t);
  }
  return false;
}

function hasSentenceTypeViolation(originalText, translatedText, sourceLang, targetLang) {
  const sourceType = detectSentenceType(originalText, sourceLang);
  if (sourceType === 'statement' && outputLooksLikeQuestion(translatedText, targetLang)) return true;
  if (sourceType === 'question' && !outputLooksLikeQuestion(translatedText, targetLang)) return true;
  return false;
}

function buildSentenceTypeInstruction(originalText, sourceLang, targetLang) {
  const sourceType = detectSentenceType(originalText, sourceLang);
  return `SOURCE SENTENCE TYPE: ${sourceType}. The output MUST remain a ${sourceType}. Target language: ${targetLang}.`;
}

function buildTranslationPrompt(sourceLang, targetLang, originalText = '', conversationContext = '') {
  const isMyanmarRelated = sourceLang.includes('မြန်မာ') || targetLang.includes('မြန်မာ');
  const chatHints = buildChatPhraseHints(originalText, targetLang);
  const thaiSemanticHints = buildThaiSemanticHints(originalText, sourceLang, targetLang);
  const contextSection = conversationContext
    ? `\nRECENT CONVERSATION CONTEXT (reference only; translate only the newest user message):\n${conversationContext}\n`
    : '';

  return `
You are a professional translator for casual LINE chat messages.

Translate from ${sourceLang} into ${targetLang}.

${buildSentenceTypeInstruction(originalText, sourceLang, targetLang)}

SENTENCE-TYPE PRESERVATION — ABSOLUTE RULE:
- Never change a statement into a question.
- Never change a question into a statement.
- Never infer an omitted question merely because the message is casual or lacks punctuation.
- Chinese sentence-final 吧 usually marks a suggestion, invitation, or softened command; it is NOT automatically a question.
- Do not add question marks or question particles that are absent from the source meaning.
- For a statement, never add: 嗎 / 呢 / ? / ไหม / มั้ย / หรือเปล่า / เหรอ / လား or an English question structure.
- Conversation context may clarify pronouns, but it MUST NOT change the sentence type or communicative intent.
- Translate what is written; do not guess what the sender probably wanted to ask.

Examples:
- 今天西門町有房間 → วันนี้ซีเหมินติงมีห้องว่าง (NOT: วันนี้ซีเหมินติงมีห้องว่างไหม)
- 今天下班了 → วันนี้เลิกงานแล้ว (NOT: วันนี้เลิกงานแล้วหรือยัง)
- 房間很小嗎？ → ห้องเล็กมากไหม? (keep it a question)

MANDATORY OUTPUT RULES:
1. Output ONLY the translation.
2. Do not explain.
3. Do not add labels.
4. Do not add quotation marks.
5. Preserve placeholders exactly:
   [[[MENTION_*]]], [[[EMOJI_*]]], [[[URL_*]]], [[[KEEP_*]]], [[[CODE_*]]], [[[TOKEN_*]]]
6. Keep numbers, codes, IDs, URLs, prices, product specs unchanged.
7. Translate all natural human-readable words.

GENERAL CHAT RULES:
- Most messages are casual LINE chat.
- Prefer natural conversational meaning over literal dictionary meaning.
- Do not translate word-by-word.
- Preserve meaning, tone, intention, and social relationship.
- Short replies should stay short and natural.
- Avoid stiff, formal, literary, or machine-like wording.
- Mixed-language messages must become fluent ${targetLang}.
- If a sentence is a joke, tease, sarcasm, rhetorical question, or emotional reply, translate the implied meaning naturally.

CRITICAL THAI PRONOUN RULES:
- คุณ = 你
- ฉัน = 我
- ผม = 我
- เรา = 我 / 我們，依上下文判斷
- เขา = 他 / 她 / 對方 / 那個人
- Do NOT translate Thai "เขา" as "你" unless the original clearly means the listener.
- If context is unclear, translate "เขา" as "他" or "對方", NOT "你".
- If a sentence contains both "เขา" and "คุณ", keep them separate:
  เขา = 他/她/對方
  คุณ = 你
- Never randomly change 我、你、他/她.
- Keep speaker, listener, and third-person references consistent.

THAI CHAT MEANING RULES:
- Thai "ยุ่ง" in casual chat often means "忙", not "打擾".
- "ไม่ยุ่งแล้วคะ/ค่ะ" usually means "不忙了 / 現在有空了", not "不再打擾了".
- "ว่าง" usually means "有空 / 空閒" in chat context.
- Polite particles คะ / ค่ะ / ครับ indicate tone and should not be translated literally.

THAI RHETORICAL / SARCASM RULES:
- Thai pattern "จะให้...ที่ไหนละ" often means "難道要...嗎？", not a real location question.
- Do NOT translate "ที่ไหนละ" literally as "去哪裡" when it is used rhetorically.
- Example:
  "ไม่ให้ห่วงคุณจะให้ห่วงหมาที่ไหนละ 555"
  means:
  "不擔心你，難道要去擔心狗嗎？哈哈"
  or naturally:
  "不擔心你，不然我要擔心誰？哈哈"

MYANMAR / BURMESE RULES:
${isMyanmarRelated ? `
- For Chinese -> Myanmar, translate meaning naturally, not word-by-word.
- Use natural Burmese word order.
- For Myanmar -> Traditional Chinese, use fluent Traditional Chinese.
- Avoid Chinese-style Burmese.
- Avoid Burmese-style Chinese.
` : '- No special Burmese handling needed.'}

${chatHints ? `IMPORTANT PHRASE HINTS:\n${chatHints}` : ''}
${thaiSemanticHints ? `${thaiSemanticHints}\n` : ''}
${contextSection}
CONTEXT RULES:
- Use recent context only to resolve omitted subjects, pronouns, relationships, time references, and short replies.
- Context is evidence, not permission to reinterpret a statement as a question or vice versa.
- Never merge previous messages into the output.
- Never answer the conversation; translate only the newest message.
- Do not invent a subject when the source intentionally omits it.
- Preserve speaker/listener/third-person roles consistently across turns.

Final check:
- Preserve 我 / 你 / 他 correctly.
- Avoid literal Thai rhetorical translation.
- Choose casual chat meaning.
- Output ONLY the final translation.
`.trim();
}

function shouldRetryOpenAIError(err) {
  const code = err?.code || err?.cause?.code || err?.error?.code;
  const message = err?.message || '';
  const status = err?.status;

  return (
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    message.includes('ERR_STREAM_PREMATURE_CLOSE') ||
    message.includes('Invalid response body') ||
    message.includes('Premature close') ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

async function callOpenAIChatWithRetry(messages, temperature, label = 'openai') {
  const maxRetries = 2;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature,
        messages,
      });

      return response.choices?.[0]?.message?.content?.trim() || '';
    } catch (err) {
      lastErr = err;
      const canRetry = shouldRetryOpenAIError(err);

      console.error(`${label} attempt ${attempt} failed:`, {
        message: err?.message,
        status: err?.status,
        code: err?.code || err?.cause?.code || err?.error?.code,
        retry: canRetry,
      });

      if (!canRetry || attempt === maxRetries) throw err;
      await sleep(500 * attempt);
    }
  }

  throw lastErr;
}

async function translateWithOpenAI(protectedText, sourceLang, targetLang, strictRetry = false, conversationContext = '') {
  const basePrompt = buildTranslationPrompt(sourceLang, targetLang, protectedText, conversationContext);

  const systemPrompt = strictRetry
    ? `${basePrompt}

EXTRA STRICT RETRY:
The previous translation may have used the wrong pronoun, literal chat meaning, or sentence type.
Check:
- Preserve the exact sentence type. A statement must stay a statement; a question must stay a question.
- Never add ไหม / มั้ย / หรือเปล่า / เหรอ / 嗎 / 呢 / လား / ? unless the source is truly a question.
- เขา = 他/她/對方, not 你.
- คุณ = 你.
- ยุ่ง often means 忙.
- ที่ไหนละ in rhetorical sentences is not 去哪裡.
- ก่อน + time = before / 之前; หลัง + time = after / 之後. Never reverse them.
- Preserve every negation: ไม่ / ไม่ได้ / ไม่ใช่ / ไม่มี.
- For ก่อน02:00ไม่ได้หรอ, the meaning is 02:00 之前不行嗎？
Output only the corrected translation.`
    : basePrompt;

  return callOpenAIChatWithRetry(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: protectedText },
    ],
    strictRetry ? 0.03 : 0.08,
    'translateWithOpenAI'
  );
}

async function refineChatTranslation(protectedOriginal, translatedText, sourceLang, targetLang) {
  return callOpenAIChatWithRetry(
    [
      {
        role: 'system',
        content: `
You are a senior LINE chat translation editor.

Fix only if needed.

ABSOLUTE SENTENCE-TYPE RULE:
- Preserve whether the original is a statement, question, command, or exclamation.
- Never turn a statement into a question.
- Never add question particles or question marks not supported by the original.

Important:
- Thai เขา = 他 / 她 / 對方, not 你.
- Thai คุณ = 你.
- Thai ยุ่ง in casual chat usually means 忙.
- ไม่ยุ่งแล้วคะ/ค่ะ = 不忙了 / 現在有空了.
- Thai "จะให้...ที่ไหนละ" often means "難道要...嗎？".
- Do NOT translate rhetorical "ที่ไหนละ" literally as "去哪裡".
- Keep jokes and teasing natural.
- Preserve placeholders exactly.
- Output only the improved translation.

Source language: ${sourceLang}
Target language: ${targetLang}
`.trim(),
      },
      {
        role: 'user',
        content: `Original:\n${protectedOriginal}\n\nCurrent translation:\n${translatedText}`,
      },
    ],
    0.03,
    'refineChatTranslation'
  );
}

async function polishMyanmarTranslation(protectedText, translatedText, sourceLang, targetLang) {
  return callOpenAIChatWithRetry(
    [
      {
        role: 'system',
        content: `
You are a senior Chinese-Burmese translation editor.

Improve only if needed.
Keep exact meaning and exact sentence type.
Never turn a statement into a question or add Burmese question particles not present in meaning.
Use natural Burmese or fluent Traditional Chinese.
Do not explain.
Preserve placeholders exactly.
Output only the improved translation.

Source language: ${sourceLang}
Target language: ${targetLang}
`.trim(),
      },
      {
        role: 'user',
        content: `Original:\n${protectedText}\n\nTranslation to improve:\n${translatedText}`,
      },
    ],
    0.03,
    'polishMyanmarTranslation'
  );
}

async function translateText(text, mention, mode, conversationEntries = []) {
  const normalized = normalizeText(text);
  if (!shouldTranslateText(normalized)) return null;

  const direction = detectTranslationDirection(normalized, mode);
  if (!direction) return null;

  const beforeDict = applyGlobalDictionaryBefore(normalized);
  const protectedPack = protectText(beforeDict, mention);
  const conversationContext = buildConversationContext(conversationEntries);

  let translatedProtected = await translateWithOpenAI(
    protectedPack.text,
    direction.sourceLang,
    direction.targetLang,
    false,
    conversationContext
  );

  if (!translatedProtected) return null;

  const isThaiToChinese =
    direction.sourceLang.includes('ไทย') &&
    direction.targetLang === '繁體中文';

  const isMyanmarMode = String(mode || '').toLowerCase() === 'zh-my';

  if (isThaiToChinese && needsThaiRefine(normalized)) {
    try {
      const refined = await refineChatTranslation(
        protectedPack.text,
        translatedProtected,
        direction.sourceLang,
        direction.targetLang
      );

      if (refined) translatedProtected = refined;
    } catch (err) {
      console.error('refineChatTranslation skipped:', err?.message);
    }
  }

  if (isMyanmarMode && needsMyanmarPolish(normalized)) {
    try {
      const polished = await polishMyanmarTranslation(
        protectedPack.text,
        translatedProtected,
        direction.sourceLang,
        direction.targetLang
      );

      if (polished) translatedProtected = polished;
    } catch (err) {
      console.error('polishMyanmarTranslation skipped:', err?.message);
    }
  }

  let restored = restorePlaceholders(translatedProtected, protectedPack.map);
  restored = applyGlobalDictionaryAfter(restored, direction.targetLang).trim();

  if (!restored) return null;

  if (hasSentenceTypeViolation(normalized, restored, direction.sourceLang, direction.targetLang)) {
    try {
      const sentenceTypeRetry = await translateWithOpenAI(
        protectedPack.text,
        direction.sourceLang,
        direction.targetLang,
        true,
        ''
      );

      if (sentenceTypeRetry) {
        const checkedRetry = applyGlobalDictionaryAfter(
          restorePlaceholders(sentenceTypeRetry, protectedPack.map),
          direction.targetLang
        ).trim();

        if (checkedRetry && !hasSentenceTypeViolation(normalized, checkedRetry, direction.sourceLang, direction.targetLang)) {
          restored = checkedRetry;
        } else {
          console.warn('Sentence-type retry still violated the source sentence type; keeping the safer candidate.');
        }
      }
    } catch (err) {
      console.error('sentence-type retry skipped:', err?.message);
    }
  }

  if (hasThaiSemanticViolation(normalized, restored, direction.sourceLang, direction.targetLang)) {
    try {
      const semanticRetry = await translateWithOpenAI(
        protectedPack.text,
        direction.sourceLang,
        direction.targetLang,
        true,
        ''
      );

      if (semanticRetry) {
        const checkedSemanticRetry = applyGlobalDictionaryAfter(
          restorePlaceholders(semanticRetry, protectedPack.map),
          direction.targetLang
        ).trim();

        if (checkedSemanticRetry && !hasThaiSemanticViolation(normalized, checkedSemanticRetry, direction.sourceLang, direction.targetLang)) {
          restored = checkedSemanticRetry;
        } else {
          console.warn('Thai semantic retry still has a possible direction/negation mismatch; returning best candidate.');
        }
      }
    } catch (err) {
      console.error('Thai semantic retry skipped:', err?.message);
    }
  }

  if (isLikelyUntranslated(normalized, restored, direction.targetLang)) {
    translatedProtected = await translateWithOpenAI(
      protectedPack.text,
      direction.sourceLang,
      direction.targetLang,
      true,
      conversationContext
    );

    if (translatedProtected) {
      const retryRestored = applyGlobalDictionaryAfter(
        restorePlaceholders(translatedProtected, protectedPack.map),
        direction.targetLang
      ).trim();

      if (retryRestored && !hasSentenceTypeViolation(normalized, retryRestored, direction.sourceLang, direction.targetLang)) restored = retryRestored;
    }
  }

  if (hasSentenceTypeViolation(normalized, restored, direction.sourceLang, direction.targetLang)) {
    // 不再因句型檢查器無法辨識罕見口語而讓機器人完全不回覆。
    // 前面已經執行嚴格重翻；若仍有差異，記錄警告並回傳最佳候選翻譯。
    console.warn('Sentence-type check still differs after retry; returning best candidate instead of silently dropping:', {
      original: normalized,
      translation: restored,
      sourceLang: direction.sourceLang,
      targetLang: direction.targetLang,
    });
  }

  return restored
    ? { text: restored, sourceLang: direction.sourceLang, targetLang: direction.targetLang }
    : null;
}

async function replyText(replyToken, text) {
  if (!replyToken || !text) return null;

  return client.replyMessage(replyToken, {
    type: 'text',
    text,
  });
}

async function handleCommand(event, text) {
  const t = normalizeText(text);
  const lower = t.toLowerCase();

  const sourceId = getSourceId(event);
  const sourceType = getSourceType(event);
  const userId = getUserIdFromEvent(event) || 'unknown';

  if (lower === '/ping' || lower === '!ping') {
    return replyText(event.replyToken, 'pong');
  }

  if (lower === '/id' || lower === '!id') {
    return replyText(
      event.replyToken,
      `sourceType: ${sourceType}\nsourceId: ${sourceId || 'unknown'}\nuserId: ${userId}`
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
/memory
/clearcontext
/auth
/unauth
/mode zh-th
/mode zh-en
/mode zh-my

模式：
- zh-th：中文→泰文，泰文→中文，英文→中文
- zh-en：中文→英文，英文→中文
- zh-my：中文→緬文，緬文→中文，英文→中文

重點：
- 快速模式：一般句子只翻譯一次
- 只有容易錯的泰文句型才二次修正
- เขา 優先翻成 他/她/對方
- 已優化 ที่ไหนละ 反問句
- 已優化 ยุ่ง / ว่าง 聊天語境
- 已加入 OpenAI 斷線重試
- 已加入聊天室獨立對話記憶`
    );
  }

  if (lower === '/status') {
    const authorized = isSourceAuthorized(event);
    const mode = sourceId ? getSourceMode(sourceId) : DEFAULT_TRANSLATION_MODE;

    return replyText(
      event.replyToken,
      `授權狀態：${authorized ? '已授權' : '未授權'}\n模式：${mode}（${modeDisplayName(mode)}）\n管理員：${isAdmin(event) ? '是' : '否'}\n你的 userId：${userId}`
    );
  }

  if (lower === '/memory' || lower === '!memory') {
    const count = getConversationEntries(event).length;
    return replyText(
      event.replyToken,
      `對話記憶：${CONTEXT_ENABLED ? '已啟用' : '已停用'}\n目前保留：${count} 則\n上限：${CONTEXT_MAX_MESSAGES} 則\n保存期限：${CONTEXT_TTL_HOURS} 小時`
    );
  }

  if (lower === '/clearcontext' || lower === '!clearcontext') {
    if (!isAdmin(event)) return replyText(event.replyToken, '你沒有清除對話記憶的權限。');
    clearConversationEntries(event);
    return replyText(event.replyToken, '已清除此聊天室的翻譯對話記憶。');
  }

  if (lower === '/auth') {
    if (!isAdmin(event)) return replyText(event.replyToken, '你沒有授權權限。');

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
    if (!isAdmin(event)) return replyText(event.replyToken, '你沒有授權權限。');

    if (!(sourceType === 'group' || sourceType === 'room')) {
      return replyText(event.replyToken, '只能在群組或多人聊天室內執行 /unauth。');
    }

    unauthorizeSource(sourceId);
    return replyText(event.replyToken, '已取消此群組/聊天室的翻譯授權。');
  }

  if (lower === '/mode zh-th' || lower === '/mode zh-en' || lower === '/mode zh-my') {
    if (!isAdmin(event)) return replyText(event.replyToken, '你沒有切換模式的權限。');

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

async function handleTextMessage(event) {
  const msg = event.message;
  const originalText = msg.text || '';

  if (!isAllowedSourceType(event)) return null;

  if (isCommand(originalText)) {
    return handleCommand(event, originalText);
  }

  if (isSystemControlText(originalText)) return null;

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

  const conversationEntries = getConversationEntries(event);
  const result = await translateText(originalText, msg.mention, mode, conversationEntries);

  if (!result?.text) return null;

  addConversationEntry(event, {
    original: originalText,
    translation: result.text,
    sourceLang: result.sourceLang,
    targetLang: result.targetLang,
  });

  return replyText(event.replyToken, result.text);
}

async function handleEvent(event) {
  try {
    if (event.type !== 'message') return null;
    if (event.message.type !== 'text') return null;

    return await handleTextMessage(event);
  } catch (err) {
    console.error('handleEvent error message:', err?.message);
    console.error('handleEvent error status:', err?.status);
    console.error('handleEvent error code:', err?.code || err?.cause?.code || err?.error?.code);
    console.error('handleEvent error full:', err);

    try {
      return await replyText(event.replyToken, '翻譯時發生錯誤，請稍後再試。');
    } catch (replyErr) {
      console.error('reply error:', replyErr);
      return null;
    }
  }
}

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
    contextEnabled: CONTEXT_ENABLED,
    contextMaxMessages: CONTEXT_MAX_MESSAGES,
    contextTtlHours: CONTEXT_TTL_HOURS,
    conversationCount: Object.keys(contextStore.conversations).length,
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
  console.log(`✅ LINE bot server running on port ${PORT} (v3.2)`);
  console.log(`✅ REQUIRE_AUTHORIZATION = ${REQUIRE_AUTHORIZATION}`);
  console.log(`✅ AUTH_ALLOW_USER_CHAT = ${AUTH_ALLOW_USER_CHAT}`);
  console.log(`✅ DEFAULT_TRANSLATION_MODE = ${DEFAULT_TRANSLATION_MODE}`);
  console.log(`✅ OPENAI_MODEL = ${OPENAI_MODEL}`);
  console.log(`✅ ADMIN_USER_IDS count = ${ADMIN_USER_IDS.size}`);
  console.log(`✅ CONTEXT_ENABLED = ${CONTEXT_ENABLED}`);
  console.log(`✅ CONTEXT_MAX_MESSAGES = ${CONTEXT_MAX_MESSAGES}`);
  console.log(`✅ CONTEXT_TTL_HOURS = ${CONTEXT_TTL_HOURS}`);
});
