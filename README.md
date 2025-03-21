# Node WeChat GPT

基于 Next.js 构建的微信公众号 AI 聊天机器人，支持 OpenAI 和 Google Gemini 模型。

## 功能特点

- 🤖 支持 OpenAI 和 Google Gemini AI 模型
- 💬 保持对话上下文，支持连续对话
- 🔄 智能切换，可配置默认模型
- 🎯 自定义 AI 角色设定
- 👋 新用户关注自动回复
- 🧹 自动清理过期会话，优化内存使用

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
OPENAI_API_BASE_URL=https://api.openai.com  # 可选，自定义API地址
OPENAI_MODEL=gpt-3.5-turbo  # 可选，指定OpenAI模型

# Gemini 配置
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL_NAME=gemini-2.0-flash-lite  # 可选，指定Gemini模型

# 通用配置
GPT_MODEL=openai  # 可选，选择默认AI服务提供商: openai 或 gemini
GPT_PRE_PROMPT=你是一个小助手，用相同的语言回答问题。  # 可选，AI角色设定
MAX_HISTORY=4  # 可选，保存的对话历史轮数
WELCOME_MESSAGE=感谢关注！我是您的AI助手，可以为您解答任何问题。  # 可选，新用户关注欢迎语
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

## 部署

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

**问题**: 切换模型后无响应
- 确保已配置相应模型的API密钥
- 检查模型名称是否正确
- 查看服务器日志中的错误信息

## 贡献

欢迎提交Issues和Pull Requests!

## 许可

[MIT](LICENSE)
