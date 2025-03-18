// src/app/api/gpt/route.js
import OpenAI from 'openai';
const { GoogleGenerativeAI } = require("@google/generative-ai"); // 引入新的库
import { NextResponse } from 'next/server';

const fixedRoleInstruction = process.env.GPT_PRE_PROMPT || "你要用与提问相同的语言回答。";
// OpenAI 配置
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_API_BASE_URL || "https://api.openai.com" });

export async function getOpenAIChatCompletion(prompt) {
  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-3.5-turbo", // 或其他你想要使用的模型
      messages: [{ role: "user", content: `${fixedRoleInstruction}\n\n用户消息：${prompt}` }],
    });
    return completion.choices[0].message.content;
  } catch (error) {
    console.error("OpenAI API Error:", error);
    throw error;
  }
}

// Gemini 配置 (使用 @google/generative-ai)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModelName = process.env.GEMINI_MODEL_NAME || "gemini-2.0-flash-lite"; // 默认使用 gemini-2.0-flash-lite
const geminiModel = genAI.getGenerativeModel({ model: geminiModelName }, { apiVersion: 'v1' });

export async function getGeminiChatCompletion(prompt) {
  try {
    const combinedPrompt = `${fixedRoleInstruction}\n\n用户消息：${prompt}`;
    const result = await geminiModel.generateContent(combinedPrompt);
    const response = await result.response;
    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text || "抱歉，Gemini 没有给出回复。";
  } catch (error) {
    console.error("Gemini API Error:", error);
    throw error;
  }
}