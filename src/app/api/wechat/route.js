// src/app/api/wechat/route.js

// 延迟加载依赖，避免模块加载时出错
let XMLParser;
let getOpenAIChatCompletion;
let getGeminiChatCompletion;
let getCloudflareContext;

// 消息去重缓存（防止微信重试导致重复处理）
const processedMessages = new Map();
const MESSAGE_CACHE_TTL = 60000; // 1分钟
const DEFAULT_WECHAT_REPLY_TIMEOUT_MS = 4500;

function getWechatReplyTimeoutMs() {
  const rawValue = Number(process.env.WECHAT_REPLY_TIMEOUT_MS || DEFAULT_WECHAT_REPLY_TIMEOUT_MS);

  if (!Number.isFinite(rawValue)) {
    return DEFAULT_WECHAT_REPLY_TIMEOUT_MS;
  }

  return Math.min(Math.max(Math.floor(rawValue), 1000), 4800);
}

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

async function withWechatTimeout(promise, timeoutMs) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('WECHAT_REPLY_TIMEOUT'));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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
  return process.env.GPT_MODEL || 'openai';
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
    const wechatReplyTimeoutMs = getWechatReplyTimeoutMs();
    const gptModelPreference = getWechatModelPreference();

    cleanupProcessedMessages(createTime);

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
        let gptResponse;
        const requestStartTime = Date.now();
        try {
          gptResponse = await withWechatTimeout((async () => {
            switch (gptModelPreference.toLowerCase()) {
              case 'openai':
                return getOpenAIChatCompletion(userMessage, fromUser, cfContext, 'wechat');
              case 'gemini':
                return getGeminiChatCompletion(userMessage, fromUser, cfContext, 0, 'wechat');
              default:
                console.warn(`Unknown GPT model preference: ${gptModelPreference}, using OpenAI as default.`);
                return getOpenAIChatCompletion(userMessage, fromUser, cfContext, 'wechat');
            }
          })(), wechatReplyTimeoutMs);
        } catch (error) {
          console.error(`Error calling ${gptModelPreference} API:`, error);
          if (error?.message === 'WECHAT_REPLY_TIMEOUT') {
            gptResponse = '当前消息较多，处理超时。请稍后重试，或把问题描述得更短一些。';
          } else {
            gptResponse = `抱歉，服务暂时不可用: ${error?.message || '未知错误'}`;
          }
        }

        console.log(`微信消息处理耗时 ${Date.now() - requestStartTime}ms，模型=${gptModelPreference}`);

        gptResponse = stripMarkdownForWechat(gptResponse);

        // 微信文本消息有长度限制，截断过长的回复
        const MAX_MSG_LENGTH = 2000;
        if (gptResponse.length > MAX_MSG_LENGTH) {
          gptResponse = gptResponse.substring(0, MAX_MSG_LENGTH - 3) + '...';
        }

        const responseXml = buildWechatTextResponse(fromUser, toUser, createTime, gptResponse);
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
