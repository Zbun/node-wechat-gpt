// src/app/api/wechat/route.js

// 延迟加载依赖，避免模块加载时出错
let XMLParser;
let getOpenAIChatCompletion;
let getGeminiChatCompletion;
let getCloudflareContext;

// 消息去重缓存（防止微信重试导致重复处理）
const processedMessages = new Map();
const MESSAGE_CACHE_TTL = 60000; // 1分钟
const MAX_WECHAT_TEXT_LENGTH = 2000;
const DEFAULT_WECHAT_SYNC_REPLY_TIMEOUT_MS = 3500;

const wechatAccessTokenCache = {
  token: '',
  expiresAt: 0,
  pendingPromise: null,
};

function cleanupProcessedMessages(now) {
  for (const [id, value] of processedMessages.entries()) {
    if (now - value.time > MESSAGE_CACHE_TTL) {
      processedMessages.delete(id);
    }
  }
}

function buildWechatTextResponse(fromUser, toUser, createTime, content) {
  return `
                  <xml>
                      <ToUserName><![CDATA[${fromUser}]]></ToUserName>
                      <FromUserName><![CDATA[${toUser}]]></FromUserName>
                      <CreateTime>${createTime}</CreateTime>
                      <MsgType><![CDATA[text]]></MsgType>
                      <Content><![CDATA[${content}]]></Content>
                  </xml>
              `;
}

function truncateWechatText(text) {
  if (typeof text !== 'string' || !text) {
    return '';
  }

  if (text.length <= MAX_WECHAT_TEXT_LENGTH) {
    return text;
  }

  return text.substring(0, MAX_WECHAT_TEXT_LENGTH - 3) + '...';
}

function getWechatSyncReplyTimeoutMs() {
  const rawValue = Number(process.env.WECHAT_SYNC_REPLY_TIMEOUT_MS || DEFAULT_WECHAT_SYNC_REPLY_TIMEOUT_MS);

  if (!Number.isFinite(rawValue)) {
    return DEFAULT_WECHAT_SYNC_REPLY_TIMEOUT_MS;
  }

  return Math.min(Math.max(Math.floor(rawValue), 500), 4500);
}

function getWechatAsyncAckMessage() {
  const configuredMessage = process.env.WECHAT_ASYNC_ACK_MESSAGE;

  if (typeof configuredMessage === 'string' && configuredMessage.trim()) {
    return truncateWechatText(configuredMessage.trim());
  }

  return '已收到，正在生成回复，请稍候。';
}

function stripMarkdownForWechat(text) {
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

async function loadDependencies() {
  if (!XMLParser) {
    const fastXmlParser = await import('fast-xml-parser');
    XMLParser = fastXmlParser.XMLParser;
  }
  if (!getOpenAIChatCompletion) {
    const gptModule = await import('../gpt/route');
    getOpenAIChatCompletion = gptModule.getOpenAIChatCompletion;
    getGeminiChatCompletion = gptModule.getGeminiChatCompletion;
  }
  if (!getCloudflareContext) {
    try {
      const cfModule = await import('@opennextjs/cloudflare');
      getCloudflareContext = cfModule.getCloudflareContext;
    } catch {
      // 非 Cloudflare 环境
      getCloudflareContext = () => null;
    }
  }
}

// 微信公众号配置 (从环境变量中获取)
const wechatToken = process.env.WECHAT_TOKEN;

function getWechatModelPreference() {
  return process.env.WECHAT_GPT_MODEL || process.env.GPT_MODEL || 'openai';
}

function getWechatDebugConfig() {
  const modelPreference = getWechatModelPreference();

  return {
    modelPreference,
    syncReplyTimeoutMs: getWechatSyncReplyTimeoutMs(),
    wechatUseKvHistory: process.env.WECHAT_USE_KV_HISTORY === 'true',
    openaiModel: process.env.WECHAT_OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
    geminiModel: process.env.WECHAT_GEMINI_MODEL_NAME || process.env.GEMINI_MODEL_NAME || 'gemini-2.0-flash-lite',
    hasOpenAIKey: Boolean(process.env.WECHAT_OPENAI_API_KEY || process.env.OPENAI_API_KEY),
    hasGeminiKey: Boolean(process.env.WECHAT_GEMINI_API_KEY || process.env.GEMINI_API_KEY),
    hasWechatAppId: Boolean(process.env.WECHAT_APPID),
    hasWechatSecret: Boolean(process.env.WECHAT_SECRET),
  };
}

function getWechatAppCredentials() {
  return {
    appId: process.env.WECHAT_APPID || '',
    appSecret: process.env.WECHAT_SECRET || '',
  };
}

async function withReplyDeadline(promise, timeoutMs) {
  let timer = null;

  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          resolve({ timedOut: true, value: null });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function getWechatAccessToken() {
  const now = Date.now();
  if (wechatAccessTokenCache.token && wechatAccessTokenCache.expiresAt > now) {
    return wechatAccessTokenCache.token;
  }

  if (wechatAccessTokenCache.pendingPromise) {
    return wechatAccessTokenCache.pendingPromise;
  }

  const { appId, appSecret } = getWechatAppCredentials();
  if (!appId || !appSecret) {
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
        throw new Error(`获取 access_token 失败: ${data?.errmsg || response.statusText || '未知错误'}`);
      }

      const expiresInSeconds = Number(data.expires_in);
      const safeExpiresInMs = Number.isFinite(expiresInSeconds) && expiresInSeconds > 300
        ? (expiresInSeconds - 300) * 1000
        : 60 * 60 * 1000;

      wechatAccessTokenCache.token = data.access_token;
      wechatAccessTokenCache.expiresAt = Date.now() + safeExpiresInMs;
      return data.access_token;
    } finally {
      wechatAccessTokenCache.pendingPromise = null;
    }
  })();

  return wechatAccessTokenCache.pendingPromise;
}

async function sendWechatCustomerServiceMessage(openId, content) {
  if (typeof openId !== 'string' || !openId) {
    throw new Error('缺少用户 openId，无法发送客服消息');
  }

  const normalizedContent = truncateWechatText(stripMarkdownForWechat(content));
  if (!normalizedContent) {
    throw new Error('客服消息内容为空');
  }

  const accessToken = await getWechatAccessToken();
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
    throw new Error(`发送客服消息失败: ${data?.errmsg || response.statusText || '未知错误'}`);
  }
}

async function generateWechatReply(userMessage, fromUser, cfContext, gptModelPreference) {
  let gptResponse;

  switch (gptModelPreference.toLowerCase()) {
    case 'openai':
      gptResponse = await getOpenAIChatCompletion(userMessage, fromUser, cfContext, 'wechat');
      break;
    case 'gemini':
      gptResponse = await getGeminiChatCompletion(userMessage, fromUser, cfContext, 0, 'wechat');
      break;
    default:
      console.warn(`Unknown GPT model preference: ${gptModelPreference}, using OpenAI as default.`);
      gptResponse = await getOpenAIChatCompletion(userMessage, fromUser, cfContext, 'wechat');
      break;
  }

  return truncateWechatText(stripMarkdownForWechat(gptResponse));
}

// 使用 Web Crypto API 验证微信公众号请求签名
async function verifySignature(signature, timestamp, nonce) {
  const token = wechatToken;
  const sorted = [token, timestamp, nonce].sort().join('');

  // 使用 Web Crypto API 计算 SHA1 哈希
  const encoder = new TextEncoder();
  const data = encoder.encode(sorted);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const shasum = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return shasum === signature;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const signature = searchParams.get('signature');
  const timestamp = searchParams.get('timestamp');
  const nonce = searchParams.get('nonce');
  const echostr = searchParams.get('echostr');

  // 如果没有参数，返回健康检查响应
  if (!signature && !timestamp && !nonce && !echostr) {
    return new Response(JSON.stringify({
      status: 'ok',
      message: 'WeChat API endpoint is running',
      runtime: 'edge'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 微信验证需要所有参数
  if (!signature || !timestamp || !nonce || !echostr) {
    return new Response('Invalid parameters', { status: 400 });
  }

  if (await verifySignature(signature, timestamp, nonce)) {
    return new Response(echostr, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  } else {
    return new Response('Invalid signature', { status: 401 });
  }
}

export async function POST(request) {
  const xml = await request.text();

  try {
    // 延迟加载依赖
    await loadDependencies();

    // 获取 Cloudflare context（包含 D1 绑定和 waitUntil）
    const cfContext = getCloudflareContext ? await getCloudflareContext() : null;

    // 使用 fast-xml-parser 解析 XML
    const parser = new XMLParser();
    const result = parser.parse(xml);

    const message = result.xml;
    const msgType = message.MsgType;
    const fromUser = message.FromUserName;
    const toUser = message.ToUserName;
    const msgId = message.MsgId;
    const createTime = Date.now();
    const gptModelPreference = getWechatModelPreference();
    const wechatDebugConfig = getWechatDebugConfig();

    cleanupProcessedMessages(createTime);

    console.log('Wechat request received', {
      fromUser,
      msgType,
      hasMsgId: Boolean(msgId),
      ...wechatDebugConfig,
    });

    // 消息去重：检查是否已处理过（微信会重试）
    if (msgId) {
      const cachedResponse = processedMessages.get(msgId);
      if (cachedResponse?.responseXml) {
        console.log(`重复消息 ${msgId}，返回缓存回复`);
        return new Response(cachedResponse.responseXml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
      }
    }

    switch (msgType) {
      case 'text': {
        const userMessage = message.Content;
        const requestStartTime = Date.now();
        const replyPromise = generateWechatReply(userMessage, fromUser, cfContext, gptModelPreference);
        let syncResult;

        try {
          syncResult = await withReplyDeadline(replyPromise, getWechatSyncReplyTimeoutMs());
        } catch (error) {
          console.error(`Error calling ${gptModelPreference} API:`, error);
          const responseXml = buildWechatTextResponse(
            fromUser,
            toUser,
            createTime,
            truncateWechatText(`抱歉，服务暂时不可用: ${error?.message || '未知错误'}`)
          );
          if (msgId) {
            processedMessages.set(msgId, { time: createTime, responseXml });
          }
          return new Response(responseXml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
        }

        let responseXml;

        if (!syncResult.timedOut) {
          const gptResponse = syncResult.value;
          console.log('Wechat sync reply completed', {
            fromUser,
            msgId: msgId || null,
            durationMs: Date.now() - requestStartTime,
            model: gptModelPreference,
          });
          responseXml = buildWechatTextResponse(fromUser, toUser, createTime, gptResponse);
        } else {
          const { appId, appSecret } = getWechatAppCredentials();
          if (!appId || !appSecret) {
            console.error('Wechat async reply skipped due to missing app credentials', {
              fromUser,
              msgId: msgId || null,
            });
            responseXml = buildWechatTextResponse(
              fromUser,
              toUser,
              createTime,
              '回复生成中，但未配置 WECHAT_APPID/WECHAT_SECRET，暂时无法异步补发。'
            );
            if (msgId) {
              processedMessages.set(msgId, { time: createTime, responseXml });
            }
            return new Response(responseXml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
          }

          const asyncTask = replyPromise
            .then(async (replyText) => {
              await sendWechatCustomerServiceMessage(fromUser, replyText);
              console.log('Wechat async customer service reply sent', {
                fromUser,
                msgId: msgId || null,
                durationMs: Date.now() - requestStartTime,
                model: gptModelPreference,
              });
            })
            .catch((error) => {
              console.error('Wechat async reply failed', {
                fromUser,
                msgId: msgId || null,
                model: gptModelPreference,
                error: error?.message || String(error),
              });
            });

          if (cfContext?.ctx?.waitUntil) {
            cfContext.ctx.waitUntil(asyncTask);
          } else {
            void asyncTask;
          }

          console.log('Wechat reply switched to async mode', {
            fromUser,
            msgId: msgId || null,
            syncWindowMs: getWechatSyncReplyTimeoutMs(),
            model: gptModelPreference,
          });
          responseXml = buildWechatTextResponse(fromUser, toUser, createTime, getWechatAsyncAckMessage());
        }

        if (msgId) {
          processedMessages.set(msgId, { time: createTime, responseXml });
        }
        return new Response(responseXml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
      }
      case 'event': {
        const eventType = message.Event;
        if (eventType === 'subscribe') {
          const welcomeMessage = process.env.WELCOME_MESSAGE || "感谢您的关注！我是您的AI助手，可以为您解答任何问题。";
          const responseXml = buildWechatTextResponse(fromUser, toUser, createTime, welcomeMessage);
          if (msgId) {
            processedMessages.set(msgId, { time: createTime, responseXml });
          }
          return new Response(responseXml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
        } else if (eventType === 'unsubscribe') {
          return new Response(null, { status: 200 });
        } else {
          console.log('Unhandled event type:', eventType);
          return new Response(null, { status: 200 });
        }
      }
      default: {
        console.log('Unhandled message type:', msgType);
        return new Response(null, { status: 200 });
      }
    }
  } catch (error) {
    console.error('Error processing request:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
