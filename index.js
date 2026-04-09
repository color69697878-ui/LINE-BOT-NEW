"use strict";

/**
 * LINE 翻譯機器人 v6.5 Persistent Disk 完整版
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");

// =========================
// 基本設定
// =========================
const PORT = process.env.PORT || 3000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "";
const DEBUG_WEBHOOK = process.env.DEBUG_WEBHOOK === "true";
const DEBUG_GROUP_ID = process.env.DEBUG_GROUP_ID || "";

// Persistent Disk 路徑
// Render Disk mount path 建議設 /var/data
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const DB_FILE = path.join(DATA_DIR, "db.json");

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret || !process.env.OPENAI_API_KEY) {
  console.error("缺少必要環境變數：LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET / OPENAI_API_KEY");
  process.exit(1);
}

const client = new line.Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();

// =========================
// 資料檔
// =========================
ensureDir(DATA_DIR);

console.log("📦 DATA_DIR =", DATA_DIR);
console.log("📦 DB_FILE =", DB_FILE);

const db = loadJson(DB_FILE, {
  allowGroups: {},
  pendingGroups: {},
  groups: {},
  globalKeepWords: [],
  globalDict: {},
  contexts: {},
});

const DEFAULT_KEEP_WORDS = [
  "IN", "OUT", "OK", "VIP", "NO", "NO.", "KG", "G", "CM", "MM",
  "M", "L", "XL", "XXL", "PCS", "PC", "SET", "COD", "SKU", "ID"
];

// =========================
// 啟動
// =========================
app.get("/", (req, res) => {
  res.status(200).send("LINE Translator Bot v6.5 Persistent Disk running");
});

app.get("/healthz", (req, res) => {
  res.status(200).json({
    ok: true,
    dataDir: DATA_DIR,
    dbFile: DB_FILE,
    time: new Date().toISOString(),
    debugWebhook: DEBUG_WEBHOOK
  });
});

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];

    console.log(`📨 webhook hit: ${events.length}`);

    if (DEBUG_WEBHOOK) {
      for (const [i, event] of events.entries()) {
        if (!shouldDebugEvent(event)) continue;
        console.log("🔍 event detail:", JSON.stringify({
          index: i,
          type: event?.type,
          sourceType: event?.source?.type,
          groupId: event?.source?.groupId || "",
          roomId: event?.source?.roomId || "",
          userId: event?.source?.userId || "",
          messageType: event?.message?.type || "",
          text: event?.message?.text || ""
        }));
      }
    }

    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

// =========================
// 主事件處理
// =========================
async function handleEvent(event) {
  try {
    if (DEBUG_WEBHOOK && shouldDebugEvent(event)) {
      console.log("🧩 handleEvent:", JSON.stringify({
        type: event?.type,
        sourceType: event?.source?.type,
        groupId: event?.source?.groupId || "",
        userId: event?.source?.userId || "",
        messageType: event?.message?.type || "",
        text: event?.message?.text || ""
      }));
    }

    const source = event.source || {};
    const sourceType = source.type || "";
    const groupId = source.groupId || "";
    const userId = source.userId || "";

    if (event.type === "join") {
      if (sourceType === "group" && groupId) {
        markPendingGroup(groupId);
        return safePushFlex(groupId, buildApproveFlex("此群尚未授權，請管理員按下方按鈕啟用。"));
      }
      return null;
    }

    if (event.type !== "message") return null;
    if (!event.message) return null;
    if (sourceType !== "group" || !groupId) return null;

    if (event.message.type === "sticker") return null;
    if (event.message.type !== "text") return null;

    const rawText = event.message.text || "";
    const text = rawText.trim();
    if (!text) return null;

    if (!db.allowGroups[groupId]) {
      markPendingGroup(groupId);
    }

    const commandHandled = await handleCommand(event, text, groupId, userId);
    if (commandHandled) return commandHandled;

    if (!db.allowGroups[groupId]) {
      if (isAdmin(userId) && shouldPromptPendingGroup(groupId)) {
        touchPendingPromptTime(groupId);
        return safeReplyFlex(event.replyToken, buildApproveFlex("此群尚未授權，按下方按鈕即可啟用。"));
      }
      return null;
    }

    initGroupSettings(groupId);
    const settings = db.groups[groupId];
    if (!settings.enable) return null;

    const lang = detectMainLanguage(text);

    if (lang === "mixed" || lang === "other") return null;

    const chatKey = getChatKey(source);
    const contextList = getRecentContext(chatKey, 3);

    if (lang === "en" && settings.englishAutoZh) {
      const result = await translateMessage({
        text,
        sourceLang: "en",
        targetLang: "zh",
        groupId,
        contextList,
      });

      if (result && result.trim() && result.trim() !== text.trim()) {
        pushContext(chatKey, { role: "user", text, lang: "en" });
        pushContext(chatKey, { role: "assistant", text: result, lang: "zh" });
        return safeReply(event.replyToken, result);
      }
      return null;
    }

    if (lang === settings.langA) {
      const result = await translateMessage({
        text,
        sourceLang: settings.langA,
        targetLang: settings.langB,
        groupId,
        contextList,
      });

      if (result && result.trim() && result.trim() !== text.trim()) {
        pushContext(chatKey, { role: "user", text, lang: settings.langA });
        pushContext(chatKey, { role: "assistant", text: result, lang: settings.langB });
        return safeReply(event.replyToken, result);
      }
      return null;
    }

    if (lang === settings.langB) {
      const result = await translateMessage({
        text,
        sourceLang: settings.langB,
        targetLang: settings.langA,
        groupId,
        contextList,
      });

      if (result && result.trim() && result.trim() !== text.trim()) {
        pushContext(chatKey, { role: "user", text, lang: settings.langB });
        pushContext(chatKey, { role: "assistant", text: result, lang: settings.langA });
        return safeReply(event.replyToken, result);
      }
      return null;
    }

    return null;
  } catch (err) {
    console.error("handleEvent error:", err);
    return null;
  }
}

// =========================
// 指令 / UI
// =========================
async function handleCommand(event, text, groupId, userId) {
  const lower = text.toLowerCase();

  // UI 批准按鈕
  if (text === "UI_APPROVE_GROUP") {
    if (!isAdmin(userId)) {
      return safeReply(event.replyToken, "你沒有權限操作此按鈕。");
    }

    approveGroup(groupId);
    return safeReplyFlex(event.replyToken, buildPanelFlex(groupId, "群組已授權，並已開啟翻譯。"));
  }

  // UI 開面板
  if (lower === "ui_open_panel") {
    if (!isAdmin(userId)) {
      return safeReply(event.replyToken, "你沒有權限操作此面板。");
    }
    if (!db.allowGroups[groupId]) {
      return safeReplyFlex(event.replyToken, buildApproveFlex("此群尚未授權，請先批准。"));
    }
    initGroupSettings(groupId);
    return safeReplyFlex(event.replyToken, buildPanelFlex(groupId));
  }

  // UI 設語言
  if (text.startsWith("UI_SET_LANG:")) {
    if (!isAdmin(userId)) return safeReply(event.replyToken, "你沒有權限操作此面板。");
    if (!db.allowGroups[groupId]) return safeReply(event.replyToken, "此群尚未授權。");

    const parts = text.split(":");
    const a = parts[1];
    const b = parts[2];
    if (!isSupportedLang(a) || !isSupportedLang(b)) {
      return safeReply(event.replyToken, "語言代碼無效。");
    }

    initGroupSettings(groupId);
    db.groups[groupId].langA = a;
    db.groups[groupId].langB = b;
    saveDb();

    return safeReplyFlex(event.replyToken, buildPanelFlex(groupId, `已設定 ${langLabel(a)} ⇄ ${langLabel(b)}`));
  }

  // UI 開關翻譯
  if (lower === "ui_toggle_on") {
    if (!isAdmin(userId)) return safeReply(event.replyToken, "你沒有權限操作此面板。");
    if (!db.allowGroups[groupId]) return safeReply(event.replyToken, "此群尚未授權。");

    initGroupSettings(groupId);
    db.groups[groupId].enable = true;
    saveDb();

    return safeReplyFlex(event.replyToken, buildPanelFlex(groupId, "翻譯已開啟"));
  }

  if (lower === "ui_toggle_off") {
    if (!isAdmin(userId)) return safeReply(event.replyToken, "你沒有權限操作此面板。");
    if (!db.allowGroups[groupId]) return safeReply(event.replyToken, "此群尚未授權。");

    initGroupSettings(groupId);
    db.groups[groupId].enable = false;
    saveDb();

    return safeReplyFlex(event.replyToken, buildPanelFlex(groupId, "翻譯已關閉"));
  }

  // UI 切換英文自動翻中
  if (lower === "ui_toggle_english_auto_zh") {
    if (!isAdmin(userId)) return safeReply(event.replyToken, "你沒有權限操作此面板。");
    if (!db.allowGroups[groupId]) return safeReply(event.replyToken, "此群尚未授權。");

    initGroupSettings(groupId);
    db.groups[groupId].englishAutoZh = !db.groups[groupId].englishAutoZh;
    saveDb();

    return safeReplyFlex(
      event.replyToken,
      buildPanelFlex(groupId, `英文自動翻中文：${db.groups[groupId].englishAutoZh ? "已開啟" : "已關閉"}`)
    );
  }

  if (lower === "/whoami") {
    return safeReply(event.replyToken, [
      `groupId: ${groupId || ""}`,
      `userId: ${userId || ""}`,
      `isAdmin: ${isAdmin(userId)}`
    ].join("\n"));
  }

  if (lower === "/status") {
    initGroupSettings(groupId);
    const allowed = !!db.allowGroups[groupId];
    const g = db.groups[groupId] || {};
    return safeReply(event.replyToken, [
      `群組授權：${allowed ? "已授權" : "未授權"}`,
      `翻譯：${g.enable ? "開啟" : "關閉"}`,
      `語言：${langLabel(g.langA || "zh")} ⇄ ${langLabel(g.langB || "th")}`,
      `英文自動翻中：${g.englishAutoZh ? "開啟" : "關閉"}`,
      `DATA_DIR：${DATA_DIR}`
    ].join("\n"));
  }

  // 只處理 / 指令
  if (!text.startsWith("/")) return null;

  const args = text.split(/\s+/);
  const cmd = args[0];

  if (cmd === "/批准") {
    if (!isAdmin(userId)) {
      return safeReply(event.replyToken, "你沒有權限執行此指令。");
    }
    approveGroup(groupId);
    return safeReplyFlex(event.replyToken, buildPanelFlex(groupId, "群組已授權，並已開啟翻譯。"));
  }

  if (cmd === "/面板") {
    if (!isAdmin(userId)) {
      return safeReply(event.replyToken, "你沒有權限開啟面板。");
    }
    if (!db.allowGroups[groupId]) {
      return safeReplyFlex(event.replyToken, buildApproveFlex("此群尚未授權，請先批准。"));
    }
    initGroupSettings(groupId);
    return safeReplyFlex(event.replyToken, buildPanelFlex(groupId));
  }

  if (cmd === "/setlang") {
    if (!isAdmin(userId)) return safeReply(event.replyToken, "你沒有權限執行此指令。");
    if (!db.allowGroups[groupId]) return safeReply(event.replyToken, "此群尚未授權。");

    const a = args[1];
    const b = args[2];
    if (!isSupportedLang(a) || !isSupportedLang(b)) {
      return safeReply(event.replyToken, "用法：/setlang zh th");
    }

    initGroupSettings(groupId);
    db.groups[groupId].langA = a;
    db.groups[groupId].langB = b;
    saveDb();

    return safeReply(event.replyToken, `已設定 ${langLabel(a)} ⇄ ${langLabel(b)}`);
  }

  if (cmd === "/lang") {
    if (!db.allowGroups[groupId]) return safeReply(event.replyToken, "此群尚未授權。");
    initGroupSettings(groupId);
    const g = db.groups[groupId];
    return safeReply(
      event.replyToken,
      `目前語言：${langLabel(g.langA)} ⇄ ${langLabel(g.langB)}\n翻譯：${g.enable ? "開啟" : "關閉"}\n英文自動翻中：${g.englishAutoZh ? "開啟" : "關閉"}`
    );
  }

  if (cmd === "/on") {
    if (!isAdmin(userId)) return safeReply(event.replyToken, "你沒有權限執行此指令。");
    if (!db.allowGroups[groupId]) return safeReply(event.replyToken, "此群尚未授權。");

    initGroupSettings(groupId);
    db.groups[groupId].enable = true;
    saveDb();
    return safeReply(event.replyToken, "翻譯已開啟。");
  }

  if (cmd === "/off") {
    if (!isAdmin(userId)) return safeReply(event.replyToken, "你沒有權限執行此指令。");
    if (!db.allowGroups[groupId]) return safeReply(event.replyToken, "此群尚未授權。");

    initGroupSettings(groupId);
    db.groups[groupId].enable = false;
    saveDb();
    return safeReply(event.replyToken, "翻譯已關閉。");
  }

  if (cmd === "/help") {
    return safeReply(
      event.replyToken,
      [
        "可用指令：",
        "/批准",
        "/面板",
        "/setlang zh th",
        "/lang",
        "/on",
        "/off",
        "/status",
        "/whoami",
      ].join("\n")
    );
  }

  return null;
}

// =========================
// 批准 / 群組初始化
// =========================
function approveGroup(groupId) {
  db.allowGroups[groupId] = true;
  delete db.pendingGroups[groupId];

  db.groups[groupId] = {
    enable: true,
    langA: "zh",
    langB: "th",
    englishAutoZh: true,
    keepWords: db.groups[groupId]?.keepWords || [],
    dict: db.groups[groupId]?.dict || {},
  };

  saveDb();
}

function markPendingGroup(groupId) {
  if (!db.pendingGroups[groupId]) {
    db.pendingGroups[groupId] = {
      firstSeenAt: Date.now(),
      lastPromptAt: 0,
    };
    saveDb();
  }
}

function touchPendingPromptTime(groupId) {
  if (!db.pendingGroups[groupId]) {
    db.pendingGroups[groupId] = {
      firstSeenAt: Date.now(),
      lastPromptAt: Date.now(),
    };
  } else {
    db.pendingGroups[groupId].lastPromptAt = Date.now();
  }
  saveDb();
}

function shouldPromptPendingGroup(groupId) {
  const item = db.pendingGroups[groupId];
  if (!item) return true;
  const last = item.lastPromptAt || 0;
  return Date.now() - last > 60 * 1000;
}

// =========================
// Flex UI
// =========================
function buildApproveFlex(message) {
  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: "群組授權", weight: "bold", size: "xl" },
        { type: "text", text: message, wrap: true, size: "sm", color: "#666666" },
        { type: "separator", margin: "md" },
        {
          type: "text",
          text: "只有管理員按下「批准此群」才會生效。",
          wrap: true,
          size: "xs",
          color: "#999999",
          margin: "md"
        }
      ]
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          action: {
            type: "message",
            label: "批准此群",
            text: "UI_APPROVE_GROUP"
          }
        }
      ]
    }
  };
}

function buildPanelFlex(groupId, tipText = "") {
  initGroupSettings(groupId);
  const g = db.groups[groupId];

  const statusText = g.enable ? "🟢 已開啟" : "🔴 已關閉";
  const englishAutoText = g.englishAutoZh ? "🟢 開啟" : "⚪ 關閉";
  const langText = `${langLabel(g.langA)} ⇄ ${langLabel(g.langB)}`;

  const contents = [
    { type: "text", text: "翻譯控制面板", weight: "bold", size: "xl" },
    { type: "text", text: `狀態：${statusText}`, margin: "md", size: "sm" },
    { type: "text", text: `語言：${langText}`, margin: "sm", size: "sm" },
    { type: "text", text: `英文自動翻中：${englishAutoText}`, margin: "sm", size: "sm" },
  ];

  if (tipText) {
    contents.push({
      type: "text",
      text: tipText,
      wrap: true,
      size: "sm",
      color: "#0B57D0",
      margin: "md"
    });
  }

  contents.push(
    { type: "separator", margin: "lg" },
    { type: "text", text: "語言設定", weight: "bold", margin: "lg", size: "sm" }
  );

  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        rowButtons([
          btn("中文⇄泰文", "UI_SET_LANG:zh:th"),
          btn("英文⇄中文", "UI_SET_LANG:en:zh")
        ]),
        rowButtons([
          btn("緬甸⇄中文", "UI_SET_LANG:my:zh"),
          btn(g.enable ? "關閉翻譯" : "開啟翻譯", g.enable ? "UI_TOGGLE_OFF" : "UI_TOGGLE_ON")
        ]),
        rowButtons([
          btn("切換英文自動翻中", "UI_TOGGLE_ENGLISH_AUTO_ZH"),
          btn("重新整理面板", "UI_OPEN_PANEL")
        ])
      ]
    }
  };
}

function btn(label, text) {
  return {
    type: "button",
    style: "primary",
    height: "sm",
    action: {
      type: "message",
      label,
      text
    }
  };
}

function rowButtons(buttons) {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    contents: buttons
  };
}

// =========================
// 翻譯主流程
// =========================
async function translateMessage({ text, sourceLang, targetLang, groupId, contextList }) {
  const protectedPack = protectAll(text, groupId);
  let protectedText = protectedPack.text;

  const lines = protectedText.split(/\r?\n/);
  const outLines = [];

  for (const lineText of lines) {
    const translated = await translateOneLine({
      line: lineText,
      sourceLang,
      targetLang,
      groupId,
      contextList,
    });
    outLines.push(translated);
  }

  let merged = outLines.join("\n");
  merged = restorePlaceholders(merged, protectedPack.restoreMap);
  merged = postNormalizeOutput(merged, sourceLang, targetLang);

  return merged;
}

async function translateOneLine({ line, sourceLang, targetLang, groupId, contextList }) {
  if (line === "") return "";

  const trimmed = line.trim();

  if (isCodeOnlyLine(trimmed)) return line;
  if (detectMainLanguage(trimmed) === "mixed") return line;

  if (sourceLang === "zh" && looksLikeCodePlusShortChinese(trimmed)) {
    return translateCodePlusShortChineseLine(line, groupId);
  }

  if (sourceLang === "zh" && targetLang === "th") {
    const segments = splitChineseForTranslation(line);
    if (!segments.length) return line;

    const out = [];
    for (const seg of segments) {
      if (!seg) {
        out.push(seg);
        continue;
      }

      if (isCodeOnlyLine(seg.trim())) {
        out.push(seg);
        continue;
      }

      if (!containsChinese(seg)) {
        out.push(seg);
        continue;
      }

      const t = await callTranslator({
        text: seg,
        sourceLang,
        targetLang,
        contextList,
        strictMode: "zh_to_th_segment",
      });
      out.push(t || seg);
    }
    return out.join("");
  }

  const t = await callTranslator({
    text: line,
    sourceLang,
    targetLang,
    contextList,
    strictMode: "normal_line",
  });

  return t || line;
}

// =========================
// OpenAI 翻譯
// =========================
async function callTranslator({ text, sourceLang, targetLang, contextList, strictMode }) {
  const contextText = (contextList || [])
    .slice(-3)
    .map((x, i) => `${i + 1}. [${x.lang}] ${x.text}`)
    .join("\n");

  const systemPrompt = buildSystemPrompt({ sourceLang, targetLang, strictMode });

  const userPrompt = [
    "請直接輸出翻譯結果，不要解釋，不要加引號，不要加前綴。",
    "規則：",
    "1. 不可漏翻後半句。",
    "2. 不可只翻前面幾個字。",
    "3. 不可把型號、數字、價格、時間、斜線代碼亂解釋。",
    "4. 任何 __PH_xxx__ 佔位符都必須原樣保留。",
    "5. 保持原本多行格式與行數。",
    "6. 若該片段是代碼或不需翻譯，請原樣保留。",
    "",
    "最近上下文（只供理解語氣，不可把上下文混入結果）：",
    contextText || "無",
    "",
    "原文：",
    text
  ].join("\n");

  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.15,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    const out = resp?.choices?.[0]?.message?.content?.trim() || "";
    return cleanupModelOutput(out);
  } catch (err) {
    console.error("OpenAI translate error:", err?.message || err);
    return text;
  }
}

function buildSystemPrompt({ sourceLang, targetLang, strictMode }) {
  const common = `
你是專業翻譯器。
你只能做忠實、自然、完整的翻譯。
不可總結，不可解釋，不可擴寫，不可腦補。

重要規則：
- 純數字、型號、時間、價格、斜線代碼、英數代碼要原樣保留。
- 任何 __PH_xxx__ 佔位符都必須原樣保留。
- 多行內容必須維持原本行數，不可合併成一行。
- 若句子中有代碼與短詞，僅翻短詞，不得亂解釋代碼。
- 不可只翻前半句。
`;

  const zhToTh = `
中文 -> 泰文要求：
- 使用自然泰文口語，但不要過度潤飾。
- 重點正確處理：剛剛、剛才、先、現在、等等、已經、還沒。
- 分段翻譯時，每段都要完整翻譯。
`;

  const thToZh = `
泰文 -> 中文要求：
- 譯成自然繁體中文口語。
- 口語句型要正確理解：ไม่มีคนช่วย..., ทำงานนะ, เพราะ..., เลย..., ยังไม่..., ได้แล้ว, ต้อง...
- นะค่ะ 視為 นะคะ 理解。
`;

  const enToZh = `
英文 -> 中文要求：
- 譯成自然繁體中文。
- 短句不要過度書面。
- 保留代碼與保留字。
`;

  const myToZh = `
緬文 -> 中文要求：
- 譯成自然繁體中文。
- 保留代碼、型號、數字。
`;

  const zhToMy = `
中文 -> 緬文要求：
- 忠實簡潔，不可擴寫。
- 保留型號、數字、代碼。
`;

  const normalLine = `
現在輸入是一行或一段原文，只能輸出翻譯結果。
`;

  const zhSeg = `
現在輸入只是中文片段。
你只能翻譯這個片段，不可遺漏，也不可補整句。
`;

  let prompt = common;
  if (sourceLang === "zh" && targetLang === "th") prompt += zhToTh;
  if (sourceLang === "th" && targetLang === "zh") prompt += thToZh;
  if (sourceLang === "en" && targetLang === "zh") prompt += enToZh;
  if (sourceLang === "my" && targetLang === "zh") prompt += myToZh;
  if (sourceLang === "zh" && targetLang === "my") prompt += zhToMy;
  if (strictMode === "zh_to_th_segment") prompt += zhSeg;
  else prompt += normalLine;

  return prompt.trim();
}

// =========================
// 保護
// =========================
function protectAll(text, groupId) {
  let out = text;
  const restoreMap = {};
  let idx = 0;

  const keepWords = getAllKeepWords(groupId).sort((a, b) => b.length - a.length);
  const dict = getMergedDict(groupId);
  const dictEntries = Object.entries(dict).sort((a, b) => b[0].length - a[0].length);

  for (const [source, target] of dictEntries) {
    if (!source) continue;
    const ph = `__PH_DICT_${idx++}__`;
    const re = new RegExp(escapeRegExp(source), "g");
    if (re.test(out)) {
      out = out.replace(re, ph);
      restoreMap[ph] = target;
    }
  }

  for (const word of keepWords) {
    if (!word) continue;
    const ph = `__PH_KEEP_${idx++}__`;
    const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, "g");
    if (re.test(out)) {
      out = out.replace(re, ph);
      restoreMap[ph] = word;
    }
  }

  out = out.replace(/@\S+/g, (m) => {
    const ph = `__PH_AT_${idx++}__`;
    restoreMap[ph] = m;
    return ph;
  });

  out = out.replace(/[\p{Extended_Pictographic}\u2600-\u27BF]/gu, (m) => {
    const ph = `__PH_EMJ_${idx++}__`;
    restoreMap[ph] = m;
    return ph;
  });

  return { text: out, restoreMap };
}

function getAllKeepWords(groupId) {
  const groupKeep = db.groups[groupId]?.keepWords || [];
  return [...new Set([...DEFAULT_KEEP_WORDS, ...(db.globalKeepWords || []), ...groupKeep])];
}

function getMergedDict(groupId) {
  return {
    ...(db.globalDict || {}),
    ...((db.groups[groupId]?.dict) || {})
  };
}

function restorePlaceholders(text, restoreMap) {
  let out = text;
  const entries = Object.entries(restoreMap).sort((a, b) => b[0].length - a[0].length);
  for (const [ph, val] of entries) {
    out = out.split(ph).join(val);
  }
  return out;
}

// =========================
// 特殊規則
// =========================
function splitChineseForTranslation(line) {
  const parts = line.split(/([，。！？；：,.!?;:])/);
  const out = [];

  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i];
    if (cur == null || cur === "") continue;
    const next = parts[i + 1];
    if (next && /^[，。！？；：,.!?;:]$/.test(next)) {
      out.push(cur + next);
      i++;
    } else {
      out.push(cur);
    }
  }

  return out;
}

function looksLikeCodePlusShortChinese(text) {
  return /^([A-Za-z0-9/._:+\- ]+)([\u4e00-\u9fff]{1,8})$/.test(text);
}

async function translateCodePlusShortChineseLine(line, groupId) {
  const match = line.match(/^([A-Za-z0-9/._:+\- ]+)([\u4e00-\u9fff]{1,8})$/);
  if (!match) return line;

  const codePart = match[1];
  const zhPart = match[2];

  const dict = getMergedDict(groupId);
  if (dict[zhPart]) return `${codePart}${dict[zhPart]}`;

  const quick = quickShortZhToTh(zhPart);
  if (quick) return `${codePart}${quick}`;

  const translated = await callTranslator({
    text: zhPart,
    sourceLang: "zh",
    targetLang: "th",
    contextList: [],
    strictMode: "zh_to_th_segment"
  });

  return `${codePart}${(translated || zhPart).trim()}`;
}

function quickShortZhToTh(zh) {
  const map = {
    "灰色": "สีเทา",
    "白色": "สีขาว",
    "黑色": "สีดำ",
    "紅色": "สีแดง",
    "藍色": "สีน้ำเงิน",
    "綠色": "สีเขียว",
    "黃色": "สีเหลือง",
    "粉色": "สีชมพู",
    "紫色": "สีม่วง",
    "棕色": "สีน้ำตาล",
    "咖啡色": "สีน้ำตาล",
    "橘色": "สีส้ม",
    "銀色": "สีเงิน",
    "金色": "สีทอง",
    "客人時間": "เวลาลูกค้า",
    "今天": "วันนี้",
    "明天": "พรุ่งนี้",
    "後天": "มะรืนนี้",
    "早上": "ตอนเช้า",
    "中午": "ตอนเที่ยง",
    "下午": "ตอนบ่าย",
    "晚上": "ตอนเย็น",
    "有": "มี",
    "沒有": "ไม่มี"
  };
  return map[zh] || null;
}

// =========================
// 語言判斷
// =========================
function detectMainLanguage(text) {
  const zh = countMatch(text, /[\u4e00-\u9fff]/g);
  const th = countMatch(text, /[\u0E00-\u0E7F]/g);
  const my = countMatch(text, /[\u1000-\u109F\uA9E0-\uA9FF\uAA60-\uAA7F]/g);
  const en = countEnglishLetters(text);

  const present = [
    zh > 0 ? "zh" : null,
    th > 0 ? "th" : null,
    my > 0 ? "my" : null,
    en > 0 ? "en" : null,
  ].filter(Boolean);

  if (present.length >= 2) return "mixed";
  if (zh > 0) return "zh";
  if (th > 0) return "th";
  if (my > 0) return "my";
  if (en > 0) return "en";
  return "other";
}

function countMatch(text, regex) {
  const m = text.match(regex);
  return m ? m.length : 0;
}

function countEnglishLetters(text) {
  const m = text.match(/[A-Za-z]/g);
  return m ? m.length : 0;
}

function containsChinese(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

// =========================
// 上下文
// =========================
function getChatKey(source) {
  if (!source) return "unknown";
  if (source.type === "group") return `group:${source.groupId}`;
  if (source.type === "room") return `room:${source.roomId}`;
  return `user:${source.userId || "unknown"}`;
}

function getRecentContext(chatKey, limit = 3) {
  const arr = db.contexts[chatKey] || [];
  return arr.slice(-limit);
}

function pushContext(chatKey, item) {
  if (!db.contexts[chatKey]) db.contexts[chatKey] = [];
  db.contexts[chatKey].push({
    role: item.role,
    text: item.text,
    lang: item.lang,
    ts: Date.now(),
  });

  if (db.contexts[chatKey].length > 20) {
    db.contexts[chatKey] = db.contexts[chatKey].slice(-20);
  }

  saveDb();
}

// =========================
// 後處理
// =========================
function postNormalizeOutput(text, sourceLang, targetLang) {
  let out = cleanupModelOutput(text);

  if (sourceLang === "th" && targetLang === "zh") {
    out = out.replace(/นะค่ะ/g, "นะคะ");
  }

  if (sourceLang === "zh" && targetLang === "th") {
    out = out.replace(/นะค่ะ/g, "นะคะ");
  }

  return out;
}

function cleanupModelOutput(text) {
  let out = (text || "").trim();

  out = out
    .replace(/^```(?:text)?/i, "")
    .replace(/```$/i, "")
    .trim();

  out = out.replace(/^(翻譯：|譯文：|Translation:|คำแปล:)\s*/i, "");
  return out.trim();
}

// =========================
// 工具判斷
// =========================
function isCodeOnlyLine(text) {
  if (!text) return false;

  const patterns = [
    /^[0-9\s/.:+\-]+$/,
    /^[A-Za-z0-9\s/._:+\-]+$/,
    /^[0-9]{1,2}\/[0-9]{1,2}\s*$/,
    /^[0-9]{3,4}\s*$/,
    /^[0-9]{1,2}:[0-9]{2}\s*$/,
    /^[0-9/]+\s*$/
  ];

  return patterns.some((p) => p.test(text));
}

function isSupportedLang(lang) {
  return ["zh", "th", "en", "my"].includes(lang);
}

function langLabel(lang) {
  const map = {
    zh: "中文",
    th: "泰文",
    en: "英文",
    my: "緬甸文"
  };
  return map[lang] || lang;
}

function initGroupSettings(groupId) {
  if (!db.groups[groupId]) {
    db.groups[groupId] = {
      enable: true,
      langA: "zh",
      langB: "th",
      englishAutoZh: true,
      keepWords: [],
      dict: {}
    };
    saveDb();
    return;
  }

  const g = db.groups[groupId];
  if (typeof g.enable !== "boolean") g.enable = true;
  if (!g.langA) g.langA = "zh";
  if (!g.langB) g.langB = "th";
  if (typeof g.englishAutoZh !== "boolean") g.englishAutoZh = true;
  if (!Array.isArray(g.keepWords)) g.keepWords = [];
  if (!g.dict || typeof g.dict !== "object") g.dict = {};
  saveDb();
}

function isAdmin(userId) {
  return !!ADMIN_USER_ID && userId === ADMIN_USER_ID;
}

function shouldDebugEvent(event) {
  if (!DEBUG_WEBHOOK) return false;
  if (!DEBUG_GROUP_ID) return true;
  return event?.source?.groupId === DEBUG_GROUP_ID;
}

// =========================
// LINE 訊息工具
// =========================
async function safeReply(replyToken, text) {
  try {
    return await client.replyMessage(replyToken, {
      type: "text",
      text: truncateText(String(text || ""), 4900)
    });
  } catch (err) {
    console.error("reply message failed:", err?.message || err);
    return null;
  }
}

async function safeReplyFlex(replyToken, bubble) {
  try {
    return await client.replyMessage(replyToken, {
      type: "flex",
      altText: "操作面板",
      contents: bubble
    });
  } catch (err) {
    console.error("reply flex failed:", err?.message || err);
    return null;
  }
}

async function safePushFlex(to, bubble) {
  try {
    return await client.pushMessage(to, {
      type: "flex",
      altText: "群組授權",
      contents: bubble
    });
  } catch (err) {
    console.error("push flex failed:", err?.message || err);
    return null;
  }
}

function truncateText(text, maxLen) {
  const s = String(text || "");
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 20) + "\n...[truncated]";
}

// =========================
// 檔案 / DB
// =========================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    ensureDir(path.dirname(file));

    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
      console.log(`初始化資料檔: ${file}`);
      return fallback;
    }

    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`讀取 JSON 失敗: ${file}`, err);
    return fallback;
  }
}

function saveDb() {
  try {
    ensureDir(path.dirname(DB_FILE));
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (err) {
    console.error("寫入 db.json 失敗:", err);
  }
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
