/*
[FILE_ID]
ROUTE: NONE
MODULE: 微信队列消费者
DESCRIPTION: 供Cloudflare后台导入仓库时使用的独立队列消费者入口
KEYWORDS: 微信队列消费者,wechatQueueConsumer,消费
*/

import worker from '../wechat-queue-consumer.mjs';

export default worker;
