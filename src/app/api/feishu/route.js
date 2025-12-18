// src/app/api/feishu/route.js
import { getOpenAIChatCompletion, getGeminiChatCompletion } from '../gpt/route';

// 启用 Edge Runtime（Cloudflare Pages 兼容）
export const runtime = 'edge';

// 飞书应用配置 (从环境变量中获取)
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_VERIFICATION_TOKEN = process.env.FEISHU_VERIFICATION_TOKEN;
const FEISHU_ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY;
const gptModelPreference = process.env.GPT_MODEL || 'openai';

// 保存访问令牌（注意：在 Edge Runtime 中，每个请求可能在不同的 worker 中处理）
let accessToken = null;
let tokenExpireTime = 0;

// 添加消息ID缓存，用于去重
const processedMessageIds = new Map();
const MESSAGE_CACHE_TTL = 60 * 1000; // 1分钟缓存时间

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
    throw error;
  }
}

// 发送消息到飞书（支持群消息和个人消息）
async function sendMessageToFeishu(message) {
  try {
    const token = await getAccessToken();
    const { chatId, userId, text, chatType } = message;

    // 确定接收ID类型和实际ID
    let receiveIdType, receiveId;

    if (chatType === 'group') {
      // 群聊消息
      receiveIdType = 'chat_id';
      receiveId = chatId;
    } else {
      // 私聊消息
      receiveIdType = 'user_id';
      receiveId = userId;
    }

    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text })
      }),
    });

    const result = await response.json();
    if (result.code !== 0) {
      throw new Error(`发送消息失败: ${result.msg}`);
    }

    return result;
  } catch (error) {
    throw error;
  }
}

// 使用 Web Crypto API 验证飞书请求签名 (最新规则)
async function verifyFeishuSignature(timestamp, signature) {
  if (!FEISHU_APP_SECRET) return true; // 如果未配置应用密钥，则跳过验证

  try {
    // 使用 APP_SECRET 作为签名密钥
    const stringToSign = timestamp + "\n" + FEISHU_APP_SECRET;

    // 使用 Web Crypto API 进行 HMAC-SHA256 签名
    const encoder = new TextEncoder();
    const keyData = encoder.encode(stringToSign);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, new Uint8Array(0));
    const sign = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

    return sign === signature;
  } catch (error) {
    return false;
  }
}

// 验证事件回调的 token
function verifyToken(token) {
  return token === FEISHU_VERIFICATION_TOKEN;
}

// 处理飞书消息事件，添加去重机制
async function handleMessage(event) {
  const { message, sender } = event;
  const messageId = message.message_id;

  // 检查消息是否已处理过
  if (processedMessageIds.has(messageId)) {
    return null; // 返回null表示不需要回复
  }

  // 记录已处理的消息ID
  processedMessageIds.set(messageId, Date.now());

  // 定期清理过期的消息ID
  const now = Date.now();
  for (const [id, timestamp] of processedMessageIds.entries()) {
    if (now - timestamp > MESSAGE_CACHE_TTL) {
      processedMessageIds.delete(id);
    }
  }

  const userId = sender.sender_id.user_id || sender.sender_id.open_id;
  const chatId = message.chat_id;
  const chatType = message.chat_type; // 'p2p' 表示私聊, 'group' 表示群聊

  if (message.message_type !== 'text') {
    return {
      text: "目前只支持文本消息",
      chatId,
      userId,
      chatType: chatType === 'group' ? 'group' : 'p2p'
    };
  }

  const content = JSON.parse(message.content);
  const userMessage = content.text.trim();

  // 调用AI接口生成回复
  let aiResponse;
  try {
    // 使用聊天ID和用户ID组合作为唯一标识，确保群聊中每个用户有独立的对话历史
    const contextId = chatType === 'group'
      ? `feishu_group_${chatId}_${userId}`
      : `feishu_${userId}`;

    switch (gptModelPreference.toLowerCase()) {
      case 'openai':
        aiResponse = await getOpenAIChatCompletion(userMessage, contextId);
        break;
      case 'gemini':
        aiResponse = await getGeminiChatCompletion(userMessage, contextId);
        break;
      default:
        aiResponse = await getOpenAIChatCompletion(userMessage, contextId);
        break;
    }
  } catch (error) {
    aiResponse = `抱歉，${gptModelPreference.toUpperCase()} 服务暂时不可用。`;
  }

  // 消息长度限制
  const MAX_MSG_LENGTH = 4000;
  if (aiResponse.length > MAX_MSG_LENGTH) {
    aiResponse = aiResponse.substring(0, MAX_MSG_LENGTH - 3) + '...';
  }

  return {
    text: aiResponse,
    chatId,
    userId,
    chatType: chatType === 'group' ? 'group' : 'p2p'
  };
}

export async function POST(request) {
  try {
    const body = await request.text();
    console.log('收到飞书请求:', body);
    const jsonBody = JSON.parse(body);

    // 获取请求头信息
    const timestamp = request.headers.get('x-lark-request-timestamp');
    const signature = request.headers.get('x-lark-signature');

    // 对于 Challenge 请求，跳过签名验证
    const { challenge } = jsonBody;
    if (challenge) {
      console.log('收到飞书 Challenge 请求，跳过签名验证');
      return new Response(JSON.stringify({ challenge }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 其他请求进行签名验证
    if (signature && FEISHU_ENCRYPT_KEY) {
      const isValid = await verifyFeishuSignature(timestamp, signature);
      if (!isValid) {
        console.error('签名验证失败');
        console.log({
          timestamp,
          signature
        });

        // 开发阶段可以临时注释下面的返回，强制继续处理
        return new Response(JSON.stringify({ error: 'Invalid signature' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 验证 Verification Token - 更宽松的逻辑
    const token = jsonBody.token;
    if (token && FEISHU_VERIFICATION_TOKEN && !verifyToken(token)) {
      console.error('Token验证失败');
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 处理飞书事件回调
    const { event } = jsonBody;
    // 事件处理
    if (jsonBody.header?.event_type === 'im.message.receive_v1') {
      const response = await handleMessage(event);

      // 如果返回null，表示消息已处理过，不需要回复
      if (!response) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 回复消息
      if (response.chatId) {
        await sendMessageToFeishu(response);
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 默认响应
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Feishu API Error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
