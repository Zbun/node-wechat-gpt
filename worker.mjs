/*
[FILE_ID]
ROUTE: NONE
MODULE: Cloudflare Worker入口
DESCRIPTION: 扩展OpenNext生成的Worker并挂载微信公众号队列消费者
KEYWORDS: Worker入口,workerEntry,处理
*/

import openNextWorker, {
  DOQueueHandler,
  DOShardedTagCache,
  BucketCachePurge,
} from './.open-next/worker.js';
import { processWechatReplyQueue } from './src/lib/wechat-async.js';

export { DOQueueHandler, DOShardedTagCache, BucketCachePurge };

export default {
  async fetch(request, env, ctx) {
    return openNextWorker.fetch(request, env, ctx);
  },

  async queue(batch, env, ctx) {
    await processWechatReplyQueue(batch, env, ctx);
  },
};
