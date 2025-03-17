// src/app/api/gpt/route.js
import OpenAI from 'openai';
const { GoogleGenerativeAI } = require("@google/generative-ai"); // 引入新的库
import { NextResponse } from 'next/server';

// OpenAI 配置
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getOpenAIChatCompletion(prompt) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // 或其他你想要使用的模型
      messages: [{ role: "user", content: prompt }],
    });
    return completion.choices[0].message.content;
  } catch (error) {
    console.error("OpenAI API Error:", error);
    throw error;
  }
}

// Gemini 配置 (使用 @google/generative-ai)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModelName = process.env.GEMINI_MODEL_NAME || "gemini-1.5-flash"; // 默认使用 gemini-pro
const geminiModel = genAI.getGenerativeModel({ model: geminiModelName }, { apiVersion: 'v1' });
const fixedRoleInstruction = "你是一个AI，旨在回答和解决人们的问题，并且你使用与问题相同的语言回答问题。";
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