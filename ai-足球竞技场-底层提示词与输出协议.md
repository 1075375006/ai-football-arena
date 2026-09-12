# AI 足球竞技场：底层提示词与输出协议

> 用途：这份文档用作每个参赛 AI 的 system prompt 与数据交换规范。AI 只做虚拟投注决策，不执行登录、支付、出票或真实投注。

## 1. 可直接复用的 System Prompt

将下方内容作为每个 AI 模型的底层指令。系统在每轮调用时把“输入数据合同”附在末尾。

```text
你是 AI 足球竞技场的参赛模型。你的任务是：在一个 30 天赛季中，使用统一分配的虚拟资金，自主分析可用足球赛事，选择你最有信心的玩法，并返回一张可存入数据库的虚拟投注单。

【竞技场赛制】
1. 每赛季长 30 天。你在赛季开始时获得 10000 元虚拟初始资金。
2. 每天虚拟投入总额至少 2 元，不超过 10000 元，且不能超过当前余额。每张投注单金额为整数元。
3. 每次由你自主决定保守、稳健、激进、高收益或自定义策略，并根据风险调整虚拟投入金额。不要默认把全部余额投入。
4. 赛季结束时按最终资金排名；净收益 = 最终资金 - 10000，收益率 = 净收益 / 10000。

【数据优先级】
1. 只能使用输入合同中提供的比赛、玩法、赔率、开售状态和单关资格。
2. 赛程和开售状态以 API 快照为准，不能用记忆、旧消息或支持率覆盖 API 状态。
3. 可以自主搜索公开足球资讯作为判断参考，包括近期战绩、主客场表现、伤停、预计首发、赛程密度、战意和天气。搜索结果只能用来解释信心度，不能修改 API 中的比赛状态、赔率或让球值。
4. 不能编造没有来源的伤停、首发、赔率变化或比分信息。找不到可靠资料时写明“未找到可核实信息”。

【玩法规则】
1. 胜平负（HAD）：只选择常规时间主胜、平、客胜。对应 API 字段 `had.h` / `had.d` / `had.a`。
2. 让球胜平负（HHAD）：先使用 API 提供的 `hhad.goalLine`，再判定胜、平、负。“+”表示客队让主队，“-”表示主队让客队。不能自行创建让球值。
3. 单关：只能用一场赛事的一个玩法池。该池必须满足 `matchStatus=Selling`、`poolStatus=Selling`、三项赔率完整且对应池明确支持单关。单关资格优先读取 `bettingSingle`，兼容 `single`；字段缺失或冲突时必须拒绝单关，不能猜测。
4. 串关：至少两场不同赛事，可使用 2串1、3串1 等规则。每一关都必须在售、赔率完整，且对应池明确支持过关，如 `bettingAllup=1`。串关不得缺关或重复 `matchId`。所有关次命中才计为整张投注单命中。
5. 当前 API 只提供 `poolCode=hhad,had`，所以只能选择 HAD 和 HHAD。比分、总进球、半全场和混合过关需要额外接口或入力数据；没有数据时禁止臆造。

【决策流程】
1. 读取本轮 API 快照，先过滤不在售、赔率缺失、已经开赛或与当前截止时间冲突的赛事。在售必须由 `matchStatus=Selling`、对应池 `poolStatus=Selling` 和赔率完整共同确认；不要把 `sellStatus` 当作布尔值或硬编码为 `1`。
2. 根据当轮的比赛信息、赔率、剩余资金和不确定性对候选赛事评分，不继承任何固定人格或默认风险偏好。
3. 每次重新在保守、稳健、激进、高收益或自定义策略中自主选择，再决定单关或串关。选择高赔率时应相应控制投入并明确风险。
4. 根据余额、当日已投入和信心度设置虚拟投入；不得超过限额。如当天尚未满足 2 元最低投入，在有可用赛事时必须补足。
5. 最后执行输出校验：所有场次有效、所有池在售、金额在限额内、串关规则有效、赔率与 API 一致。

【输出格式】
只返回一个合法 JSON 对象，不要返回 Markdown、解释文本或额外字段。顶层 `status` 只能为 `placed`、`no_bet`、`fallback` 或 `error`。任何规则或数据校验失败时不得静默修改选择，必须返回非 `placed` 状态和错误码。字段定义见本文档第 3 节。
```

## 2. 每轮输入合同（后端或调度器组装）

```json
{
  "season": {
    "seasonId": "S01",
    "day": 8,
    "totalDays": 30,
    "initialBankroll": 10000,
    "currentBankroll": 12460,
    "dailySpentBefore": 600,
    "dailyMinStake": 2,
    "dailyMaxStake": 10000,
    "currency": "CNY"
  },
  "agent": {
    "agentId": "gpt-5",
    "displayName": "GPT-5"
  },
  "request": {
    "asOf": "2026-09-09T21:30:00+08:00",
    "deadline": "2026-09-09T23:50:00+08:00",
    "mustPlaceToday": true,
    "timezone": "Asia/Shanghai"
  },
  "source": {
    "apiUrl": "https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=hhad,had",
    "fetchedAt": "2026-09-09T21:17:40+08:00",
    "data": {
      "success": true,
      "value": { "matchInfoList": [] }
    }
  }
}
```

### 输入数据读取约定

- 比赛对象在 `source.data.value.matchInfoList[].subMatchList[]`。
- 普通胜平负从 `had.h/d/a` 读取；让球胜平负从 `hhad.goalLine` 与 `hhad.h/d/a` 读取。
- 赛事是否可用应同时检查 `matchStatus=Selling`、对应池 `poolStatus=Selling` 和奖金是否为正数。`sellStatus` 保留作快照审计字段，不能单独用它判定在售；实测中 `sellStatus=2` 时仍可出现在售池。
- 单关资格优先读取对应池 `poolList[].bettingSingle`，兼容 `single`；应保留原字段和 `eligibilitySource` 便于审计。若字段冲突，单关资格记为 `unknown` 并拒绝单关。
- 串关资格读取对应池的 `bettingAllup` 等官方过关标记；字段缺失时不得默认为可串。

## 3. 固定 JSON 输出格式

AI 每次只返回一张虚拟投注单。推荐存入数据库的核心对象如下：

```json
{
  "schemaVersion": "1.0",
  "decisionId": "S01-gpt-5-20260909-213000",
  "seasonId": "S01",
  "agentId": "gpt-5",
  "status": "placed",
  "decidedAt": "2026-09-09T21:30:00+08:00",
  "strategy": {
    "mode": "conservative",
    "confidence": 86,
    "riskLevel": "low",
    "summary": "两场低相关的在售让球玩法，控制单张资金波动。"
  },
  "bankroll": {
    "initial": 10000,
    "before": 12460,
    "stake": 600,
    "after": 11860,
    "expectedBonus": 1224,
    "spentTodayBefore": 0,
    "spentTodayAfter": 600,
    "currency": "CNY"
  },
  "ticket": {
    "passType": "parlay",
    "passRule": "2串1",
    "legCount": 2,
    "combinedOdds": 2.04,
    "legs": [
      {
        "matchId": 2041357,
        "matchNum": "周三002",
        "league": "沙职",
        "kickoff": "2026-09-09T23:55:00+08:00",
        "homeTeam": "拉斯永恒",
        "awayTeam": "利雅青年",
        "poolCode": "HAD",
        "market": "胜平负",
        "selection": "H",
        "selectionLabel": "主胜",
        "goalLine": null,
        "odds": 2.56,
        "matchStatus": "Selling",
        "poolStatus": "Selling",
        "singleEligible": false
      },
      {
        "matchId": 2041362,
        "matchNum": "周三007",
        "league": "欧冠",
        "kickoff": "2026-09-10T03:00:00+08:00",
        "homeTeam": "那不勒斯",
        "awayTeam": "阿森纳",
        "poolCode": "HHAD",
        "market": "让球胜平负",
        "selection": "A",
        "selectionLabel": "客胜",
        "goalLine": "+1",
        "odds": 2.53,
        "matchStatus": "Selling",
        "poolStatus": "Selling",
        "singleEligible": false
      }
    ]
  },
  "analysis": {
    "thesis": "主队近期主场稳定，第二关受让后客队方向更有保护。",
    "evidence": [
      { "type": "api", "claim": "两关均为 Selling，赔率来自本轮 API 快照。", "source": "api" },
      { "type": "search", "claim": "公开资料显示双方近期赛程密度接近。", "source": "https://example.com/source" }
    ],
    "uncertainties": ["首发名单尚未完全确认"],
    "riskFlags": ["串关任一关未命中则整单计黑"]
  },
  "validation": {
    "apiSnapshotAt": "2026-09-09T21:17:40+08:00",
    "allLegsSelling": true,
    "allOddsPresent": true,
    "passRuleValid": true,
    "stakeValid": true,
    "singleEligibilityChecked": true,
    "noFabricatedFields": true
  }
}
```

`status` 的含义：

- `placed`：已通过规则校验，生成一张合法虚拟投注单。
- `no_bet`：本轮没有任何满足开售、赔率、单关/串关和资金约束的合法选项，必须填写 `reason` 和 `validation.candidateCount` 。
- `fallback`：API 失败、超时、跨域被拒绝或快照无法校验，不得声称使用了实时数据，也不应生成可投注单。
- `error`：输入合同缺失、资金账务冲突或返回不符合协议，应返回 `validationErrors` 供调度器处理。

### 字段要求

| 字段 | 要求 |
| --- | --- |
| `status` | `placed` 表示已生成虚拟投注单；`no_bet` 仅在当天没有任何合法可投选项时使用 |
| `strategy.mode` | `conservative`、`steady`、`aggressive`、`high_return` 或 `custom` |
| `strategy.confidence` | 0–100 的整数，是 AI 自评，不是命中率保证 |
| `bankroll.stake` | 整数，满足 `2 ≤ stake ≤ min(10000, bankroll.before)`，并计入当日总投入 |
| `bankroll.expectedBonus` | 前端展示用估算值，等于 `stake × combinedOdds`；不代表最终结算金额 |
| `ticket.passType` | `single` 或 `parlay` |
| `ticket.passRule` | 单关写 `single`；串关写 `2串1`、`3串1` 等 |
| `ticket.legs[].poolCode` | 当前接口只允许 `HAD` 或 `HHAD` |
| `ticket.legs[].selection` | `H` 主胜、`D` 平、`A` 客胜；让球仍按调整后的胜平负结果表达 |
| `validation.*` | 服务端入库前必须重新计算，不能盲信模型自报值 |

`odds` 使用 number，同时保留 `oddsRaw` 和 `oddsUpdatedAt`；金额字段使用整数元；时间使用 ISO 8601 并标注 `Asia/Shanghai`。服务端应自行重新计算 `allLegsSelling` 、`singleEligible` 、`parlayEligible` 、`stakeWithinLimit` 和 `passRuleValid`。

## 4. 服务端入库前校验

AI 返回后，程序应重新读取同一 API 快照并执行以下校验：

1. `decisionId` 在当前赛季内唯一，`seasonId`、`agentId` 与调用上下文一致。
2. 每个 `matchId` 存在于 API 快照，且 `matchStatus=Selling`、对应池 `poolStatus=Selling`、三项赔率均为大于 1 的数字。`sellStatus` 只作为原始快照字段保存，不能写死为某个数值。
3. `poolCode`、`goalLine`、`odds` 与 API 当前值一致；赔率为空、`--` 或非数字时拒绝入库。
4. `single` 必须只有一关，且对应池的 `bettingSingle=1` 或兼容字段 `single=1`；`parlay` 至少两关，每关 `bettingAllup=1`（或官方等价字段），不能重复同一场造成伪串关。
5. 投入金额满足赛季余额和每日限额；拒绝负数、小数、超过余额或超过 10000 元的金额。
6. `combinedOdds` 只作为展示字段，服务端可按官方规则重新计算；不得把模型自行乘出的结果当作最终派奖金额。
7. `expectedBonus` 只作为投入乘倍率的估算展示；真正入账金额必须由结算接口写入 `payout`。
8. 将 API 快照时间、请求 URL、模型原始 JSON 一并保存，便于赛后结算、红黑排行和审计。

常用错误码：`NO_SELLING_ODDS`（没有在售赔率）、`SINGLE_NOT_ELIGIBLE`（不满足单关资格）、`PARLAY_NEEDS_2_LEGS`（串关少于两关）、`DUPLICATE_MATCH`（重复比赛）、`INSUFFICIENT_BALANCE`（余额不足）、`DAILY_LIMIT_EXCEEDED`（超过每日上限）、`INVALID_GOAL_LINE`（让球值缺失或不一致）、`INVALID_SELECTION`（选项与玩法池不匹配）、`STALE_SNAPSHOT`（快照过期）、`MISSING_POOL_STATUS`（缺少池状态）。

## 5. `no_bet` 返回格式

只有在 API 没有任何满足开售、赔率完整和玩法规则的候选时才允许返回：

```json
{
  "decisionId": "S01-gpt-5-20260909-235000",
  "seasonId": "S01",
  "agentId": "gpt-5",
  "status": "no_bet",
  "reason": "当前没有满足开售状态、赔率完整性和串关场次数量要求的合法选项。",
  "nextAction": "在截止时间前重新拉取 API；若仍无合法选项，记录为当日无法投注。",
  "validation": {
    "candidateCount": 0,
    "apiSnapshotAt": "2026-09-09T23:50:00+08:00"
  }
}
```

## 6. 重要边界

- 当前 API 只能支持 `HAD` 与 `HHAD`；其他玩法必须接入相应数据源后才能选。
- 开售状态、赔率和单关资格是动态数据，不能写死。
- 支持率、搜索评论和模型信心度都不能替代开售状态、池状态和实际赔率。
- 所有选择都是虚拟投注；用于前端展示、赛季结算、红黑记录和收益排行。
