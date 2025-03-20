// src/app/api/wechat/route.js
import {
  getOpenAIChatCompletion,
  getGeminiChatCompletion,
} from '../../../../src/app/api/gpt/route'; // 调整导入路径
import { parseString } from 'xml2js';
import crypto from 'crypto';
import { NextResponse } from 'next/server';

// 微信公众号配置 (从环境变量中获取)
const wechatToken = process.env.WECHAT_TOKEN;
const gptModelPreference = process.env.GPT_MODEL || 'openai';

// 验证微信公众号请求签名
function verifySignature(signature, timestamp, nonce) {
  const token = wechatToken;
  const sorted = [token, timestamp, nonce].sort().join('');
  const shasum = crypto.createHash('sha1').update(sorted).digest('hex');
  return shasum === signature;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const signature = searchParams.get('signature');
  const timestamp = searchParams.get('timestamp');
  const nonce = searchParams.get('nonce');
  const echostr = searchParams.get('echostr');

  if (!signature || !timestamp || !nonce || !echostr) {
    return new NextResponse('Invalid parameters', { status: 400 });
  }

  if (verifySignature(signature, timestamp, nonce)) {
    return new NextResponse(echostr, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  } else {
    return new NextResponse('Invalid signature', { status: 401 });
  }
}

export async function POST(request) {
  const xml = await request.text();

  try {
    const result = await new Promise((resolve, reject) => {
      parseString(xml, { explicitArray: false }, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    });

    const message = result.xml;
    const msgType = message.MsgType;
    const fromUser = message.FromUserName;
    const toUser = message.ToUserName;
    const createTime = Date.now();

    switch (msgType) {
      case 'text': {
        const userMessage = message.Content;
        let gptResponse;
        try {
          switch (gptModelPreference.toLowerCase()) {
            case 'openai':
              gptResponse = await getOpenAIChatCompletion(userMessage);
              break;
            case 'gemini':
              gptResponse = await getGeminiChatCompletion(userMessage);
              break;
            default:
              console.warn(`Unknown GPT model preference: ${gptModelPreference}, using OpenAI as default.`);
              gptResponse = await getOpenAIChatCompletion(userMessage);
              break;
          }
        } catch (error) {
          console.error(`Error calling ${gptModelPreference} API:`, error);
          gptResponse = `抱歉，${gptModelPreference.toUpperCase()} 服务暂时不可用。`;
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
        return new NextResponse(responseXml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
      }
      case 'event': {
        const eventType = message.Event;
        if (eventType === 'subscribe') {
          const welcomeMessage = process.env.WELCOME_MESSAGE || "感谢您的关注！我是您的 AI 助手，可以为您解答任何问题。";
          const responseXml = `
                      <xml>
                          <ToUserName><![CDATA[${fromUser}]]></ToUserName>
                          <FromUserName><![CDATA[${toUser}]]></FromUserName>
                          <CreateTime>${createTime}</CreateTime>
                          <MsgType><![CDATA[text]]></MsgType>
                          <Content><![CDATA[${welcomeMessage}]]></Content>
                      </xml>
                  `;
          return new NextResponse(responseXml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
        } else if (eventType === 'unsubscribe') {
          return new NextResponse(null, { status: 200 });
        } else {
          console.log('Unhandled event type:', eventType);
          return new NextResponse(null, { status: 200 });
        }
      }
      default: {
        console.log('Unhandled message type:', msgType);
        return new NextResponse(null, { status: 200 });
      }
    }
  } catch (error) {
    console.error('Error processing request:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}