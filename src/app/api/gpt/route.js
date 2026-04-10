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

/**
 * 使用原生 fetch 调用 OpenAI API（兼容 OpenRouter 等）
 */
async function callOpenAI(messages, channel = 'default') {
  const { apiKey, baseURL, model } = getOpenAIConfig(channel);
  const maxTokens = channel === 'wechat'
    ? Number(process.env.WECHAT_OPENAI_MAX_TOKENS || DEFAULT_WECHAT_OPENAI_MAX_TOKENS)
    : undefined;

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
    throw new Error(`API请求失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * 从 KV 获取历史记录
 */
async function getHistoryFromKV(kv, userId) {
  if (!kv) return null;
  try {
    const data = await kv.get(userId, { type: 'json' });
    return data;
  } catch (error) {
    console.error('KV 读取失败:', error);
    return null;
  }
}

/**
 * 保存历史记录到 KV（异步，不阻塞响应）
 */
async function saveHistoryToKV(kv, userId, messages) {
  if (!kv) return;
  try {
    await kv.put(userId, JSON.stringify(messages), {
      expirationTtl: 600  // 10分钟后过期
    });
  } catch (error) {
    console.error('KV 写入失败:', error);
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

/**
 * OpenAI 聊天接口
 * @param {string} prompt - 用户消息
 * @param {string} userId - 用户ID
 * @param {Object} cfContext - Cloudflare context，用于 waitUntil 和 KV
 * @param {string} channel - 回复渠道
 */
export async function getOpenAIChatCompletion(prompt, userId, cfContext = null, channel = 'default') {
  try {
    const kv = cfContext?.env?.CHAT_HISTORY;
    let history = [];
    let needKVWrite = false;

    // 1. 先查内存缓存
    const cached = memoryHistory.get(userId);
    if (cached && Date.now() - cached.time < MEMORY_CACHE_TTL) {
      history = cached.messages;
    } else if (kv) {
      // 2. 内存没有，查 KV
      const kvData = await getHistoryFromKV(kv, userId);
      if (kvData) {
        history = kvData;
        // 同步到内存
        memoryHistory.set(userId, { messages: history, time: Date.now() });
      }
      needKVWrite = true;  // 内存 miss 了，之后需要写 KV
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

    // 只在内存 miss 时才写 KV（减少写入次数）
    if (needKVWrite && kv && cfContext?.ctx?.waitUntil) {
      cfContext.ctx.waitUntil(saveHistoryToKV(kv, userId, newHistory));
    }

    return assistantMessage;
  } catch (error) {
    console.error("OpenAI API Error:", error);
    const errorMsg = error?.message || error?.toString() || '未知错误';
    throw new Error(`OpenAI调用失败: ${errorMsg}`);
  }
}

// Gemini 配置 (使用 @google/generative-ai)
const getGeminiModel = async () => {
  const GoogleAIClass = await loadGoogleAI();
  const genAI = new GoogleAIClass(process.env.GEMINI_API_KEY);
  const geminiModelName = getGeminiModelName();
  return genAI.getGenerativeModel({ model: geminiModelName }, { apiVersion: 'v1' });
};

const getChannelGeminiModel = async (channel = 'default') => {
  const GoogleAIClass = await loadGoogleAI();
  const apiKey = channel === 'wechat'
    ? process.env.WECHAT_GEMINI_API_KEY || process.env.GEMINI_API_KEY
    : process.env.GEMINI_API_KEY;
  const genAI = new GoogleAIClass(apiKey);
  return genAI.getGenerativeModel({ model: getGeminiModelName(channel) }, { apiVersion: 'v1' });
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
    const kv = cfContext?.env?.CHAT_HISTORY;
    const geminiUserId = userId + '_gemini';
    let history = [];
    let needKVWrite = false;

    // 1. 先查内存缓存
    const cached = memoryHistory.get(geminiUserId);
    if (cached && Date.now() - cached.time < MEMORY_CACHE_TTL) {
      history = cached.messages;
    } else if (kv) {
      // 2. 内存没有，查 KV
      const kvData = await getHistoryFromKV(kv, geminiUserId);
      if (kvData) {
        history = kvData;
        memoryHistory.set(geminiUserId, { messages: history, time: Date.now() });
      }
      needKVWrite = true;
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

    const geminiModel = channel === 'wechat' ? await getChannelGeminiModel(channel) : await getGeminiModel();
    const result = await geminiModel.generateContent(contextString);
    const response = await result.response;
    let text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "抱歉，Gemini 没有给出回复。";

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

    // 只在内存 miss 时才写 KV
    if (needKVWrite && kv && cfContext?.ctx?.waitUntil) {
      cfContext.ctx.waitUntil(saveHistoryToKV(kv, geminiUserId, newHistory));
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
