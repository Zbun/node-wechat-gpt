# Node WeChat GPT

基于 Next.js 构建的微信公众号 AI 聊天机器人，支持 OpenAI 和 Google Gemini 模型。部署到 Cloudflare Workers。

## 功能特点

- 🤖 支持 OpenAI 和 Google Gemini AI 模型
- 💬 内存缓存保留最近4轮对话上下文
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

### 步骤二：创建 Workers 项目

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages**
3. 点击 **Create** > **Import a repository**
4. 授权并选择你 Fork 的仓库
5. 配置构建设置：
   - **Build command**: `npx opennextjs-cloudflare build`
   - **Deploy command**: `npx wrangler deploy`
   - **Root directory**: 留空

### 步骤三：配置环境变量

**构建变量（Build settings > Environment variables）：**

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `NODE_VERSION` | Node.js 版本，设置为 `20` | ✅ |

**运行时变量（Settings > Variables and Secrets）：**

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `WECHAT_TOKEN` | 微信公众号令牌 | ✅ |
| `OPENAI_API_KEY` | OpenAI API 密钥 | 使用 OpenAI 时必填 |
| `OPENAI_MODEL` | OpenAI 模型名称 | 可选，默认 `gpt-3.5-turbo` |
| `OPENAI_API_BASE_URL` | 自定义 API 地址（如 OpenRouter） | 可选 |
| `GEMINI_API_KEY` | Google Gemini API 密钥 | 使用 Gemini 时必填 |
| `GEMINI_MODEL_NAME` | Gemini 模型名称 | 可选，默认 `gemini-2.0-flash-lite` |
| `GPT_MODEL` | 默认 AI 服务 | 默认 `openai`，可选 `gemini` |
| `GPT_PRE_PROMPT` | AI 角色设定 | 可选 |
| `WELCOME_MESSAGE` | 新用户关注欢迎语 | 可选 |

### 步骤四：配置微信公众号

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
- 确认 `NODE_VERSION` 环境变量设置为 `20`
- 查看构建日志排查具体错误

## 技术说明

### 对话历史

使用内存缓存保存对话历史：
- 每用户保留最近4轮对话
- 缓存10分钟后自动清除
- 不阻塞响应，满足微信5秒限制

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
