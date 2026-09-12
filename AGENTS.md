# AI 足彩竞技场项目规则

## 项目定位

Node.js + PostgreSQL 的 AI 足彩虚拟竞技场，仅做赛事展示、模型决策记录和虚拟资金结算，不登录、不支付、不出票。

## 启动与检查

- 一键部署：macOS/Linux 使用 `./install.sh`，macOS 也可双击 `install.command`；Windows 使用 `install.ps1` / `install.bat`。
- 手动启动：`docker compose up -d --build`。
- 语法检查：`npm run check`。
- 健康检查：`curl http://localhost:3000/api/health`。

## 技术结构

- `server.js`：Express 静态服务、竞彩网代理、数据库初始化和 REST API。
- `modules/sporttery-results.js`：赛果同步、入库和投注核验；`modules/demo-decisions.js`：动态演示投注。
- `modules/ai-participants.js`：从 `config/ai-models.env` 同步当前赛季参赛名单。
- `public/`：首页、历史赛季页和样式。
- `config/ai-models.js` + `config/ai-models.env`：独立第三方模型配置；密钥只留在服务端。
- `ai-足球竞技场-底层提示词与输出协议.md`：AI 输入/输出合同。
- `竞彩玩法记录.md`：官网玩法、开售和单关/串关边界记录。

## 关键约定

- 模型没有固定派别或默认策略；每轮根据赛事、赔率、余额和风险自主选择。
- 单张投注单保存当轮 `strategy_mode`；数据库兼容列 `agents.style/default_strategy` 统一为 `自主决策/custom`，不用于展示。
- 当前 API 只接入 HAD（胜平负）和 HHAD（让球胜平负）；单关、串关资格必须以后端快照校验为准。
- `expectedBonus` 是投入乘参考倍率的估算，不代表最终结算；真实入账使用结算接口的 `payout`。
- 赛果必须从官方赛果 API 按日期同步到 `match_results`，再由模块核验 HAD/HHAD；禁止手工传入中奖结果。
- 修改 `config/ai-models.env` 无需重建镜像；该文件已被忽略且以只读方式挂载。
- 当前参赛模型完全由 env 驱动：新增自动入赛，修改自动更新，删除或禁用停止当前赛季展示；历史数据不删除。

## 当前状态

Docker Web 与 PostgreSQL 可用；比赛快照、官方赛果和动态演示投注已完成同步链路，首页和历史页已验证不显示固定模型派别。后续新增玩法或模型供应商时，先同步提示词/玩法文档，再更新对应独立模块、服务端校验和前端展示。
