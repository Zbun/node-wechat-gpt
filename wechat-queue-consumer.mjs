/*
[FILE_ID]
ROUTE: NONE
MODULE: 微信队列消费者
DESCRIPTION: 独立消费微信公众号回复队列并发送客服消息
KEYWORDS: 微信队列消费者,wechatQueueConsumer,消费
*/

import { processWechatReplyQueue } from './src/lib/wechat-async.js';

export default {
  async queue(batch, env, ctx) {
    await processWechatReplyQueue(batch, env, ctx);
  },
};
