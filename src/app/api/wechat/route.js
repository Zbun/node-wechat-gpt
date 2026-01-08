// src/app/api/wechat/route.js

// 延迟加载依赖，避免模块加载时出错
let XMLParser;
let getOpenAIChatCompletion;
let getGeminiChatCompletion;
let getCloudflareContext;

// 消息去重缓存（防止微信重试导致重复处理）
const processedMessages = new Map();
const MESSAGE_CACHE_TTL = 60000; // 1分钟

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
const gptModelPreference = process.env.GPT_MODEL || 'openai';

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

    // 消息去重：检查是否已处理过（微信会重试）
    if (msgId && processedMessages.has(msgId)) {
      console.log(`重复消息 ${msgId}，跳过处理`);
      return new Response('', { status: 200 });
    }

    // 标记消息为已处理
    if (msgId) {
      processedMessages.set(msgId, createTime);
      // 清理过期缓存
      for (const [id, time] of processedMessages.entries()) {
        if (createTime - time > MESSAGE_CACHE_TTL) {
          processedMessages.delete(id);
        }
      }
    }

    switch (msgType) {
      case 'text': {
        const userMessage = message.Content;
        let gptResponse;
        try {
          switch (gptModelPreference.toLowerCase()) {
            case 'openai':
              gptResponse = await getOpenAIChatCompletion(userMessage, fromUser, cfContext);
              break;
            case 'gemini':
              gptResponse = await getGeminiChatCompletion(userMessage, fromUser, cfContext);
              break;
            default:
              console.warn(`Unknown GPT model preference: ${gptModelPreference}, using OpenAI as default.`);
              gptResponse = await getOpenAIChatCompletion(userMessage, fromUser, cfContext);
              break;
          }
        } catch (error) {
          console.error(`Error calling ${gptModelPreference} API:`, error);
          gptResponse = `抱歉，服务暂时不可用: ${error?.message || '未知错误'}`;
        }

        // 微信文本消息有长度限制，截断过长的回复
        const MAX_MSG_LENGTH = 2000;
        if (gptResponse.length > MAX_MSG_LENGTH) {
          gptResponse = gptResponse.substring(0, MAX_MSG_LENGTH - 3) + '...';
        }

        const responseXml = `
                  <xml>
                      <ToUserName><![CDATA[${fromUser}]]></ToUserName>
                      <FromUserName><![CDATA[${toUser}]]></FromUserName>
                      <CreateTime>${createTime}</CreateTime>
                      <MsgType><![CDATA[text]]></MsgType>
                      <Content><![CDATA[${gptResponse}]]></Content>
                  </xml>
              `;
        return new Response(responseXml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
      }
      case 'event': {
        const eventType = message.Event;
        if (eventType === 'subscribe') {
          const welcomeMessage = process.env.WELCOME_MESSAGE || "感谢您的关注！我是您的AI助手，可以为您解答任何问题。";
          const responseXml = `
                      <xml>
                          <ToUserName><![CDATA[${fromUser}]]></ToUserName>
                          <FromUserName><![CDATA[${toUser}]]></FromUserName>
                          <CreateTime>${createTime}</CreateTime>
                          <MsgType><![CDATA[text]]></MsgType>
                          <Content><![CDATA[${welcomeMessage}]]></Content>
                      </xml>
                  `;
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
