// src/app/api/test/route.js
// 测试路由，用于验证 Cloudflare Pages Functions 是否正常工作
import { WECHAT_DEBUG_STATE_KEY } from '../../../lib/wechat-async.js';

export async function GET(request) {
  const wechatEffectiveModel = process.env.WECHAT_GPT_MODEL || process.env.GPT_MODEL || 'openai';
  const wechatAsyncDebugState = globalThis[WECHAT_DEBUG_STATE_KEY]?.lastAsyncStatus || null;
  let hasWechatReplyQueue = false;
  let hasChatHistoryDb = false;

  try {
    const cfModule = await import('@opennextjs/cloudflare');
    const cfContext = cfModule.getCloudflareContext ? await cfModule.getCloudflareContext() : null;
    hasWechatReplyQueue = Boolean(cfContext?.env?.WECHAT_REPLY_QUEUE);
    hasChatHistoryDb = Boolean(cfContext?.env?.CHAT_HISTORY_DB);
  } catch {
    hasWechatReplyQueue = false;
    hasChatHistoryDb = false;
  }

  return new Response(JSON.stringify({
    status: 'ok',
    message: 'Cloudflare Pages Functions is working!',
    timestamp: new Date().toISOString(),
    wechatAsyncDebugState,
    env: {
      hasWechatToken: !!process.env.WECHAT_TOKEN,
      hasWechatAppId: !!process.env.WECHAT_APPID,
      hasWechatSecret: !!process.env.WECHAT_SECRET,
      hasWechatReplyQueue,
      hasChatHistoryDb,
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
      wechatSyncReplyTimeoutMs: process.env.WECHAT_SYNC_REPLY_TIMEOUT_MS || '3500',
      wechatAsyncAckMessage: process.env.WECHAT_ASYNC_ACK_MESSAGE || '已收到，正在生成回复，请稍候。',
      wechatUseKvHistory: process.env.WECHAT_USE_KV_HISTORY || 'false'
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
