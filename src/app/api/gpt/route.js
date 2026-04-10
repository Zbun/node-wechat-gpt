// src/app/api/gpt/route.js

// 延迟加载的模块
let OpenAI;
let GoogleGenerativeAI;

async function loadOpenAI() {
  if (!OpenAI) {
    const module = await import('openai');
    OpenAI = module.default;
  }
  return OpenAI;
}

async function loadGoogleAI() {
  if (!GoogleGenerativeAI) {
    const module = await import('@google/generative-ai');
    GoogleGenerativeAI = module.GoogleGenerativeAI;
  }
  return GoogleGenerativeAI;
}

const fixedRoleInstruction = process.env.GPT_PRE_PROMPT || "你是一个小助手，用相同的语言回答问题。";
const MAX_MEMORY_HISTORY = 4; // 内存中保留的历史轮数
const MEMORY_CACHE_TTL = 10 * 60 * 1000; // 10分钟过期
const wechatChannelInstruction = process.env.WECHAT_PRE_PROMPT || "当前输出渠道是微信公众号文本消息。请优先直接回答结论，表达尽量简短，避免冗长开场白。只返回适合微信文本消息的纯文本内容。不要使用 Markdown、代码块、标题、表格、HTML、XML、LaTeX、无序列表、有序列表、加粗、斜体、链接标记，也不要输出反引号。不要用 JSON、YAML、伪代码格式组织内容。需要分点时请直接使用中文序号或短句。默认把回复控制在 3 到 5 句、150 字以内。除非用户明确要求，否则不要贴长链接、代码示例或大段引用。";
const WECHAT_MAX_HISTORY_ROUNDS = 2;
const DEFAULT_WECHAT_OPENAI_MAX_TOKENS = 220;
const CHAT_HISTORY_TTL_SECONDS = 600;

// 内存历史缓存（比 D1 快，不阻塞响应）
const memoryHistory = new Map();

function getOpenAIConfig(channel = 'default') {
  if (channel === 'wechat') {
    return {
      apiKey: process.env.WECHAT_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
      baseURL: process.env.WECHAT_OPENAI_API_BASE_URL || process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1",
      model: process.env.WECHAT_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-3.5-turbo",
    };
  }

  return {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1",
    model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
  };
}

function getGeminiModelName(channel = 'default') {
  if (channel === 'wechat') {
    return process.env.WECHAT_GEMINI_MODEL_NAME || process.env.GEMINI_MODEL_NAME || "gemini-2.0-flash-lite";
  }

  return process.env.GEMINI_MODEL_NAME || "gemini-2.0-flash-lite";
}

function getGeminiApiKey(channel = 'default') {
  if (channel === 'wechat') {
    return process.env.WECHAT_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  }

  return process.env.GEMINI_API_KEY;
}

function getSafeBaseUrlHost(baseURL) {
  if (typeof baseURL !== 'string' || !baseURL) {
    return 'not-set';
  }

  try {
    return new URL(baseURL).host || 'invalid-url';
  } catch {
    return 'invalid-url';
  }
}

/**
 * 使用原生 fetch 调用 OpenAI API（兼容 OpenRouter 等）
 */
async function callOpenAI(messages, channel = 'default') {
  const { apiKey, baseURL, model } = getOpenAIConfig(channel);
  const maxTokens = channel === 'wechat'
    ? Number(process.env.WECHAT_OPENAI_MAX_TOKENS || DEFAULT_WECHAT_OPENAI_MAX_TOKENS)
    : undefined;
  const requestStartTime = Date.now();

  const body = {
    model: model,
    messages: messages,
  };

  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    body.max_tokens = Math.floor(maxTokens);
  }

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('OpenAI upstream request failed', {
      channel,
      model,
      baseUrlHost: getSafeBaseUrlHost(baseURL),
      durationMs: Date.now() - requestStartTime,
      status: response.status,
    });
    throw new Error(`API请求失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  console.log('OpenAI upstream request completed', {
    channel,
    model,
    baseUrlHost: getSafeBaseUrlHost(baseURL),
    durationMs: Date.now() - requestStartTime,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : null,
  });
  return data.choices[0].message.content;
}

function normalizeHistoryMessages(data) {
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter((msg) => msg && typeof msg.role === 'string' && typeof msg.content === 'string')
    .map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
}

async function getHistoryFromKV(kv, userId) {
  if (!kv) {
    return [];
  }

  try {
    const data = await kv.get(userId, { type: 'json' });
    return normalizeHistoryMessages(data);
  } catch (error) {
    console.error('KV 读取失败:', error);
    return [];
  }
}

async function saveHistoryToKV(kv, userId, messages) {
  if (!kv) {
    return;
  }

  try {
    await kv.put(userId, JSON.stringify(messages), {
      expirationTtl: CHAT_HISTORY_TTL_SECONDS,
    });
  } catch (error) {
    console.error('KV 写入失败:', error);
  }
}

async function getHistoryFromD1(db, userId) {
  if (!db) {
    return [];
  }

  try {
    const result = await db
      .prepare(`
        SELECT messages_json
        FROM ai_chat_history
        WHERE user_id = ?
          AND expires_at > ?
        LIMIT 1
      `)
      .bind(userId, Date.now())
      .first();

    if (!result?.messages_json || typeof result.messages_json !== 'string') {
      return [];
    }

    return normalizeHistoryMessages(JSON.parse(result.messages_json));
  } catch (error) {
    console.error('D1 读取失败:', error);
    return [];
  }
}

async function saveHistoryToD1(db, userId, messages) {
  if (!db) {
    return;
  }

  try {
    const now = Date.now();
    const expiresAt = now + CHAT_HISTORY_TTL_SECONDS * 1000;

    await db
      .prepare(`
        INSERT INTO ai_chat_history (user_id, messages_json, updated_at, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          messages_json = excluded.messages_json,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `)
      .bind(userId, JSON.stringify(messages), now, expiresAt)
      .run();
  } catch (error) {
    console.error('D1 写入失败:', error);
  }
}

function getHistoryStorage(cfContext, channel = 'default') {
  const d1 = cfContext?.env?.CHAT_HISTORY_DB || null;
  const kv = cfContext?.env?.CHAT_HISTORY || null;

  if (d1) {
    return { type: 'd1', binding: d1 };
  }

  if (shouldUseKVHistory(channel) && kv) {
    return { type: 'kv', binding: kv };
  }

  return { type: 'memory', binding: null };
}

async function loadHistory(storage, userId) {
  if (!storage?.binding) {
    return [];
  }

  if (storage.type === 'd1') {
    return getHistoryFromD1(storage.binding, userId);
  }

  if (storage.type === 'kv') {
    return getHistoryFromKV(storage.binding, userId);
  }

  return [];
}

async function persistHistory(storage, userId, messages) {
  if (!storage?.binding) {
    return;
  }

  if (storage.type === 'd1') {
    await saveHistoryToD1(storage.binding, userId, messages);
    return;
  }

  if (storage.type === 'kv') {
    await saveHistoryToKV(storage.binding, userId, messages);
  }
}

function buildSystemInstruction(channel = 'default') {
  if (channel === 'wechat') {
    return `${fixedRoleInstruction}\n\n${wechatChannelInstruction}`;
  }
  return fixedRoleInstruction;
}

function trimHistoryForChannel(history, channel = 'default') {
  if (!Array.isArray(history)) {
    return [];
  }

  if (channel === 'wechat') {
    return history.slice(-WECHAT_MAX_HISTORY_ROUNDS * 2);
  }

  return history;
}

function shouldUseKVHistory(channel = 'default') {
  if (channel !== 'wechat') {
    return true;
  }

  return process.env.WECHAT_USE_KV_HISTORY === 'true';
}

/**
 * OpenAI 聊天接口
 * @param {string} prompt - 用户消息
 * @param {string} userId - 用户ID
 * @param {Object} cfContext - Cloudflare context，用于 waitUntil 和 KV
 * @param {string} channel - 回复渠道
 */
export async function getOpenAIChatCompletion(prompt, userId, cfContext = null, channel = 'default') {
  try {
    const storage = getHistoryStorage(cfContext, channel);
    let history = [];

    // 1. 先查内存缓存
    const cached = memoryHistory.get(userId);
    if (cached && Date.now() - cached.time < MEMORY_CACHE_TTL) {
      history = cached.messages;
    } else if (storage.binding) {
      history = await loadHistory(storage, userId);
      memoryHistory.set(userId, { messages: history, time: Date.now() });
    }

    const trimmedHistory = trimHistoryForChannel(history, channel);

    const messages = [
      { role: "system", content: buildSystemInstruction(channel) },
      ...trimmedHistory,
      { role: "user", content: prompt }
    ];

    const assistantMessage = await callOpenAI(messages, channel);

    // 更新历史（保留最近4轮）
    const newHistory = [
      ...history,
      { role: "user", content: prompt },
      { role: "assistant", content: assistantMessage }
    ].slice(-MAX_MEMORY_HISTORY * 2);

    // 更新内存缓存
    memoryHistory.set(userId, { messages: newHistory, time: Date.now() });

    if (storage.binding && cfContext?.ctx?.waitUntil) {
      cfContext.ctx.waitUntil(persistHistory(storage, userId, newHistory));
    } else if (storage.binding) {
      await persistHistory(storage, userId, newHistory);
    }

    return assistantMessage;
  } catch (error) {
    console.error("OpenAI API Error:", error);
    const errorMsg = error?.message || error?.toString() || '未知错误';
    throw new Error(`OpenAI调用失败: ${errorMsg}`);
  }
}

// Gemini 配置 (使用 @google/generative-ai)
const getGeminiModel = async (channel = 'default') => {
  const GoogleAIClass = await loadGoogleAI();
  const genAI = new GoogleAIClass(getGeminiApiKey(channel));
  const geminiModelName = getGeminiModelName(channel);
  return genAI.getGenerativeModel({ model: geminiModelName }, { apiVersion: 'v1' });
};

/**
 * Gemini 聊天接口
 * @param {string} prompt - 用户消息
 * @param {string} userId - 用户ID
 * @param {Object} cfContext - Cloudflare context，用于 waitUntil 和 KV
 * @param {number} retryCount - 重试次数
 * @param {string} channel - 回复渠道
 */
export async function getGeminiChatCompletion(prompt, userId, cfContext = null, retryCount = 0, channel = 'default') {
  const MAX_RETRIES = 3;
  try {
    const storage = getHistoryStorage(cfContext, channel);
    const geminiUserId = userId + '_gemini';
    let history = [];

    // 1. 先查内存缓存
    const cached = memoryHistory.get(geminiUserId);
    if (cached && Date.now() - cached.time < MEMORY_CACHE_TTL) {
      history = cached.messages;
    } else if (storage.binding) {
      history = await loadHistory(storage, geminiUserId);
      memoryHistory.set(geminiUserId, { messages: history, time: Date.now() });
    }

    const trimmedHistory = trimHistoryForChannel(history, channel);
    let contextString = buildSystemInstruction(channel) + "\n\n";

    // 格式化历史对话
    for (const msg of trimmedHistory) {
      if (msg && typeof msg.role === 'string' && typeof msg.content === 'string') {
        contextString += `${msg.content}\n`;
      }
    }

    contextString += prompt;

    const geminiModel = await getGeminiModel(channel);
    const requestStartTime = Date.now();
    const result = await geminiModel.generateContent(contextString);
    const response = await result.response;
    let text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "抱歉，Gemini 没有给出回复。";

    console.log('Gemini upstream request completed', {
      channel,
      model: getGeminiModelName(channel),
      durationMs: Date.now() - requestStartTime,
      retryCount,
    });

    // 移除可能的 AI 前缀
    if (text.match(/^(AI[:：]|Assistant[:：]|机器人[:：])/i)) {
      text = text.replace(/^(AI[:：]|Assistant[:：]|机器人[:：])\s*/i, '');
    }

    // 更新历史（保留最近4轮）
    const newHistory = [
      ...history,
      { role: "user", content: prompt },
      { role: "assistant", content: text }
    ].slice(-MAX_MEMORY_HISTORY * 2);

    // 更新内存缓存
    memoryHistory.set(geminiUserId, { messages: newHistory, time: Date.now() });

    if (storage.binding && cfContext?.ctx?.waitUntil) {
      cfContext.ctx.waitUntil(persistHistory(storage, geminiUserId, newHistory));
    } else if (storage.binding) {
      await persistHistory(storage, geminiUserId, newHistory);
    }

    return text;
  } catch (error) {
    console.error("Gemini API Error:", error);
    if (error.toString().includes('rate limit') && retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return getGeminiChatCompletion(prompt, userId, cfContext, retryCount + 1, channel);
    }
    throw error;
  }
}
