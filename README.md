# Node WeChat GPT

基于 Next.js 构建的微信公众号 AI 聊天机器人，支持 OpenAI 和 Google Gemini 模型。部署到 Cloudflare Workers。

## 功能特点

- 🤖 支持 OpenAI 和 Google Gemini AI 模型
- 💬 内存 + D1/KV 混合缓存，保留最近4轮对话上下文
- 🔄 智能切换，可配置默认模型
- 🎯 自定义 AI 角色设定
- 👋 新用户关注自动回复
- ⚡ 满足微信5秒响应限制

## 部署到 Cloudflare Workers

### 前置准备

1. [Cloudflare 账户](https://dash.cloudflare.com/)
2. GitHub 账户（用于连接仓库）
3. OpenAI API Key 或 Google Gemini API Key
4. 微信公众号（需要配置服务器）

### 步骤一：Fork 仓库

1. 登录 GitHub
2. Fork 本仓库到你的账户

### 步骤二：创建 D1 数据库（可选，推荐）

> **说明**：D1 / KV 都可用于在不同实例间同步对话历史。不配置时仅使用内存缓存。
>
> **当前代码优先级**：优先使用 D1 绑定 `CHAT_HISTORY_DB`；未绑定 D1 时，回退到 KV 绑定 `CHAT_HISTORY`。

1. 进入 **Workers & Pages** > **D1 SQL Database**
2. 点击 **Create**
3. 输入名称：`wechat-gpt-history`
4. 创建后执行下面这段 SQL：

```sql
CREATE TABLE IF NOT EXISTS ai_chat_history (
  user_id TEXT PRIMARY KEY,
  messages_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_history_expires_at
ON ai_chat_history (expires_at);
```

### 步骤三：创建 Workers 项目

1. 进入 **Workers & Pages**
2. 点击 **Create** > **Import a repository**
3. 授权并选择你 Fork 的仓库
4. 配置构建设置：
   - **Build command**: `npx opennextjs-cloudflare build`
   - **Deploy command**: `npx wrangler deploy`
   - **Root directory**: 留空

### 步骤四：配置环境变量

**构建变量（Build settings > Environment variables）：**

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `NODE_VERSION` | Node.js 版本，设置为 `20` | 推荐 |

**运行时变量（Settings > Variables and Secrets）：**

先看最少配置。大多数情况下，你只需要配下面这些：

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `WECHAT_TOKEN` | 微信公众号令牌 | ✅ |
| `GPT_MODEL` | 使用哪个模型通道，填 `openai` 或 `gemini` | ✅ |
| `OPENAI_API_KEY` | OpenAI / OpenRouter 密钥 | 使用 `openai` 时必填 |
| `GEMINI_API_KEY` | Gemini 密钥 | 使用 `gemini` 时必填 |

如果你只是想先跑起来，建议按下面二选一：

1. 用 OpenAI / OpenRouter：`WECHAT_TOKEN`、`GPT_MODEL=openai`、`OPENAI_API_KEY`
2. 用 Gemini：`WECHAT_TOKEN`、`GPT_MODEL=gemini`、`GEMINI_API_KEY`

下面这些都不是必须的，先不配也能用：

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `OPENAI_MODEL` | OpenAI 模型名称 | 可选，默认 `gpt-3.5-turbo` |
| `OPENAI_API_BASE_URL` | 自定义 API 地址（如 OpenRouter） | 可选 |
| `GEMINI_MODEL_NAME` | Gemini 模型名称 | 可选，默认 `gemini-2.0-flash-lite` |
| `GPT_PRE_PROMPT` | AI 角色设定 | 可选 |
| `WECHAT_PRE_PROMPT` | 微信渠道专用提示词 | 可选，默认更偏纯文本、短回复、禁 Markdown |
| `WECHAT_REPLY_TIMEOUT_MS` | 微信被动回复超时阈值 | 可选，默认 `4500` 毫秒 |
| `WECHAT_OPENAI_MAX_TOKENS` | 微信渠道 OpenAI 最大输出 token | 可选，默认 `220` |
| `WECHAT_USE_KV_HISTORY` | 微信渠道是否启用 KV 历史读取 | 可选，默认 `false`，仅在未绑定 D1 时生效 |
| `WELCOME_MESSAGE` | 新用户关注欢迎语 | 可选 |

建议先不要动这些进阶参数：

1. `WECHAT_REPLY_TIMEOUT_MS`
2. `WECHAT_OPENAI_MAX_TOKENS`
3. `WECHAT_USE_KV_HISTORY`
4. `GPT_PRE_PROMPT`
5. `WECHAT_PRE_PROMPT`

先确认公众号能稳定回复，再按需要慢慢加。

### 步骤五：绑定 D1 或 KV（可选）

当前项目支持以下历史存储绑定：

| 绑定变量名 | 数量 | 用途 |
|------------|------|------|
| `CHAT_HISTORY_DB` | 1 个 | D1 数据库，优先用于存储每个用户的对话历史 |
| `CHAT_HISTORY` | 1 个 | KV 命名空间，作为 D1 未绑定时的回退方案 |

默认仓库 **不会** 在 [wrangler.toml](wrangler.toml) 里写死 D1 / KV 的真实 ID，避免直接部署时因为占位符或环境差异失败。

首次部署建议这样做：

1. 先直接部署，不配置 D1 / KV 也可以运行
2. 部署成功后，到 Cloudflare Dashboard 里添加 D1 绑定
3. 绑定变量名使用 `CHAT_HISTORY_DB`
4. 如暂时不用 D1，也可以继续添加 KV 绑定 `CHAT_HISTORY`
5. 重新部署一次让绑定生效

如果你明确要用 `wrangler.toml` 管理绑定，再手动填写真实 ID：

```toml
[[d1_databases]]
binding = "CHAT_HISTORY_DB"
database_name = "wechat-gpt-history"
database_id = "你的 D1 database_id"
```

1. 部署完成后，进入项目 **Settings** > **Bindings**
2. 添加 D1 binding：
   - **Variable name**: `CHAT_HISTORY_DB`
   - **D1 database**: 选择 `wechat-gpt-history`
3. 如需 KV 回退，再添加 KV binding：
   - **Variable name**: `CHAT_HISTORY`
   - **KV namespace**: 选择 `wechat-gpt-history`
4. 点击 **Save**
5. 进入 **Deployments** 点击 **Retry deployment** 使绑定生效

如果你只想用 KV，不用 D1，也可以仅绑定 `CHAT_HISTORY`。

### 对话历史存储优先级

1. 已绑定 `CHAT_HISTORY_DB`：优先走 D1
2. 未绑定 D1 且存在 `CHAT_HISTORY`：回退到 KV
3. 都未绑定：仅使用当前实例内存

### 微信公众号异步补发配置

如果你启用了“同步抢答，超时后异步客服消息补发”，还需要：

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `WECHAT_APPID` | 微信公众号 AppID | 异步补发时必填 |
| `WECHAT_SECRET` | 微信公众号 App Secret | 异步补发时必填 |
| `WECHAT_SYNC_REPLY_TIMEOUT_MS` | 同步抢答窗口毫秒数 | 可选，默认 `3500` |
| `WECHAT_ASYNC_ACK_MESSAGE` | 转异步时的确认文案 | 可选 |

异步补发依赖微信客服消息接口，因此必须配置 `WECHAT_APPID` 和 `WECHAT_SECRET`。

如果你当前部署的是 **Cloudflare Pages 项目**，要特别注意：

- Pages 这边只能作为 **Queue producer**
- Queue consumer 必须是一个 **独立的 Worker**
- 仓库里已提供独立消费者入口 [wechat-queue-consumer.mjs](wechat-queue-consumer.mjs) 和配置 [wrangler.queue-consumer.toml](wrangler.queue-consumer.toml)

推荐部署方式：

1. 保持当前 Pages 项目继续提供网站和 `/api/wechat`
2. 在 Cloudflare 另建一个 Worker：`node-wechat-gpt-queue-consumer`
3. 使用 `wrangler.queue-consumer.toml` 部署它
4. 给 Pages 项目绑定 Queue producer：`WECHAT_REPLY_QUEUE`
5. 给独立 Worker 绑定同一个 Queue consumer：`wechat-reply-queue`
6. 把 `WECHAT_APPID`、`WECHAT_SECRET`、模型相关变量也配置到这个独立 Worker 上

### 注意

- D1 只负责历史上下文，不负责异步回复路由
- 同一个用户的并发消息在多实例下仍可能存在回复顺序竞争，D1 不能自动解决这个问题
- 如需严格串行，后续应再引入队列或显式加锁
- D1 表中的过期记录当前按 `expires_at` 懒清理，读取时会自动忽略

### 步骤六：配置微信公众号

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)
2. 进入 **设置与开发** > **基本配置**
3. 配置服务器：
   - **URL**: `https://你的项目名.workers.dev/api/wechat`
   - **Token**: 与环境变量 `WECHAT_TOKEN` 一致
   - **消息加解密方式**: 明文模式
4. 启用服务器配置

## 飞书机器人配置（可选）

1. 登录 [飞书开发者平台](https://open.feishu.cn/app)
2. 创建自建应用，启用"机器人"功能
3. 在"事件订阅"中添加请求地址：`https://你的项目名.workers.dev/api/feishu`
4. 订阅事件：`im:message.receive_v1`
5. 配置环境变量：
   - `FEISHU_APP_ID`: App ID
   - `FEISHU_APP_SECRET`: App Secret
   - `FEISHU_VERIFICATION_TOKEN`: Verification Token
   - `FEISHU_ENCRYPT_KEY`: Encrypt Key（可选）

## 故障排除

**微信无法收到回复**
- 检查服务器配置 URL 是否正确
- 确认 `WECHAT_TOKEN` 设置正确
- 查看 Cloudflare Dashboard > Workers & Pages > 项目 > Logs

**AI 响应过慢**
- 考虑使用更快的模型（如 `gemini-2.0-flash-lite`）

**部署失败**
- 如使用 Cloudflare 默认 Node 环境，项目已兼容 Node 20
- 如果你手动设置了 `NODE_VERSION`，建议使用 `20`
- 不要在 [wrangler.toml](wrangler.toml) 中保留占位的 KV ID，例如 `your-kv-namespace-id`
- 查看构建日志排查具体错误

## 技术说明

### 对话历史存储

使用内存 + D1/KV 混合缓存：
- **内存优先**：同一实例内快速读取，不阻塞响应
- **D1 优先**：绑定 `CHAT_HISTORY_DB` 时，优先从 D1 读写
- **KV 回退**：未绑定 D1 时，才会使用 `CHAT_HISTORY`
- **异步写入**：有持久化绑定时，回复完成后异步写回
- **KV Key 规则**：OpenAI 使用 `userId`，Gemini 使用 `userId_gemini`
- 每个 Key 保留最近4轮对话（共 8 条消息），10分钟后自动清除

### 微信渠道输出约束

- 微信渠道默认会额外要求模型输出纯文本，避免 Markdown、代码块、表格、HTML、LaTeX 等不适合公众号文本消息的格式
- 微信出口会再做一次文本清洗，兜底移除残留的 Markdown / HTML / LaTeX 标记
- 如需自定义微信回复风格，可设置 `WECHAT_PRE_PROMPT`
- 微信被动回复默认会在 4.5 秒内超时降级，避免超过公众号 5 秒限制导致整条消息无回复
- 微信渠道默认只带最近 2 轮上下文，并限制 OpenAI 输出 token，优先保证在公众号超时前回包
- 微信渠道和其他渠道共用同一套模型配置，使用 `GPT_MODEL` 决定走 `openai` 还是 `gemini`
- 微信渠道默认不读取 KV 历史，优先保证时延；如确实需要跨实例上下文，再显式设置 `WECHAT_USE_KV_HISTORY=true`

### 文件结构

```
src/app/
├── api/
│   ├── wechat/route.js    # 微信公众号 API
│   ├── gpt/route.js       # AI 模型调用
│   └── feishu/route.js    # 飞书机器人 API
├── page.js
└── layout.js
wrangler.toml              # Cloudflare 配置
```

## 许可

[MIT](LICENSE)
