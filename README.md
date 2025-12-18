# Node WeChat GPT

基于 Next.js 构建的微信公众号 AI 聊天机器人，支持 OpenAI 和 Google Gemini 模型。可部署到 Cloudflare Pages 或 Vercel。

## 功能特点

- 🤖 支持 OpenAI 和 Google Gemini AI 模型
- 💬 保持对话上下文，支持连续对话
- 🔄 智能切换，可配置默认模型
- 🎯 自定义 AI 角色设定
- 👋 新用户关注自动回复
- 🧹 自动清理过期会话，优化内存使用
- ☁️ 支持 Cloudflare Pages Edge Runtime 部署
- 🚀 支持 Vercel 部署

## 安装

1. 克隆仓库：
```bash
git clone https://github.com/yourusername/node-wechat-gpt.git
cd node-wechat-gpt
```

2. 安装依赖：
```bash
npm install
```

3. 创建环境配置文件 `.env.local`：
```
# 微信公众号配置
WECHAT_TOKEN=your_wechat_token
WECHAT_APP_ID=your_app_id
WECHAT_APP_SECRET=your_app_secret

# OpenAI 配置
OPENAI_API_KEY=your_openai_api_key
OPENAI_API_BASE_URL=https://api.openai.com/v1  # 可选，自定义API地址（注意要包含 /v1）
OPENAI_MODEL=gpt-3.5-turbo  # 可选，指定OpenAI模型

# Gemini 配置
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL_NAME=gemini-2.0-flash-lite  # 可选，指定Gemini模型

# 通用配置
GPT_MODEL=openai  # 可选，选择默认AI服务提供商: openai 或 gemini
GPT_PRE_PROMPT=你是一个小助手，用相同的语言回答问题。  # 可选，AI角色设定
MAX_HISTORY=4  # 可选，保存的对话历史轮数
WELCOME_MESSAGE=感谢关注！我是您的AI助手，可以为您解答任何问题。  # 可选，新用户关注欢迎语

# 飞书机器人配置
FEISHU_APP_ID=your_feishu_app_id
FEISHU_APP_SECRET=your_feishu_app_secret
FEISHU_VERIFICATION_TOKEN=your_feishu_verification_token
FEISHU_ENCRYPT_KEY=your_feishu_encrypt_key
```

4. 启动开发服务器：
```bash
npm run dev
```

## 配置选项

| 变量名 | 说明 | 默认值 | 可选值 |
|---------|-----------|---------|---------|
| WECHAT_TOKEN | 微信公众号令牌 | 必填 | - |
| OPENAI_API_KEY | OpenAI API密钥 | 必填(使用OpenAI时) | - |
| OPENAI_MODEL | OpenAI模型名称 | gpt-3.5-turbo | gpt-3.5-turbo, gpt-4, gpt-4-turbo 等 |
| GEMINI_API_KEY | Google Gemini API密钥 | 必填(使用Gemini时) | - |
| GEMINI_MODEL_NAME | Gemini模型名称 | gemini-2.0-flash-lite | gemini-1.0-pro, gemini-2.0-flash-lite, gemini-2.0-pro 等 |
| GPT_MODEL | 默认AI服务提供商 | openai | openai: 使用OpenAI服务<br>gemini: 使用Google Gemini服务 |
| MAX_HISTORY | 保存的对话历史轮数 | 4 | 任意正整数 |
| GPT_PRE_PROMPT | AI角色设定 | 你是一个小助手，用相同的语言回答问题。 | 任意文本 |
| WELCOME_MESSAGE | 新用户关注欢迎语 | 感谢您的关注！我是您的AI助手... | 任意文本 |
| FEISHU_APP_ID | 飞书应用ID | 必填 | - |
| FEISHU_APP_SECRET | 飞书应用密钥 | 必填 | - |
| FEISHU_VERIFICATION_TOKEN | 飞书验证令牌 | 必填 | - |
| FEISHU_ENCRYPT_KEY | 飞书加密密钥 | 可选 | - |

### GPT_MODEL 详细说明

- `openai`: 使用OpenAI服务，需要配置`OPENAI_API_KEY`。可通过`OPENAI_MODEL`指定具体模型版本，如`gpt-3.5-turbo`(默认)、`gpt-4`等。
- `gemini`: 使用Google Gemini服务，需要配置`GEMINI_API_KEY`。可通过`GEMINI_MODEL_NAME`指定具体模型版本，如`gemini-2.0-flash-lite`(默认)、`gemini-2.0-pro`等。

如果配置了无效值，系统会默认使用`openai`服务并记录警告信息。

## 微信公众号配置

1. 登录[微信公众平台](https://mp.weixin.qq.com/)
2. 进入"开发"->"基本配置"
3. 设置服务器配置：
   - URL: `https://你的域名/api/wechat`
   - Token: 与环境变量中的WECHAT_TOKEN一致
   - 消息加解密方式: 明文模式

## 飞书机器人配置

除了微信公众号外，本项目还支持接入飞书机器人。

### 飞书应用配置

1. 登录[飞书开发者平台](https://open.feishu.cn/app)
2. 创建一个自建应用
3. 在"应用功能"中启用"机器人"功能
4. 在"事件订阅"中添加请求地址：`https://你的域名/api/feishu`
5. 订阅以下事件：
   - `im:message.receive_v1` (接收消息)
6. 获取并配置以下环境变量：
   - `FEISHU_APP_ID`: 应用凭证中的App ID
   - `FEISHU_APP_SECRET`: 应用凭证中的App Secret
   - `FEISHU_VERIFICATION_TOKEN`: 事件订阅中的Verification Token
   - `FEISHU_ENCRYPT_KEY`: 事件订阅中的Encrypt Key (如启用了加密)

## 部署

### 使用 Cloudflare Pages 部署（推荐）

本项目已适配 Cloudflare Pages Edge Runtime，可获得更快的响应速度和更低的延迟。

#### 方式一：通过 Cloudflare Dashboard

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 "Workers & Pages"
3. 点击 "Create application" -> "Pages" -> "Connect to Git"
4. 选择你的 GitHub 仓库
5. 配置构建设置：
   - **Framework preset**: `Next.js (Static HTML Export)` 或留空
   - **Build command**: `npm run pages:build`
   - **Build output directory**: `.vercel/output/static`
6. 在 "Environment variables" 中添加环境变量：
   - `NODE_VERSION`: `20`（必须设置，确保 Node.js 版本兼容）
   - 以及其他应用所需的环境变量（WECHAT_TOKEN、OPENAI_API_KEY 等）
7. 点击 "Save and Deploy"
8. 部署完成后，进入项目设置 -> "Functions" -> "Compatibility flags"：
   - 添加 `nodejs_compat` 标志（生产环境和预览环境都需要）
   - 设置 Compatibility date 为 `2024-07-01` 或更新日期

#### 方式二：通过命令行部署

1. 安装 Wrangler CLI（如果尚未安装）：
```bash
npm install -g wrangler
```

2. 登录 Cloudflare：
```bash
wrangler login
```

3. 构建并部署：
```bash
npm run pages:deploy
```

#### 本地开发（Cloudflare 模式）

```bash
# 先构建 Next.js
npm run build

# 使用 Wrangler 本地开发
npm run pages:dev
```

### 使用 Vercel 部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyourusername%2Fnode-wechat-gpt)

1. 点击上方按钮
2. 配置环境变量
3. 部署完成后，设置微信公众号服务器地址为 `https://你的vercel域名/api/wechat`

### 使用 Docker 部署

```bash
docker build -t node-wechat-gpt .
docker run -p 3000:3000 --env-file .env.local node-wechat-gpt
```

## 技术说明

### Edge Runtime 适配

本项目使用 Edge Runtime 以支持 Cloudflare Pages 部署，主要改动包括：

- **加密模块**: 使用 Web Crypto API 替代 Node.js `crypto` 模块
- **XML 解析**: 使用 `fast-xml-parser` 替代 `xml2js`（后者不兼容 Edge Runtime）
- **对话历史**: 目前使用内存存储。在 Edge Runtime 中，每个请求可能在不同的 worker 实例中处理，因此对话历史不会跨请求持久化。如需持久化存储，可以：
  - 使用 Cloudflare KV 存储
  - 使用 Cloudflare D1 数据库
  - 使用外部数据库服务

### 文件结构

```
src/
├── app/
│   ├── api/
│   │   ├── wechat/route.js    # 微信公众号 API
│   │   ├── gpt/route.js       # AI 模型调用
│   │   └── feishu/route.js    # 飞书机器人 API
│   ├── globals.css
│   ├── layout.js
│   └── page.js
├── next.config.mjs            # Next.js 配置
└── wrangler.toml              # Cloudflare 配置
```

## 故障排除

**问题**: 微信公众号无法接收到回复
- 检查服务器配置是否正确
- 确认WECHAT_TOKEN设置正确
- 查看日志是否有API错误

**问题**: AI响应过慢
- 考虑使用更快的API端点
- 减少MAX_HISTORY值
- 检查网络连接

**问题**: 记忆上下文失败
- 确保MAX_HISTORY值大于0
- 检查用户ID是否正确传递
- 注意：在 Cloudflare Pages 上，对话历史存储在内存中，不会跨请求持久化

**问题**: 切换模型后无响应
- 确保已配置相应模型的API密钥
- 检查模型名称是否正确
- 查看服务器日志中的错误信息

**问题**: Cloudflare Pages 部署失败
- 确保 `compatibility_flags` 包含 `nodejs_compat`
- 检查是否有不兼容 Edge Runtime 的依赖
- 查看 Cloudflare Dashboard 中的构建日志

## 贡献

欢迎提交Issues和Pull Requests!

## 许可

[MIT](LICENSE)
