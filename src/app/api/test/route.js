// src/app/api/test/route.js
// 最简化的测试路由，用于验证 Cloudflare Pages Functions 是否正常工作

export const runtime = 'edge';

export async function GET(request) {
  return new Response(JSON.stringify({
    status: 'ok',
    message: 'Cloudflare Pages Functions is working!',
    timestamp: new Date().toISOString(),
    env: {
      hasWechatToken: !!process.env.WECHAT_TOKEN,
      hasOpenAIKey: !!process.env.OPENAI_API_KEY,
      hasGeminiKey: !!process.env.GEMINI_API_KEY,
      gptModel: process.env.GPT_MODEL || 'not set'
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

