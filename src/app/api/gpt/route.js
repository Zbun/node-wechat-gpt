// src/app/api/gpt/route.js
import OpenAI from 'openai';
const { GoogleGenerativeAI } = require("@google/generative-ai"); // 引入新的库
import { NextResponse } from 'next/server';

const fixedRoleInstruction = process.env.GPT_PRE_PROMPT || "你要用与提问相同的语言回答。";
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || "2"); // 添加历史记录条数配置

// 用于存储对话历史的 Map
const conversationHistory = new Map();

// 清理超过1小时的历史记录
function cleanupOldHistory() {
  const oneHourAgo = Date.now() - 3600000;
  for (const [key, value] of conversationHistory.entries()) {
    if (value.lastUpdate < oneHourAgo) {
      conversationHistory.delete(key);
    }
  }
}

// OpenAI 配置
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_API_BASE_URL || "https://api.openai.com" });

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

    return assistantMessage;
  } catch (error) {
    console.error("OpenAI API Error:", error);
    throw error;
  }
}

// Gemini 配置 (使用 @google/generative-ai)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModelName = process.env.GEMINI_MODEL_NAME || "gemini-2.0-flash-lite"; // 默认使用 gemini-2.0-flash-lite
const geminiModel = genAI.getGenerativeModel({ model: geminiModelName }, { apiVersion: 'v1' });

export async function getGeminiChatCompletion(prompt, userId) {
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

    // 添加历史对话（增加安全检查）
    if (Array.isArray(userHistory.messages)) {
      for (const msg of userHistory.messages.slice(-MAX_HISTORY * 2)) {
        if (msg && typeof msg.role === 'string' && typeof msg.content === 'string') {
          contextString += `${msg.role === 'user' ? '用户' : 'AI'}：${msg.content}\n`;
        }
      }
    }

    contextString += `用户：${prompt}`;

    const result = await geminiModel.generateContent(contextString);
    const response = await result.response;
    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "抱歉，Gemini 没有给出回复。";

    // 更新对话历史
    userHistory.messages = [
      ...userHistory.messages.slice(-MAX_HISTORY * 2),
      { role: 'user', content: prompt },
      { role: 'assistant', content: text }
    ];
    userHistory.lastUpdate = Date.now();

    return text;
  } catch (error) {
    console.error("Gemini API Error:", error);
    throw error;
  }
}