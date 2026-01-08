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

// 内存历史缓存（比 D1 快，不阻塞响应）
const memoryHistory = new Map();

/**
 * 使用原生 fetch 调用 OpenAI API（兼容 OpenRouter 等）
 */
async function callOpenAI(messages) {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL || "gpt-3.5-turbo";

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API请求失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * OpenAI 聊天接口
 * @param {string} prompt - 用户消息
 * @param {string} userId - 用户ID
 * @param {Object} cfContext - Cloudflare context，用于 waitUntil
 */
export async function getOpenAIChatCompletion(prompt, userId, cfContext = null) {
  try {
    // 从内存获取历史记录（快速，不阻塞）
    const cached = memoryHistory.get(userId);
    const history = (cached && Date.now() - cached.time < MEMORY_CACHE_TTL) ? cached.messages : [];

    const messages = [
      { role: "system", content: fixedRoleInstruction },
      ...history,
      { role: "user", content: prompt }
    ];

    const assistantMessage = await callOpenAI(messages);

    // 更新内存缓存（保留最近2轮）
    const newHistory = [
      ...history,
      { role: "user", content: prompt },
      { role: "assistant", content: assistantMessage }
    ].slice(-MAX_MEMORY_HISTORY * 2);

    memoryHistory.set(userId, { messages: newHistory, time: Date.now() });

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
  const geminiModelName = process.env.GEMINI_MODEL_NAME || "gemini-2.0-flash-lite";
  return genAI.getGenerativeModel({ model: geminiModelName }, { apiVersion: 'v1' });
};

/**
 * Gemini 聊天接口
 * @param {string} prompt - 用户消息
 * @param {string} userId - 用户ID
 * @param {Object} cfContext - Cloudflare context，用于 waitUntil
 * @param {number} retryCount - 重试次数
 */
export async function getGeminiChatCompletion(prompt, userId, cfContext = null, retryCount = 0) {
  try {
    const db = cfContext?.env?.DB;

    // 获取历史记录
    const history = await getHistory(db, userId + '_gemini');

    let contextString = fixedRoleInstruction + "\n\n";

    // 格式化历史对话
    for (const msg of history) {
      if (msg && typeof msg.role === 'string' && typeof msg.content === 'string') {
        contextString += `${msg.content}\n`;
      }
    }

    contextString += prompt;

    const geminiModel = await getGeminiModel();
    const result = await geminiModel.generateContent(contextString);
    const response = await result.response;
    let text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "抱歉，Gemini 没有给出回复。";

    // 移除可能的 AI 前缀
    if (text.match(/^(AI[:：]|Assistant[:：]|机器人[:：])/i)) {
      text = text.replace(/^(AI[:：]|Assistant[:：]|机器人[:：])\s*/i, '');
    }

    // 使用 waitUntil 异步保存消息，不阻塞响应
    if (cfContext?.ctx?.waitUntil && db) {
      cfContext.ctx.waitUntil(saveMessages(db, userId + '_gemini', prompt, text));
    } else if (db) {
      await saveMessages(db, userId + '_gemini', prompt, text);
    }

    return text;
  } catch (error) {
    console.error("Gemini API Error:", error);
    // 添加重试逻辑
    if (error.toString().includes('rate limit') && retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return getGeminiChatCompletion(prompt, userId, cfContext, retryCount + 1);
    }
    throw error;
  }
}
