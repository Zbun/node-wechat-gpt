// src/app/api/feishu/route.js
import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { getOpenAIChatCompletion, getGeminiChatCompletion } from '../gpt/route';

// 飞书应用配置 (从环境变量中获取)
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_VERIFICATION_TOKEN = process.env.FEISHU_VERIFICATION_TOKEN;
const FEISHU_ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY;
const gptModelPreference = process.env.GPT_MODEL || 'openai';

// 保存访问令牌
let accessToken = null;
let tokenExpireTime = 0;

// 获取飞书访问令牌
async function getAccessToken() {
  // 如果当前令牌有效，直接返回
  if (accessToken && tokenExpireTime > Date.now()) {
    return accessToken;
  }

  try {
    const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: FEISHU_APP_ID,
        app_secret: FEISHU_APP_SECRET,
      }),
    });

    const data = await response.json();
    if (data.code !== 0) {
      throw new Error(`Failed to get access token: ${data.msg}`);
    }

    accessToken = data.tenant_access_token;
    // 设置过期时间，比实际时间提前5分钟
    tokenExpireTime = Date.now() + (data.expire - 300) * 1000;
    return accessToken;
  } catch (error) {
    console.error('获取飞书访问令牌失败:', error);
    throw error;
  }
}

// 发送消息到飞书
async function sendMessageToFeishu(chatId, text) {
  try {
    const token = await getAccessToken();
    const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    });
    return await response.json();
  } catch (error) {
    console.error('发送飞书消息失败:', error);
    throw error;
  }
}

// 验证飞书请求签名
function verifyFeishuSignature(timestamp, nonce, body, signature) {
  if (!FEISHU_ENCRYPT_KEY) return true; // 如果未配置加密密钥，则跳过验证

  const stringToSign = timestamp + nonce + FEISHU_ENCRYPT_KEY + body;
  const sign = crypto.createHash('sha256').update(stringToSign).digest('hex');
  return sign === signature;
}

// 验证事件回调的 token
function verifyToken(token) {
  return token === FEISHU_VERIFICATION_TOKEN;
}

// 处理飞书消息事件
async function handleMessage(event) {
  const { message, sender } = event;
  const userId = sender.sender_id.user_id || sender.sender_id.open_id;
  const chatId = message.chat_id;

  if (message.message_type !== 'text') {
    return { text: "目前只支持文本消息" };
  }

  const content = JSON.parse(message.content);
  const userMessage = content.text.trim();

  // 调用AI接口生成回复
  let aiResponse;
  try {
    switch (gptModelPreference.toLowerCase()) {
      case 'openai':
        aiResponse = await getOpenAIChatCompletion(userMessage, `feishu_${userId}`);
        break;
      case 'gemini':
        aiResponse = await getGeminiChatCompletion(userMessage, `feishu_${userId}`);
        break;
      default:
        console.warn(`Unknown GPT model preference: ${gptModelPreference}, using OpenAI as default.`);
        aiResponse = await getOpenAIChatCompletion(userMessage, `feishu_${userId}`);
        break;
    }
  } catch (error) {
    console.error(`Error calling ${gptModelPreference} API:`, error);
    aiResponse = `抱歉，${gptModelPreference.toUpperCase()} 服务暂时不可用。`;
  }

  // 消息长度限制
  const MAX_MSG_LENGTH = 4000;
  if (aiResponse.length > MAX_MSG_LENGTH) {
    aiResponse = aiResponse.substring(0, MAX_MSG_LENGTH - 3) + '...';
  }

  return { text: aiResponse, chatId };
}

export async function POST(request) {
  try {
    const body = await request.text();
    const jsonBody = JSON.parse(body);

    // 获取请求头信息
    const timestamp = request.headers.get('x-lark-request-timestamp');
    const nonce = request.headers.get('x-lark-request-nonce');
    const signature = request.headers.get('x-lark-signature');
    const token = jsonBody.token;

    // 验证请求签名
    if (signature && !verifyFeishuSignature(timestamp, nonce, body, signature)) {
      return new NextResponse(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 验证 Verification Token
    if (token && !verifyToken(token)) {
      return new NextResponse(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 处理飞书事件回调
    const { challenge, type, event } = jsonBody;

    // URL验证请求
    if (challenge) {
      return new NextResponse(JSON.stringify({ challenge }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 事件处理
    if (type === 'im.message.receive_v1') {
      const response = await handleMessage(event);

      // 回复消息
      if (response.chatId) {
        await sendMessageToFeishu(response.chatId, response.text);
      }

      return new NextResponse(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 默认响应
    return new NextResponse(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Feishu API Error:', error);
    return new NextResponse(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}