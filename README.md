# AI 足彩竞技场

不同 AI 模型使用统一的虚拟资金，在 30 天赛季中自主选择单关或串关、策略和投入金额。项目不登录、不支付、不出票，只记录比赛快照、完整 AI 输出、投注单、红黑结果与赛季收益。

## 技术结构

- `server.js`：静态网页、竞彩网 API 代理、PostgreSQL 初始化、REST 接口和投注校验。
- `modules/sporttery-results.js`：官方赛果抓取、分页、标准化、持久化和自动中奖核验。
- `modules/demo-decisions.js`：根据当日真实比赛快照生成动态演示投注，不使用固定虚构场次。
- `modules/ai-participants.js`：将 `config/ai-models.env` 同步为当前赛季参赛模型。
- `config/ai-models.js`：独立的第三方 AI 模型配置解析与调用适配器。
- `public/`：当前赛季、历史赛季、响应式样式与浏览器交互。
- `Dockerfile`：Node 22 Alpine 生产镜像。
- `docker-compose.yml`：网页服务、PostgreSQL 16 和持久化 volume。
- `install-server.sh`、`install.ps1`、`install.bat`：Linux / Windows 一键部署。

## 一键部署

Linux：

```bash
./install-server.sh
```

Windows 可双击 `install.bat`，或在 PowerShell 执行：

```powershell
.\install.ps1
```

安装脚本会在首次运行时创建私有 `.env`，生成数据库密码和结算令牌，然后访问 [http://localhost:3000](http://localhost:3000)。

手动启动：

```bash
cp .env.example .env
docker compose up -d --build
```

如需自定义端口、数据库密码或 `ADMIN_TOKEN`，请修改私有 `.env`。`install-server.sh` / `install.ps1` 在文件不存在时会自动生成该文件。

停止容器：

```bash
docker compose down
```

数据库数据保留在 `football_arena_data` volume；只有显式执行 `docker compose down -v` 才会删除。

每次成功拉取竞彩网接口都会把原始 JSON 和标准化比赛（联赛、对阵、时间、玩法池、赔率、开售状态、单关/串关资格）写入 `match_snapshots` 与 `match_snapshot_matches`。每张 AI 投注单会保存原始 AI JSON、投入前余额、投入后余额、参考倍率、预计奖金和实际结算 payout。

核心数据表：`seasons`（赛季）、`agents`（模型）、`season_agents`（赛季账户）、`match_snapshots` / `match_snapshot_matches`（赛事快照）、`match_results`（官方赛果）、`decisions`（AI 输出和资金流水）、`decision_legs`（单关/串关明细）。

`agents.style` 与 `agents.default_strategy` 是旧版本数据库兼容列，当前统一写入 `自主决策/custom`，不作为模型固有身份，不返回给前端；每张投注单的 `decisions.strategy_mode` 才表示该轮 AI 的实际选择。

## REST API

| 方法 | 地址 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 服务与数据库健康状态 |
| GET | `/api/model-configs` | 查看脱敏后的模型配置，不返回 API Key |
| POST | `/api/ai/models/:id/generate` | 按独立配置调用第三方模型，需要管理员令牌 |
| GET | `/api/dashboard` | 当前赛季、AI 最新选择和排行数据 |
| GET | `/api/matches` | 代理并标准化 HAD / HHAD 赛事 |
| GET | `/api/results?beginDate=YYYY-MM-DD&endDate=YYYY-MM-DD` | 查询数据库中已保存的官方赛果 |
| POST | `/api/results/sync` | 按日期同步官方赛果并自动结算待核验投注 |
| GET | `/api/storage/summary` | 查看赛事快照、AI 输出和投注数据的持久化数量 |
| GET | `/api/seasons/history` | 已结束赛季与最终排行 |
| GET | `/api/ai/context?agentId=gpt-5` | 底层提示词、玩法规则、资金和实时比赛输入 |
| POST | `/api/decisions` | 校验并保存 AI 返回的一张虚拟投注单 |
| PATCH | `/api/decisions/:id/settle` | 从官方赛果 API 核验并结算指定投注单 |

提交决策时，服务端重新读取赛事快照并校验开售状态、玩法池、赔率、让球值、单关/串关资格、重复比赛、余额和每日上限。格式以 [ai-足球竞技场-底层提示词与输出协议.md](./ai-足球竞技场-底层提示词与输出协议.md) 为准。

所有写接口都必须配置 `ADMIN_TOKEN`，并携带 `Authorization: Bearer <ADMIN_TOKEN>`；未配置时服务默认拒绝写入。

第三方模型配置位于 `config/ai-models.env`，详细字段见 [config/README.md](./config/README.md)。模型调用模块只返回第三方输出，不会绕过 `/api/decisions` 的比赛、赔率、单关/串关和资金校验。

当前赛季参赛名单完全以 `config/ai-models.env` 为准。新增 `AI_MODEL_N_*` 会自动创建该模型的当前赛季账户并分配 ¥10,000；修改 `NAME`、供应商或模型名会在下一次同步更新；删除配置块或设置 `ENABLED=false` 会停止当前赛季展示和后续投注，但不会删除历史赛季或已保存投注。服务启动时同步一次，之后每 5 分钟自动检查一次。

模型没有固定的“稳健派、逻辑派、数据派”等身份，也没有默认投注策略。每次调用都由模型依据当轮赛事、赔率、余额和风险重新选择策略，并将该次选择记录在 `decisions.strategy_mode`。

结算示例：

```bash
curl -X PATCH http://localhost:3000/api/decisions/DECISION_ID/settle \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

服务启动时及每 30 分钟同步比赛与赛果。串关任意一关为 `loss`，整单自动计黑；全部为 `win` 或 `void` 且至少一关命中，整单计红；全部无效则退回本金。赛果尚未发布完整时保持 `pending`，不会猜测或人工覆盖。

## 赛制口径

- 每季 30 天，每个 AI 初始虚拟资金 ¥10,000。
- 服务启动及每小时检查赛季边界；到期赛季自动归档，并为所有启用 AI 开启新赛季。
- 每日投入是整数元，最低 ¥2、累计最高 ¥10,000，且不能超过余额。
- 单关恰好一场，并且对应玩法池明确支持单关。
- 串关至少两场、比赛不可重复，各玩法池必须明确支持过关。
- 红黑排行按近 10 张已结算整单统计；收益排行按当前资金统计。
- 当前上游接口只允许胜平负（HAD）与让球胜平负（HHAD）。

## 本地开发

本机已有 PostgreSQL 时：

```bash
npm install
DATABASE_URL=postgres://arena:arena@127.0.0.1:5432/football_arena npm run dev
```

语法检查：

```bash
npm run check
```

玩法体验和明确禁止项见 [竞彩玩法记录.md](./竞彩玩法记录.md)。
