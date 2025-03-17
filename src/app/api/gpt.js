// pages/api/gpt.js
import OpenAI from 'openai';
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const { VertexAI } = require('@google-cloud/vertexai');

// OpenAI 配置
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getOpenAIChatCompletion(prompt) {
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

// Azure OpenAI 配置
const azureOpenAIClient = new OpenAIClient(
  process.env.AZURE_OPENAI_ENDPOINT,
  new AzureKeyCredential(process.env.AZURE_OPENAI_API_KEY)
);
const azureDeploymentId = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;

async function getAzureOpenAIChatCompletion(prompt) {
  try {
    const result = await azureOpenAIClient.getChatCompletions(azureDeploymentId, [
      { role: "user", content: prompt },
    ]);
    return result.choices[0].message.content;
  } catch (error) {
    console.error("Azure OpenAI API Error:", error);
    throw error;
  }
}

// Gemini 配置
const vertexAI = new VertexAI({ project: 'your-gcp-project-id', location: 'us-central1' }); // 替换为你的 GCP 项目 ID 和区域
const geminiModel = vertexAI.preview.generativeModel({
  model: 'gemini-pro',
  generationConfig: {
    maxOutputTokens: 2048,
  },
});

async function getGeminiChatCompletion(prompt) {
  try {
    const result = await geminiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const response = result.response;
    const text = response.candidates[0].content.parts[0].text;
    return text;
  } catch (error) {
    console.error("Gemini API Error:", error);
    throw error;
  }
}

export { getOpenAIChatCompletion, getAzureOpenAIChatCompletion, getGeminiChatCompletion };