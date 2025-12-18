// src/app/api/gpt/route.js
import OpenAI from 'openai';
import { GoogleGenerativeAI } from "@google/generative-ai";

// 启用 Edge Runtime（Cloudflare Pages 兼容）
export const runtime = 'edge';

const fixedRoleInstruction = process.env.GPT_PRE_PROMPT || "你是一个小助手，用相同的语言回答问题。";
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || "4"); // 默认保存4条历史记录
const MAX_RETRIES = 3;

// 用于存储对话历史的 Map
// 注意：在 Edge Runtime 中，每个请求可能在不同的 worker 中处理，
// 因此内存存储的历史记录不会跨请求持久化。
// 如需持久化存储，建议使用 Cloudflare KV 或 D1。
const conversationHistory = new Map();

// 清理超过1小时的历史记录（在每次请求时调用）
function cleanupOldHistory() {
  const oneHourAgo = Date.now() - 3600000;
  let cleanCount = 0;
  for (const [key, value] of conversationHistory.entries()) {
    if (value.lastUpdate < oneHourAgo) {
      conversationHistory.delete(key);
      cleanCount++;
    }
  }
  if (cleanCount > 0) {
    console.log(`已清理 ${cleanCount} 条过期对话历史`);
  }
}

// OpenAI 配置
const getOpenAIClient = () => {
  return new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY, 
    baseURL: process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1"
  });
};

export async function getOpenAIChatCompletion(prompt, userId) {
  try {
    cleanupOldHistory();

    // 获取或初始化用户的对话历史
    if (!conversationHistory.has(userId) || !Array.isArray(conversationHistory.get(userId)?.messages)) {
      conversationHistory.set(userId, {
        messages: [],
        lastUpdate: Date.now()
      });
    }

    const userHistory = conversationHistory.get(userId);
    const messages = [
      { role: "system", content: fixedRoleInstruction },
      ...(Array.isArray(userHistory.messages) ? userHistory.messages : []),
      { role: "user", content: prompt }
    ];

    // 保持历史记录在指定条数内
    while (messages.length > MAX_HISTORY * 2 + 1) {
      messages.splice(1, 2);
    }

    const openai = getOpenAIClient();
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
      messages: messages,
    });

    const assistantMessage = completion.choices[0].message.content;

    // 更新对话历史
    userHistory.messages = [
      ...messages.slice(1),
      { role: "assistant", content: assistantMessage }
    ];
    userHistory.lastUpdate = Date.now();

    // 限制历史记录大小
    const MAX_HISTORY_SIZE = 50;
    if (userHistory.messages.length > MAX_HISTORY_SIZE) {
      userHistory.messages = userHistory.messages.slice(-MAX_HISTORY_SIZE);
    }

    return assistantMessage;
  } catch (error) {
    console.error("OpenAI API Error:", error);
    throw error;
  }
}

// Gemini 配置 (使用 @google/generative-ai)
const getGeminiModel = () => {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const geminiModelName = process.env.GEMINI_MODEL_NAME || "gemini-2.0-flash-lite";
  return genAI.getGenerativeModel({ model: geminiModelName }, { apiVersion: 'v1' });
};

export async function getGeminiChatCompletion(prompt, userId, retryCount = 0) {
  try {
    cleanupOldHistory();

    // 获取或初始化用户的对话历史
    if (!conversationHistory.has(userId + '_gemini') || !Array.isArray(conversationHistory.get(userId + '_gemini')?.messages)) {
      conversationHistory.set(userId + '_gemini', {
        messages: [],
        lastUpdate: Date.now()
      });
    }

    const userHistory = conversationHistory.get(userId + '_gemini');
    let contextString = fixedRoleInstruction + "\n\n";

    // 修改历史对话格式，移除角色标签
    if (Array.isArray(userHistory.messages)) {
      for (const msg of userHistory.messages.slice(-MAX_HISTORY * 2)) {
        if (msg && typeof msg.role === 'string' && typeof msg.content === 'string') {
          // 直接添加内容，不添加角色标签
          contextString += `${msg.content}\n`;
        }
      }
    }

    // 直接添加用户问题，不添加"用户："前缀
    contextString += prompt;

    const geminiModel = getGeminiModel();
    const result = await geminiModel.generateContent(contextString);
    const response = await result.response;
    let text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "抱歉，Gemini 没有给出回复。";

    // 改进前缀检测
    // 如果回复以"AI："或类似前缀开头，移除这个前缀
    if (text.match(/^(AI[:：]|Assistant[:：]|机器人[:：])/i)) {
      text = text.replace(/^(AI[:：]|Assistant[:：]|机器人[:：])\s*/i, '');
    }

    // 更新对话历史
    userHistory.messages = [
      ...userHistory.messages.slice(-MAX_HISTORY * 2),
      { role: 'user', content: prompt },
      { role: 'assistant', content: text }
    ];
    userHistory.lastUpdate = Date.now();

    // 限制历史记录大小
    const MAX_HISTORY_SIZE = 50;
    if (userHistory.messages.length > MAX_HISTORY_SIZE) {
      userHistory.messages = userHistory.messages.slice(-MAX_HISTORY_SIZE);
    }

    return text;
  } catch (error) {
    console.error("Gemini API Error:", error);
    // 添加重试逻辑
    if (error.toString().includes('rate limit') && retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return getGeminiChatCompletion(prompt, userId, retryCount + 1);
    }
    throw error;  // 确保抛出错误
  }
}
