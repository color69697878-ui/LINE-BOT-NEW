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
  console.error('❌ 缺少必要環境變數');
  process.exit(1);
}

const client = new line.Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PORT = Number(process.env.PORT || 3000);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

const REQUIRE_AUTHORIZATION = true;
const AUTH_ALLOW_USER_CHAT = String(process.env.AUTH_ALLOW_USER_CHAT || 'false').toLowerCase() === 'true';
const DEFAULT_TRANSLATION_MODE = String(process.env.TRANSLATION_MODE || 'zh-th').toLowerCase();

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
  { lang: 'thai', phrase: 'ไม่ยุ่งแล้วคะ', meaningZh: '不忙了 / 現在有空了' },
  { lang: 'thai', phrase: 'ไม่ยุ่งแล้วค่ะ', meaningZh: '不忙了 / 現在有空了' },
  { lang: 'thai', phrase: 'ว่างแล้ว', meaningZh: '有空了 / 現在有空' },
  { lang: 'thai', phrase: 'ไม่ว่าง', meaningZh: '沒空 / 不方便' },
  { lang: 'thai', phrase: 'ได้ค่ะ', meaningZh: '可以 / 好的' },
];

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_FILE = path.join(DATA_DIR, 'authorized-sources.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  try {
    ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('writeJsonSafe error:', err);
    return false;
  }
}

function loadAuthStore() {
  const initial = readJsonSafe(AUTH_FILE, { sources: {} });

  if (!initial.sources || typeof initial.sources !== 'object') {
    initial.sources = {};
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

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(text) {
  return (text || '').replace(/\r\n/g, '\n').replace(/\u00A0/g, ' ').trim();
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
  return /^UI_[A-Z0-9_:.-]+$/u.test(t) || /^SYS_[A-Z0-9_:.-]+$/u.test(t) || /^CMD_[A-Z0-9_:.-]+$/u.test(t);
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
  if (!mention || !Array.isArray(mention.mentionees)) return { text, map: {} };

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
    map: { ...p1.map, ...p2.map, ...p3.map, ...p4.map },
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

function buildChatPhraseHints(text, sourceLang, targetLang) {
  const hints = [];

  for (const item of CHAT_PHRASE_HINTS) {
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

  if (targetLang === 'မြန်မာဘာသာ') {
    if (hasChinese(translated) && !hasMyanmar(translated)) return true;
  }

  return false;
}

function buildTranslationPrompt(sourceLang, targetLang, originalText = '') {
  const isMyanmarRelated = sourceLang.includes('မြန်မာ') || targetLang.includes('မြန်မာ');
  const chatHints = buildChatPhraseHints(originalText, sourceLang, targetLang);

  return `
You are a professional translator for LINE chat messages.

Translate from ${sourceLang} into ${targetLang}.

MANDATORY RULES:
1. Output ONLY the translation.
2. Do not explain.
3. Do not add labels.
4. Translate naturally based on casual chat context.
5. Preserve meaning, tone, intention, and speaker/listener relationship.
6. Preserve placeholders exactly:
   [[[MENTION_*]]], [[[EMOJI_*]]], [[[URL_*]]], [[[KEEP_*]]], [[[CODE_*]]], [[[TOKEN_*]]]
7. Keep numbers, codes, IDs, URLs, prices, product specs unchanged.
8. Mixed-language messages must become fluent ${targetLang}.

Conversation context:
- Most messages are casual LINE chat.
- Prefer natural chat meaning over literal dictionary meaning.
- Short replies should stay short and natural.
- Avoid stiff, formal, or machine-like wording.

Thai pronoun consistency rules:
- คุณ = 你
- ฉัน = 我
- ผม = 我
- เรา = 我 / 我們，依上下文判斷
- เขา = 他 / 她 / 對方 / 那個人
- Do NOT translate Thai "เขา" as "你" unless the sentence clearly says the listener is the person.
- If context is unclear, translate "เขา" as "他" or "對方", NOT "你".
- Keep speaker, listener, and third-person references consistent.
- Never randomly change 我、你、他/她.
- If a sentence contains both "เขา" and "คุณ", keep them separate: เขา = 他/她/對方, คุณ = 你.

Thai-specific meaning rules:
- Thai "ยุ่ง" in casual chat often means "忙", not "打擾".
- "ไม่ยุ่งแล้วคะ/ค่ะ" usually means "不忙了 / 現在有空了", not "不再打擾了".
- "ว่าง" means "有空 / 空閒" in chat context.
- Polite particles คะ / ค่ะ / ครับ indicate tone and should not be translated literally.

Myanmar/Burmese rules:
${isMyanmarRelated ? `
- For Chinese -> Myanmar, translate meaning naturally, not word-by-word.
- Use natural Burmese word order.
- For Myanmar -> Traditional Chinese, use fluent Traditional Chinese.
- Avoid Chinese-style Burmese and Burmese-style Chinese.
` : '- No special Burmese handling needed.'}

${chatHints ? `Important phrase hints:\n${chatHints}` : ''}

Output ONLY the translated result.
`.trim();
}

async function translateWithOpenAI(protectedText, sourceLang, targetLang, strictRetry = false) {
  const basePrompt = buildTranslationPrompt(sourceLang, targetLang, protectedText);

  const systemPrompt = strictRetry
    ? `${basePrompt}

Extra retry:
The previous translation may have used the wrong pronoun or wrong chat meaning.
Check pronouns carefully:
เขา = 他/她/對方, not 你.
คุณ = 你.
Translate again naturally.
Output only the corrected translation.`
    : basePrompt;

  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: strictRetry ? 0.03 : 0.08,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: protectedText },
    ],
  });

  return response.choices?.[0]?.message?.content?.trim() || '';
}

async function refineChatTranslation(protectedOriginal, translatedText, sourceLang, targetLang) {
  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.03,
    messages: [
      {
        role: 'system',
        content: `
You are a senior LINE chat translation editor.

Review and improve the translation.

Critical pronoun rules:
- Thai เขา should usually be 他 / 她 / 對方.
- Thai เขา must NOT become 你 unless the original clearly means the listener.
- Thai คุณ = 你.
- Thai ฉัน / ผม = 我.
- Keep 我、你、他/她 consistent.
- If uncertain, prefer 他 / 對方 for เขา.

Meaning rules:
- Fix literal dictionary mistakes.
- Thai ยุ่ง in casual chat usually means 忙.
- ไม่ยุ่งแล้วคะ/ค่ะ = 不忙了 / 現在有空了.
- Keep the translation short and natural.
- Do not add explanation.
- Preserve placeholders exactly.

Output only the improved translation.
Source language: ${sourceLang}
Target language: ${targetLang}
`.trim(),
      },
      {
        role: 'user',
        content: `Original:\n${protectedOriginal}\n\nCurrent translation:\n${translatedText}`,
      },
    ],
  });

  return response.choices?.[0]?.message?.content?.trim() || '';
}

async function polishMyanmarTranslation(protectedText, translatedText, sourceLang, targetLang) {
  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.03,
    messages: [
      {
        role: 'system',
        content: `
You are a senior Chinese-Burmese translation editor.

Improve the translation quality.
Keep the exact meaning.
Use natural Burmese or fluent Traditional Chinese.
Preserve all placeholders exactly.
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

  const isThaiToChinese =
    direction.sourceLang.includes('ไทย') &&
    direction.targetLang === '繁體中文';

  const isMyanmarMode = String(mode || '').toLowerCase() === 'zh-my';

  if (isThaiToChinese) {
    const refined = await refineChatTranslation(
      protectedPack.text,
      translatedProtected,
      direction.sourceLang,
      direction.targetLang
    );
    if (refined) translatedProtected = refined;
  }

  if (isMyanmarMode) {
    const polished = await polishMyanmarTranslation(
      protectedPack.text,
      translatedProtected,
      direction.sourceLang,
      direction.targetLang
    );
    if (polished) translatedProtected = polished;
  }

  let restored = restorePlaceholders(translatedProtected, protectedPack.map);
  restored = applyGlobalDictionaryAfter(restored, direction.targetLang).trim();

  if (!restored) return null;

  if (isLikelyUntranslated(normalized, restored, direction.targetLang)) {
    translatedProtected = await translateWithOpenAI(
      protectedPack.text,
      direction.sourceLang,
      direction.targetLang,
      true
    );

    if (translatedProtected) {
      if (isThaiToChinese) {
        const refinedRetry = await refineChatTranslation(
          protectedPack.text,
          translatedProtected,
          direction.sourceLang,
          direction.targetLang
        );
        if (refinedRetry) translatedProtected = refinedRetry;
      }

      if (isMyanmarMode) {
        const polishedRetry = await polishMyanmarTranslation(
          protectedPack.text,
          translatedProtected,
          direction.sourceLang,
          direction.targetLang
        );
        if (polishedRetry) translatedProtected = polishedRetry;
      }

      const retryRestored = applyGlobalDictionaryAfter(
        restorePlaceholders(translatedProtected, protectedPack.map),
        direction.targetLang
      ).trim();

      if (retryRestored) restored = retryRestored;
    }
  }

  return restored || null;
}

async function replyText(replyToken, text) {
  if (!replyToken || !text) return null;
  return client.replyMessage(replyToken, { type: 'text', text });
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
- 已加強泰文你我他判斷
- เขา 優先翻成 他/她/對方，不會亂翻成你
- 已加強 LINE 聊天語境
- 已加強中緬翻譯自然度`
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
      return replyText(event.replyToken, '此群組/聊天室尚未授權使用翻譯功能。請由管理員在本群直接輸入 /auth 進行授權。');
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

async function handleEvent(event) {
  try {
    if (event.type !== 'message') return null;
    if (event.message.type !== 'text') return null;
    return await handleTextMessage(event);
  } catch (err) {
    console.error('handleEvent error message:', err?.message);
    console.error('handleEvent error status:', err?.status);
    console.error('handleEvent error code:', err?.code);
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
