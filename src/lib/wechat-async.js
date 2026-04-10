/*
[FILE_ID]
ROUTE: NONE
MODULE: 微信异步回复
DESCRIPTION: 处理微信公众号队列消息并发送客服补发回复
KEYWORDS: 微信异步回复,wechatAsyncReply,处理
*/

import { getOpenAIChatCompletion, getGeminiChatCompletion } from '../app/api/gpt/route.js';

export const WECHAT_DEBUG_STATE_KEY = '__wechat_async_debug_state__';
const MAX_WECHAT_TEXT_LENGTH = 2000;

const wechatAccessTokenCache = {
  token: '',
  expiresAt: 0,
  pendingPromise: null,
};

function readEnv(env, key) {
  const envValue = env && typeof env[key] === 'string' ? env[key] : '';
  if (envValue) {
    return envValue;
  }

  const processValue = typeof process !== 'undefined' && process?.env ? process.env[key] : '';
  return typeof processValue === 'string' ? processValue : '';
}

function getWechatDebugStateStore() {
  if (!globalThis[WECHAT_DEBUG_STATE_KEY]) {
    globalThis[WECHAT_DEBUG_STATE_KEY] = {
      lastAsyncStatus: null,
    };
  }

  return globalThis[WECHAT_DEBUG_STATE_KEY];
}

export function updateWechatAsyncDebugStatus(status) {
  const store = getWechatDebugStateStore();
  store.lastAsyncStatus = {
    ...status,
    timestamp: new Date().toISOString(),
  };
}

export function truncateWechatText(text) {
  if (typeof text !== 'string' || !text) {
    return '';
  }

  if (text.length <= MAX_WECHAT_TEXT_LENGTH) {
    return text;
  }

  return text.substring(0, MAX_WECHAT_TEXT_LENGTH - 3) + '...';
}

export function stripMarkdownForWechat(text) {
  if (typeof text !== 'string' || !text) {
    return '';
  }

  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-zA-Z0-9_-]*\n?/g, '').trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, (match) => match.replace('.', '、'))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1：$2')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-|:]{3,}\s*$/gm, '')
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function getWechatModelPreference(env) {
  return readEnv(env, 'WECHAT_GPT_MODEL') || readEnv(env, 'GPT_MODEL') || 'openai';
}

function getWechatAppCredentials(env) {
  return {
    appId: readEnv(env, 'WECHAT_APPID'),
    appSecret: readEnv(env, 'WECHAT_SECRET'),
  };
}

async function getWechatAccessToken(env) {
  const now = Date.now();
  if (wechatAccessTokenCache.token && wechatAccessTokenCache.expiresAt > now) {
    return wechatAccessTokenCache.token;
  }

  if (wechatAccessTokenCache.pendingPromise) {
    return wechatAccessTokenCache.pendingPromise;
  }

  const { appId, appSecret } = getWechatAppCredentials(env);
  if (!appId || !appSecret) {
    updateWechatAsyncDebugStatus({
      stage: 'validate_credentials',
      success: false,
      error: '缺少 WECHAT_APPID 或 WECHAT_SECRET',
    });
    throw new Error('缺少 WECHAT_APPID 或 WECHAT_SECRET，无法发送异步客服消息');
  }

  wechatAccessTokenCache.pendingPromise = (async () => {
    try {
      const tokenUrl = new URL('https://api.weixin.qq.com/cgi-bin/token');
      tokenUrl.searchParams.set('grant_type', 'client_credential');
      tokenUrl.searchParams.set('appid', appId);
      tokenUrl.searchParams.set('secret', appSecret);

      const response = await fetch(tokenUrl.toString(), { method: 'GET' });
      const data = await response.json();

      if (!response.ok || typeof data?.access_token !== 'string' || !data.access_token) {
        updateWechatAsyncDebugStatus({
          stage: 'get_access_token',
          success: false,
          error: data?.errmsg || response.statusText || '未知错误',
          errcode: Number(data?.errcode || 0),
        });
        throw new Error(`获取 access_token 失败: ${data?.errmsg || response.statusText || '未知错误'}`);
      }

      const expiresInSeconds = Number(data.expires_in);
      const safeExpiresInMs = Number.isFinite(expiresInSeconds) && expiresInSeconds > 300
        ? (expiresInSeconds - 300) * 1000
        : 60 * 60 * 1000;

      wechatAccessTokenCache.token = data.access_token;
      wechatAccessTokenCache.expiresAt = Date.now() + safeExpiresInMs;
      updateWechatAsyncDebugStatus({
        stage: 'get_access_token',
        success: true,
      });
      return data.access_token;
    } finally {
      wechatAccessTokenCache.pendingPromise = null;
    }
  })();

  return wechatAccessTokenCache.pendingPromise;
}

async function sendWechatCustomerServiceMessage(env, openId, content) {
  if (typeof openId !== 'string' || !openId) {
    throw new Error('缺少用户 openId，无法发送客服消息');
  }

  const normalizedContent = truncateWechatText(stripMarkdownForWechat(content));
  if (!normalizedContent) {
    throw new Error('客服消息内容为空');
  }

  const accessToken = await getWechatAccessToken(env);
  const response = await fetch(`https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      touser: openId,
      msgtype: 'text',
      text: {
        content: normalizedContent,
      },
    }),
  });

  const data = await response.json();
  if (!response.ok || Number(data?.errcode || 0) !== 0) {
    updateWechatAsyncDebugStatus({
      stage: 'send_customer_service_message',
      success: false,
      error: data?.errmsg || response.statusText || '未知错误',
      errcode: Number(data?.errcode || 0),
    });
    throw new Error(`发送客服消息失败: ${data?.errmsg || response.statusText || '未知错误'}`);
  }

  updateWechatAsyncDebugStatus({
    stage: 'send_customer_service_message',
    success: true,
  });
}

async function generateWechatReply(env, payload) {
  const { fromUser, userMessage, gptModelPreference } = payload;
  const cfContext = { env, ctx: null };
  let gptResponse;

  switch ((gptModelPreference || getWechatModelPreference(env)).toLowerCase()) {
    case 'openai':
      gptResponse = await getOpenAIChatCompletion(userMessage, fromUser, cfContext, 'wechat');
      break;
    case 'gemini':
      gptResponse = await getGeminiChatCompletion(userMessage, fromUser, cfContext, 0, 'wechat');
      break;
    default:
      gptResponse = await getOpenAIChatCompletion(userMessage, fromUser, cfContext, 'wechat');
      break;
  }

  const normalizedReply = truncateWechatText(stripMarkdownForWechat(gptResponse));
  if (normalizedReply) {
    return normalizedReply;
  }

  const rawReply = typeof gptResponse === 'string' ? gptResponse.trim() : '';
  if (rawReply) {
    return truncateWechatText(rawReply);
  }

  return '抱歉，这次没有生成有效回复，请换个说法再试一次。';
}

function normalizeQueuePayload(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('队列消息格式错误');
  }

  const fromUser = typeof body.fromUser === 'string' ? body.fromUser.trim() : '';
  const userMessage = typeof body.userMessage === 'string' ? body.userMessage.trim() : '';
  const msgId = typeof body.msgId === 'string' ? body.msgId.trim() : '';
  const gptModelPreference = typeof body.gptModelPreference === 'string' ? body.gptModelPreference.trim() : '';

  if (!fromUser || !userMessage) {
    throw new Error('队列消息缺少 fromUser 或 userMessage');
  }

  return {
    fromUser,
    userMessage: userMessage.slice(0, 4000),
    msgId,
    gptModelPreference,
  };
}

export async function processWechatReplyJob(env, body) {
  const payload = normalizeQueuePayload(body);

  updateWechatAsyncDebugStatus({
    stage: 'queue_consume_started',
    success: true,
    fromUser: payload.fromUser,
    msgId: payload.msgId || null,
    model: payload.gptModelPreference || getWechatModelPreference(env),
  });

  const replyText = await generateWechatReply(env, payload);
  updateWechatAsyncDebugStatus({
    stage: 'generate_reply',
    success: true,
    fromUser: payload.fromUser,
    msgId: payload.msgId || null,
  });

  await sendWechatCustomerServiceMessage(env, payload.fromUser, replyText);
  console.log('Wechat queue reply sent', {
    fromUser: payload.fromUser,
    msgId: payload.msgId || null,
    model: payload.gptModelPreference || getWechatModelPreference(env),
  });
}

export async function processWechatReplyQueue(batch, env) {
  for (const message of batch.messages) {
    try {
      await processWechatReplyJob(env, message.body);
      message.ack();
    } catch (error) {
      updateWechatAsyncDebugStatus({
        stage: 'queue_consume_failed',
        success: false,
        error: error?.message || String(error),
      });
      console.error('Wechat queue reply failed', {
        error: error?.message || String(error),
      });
      message.retry();
    }
  }
}
