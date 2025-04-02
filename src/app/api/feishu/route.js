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

// 验证飞书请求签名
function verifyFeishuSignature(timestamp, nonce, body, signature) {
  if (!FEISHU_ENCRYPT_KEY) return true; // 如果未配置加密密钥，则跳过验证

  const stringToSign = timestamp + nonce + FEISHU_ENCRYPT_KEY + body;
  const sign = crypto.createHash('sha256').update(stringToSign).digest('hex');
  return sign === signature;
}

// 处理飞书消息事件
async function handleMessage(event) {
  const { message, sender } = event;
  const userId = sender.sender_id.user_id || sender.sender_id.open_id;

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

  return { text: aiResponse };
}

export async function POST(request) {
  try {
    const body = await request.text();
    const jsonBody = JSON.parse(body);

    // 获取请求头信息
    const timestamp = request.headers.get('x-lark-request-timestamp');
    const nonce = request.headers.get('x-lark-request-nonce');
    const signature = request.headers.get('x-lark-signature');

    // 验证请求签名
    if (signature && !verifyFeishuSignature(timestamp, nonce, body, signature)) {
      return new NextResponse(JSON.stringify({ error: 'Invalid signature' }), {
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

      return new NextResponse(JSON.stringify({
        msg_type: 'text',
        content: {
          text: response.text
        }
      }), {
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