// src/app/api/wechat/route.js

import { getWechatModelPreference, WECHAT_DEBUG_STATE_KEY } from '../../../lib/wechat-async.js';

let XMLParser;
let getCloudflareContext;

const processedMessages = new Map();
const MESSAGE_CACHE_TTL = 60000;

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

async function loadDependencies() {
  if (!XMLParser) {
    const fastXmlParser = await import('fast-xml-parser');
    XMLParser = fastXmlParser.XMLParser;
  }

  if (!getCloudflareContext) {
    try {
      const cfModule = await import('@opennextjs/cloudflare');
      getCloudflareContext = cfModule.getCloudflareContext;
    } catch {
      getCloudflareContext = () => null;
    }
  }
}

const wechatToken = process.env.WECHAT_TOKEN;

function getWechatDebugConfig(cfContext) {
  const env = cfContext?.env;

  return {
    modelPreference: getWechatModelPreference(env),
    hasWechatReplyQueue: Boolean(env?.WECHAT_REPLY_QUEUE),
    hasWechatAppId: Boolean(env?.WECHAT_APPID || process.env.WECHAT_APPID),
    hasWechatSecret: Boolean(env?.WECHAT_SECRET || process.env.WECHAT_SECRET),
  };
}

async function verifySignature(signature, timestamp, nonce) {
  const token = wechatToken;
  const sorted = [token, timestamp, nonce].sort().join('');
  const encoder = new TextEncoder();
  const data = encoder.encode(sorted);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const shasum = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  return shasum === signature;
}

async function enqueueWechatReply(cfContext, payload) {
  const queue = cfContext?.env?.WECHAT_REPLY_QUEUE;
  if (!queue || typeof queue.send !== 'function') {
    throw new Error('未绑定 WECHAT_REPLY_QUEUE，无法处理异步回复');
  }

  await queue.send(payload);
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const signature = searchParams.get('signature');
  const timestamp = searchParams.get('timestamp');
  const nonce = searchParams.get('nonce');
  const echostr = searchParams.get('echostr');

  if (!signature && !timestamp && !nonce && !echostr) {
    return new Response(JSON.stringify({
      status: 'ok',
      message: 'WeChat API endpoint is running',
      runtime: 'edge',
      wechatAsyncDebugState: globalThis[WECHAT_DEBUG_STATE_KEY]?.lastAsyncStatus || null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!signature || !timestamp || !nonce || !echostr) {
    return new Response('Invalid parameters', { status: 400 });
  }

  if (await verifySignature(signature, timestamp, nonce)) {
    return new Response(echostr, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  return new Response('Invalid signature', { status: 401 });
}

export async function POST(request) {
  const xml = await request.text();

  try {
    await loadDependencies();
    const cfContext = getCloudflareContext ? await getCloudflareContext() : null;

    const parser = new XMLParser();
    const result = parser.parse(xml);
    const message = result.xml;
    const msgType = message.MsgType;
    const fromUser = message.FromUserName;
    const toUser = message.ToUserName;
    const msgId = message.MsgId;
    const createTime = Date.now();

    cleanupProcessedMessages(createTime);

    console.log('Wechat request received', {
      fromUser,
      msgType,
      hasMsgId: Boolean(msgId),
      ...getWechatDebugConfig(cfContext),
    });

    if (msgId) {
      const cachedResponse = processedMessages.get(msgId);
      if (cachedResponse?.response) {
        console.log(`重复消息 ${msgId}，返回缓存结果`);
        return cachedResponse.response.clone();
      }
    }

    switch (msgType) {
      case 'text': {
        const responsePayload = new Response('success', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });

        try {
          await enqueueWechatReply(cfContext, {
            fromUser,
            userMessage: typeof message.Content === 'string' ? message.Content.slice(0, 4000) : '',
            msgId: typeof msgId === 'string' ? msgId : '',
            gptModelPreference: getWechatModelPreference(cfContext?.env),
          });
        } catch (error) {
          console.error('Wechat queue enqueue failed', {
            fromUser,
            msgId: msgId || null,
            error: error?.message || String(error),
          });

          const failureXml = buildWechatTextResponse(
            fromUser,
            toUser,
            createTime,
            '服务暂时不可用，请稍后再试。'
          );
          const failureResponse = new Response(failureXml, {
            status: 200,
            headers: { 'Content-Type': 'text/xml' },
          });

          if (msgId) {
            processedMessages.set(msgId, { time: createTime, response: failureResponse.clone() });
          }
          return failureResponse;
        }

        if (msgId) {
          processedMessages.set(msgId, { time: createTime, response: responsePayload.clone() });
        }

        return responsePayload;
      }
      case 'event': {
        const eventType = message.Event;
        if (eventType === 'subscribe') {
          const welcomeMessage = process.env.WELCOME_MESSAGE || '感谢您的关注！我是您的AI助手，可以为您解答任何问题。';
          const responseXml = buildWechatTextResponse(fromUser, toUser, createTime, welcomeMessage);
          const response = new Response(responseXml, {
            status: 200,
            headers: { 'Content-Type': 'text/xml' },
          });

          if (msgId) {
            processedMessages.set(msgId, { time: createTime, response: response.clone() });
          }
          return response;
        }

        return new Response('success', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      default:
        return new Response('success', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
  } catch (error) {
    console.error('Error processing request:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
