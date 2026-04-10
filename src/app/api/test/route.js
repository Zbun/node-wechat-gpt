// src/app/api/test/route.js
// 测试路由，用于验证 Cloudflare Pages Functions 是否正常工作

export async function GET(request) {
  return new Response(JSON.stringify({
    status: 'ok',
    message: 'Cloudflare Pages Functions is working!',
    timestamp: new Date().toISOString(),
    env: {
      hasWechatToken: !!process.env.WECHAT_TOKEN,
      hasOpenAIKey: !!process.env.OPENAI_API_KEY,
      hasGeminiKey: !!process.env.GEMINI_API_KEY,
      gptModel: process.env.GPT_MODEL || 'not set',
      wechatEffectiveModel: process.env.GPT_MODEL || 'openai',
      openaiModel: process.env.OPENAI_MODEL || 'not set',
      geminiModel: process.env.GEMINI_MODEL_NAME || 'not set',
      wechatReplyTimeoutMs: process.env.WECHAT_REPLY_TIMEOUT_MS || '4500',
      wechatUseKvHistory: process.env.WECHAT_USE_KV_HISTORY || 'false'
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

