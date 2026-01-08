# Node WeChat GPT

基于 Next.js 构建的微信公众号 AI 聊天机器人，支持 OpenAI 和 Google Gemini 模型。部署到 Cloudflare Pages。

## 功能特点

- 🤖 支持 OpenAI 和 Google Gemini AI 模型
- 💬 可选 D1 持久化存储，支持对话上下文（无配置时只发送当前消息）
- 🔄 智能切换，可配置默认模型
- 🎯 自定义 AI 角色设定
- 👋 新用户关注自动回复
- ⚡ 异步保存优化，满足微信5秒响应限制

## 部署到 Cloudflare Pages

### 前置准备

1. [Cloudflare 账户](https://dash.cloudflare.com/)
2. GitHub 账户（用于连接仓库）
3. OpenAI API Key 或 Google Gemini API Key
4. 微信公众号（需要配置服务器）

### 步骤一：Fork 仓库

1. 登录 GitHub
2. Fork 本仓库到你的账户

### 步骤二：创建 D1 数据库

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages** > **D1 SQL Database**
3. 点击 **Create database**
4. 输入数据库名称：`wechat-gpt-db`
5. 点击 **Create**

> **注意**：数据库表会在首次使用时自动创建，无需手动执行 SQL。

### 步骤三：创建 Workers 项目

1. 进入 **Workers & Pages**
2. 点击 **Create** > **Import a repository**
3. 授权并选择你 Fork 的仓库
4. 配置构建设置：
   - **Build command**: `npm run deploy`
   - **Deploy command**: 留空（deploy 命令已包含部署步骤）
   - **Root directory**: 留空

### 步骤四：配置环境变量

在 **Environment variables** 中添加以下变量：

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `NODE_VERSION` | Node.js 版本，设置为 `20` | ✅ |
| `WECHAT_TOKEN` | 微信公众号令牌 | ✅ |
| `OPENAI_API_KEY` | OpenAI API 密钥 | 使用 OpenAI 时必填 |
| `OPENAI_MODEL` | OpenAI 模型名称 | 可选，默认 `gpt-3.5-turbo` |
| `OPENAI_API_BASE_URL` | 自定义 API 地址 | 可选 |
| `GEMINI_API_KEY` | Google Gemini API 密钥 | 使用 Gemini 时必填 |
| `GEMINI_MODEL_NAME` | Gemini 模型名称 | 可选，默认 `gemini-2.0-flash-lite` |
| `GPT_MODEL` | 默认 AI 服务：`openai` 或 `gemini` | 可选，默认 `openai` |
| `GPT_PRE_PROMPT` | AI 角色设定 | 可选 |
| `MAX_HISTORY` | 发送给 AI 的历史轮数 | 可选，默认 `4` |
| `WELCOME_MESSAGE` | 新用户关注欢迎语 | 可选 |

### 步骤五：绑定 D1 数据库（可选）

> **注意**：D1 绑定是可选的。不配置时不保留历史记录，每次只发送当前消息。
>
> **限制**：由于 Cloudflare 的限制，D1 绑定需要在每次重新部署后手动重新配置。

1. 部署完成后，进入项目 **Settings** > **Functions** > **D1 database bindings**
2. 点击 **Add binding**：
   - **Variable name**: `DB`
   - **D1 database**: 选择 `wechat-gpt-db`
3. 点击 **Save**

### 步骤六：配置兼容性标志

1. 进入项目 **Settings** > **Functions** > **Compatibility flags**
2. 在 **Production** 和 **Preview** 中都添加：`nodejs_compat`
3. 设置 **Compatibility date** 为 `2024-12-01` 或更新日期
4. 点击 **Save**

### 步骤七：重新部署

1. 进入 **Deployments** 标签
2. 找到最新的部署，点击 **...** > **Retry deployment**
3. 等待部署完成

### 步骤八：配置微信公众号

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)
2. 进入 **设置与开发** > **基本配置**
3. 配置服务器：
   - **URL**: `https://你的项目.pages.dev/api/wechat`
   - **Token**: 与环境变量 `WECHAT_TOKEN` 一致
   - **消息加解密方式**: 明文模式
4. 启用服务器配置

## 飞书机器人配置（可选）

1. 登录 [飞书开发者平台](https://open.feishu.cn/app)
2. 创建自建应用，启用"机器人"功能
3. 在"事件订阅"中添加请求地址：`https://你的项目.pages.dev/api/feishu`
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
- 减少 `MAX_HISTORY` 值
- 考虑使用更快的模型（如 `gemini-2.0-flash-lite`）

**D1 数据库连接失败**
- 确认已完成步骤五的 D1 绑定
- 确认变量名为 `DB`
- 确认已执行数据库初始化 SQL

**部署失败**
- 确认 `NODE_VERSION` 环境变量设置为 `20`
- 确认 `nodejs_compat` 兼容性标志已添加
- 查看构建日志排查具体错误

## 技术说明

### 数据存储

使用 Cloudflare D1（SQLite）存储对话历史：
- 每用户保留最近1000条消息记录
- 发送给 AI 时使用最近4轮对话作为上下文
- 使用 `waitUntil` 异步保存，不阻塞微信响应

### 文件结构

```
src/app/
├── api/
│   ├── wechat/route.js    # 微信公众号 API
│   ├── gpt/route.js       # AI 模型调用 + D1 存储
│   └── feishu/route.js    # 飞书机器人 API
├── page.js
└── layout.js
schema.sql                  # D1 数据库表结构
wrangler.toml              # Cloudflare 配置
```

## 许可

[MIT](LICENSE)
