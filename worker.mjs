/*
[FILE_ID]
ROUTE: /api/wechat
MODULE: 微信公众号Worker
DESCRIPTION: 纯Cloudflare Worker实现微信公众号消息处理与异步客服补发
KEYWORDS: 微信公众号Worker,wechatWorker,处理
*/

import { XMLParser } from 'fast-xml-parser';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

const MESSAGE_CACHE_TTL_MS = 60 * 1000;
const MAX_WECHAT_TEXT_LENGTH = 2000;
const MAX_MEMORY_HISTORY = 4;
const MEMORY_CACHE_TTL_MS = 10 * 60 * 1000;
const CHAT_HISTORY_TTL_SECONDS = 600;
const DEFAULT_WECHAT_OPENAI_MAX_TOKENS = 220;
const DEFAULT_WECHAT_REPLY_TIMEOUT_MS = 4500;
const WECHAT_DEBUG_STATE_KEY = '__wechat_sync_debug_state__';

const processedMessages = new Map();
const memoryHistory = new Map();

const defaultWechatInstruction = '当前输出渠道是微信公众号文本消息。请优先直接回答结论，表达尽量简短，避免冗长开场白。只返回适合微信文本消息的纯文本内容。不要使用 Markdown、代码块、标题、表格、HTML、XML、LaTeX、无序列表、有序列表、加粗、斜体、链接标记，也不要输出反引号。不要用 JSON、YAML、伪代码格式组织内容。需要分点时请直接使用中文序号或短句。默认把回复控制在 3 到 5 句、150 字以内。除非用户明确要求，否则不要贴长链接、代码示例或大段引用。';

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
    globalThis[WECHAT_DEBUG_STATE_KEY] = { lastAsyncStatus: null };
  }

  return globalThis[WECHAT_DEBUG_STATE_KEY];
}

function updateWechatAsyncDebugStatus(status) {
  const store = getWechatDebugStateStore();
  store.lastAsyncStatus = {
    ...status,
    timestamp: new Date().toISOString(),
  };
}

function getWechatReplyTimeoutMs(env) {
  const rawValue = Number(readEnv(env, 'WECHAT_REPLY_TIMEOUT_MS') || DEFAULT_WECHAT_REPLY_TIMEOUT_MS);
  if (!Number.isFinite(rawValue)) {
    return DEFAULT_WECHAT_REPLY_TIMEOUT_MS;
  }

  return Math.min(Math.max(Math.floor(rawValue), 1000), 4800);
}

function cleanupProcessedMessages(now) {
  for (const [id, value] of processedMessages.entries()) {
    if (now - value.time > MESSAGE_CACHE_TTL_MS) {
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
</xml>`;
}

function truncateWechatText(text) {
  if (typeof text !== 'string' || !text) {
    return '';
  }

  if (text.length <= MAX_WECHAT_TEXT_LENGTH) {
    return text;
  }

  return text.slice(0, MAX_WECHAT_TEXT_LENGTH - 3) + '...';
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

function getWechatModelPreference(env) {
  return readEnv(env, 'WECHAT_GPT_MODEL') || readEnv(env, 'GPT_MODEL') || 'openai';
}

function getOpenAIConfig(env, channel = 'default') {
  if (channel === 'wechat') {
    return {
      apiKey: readEnv(env, 'WECHAT_OPENAI_API_KEY') || readEnv(env, 'OPENAI_API_KEY'),
      baseURL: readEnv(env, 'WECHAT_OPENAI_API_BASE_URL') || readEnv(env, 'OPENAI_API_BASE_URL') || 'https://api.openai.com/v1',
      model: readEnv(env, 'WECHAT_OPENAI_MODEL') || readEnv(env, 'OPENAI_MODEL') || 'gpt-3.5-turbo',
    };
  }

  return {
    apiKey: readEnv(env, 'OPENAI_API_KEY'),
    baseURL: readEnv(env, 'OPENAI_API_BASE_URL') || 'https://api.openai.com/v1',
    model: readEnv(env, 'OPENAI_MODEL') || 'gpt-3.5-turbo',
  };
}

function getGeminiConfig(env, channel = 'default') {
  if (channel === 'wechat') {
    return {
      apiKey: readEnv(env, 'WECHAT_GEMINI_API_KEY') || readEnv(env, 'GEMINI_API_KEY'),
      model: readEnv(env, 'WECHAT_GEMINI_MODEL_NAME') || readEnv(env, 'GEMINI_MODEL_NAME') || 'gemini-2.0-flash-lite',
    };
  }

  return {
    apiKey: readEnv(env, 'GEMINI_API_KEY'),
    model: readEnv(env, 'GEMINI_MODEL_NAME') || 'gemini-2.0-flash-lite',
  };
}

function buildSystemInstruction(env, channel = 'default') {
  const baseInstruction = readEnv(env, 'GPT_PRE_PROMPT') || '你是一个小助手，用相同的语言回答问题。';
  if (channel !== 'wechat') {
    return baseInstruction;
  }

  return `${baseInstruction}\n\n${readEnv(env, 'WECHAT_PRE_PROMPT') || defaultWechatInstruction}`;
}

function normalizeHistoryMessages(data) {
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter((msg) => msg && typeof msg.role === 'string' && typeof msg.content === 'string')
    .map((msg) => ({ role: msg.role, content: msg.content }));
}

async function getHistoryFromKV(kv, userId) {
  if (!kv) {
    return [];
  }

  try {
    const data = await kv.get(userId, { type: 'json' });
    return normalizeHistoryMessages(data);
  } catch (error) {
    console.error('KV 读取失败', { userId, error: error?.message || String(error) });
    return [];
  }
}

async function saveHistoryToKV(kv, userId, messages) {
  if (!kv) {
    return;
  }

  try {
    await kv.put(userId, JSON.stringify(messages), {
      expirationTtl: CHAT_HISTORY_TTL_SECONDS,
    });
  } catch (error) {
    console.error('KV 写入失败', { userId, error: error?.message || String(error) });
  }
}

async function getHistoryFromD1(db, userId) {
  if (!db) {
    return [];
  }

  try {
    const result = await db.prepare(`
      SELECT messages_json
      FROM ai_chat_history
      WHERE user_id = ?
        AND expires_at > ?
      LIMIT 1
    `).bind(userId, Date.now()).first();

    if (!result?.messages_json || typeof result.messages_json !== 'string') {
      return [];
    }

    return normalizeHistoryMessages(JSON.parse(result.messages_json));
  } catch (error) {
    console.error('D1 读取失败', { userId, error: error?.message || String(error) });
    return [];
  }
}

async function saveHistoryToD1(db, userId, messages) {
  if (!db) {
    return;
  }

  try {
    const now = Date.now();
    const expiresAt = now + CHAT_HISTORY_TTL_SECONDS * 1000;
    await db.prepare(`
      INSERT INTO ai_chat_history (user_id, messages_json, updated_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        messages_json = excluded.messages_json,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).bind(userId, JSON.stringify(messages), now, expiresAt).run();
  } catch (error) {
    console.error('D1 写入失败', { userId, error: error?.message || String(error) });
  }
}

function getHistoryStorage(env, channel = 'default') {
  if (env?.CHAT_HISTORY_DB) {
    return { type: 'd1', binding: env.CHAT_HISTORY_DB };
  }

  if (channel !== 'wechat' || readEnv(env, 'WECHAT_USE_KV_HISTORY') === 'true') {
    if (env?.CHAT_HISTORY) {
      return { type: 'kv', binding: env.CHAT_HISTORY };
    }
  }

  return { type: 'memory', binding: null };
}

async function loadHistory(storage, userId) {
  if (!storage?.binding) {
    return [];
  }

  if (storage.type === 'd1') {
    return getHistoryFromD1(storage.binding, userId);
  }

  if (storage.type === 'kv') {
    return getHistoryFromKV(storage.binding, userId);
  }

  return [];
}

async function persistHistory(storage, userId, messages) {
  if (!storage?.binding) {
    return;
  }

  if (storage.type === 'd1') {
    await saveHistoryToD1(storage.binding, userId, messages);
    return;
  }

  if (storage.type === 'kv') {
    await saveHistoryToKV(storage.binding, userId, messages);
  }
}

function trimHistoryForChannel(history, channel = 'default') {
  if (!Array.isArray(history)) {
    return [];
  }

  if (channel === 'wechat') {
    return history.slice(-4);
  }

  return history;
}

async function callOpenAI(env, messages, channel = 'default') {
  const { apiKey, baseURL, model } = getOpenAIConfig(env, channel);
  if (!apiKey) {
    throw new Error('缺少 OPENAI_API_KEY');
  }

  const maxTokens = channel === 'wechat'
    ? Number(readEnv(env, 'WECHAT_OPENAI_MAX_TOKENS') || DEFAULT_WECHAT_OPENAI_MAX_TOKENS)
    : undefined;

  const body = { model, messages };
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    body.max_tokens = Math.floor(maxTokens);
  }

  const requestStartTime = Date.now();
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI请求失败(${response.status}): ${errorText}`);
  }

  const data = await response.json();
  console.log('OpenAI upstream request completed', {
    model,
    channel,
    durationMs: Date.now() - requestStartTime,
  });
  return data?.choices?.[0]?.message?.content || '';
}

async function callGemini(env, prompt, history, channel = 'default') {
  const { apiKey, model } = getGeminiConfig(env, channel);
  if (!apiKey) {
    throw new Error('缺少 GEMINI_API_KEY');
  }

  const contextString = [
    buildSystemInstruction(env, channel),
    ...history.map((msg) => msg.content),
    prompt,
  ].join('\n\n');

  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({ model }, { apiVersion: 'v1' });
  const requestStartTime = Date.now();
  const result = await geminiModel.generateContent(contextString);
  const response = await result.response;
  console.log('Gemini upstream request completed', {
    model,
    channel,
    durationMs: Date.now() - requestStartTime,
  });
  return response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function generateAIReply(env, userMessage, userId, channel = 'wechat') {
  const storage = getHistoryStorage(env, channel);
  let history = [];

  const cached = memoryHistory.get(userId);
  if (cached && Date.now() - cached.time < MEMORY_CACHE_TTL_MS) {
    history = cached.messages;
  } else if (storage.binding) {
    history = await loadHistory(storage, userId);
    memoryHistory.set(userId, { messages: history, time: Date.now() });
  }

  const trimmedHistory = trimHistoryForChannel(history, channel);
  const modelPreference = getWechatModelPreference(env).toLowerCase();
  let rawReply = '';

  if (modelPreference === 'gemini') {
    rawReply = await callGemini(env, userMessage, trimmedHistory, channel);
  } else {
    const messages = [
      { role: 'system', content: buildSystemInstruction(env, channel) },
      ...trimmedHistory,
      { role: 'user', content: userMessage },
    ];
    rawReply = await callOpenAI(env, messages, channel);
  }

  const normalizedReply = truncateWechatText(stripMarkdownForWechat(rawReply));
  const finalReply = normalizedReply || truncateWechatText(typeof rawReply === 'string' ? rawReply.trim() : '') || '抱歉，这次没有生成有效回复，请换个说法再试一次。';

  const newHistory = [
    ...history,
    { role: 'user', content: userMessage },
    { role: 'assistant', content: finalReply },
  ].slice(-MAX_MEMORY_HISTORY * 2);

  memoryHistory.set(userId, { messages: newHistory, time: Date.now() });
  await persistHistory(storage, userId, newHistory);
  return finalReply;
}

async function withWechatTimeout(promise, timeoutMs) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('WECHAT_REPLY_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function verifySignature(env, signature, timestamp, nonce) {
  const token = readEnv(env, 'WECHAT_TOKEN');
  const sorted = [token, timestamp, nonce].sort().join('');
  const encoder = new TextEncoder();
  const data = encoder.encode(sorted);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const shasum = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return shasum === signature;
}

function buildTestResponse(env) {
  return {
    status: 'ok',
    message: 'Wechat worker is running',
    timestamp: new Date().toISOString(),
    wechatAsyncDebugState: globalThis[WECHAT_DEBUG_STATE_KEY]?.lastAsyncStatus || null,
    env: {
      hasWechatToken: Boolean(readEnv(env, 'WECHAT_TOKEN')),
      hasWechatAppId: Boolean(readEnv(env, 'WECHAT_APPID')),
      hasWechatSecret: Boolean(readEnv(env, 'WECHAT_SECRET')),
      hasChatHistoryDb: Boolean(env?.CHAT_HISTORY_DB),
      hasChatHistoryKv: Boolean(env?.CHAT_HISTORY),
      hasOpenAIKey: Boolean(readEnv(env, 'OPENAI_API_KEY')),
      hasGeminiKey: Boolean(readEnv(env, 'GEMINI_API_KEY')),
      gptModel: getWechatModelPreference(env),
      openaiModel: getOpenAIConfig(env, 'wechat').model,
      geminiModel: getGeminiConfig(env, 'wechat').model,
    },
  };
}

function parseMessage(xml) {
  const parser = new XMLParser();
  const result = parser.parse(xml);
  return result?.xml || null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/api/test' || pathname === '/test') {
      return new Response(JSON.stringify(buildTestResponse(env)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (pathname !== '/' && pathname !== '/api/wechat') {
      return new Response('Not Found', { status: 404 });
    }

    if (request.method === 'GET') {
      const signature = url.searchParams.get('signature');
      const timestamp = url.searchParams.get('timestamp');
      const nonce = url.searchParams.get('nonce');
      const echostr = url.searchParams.get('echostr');

      if (!signature && !timestamp && !nonce && !echostr) {
        return new Response(JSON.stringify(buildTestResponse(env)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (!signature || !timestamp || !nonce || !echostr) {
        return new Response('Invalid parameters', { status: 400 });
      }

      const isValid = await verifySignature(env, signature, timestamp, nonce);
      if (!isValid) {
        return new Response('Invalid signature', { status: 401 });
      }

      return new Response(echostr, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const xml = await request.text();

    try {
      const message = parseMessage(xml);
      if (!message) {
        return new Response('Bad Request', { status: 400 });
      }

      const msgType = message.MsgType;
      const fromUser = message.FromUserName;
      const toUser = message.ToUserName;
      const msgId = typeof message.MsgId === 'string' ? message.MsgId : '';
      const createTime = Date.now();

      cleanupProcessedMessages(createTime);

      if (msgId) {
        const cached = processedMessages.get(msgId);
        if (cached?.response) {
          return cached.response.clone();
        }
      }

      if (msgType === 'event') {
        const eventType = message.Event;
        if (eventType === 'subscribe') {
          const welcomeMessage = readEnv(env, 'WELCOME_MESSAGE') || '感谢您的关注！我是您的AI助手，可以为您解答任何问题。';
          const responseXml = buildWechatTextResponse(fromUser, toUser, createTime, truncateWechatText(welcomeMessage));
          const response = new Response(responseXml, {
            status: 200,
            headers: { 'Content-Type': 'text/xml' },
          });
          if (msgId) {
            processedMessages.set(msgId, { time: createTime, response: response.clone() });
          }
          return response;
        }

        return new Response('success', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      if (msgType !== 'text') {
        return new Response('success', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      const userMessage = typeof message.Content === 'string' ? message.Content.trim().slice(0, 4000) : '';
      if (!userMessage) {
        return new Response('success', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      let replyText;

      try {
        updateWechatAsyncDebugStatus({
          stage: 'sync_started',
          success: true,
          fromUser,
          msgId: msgId || null,
        });

        replyText = await withWechatTimeout(
          generateAIReply(env, userMessage, fromUser, 'wechat'),
          getWechatReplyTimeoutMs(env)
        );

        updateWechatAsyncDebugStatus({
          stage: 'sync_completed',
          success: true,
          fromUser,
          msgId: msgId || null,
        });
      } catch (error) {
        const errorMessage = error?.message || String(error);
        updateWechatAsyncDebugStatus({
          stage: 'sync_failed',
          success: false,
          fromUser,
          msgId: msgId || null,
          error: errorMessage,
        });
        console.error('Wechat sync reply failed', {
          fromUser,
          msgId: msgId || null,
          error: errorMessage,
        });

        replyText = errorMessage === 'WECHAT_REPLY_TIMEOUT'
          ? '当前消息较多，处理超时。请稍后重试，或把问题描述得更短一些。'
          : `抱歉，服务暂时不可用: ${errorMessage}`;
      }

      const responseXml = buildWechatTextResponse(
        fromUser,
        toUser,
        createTime,
        truncateWechatText(stripMarkdownForWechat(replyText))
      );
      const response = new Response(responseXml, {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });

      if (msgId) {
        processedMessages.set(msgId, { time: createTime, response: response.clone() });
      }

      return response;
    } catch (error) {
      console.error('Error processing wechat request', {
        error: error?.message || String(error),
      });
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};
