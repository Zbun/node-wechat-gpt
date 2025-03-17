// src/pages/api/wechat.js
import {
  getOpenAIChatCompletion,
  getAzureOpenAIChatCompletion,
  getGeminiChatCompletion,
} from '../../../src/pages/api/gpt'; // 调整导入路径
import { parseString } from 'xml2js';
import crypto from 'crypto';

// 微信公众号配置 (从环境变量中获取)
const wechatToken = process.env.WECHAT_TOKEN;
const gptModelPreference = process.env.GPT_MODEL || 'openai'; // 默认使用 openai，你可以根据需要修改

// 验证微信公众号请求签名
function verifySignature(signature, timestamp, nonce) {
  const token = wechatToken;
  const sorted = [token, timestamp, nonce].sort().join('');
  const shasum = crypto.createHash('sha1').update(sorted).digest('hex');
  return shasum === signature;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { signature, timestamp, nonce, echostr } = req.query;

    if (!signature || !timestamp || !nonce || !echostr) {
      return res.status(400).send('Invalid parameters');
    }

    if (verifySignature(signature, timestamp, nonce)) {
      res.status(200).send(echostr);
    } else {
      res.status(401).send('Invalid signature');
    }
  } else if (req.method === 'POST') {
    let xml = '';
    req.on('data', (chunk) => {
      xml += chunk;
    });
    req.on('end', async () => {
      parseString(xml, { explicitArray: false }, async (err, result) => {
        if (err) {
          console.error('Error parsing XML:', err);
          return res.status(500).send('Error parsing XML');
        }

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
                case 'azure':
                  gptResponse = await getAzureOpenAIChatCompletion(userMessage);
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
            res.setHeader('Content-Type', 'text/xml');
            res.status(200).send(responseXml);
            break;
          }
          case 'event': {
            const eventType = message.Event;
            if (eventType === 'subscribe') {
              const responseXml = `
                              <xml>
                                  <ToUserName><![CDATA[${fromUser}]]></ToUserName>
                                  <FromUserName><![CDATA[${toUser}]]></FromUserName>
                                  <CreateTime>${createTime}</CreateTime>
                                  <MsgType><![CDATA[text]]></MsgType>
                                  <Content><![CDATA[感谢您的关注！有什么我可以帮您解答的吗？]]></Content>
                              </xml>
                          `;
              res.setHeader('Content-Type', 'text/xml');
              res.status(200).send(responseXml);
            } else if (eventType === 'unsubscribe') {
              res.status(200).send('');
            } else {
              console.log('Unhandled event type:', eventType);
              res.status(200).send('');
            }
            break;
          }
          default: {
            console.log('Unhandled message type:', msgType);
            res.status(200).send('');
          }
        }
      });
    });
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}