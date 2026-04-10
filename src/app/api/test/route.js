// src/app/api/test/route.js
// 测试路由，用于验证 Cloudflare Pages Functions 是否正常工作

export async function GET(request) {
  const wechatEffectiveModel = process.env.WECHAT_GPT_MODEL || process.env.GPT_MODEL || 'openai';

  return new Response(JSON.stringify({
    status: 'ok',
    message: 'Cloudflare Pages Functions is working!',
    timestamp: new Date().toISOString(),
    env: {
      hasWechatToken: !!process.env.WECHAT_TOKEN,
      hasOpenAIKey: !!process.env.OPENAI_API_KEY,
      hasWechatOpenAIKey: !!process.env.WECHAT_OPENAI_API_KEY,
      hasGeminiKey: !!process.env.GEMINI_API_KEY,
      hasWechatGeminiKey: !!process.env.WECHAT_GEMINI_API_KEY,
      gptModel: process.env.GPT_MODEL || 'not set',
      wechatGptModel: process.env.WECHAT_GPT_MODEL || 'not set',
      wechatEffectiveModel,
      openaiModel: process.env.OPENAI_MODEL || 'not set',
      wechatOpenaiModel: process.env.WECHAT_OPENAI_MODEL || 'not set',
      geminiModel: process.env.GEMINI_MODEL_NAME || 'not set',
      wechatGeminiModel: process.env.WECHAT_GEMINI_MODEL_NAME || 'not set',
      wechatReplyTimeoutMs: process.env.WECHAT_REPLY_TIMEOUT_MS || '4500',
      wechatUseKvHistory: process.env.WECHAT_USE_KV_HISTORY || 'false'
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
