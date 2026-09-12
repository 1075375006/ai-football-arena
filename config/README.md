# AI 模型配置模块

这个目录独立于赛季、投注和数据库业务。它只负责读取模型配置，以及为后续调度器提供第三方模型调用适配器。

## 使用方式

```bash
cp config/ai-models.env.example config/ai-models.env
```

然后填写 `AI_MODEL_N_*`。`N` 从 1 开始，可以继续添加 `AI_MODEL_3_*`、`AI_MODEL_4_*`。

| 字段 | 说明 |
| --- | --- |
| `ID` | 系统内部唯一 ID，例如 `gpt-5` |
| `NAME` | 页面和日志使用的显示名称 |
| `PROVIDER` | `openai-compatible`、`anthropic` 或 `gemini`；也兼容 `deepseek`、`qwen`、`moonshot`、`zhipu` |
| `BASE_URL` | 第三方 API 根地址，不包含具体 endpoint |
| `MODEL` | 供应商侧的模型名 |
| `API_KEY_ENV` | 推荐填写环境变量名，避免把密钥写进文件 |
| `API_KEY` | 可直接填写密钥，但文件必须保持本地私有 |
| `ENABLED` | `true` / `false` |

模型配置不设置固定风格或默认策略。`保守 / 稳健 / 激进 / 高收益 / 自定义` 由 AI 在每一次执行时，根据比赛、赔率、剩余资金和不确定性自行选择，并随本次决策保存到数据库。

服务端通过 `GET /api/model-configs` 只返回脱敏配置，永远不会返回 API Key。完整调用函数是 `config/ai-models.js` 的 `requestAiModel()`，目前支持 OpenAI-compatible Chat Completions、Anthropic Messages 和 Gemini generateContent。

直接填写示例：

```dotenv
AI_MODEL_1_NAME=我的 GPT 模型
AI_MODEL_1_BASE_URL=https://api.example.com/v1
AI_MODEL_1_MODEL=gpt-compatible-model
AI_MODEL_1_API_KEY=your-private-key
```

检查脱敏配置：

```bash
curl 'http://localhost:3000/api/model-configs?reload=1'
```

调用测试（`ADMIN_TOKEN` 来自主项目根目录 `.env`）：

```bash
curl -X POST 'http://localhost:3000/api/ai/models/gpt-5/generate' \
  -H 'Authorization: Bearer YOUR_ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"systemPrompt":"只返回 JSON","messages":[{"role":"user","content":"输出一个测试对象"}]}'
```

修改 `config/ai-models.env` 不需要重建镜像；配置目录以只读方式挂载，调用接口会重新读取文件。

## 动态参赛名单

当前赛季的参赛模型直接来自该文件中的 `AI_MODEL_N_*` 配置块：

- 新增配置块：下一次同步自动加入当前赛季，初始虚拟资金为 ¥10,000。
- 修改 `NAME`、`PROVIDER`、`BASE_URL` 或 `MODEL`：自动更新模型资料；模型 ID `ID` 应保持稳定，否则会被视为新模型。
- 删除配置块或设置 `ENABLED=false`：停止当前赛季参赛和首页展示，但保留数据库历史。

服务启动时同步，并每 5 分钟重新读取一次。也可以访问 `GET /api/model-configs?reload=1` 立即触发同步并查看 `participants` 结果。

`API_KEY_ENV` 应填写环境变量名，例如 `OPENROUTER_API_KEY`，不要填写实际密钥值。旧配置若误把 Key 写进该字段，服务会兼容调用但不会把它作为环境变量名返回；建议尽快迁移密钥。

## Docker

Compose 会把本地 `config/` 只读挂载到容器 `/app/config/`。首次部署脚本会自动从示例生成 `config/ai-models.env`；手动部署则先复制示例文件。真实 Key 建议放在 `.env` 或宿主机环境变量中，再通过 `API_KEY_ENV` 引用。
