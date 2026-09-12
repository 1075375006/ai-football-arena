import express from "express";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicAiModelConfigs, loadAiModelsConfig, requestAiModel } from "./config/ai-models.js";
import { fetchMatchResults, persistMatchResults, shiftDate, shanghaiDate as resultShanghaiDate, syncResultsAndSettle, verifyAndSettlePending } from "./modules/sporttery-results.js";
import { ensureDailyDemoDecisions, removeLegacyDemoDecisions } from "./modules/demo-decisions.js";
import { createSportteryMatchesService, SPORTTERY_MATCH_URL } from "./modules/sporttery-matches.js";
import { syncConfiguredParticipants } from "./modules/ai-participants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || "postgres://arena:arena@127.0.0.1:5432/football_arena";
const SPORTTERY_URL = SPORTTERY_MATCH_URL;
const MATCH_CACHE_TTL = Number(process.env.SPORTTERY_CACHE_TTL_MS || 60_000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const pool = new Pool({ connectionString: DATABASE_URL });
const app = express();

const agentSeeds = [
  ["gpt-5", "GPT-5", "G5", "自主决策", "custom", "#0c6b45", "#eaf4ee"],
  ["claude-4", "Claude 4", "C4", "自主决策", "custom", "#b85c2f", "#fff0e8"],
  ["gemini-2-5", "Gemini 2.5", "G✦", "自主决策", "custom", "#315aa6", "#ebf0fb"],
  ["deepseek-r1", "DeepSeek R1", "DS", "自主决策", "custom", "#6c4bb4", "#f0ecfa"],
  ["grok-3", "Grok 3", "GX", "自主决策", "custom", "#c73f3a", "#faecea"],
  ["qwen-max", "Qwen Max", "QW", "自主决策", "custom", "#9a7220", "#f7f0df"],
];

const historySeeds = {
  S00: [
    ["claude-4", 17680, 18420, 28, 16, 44], ["deepseek-r1", 15940, 16320, 21, 23, 44],
    ["gpt-5", 14860, 15120, 30, 14, 44], ["qwen-max", 12730, 17260, 26, 18, 44],
    ["gemini-2-5", 10840, 19480, 27, 17, 44], ["grok-3", 6240, 20860, 18, 26, 44],
  ],
  "S-01": [
    ["deepseek-r1", 21350, 15860, 18, 21, 39], ["gemini-2-5", 15310, 18740, 25, 14, 39],
    ["gpt-5", 13920, 14120, 28, 11, 39], ["claude-4", 12140, 16920, 23, 16, 39],
    ["qwen-max", 9460, 18080, 21, 18, 39], ["grok-3", 3180, 22640, 15, 24, 39],
  ],
  "S-02": [
    ["gpt-5", 16220, 20260, 35, 12, 47], ["claude-4", 14990, 18120, 31, 16, 47],
    ["qwen-max", 13180, 17480, 29, 18, 47], ["gemini-2-5", 11940, 21320, 30, 17, 47],
    ["deepseek-r1", 8710, 16880, 21, 26, 47], ["grok-3", 5580, 23760, 19, 28, 47],
  ],
};

const matchService = createSportteryMatchesService(pool, { cacheTtl: MATCH_CACHE_TTL });
const fetchMatches = matchService.fetchMatches;
const loadLatestSavedSnapshot = matchService.loadLatestSavedSnapshot;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
});

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
const shanghaiDate = resultShanghaiDate;

function httpError(status, code, message, details) {
  return Object.assign(new Error(message), { status, code, details });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireAdmin(req) {
  if (!ADMIN_TOKEN) throw httpError(503, "ADMIN_TOKEN_NOT_CONFIGURED", "写接口尚未配置 ADMIN_TOKEN");
  if (req.get("authorization") !== `Bearer ${ADMIN_TOKEN}`) {
    throw httpError(401, "UNAUTHORIZED", "写接口需要有效的 ADMIN_TOKEN");
  }
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seasons (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      starts_on DATE NOT NULL,
      ends_on DATE NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('current', 'completed', 'upcoming')),
      initial_bankroll INTEGER NOT NULL DEFAULT 10000 CHECK (initial_bankroll > 0),
      story TEXT NOT NULL DEFAULT '',
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_current_season ON seasons (status) WHERE status = 'current';

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      monogram TEXT NOT NULL,
      style TEXT NOT NULL,
      default_strategy TEXT NOT NULL,
      color TEXT NOT NULL,
      soft_color TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS season_agents (
      season_id TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      current_balance NUMERIC(12,2) NOT NULL,
      season_spent NUMERIC(12,2) NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      tickets INTEGER NOT NULL DEFAULT 0,
      recent_form JSONB NOT NULL DEFAULT '[]'::jsonb,
      PRIMARY KEY (season_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS match_snapshots (
      id BIGSERIAL PRIMARY KEY,
      snapshot_at TIMESTAMPTZ NOT NULL,
      source_url TEXT NOT NULL,
      source TEXT NOT NULL,
      match_count INTEGER NOT NULL CHECK (match_count >= 0),
      raw_payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS match_snapshots_snapshot_at_idx ON match_snapshots (snapshot_at DESC);

    CREATE TABLE IF NOT EXISTS match_snapshot_matches (
      snapshot_id BIGINT NOT NULL REFERENCES match_snapshots(id) ON DELETE CASCADE,
      match_id TEXT NOT NULL,
      match_num TEXT NOT NULL,
      league TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      match_date DATE,
      match_time TIME,
      kickoff TIMESTAMPTZ,
      match_status TEXT,
      sell_status INTEGER,
      markets JSONB NOT NULL,
      PRIMARY KEY (snapshot_id, match_id)
    );
    CREATE INDEX IF NOT EXISTS match_snapshot_matches_match_id_idx ON match_snapshot_matches (match_id);

    CREATE TABLE IF NOT EXISTS match_results (
      match_id TEXT PRIMARY KEY,
      match_date DATE,
      match_num TEXT NOT NULL,
      league TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      home_score INTEGER,
      away_score INTEGER,
      half_home_score INTEGER,
      half_away_score INTEGER,
      had_result TEXT CHECK (had_result IN ('H', 'D', 'A') OR had_result IS NULL),
      result_status TEXT,
      match_result_status TEXT,
      odds JSONB NOT NULL DEFAULT '{}'::jsonb,
      goal_line TEXT,
      single_eligible BOOLEAN,
      is_void BOOLEAN NOT NULL DEFAULT FALSE,
      source_url TEXT NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL,
      raw_payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS match_results_match_date_idx ON match_results (match_date DESC);

    CREATE TABLE IF NOT EXISTS decisions (
      decision_id TEXT PRIMARY KEY,
      season_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      decision_date DATE NOT NULL,
      decided_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('placed', 'no_bet', 'fallback', 'error')),
      strategy_mode TEXT,
      confidence INTEGER CHECK (confidence BETWEEN 0 AND 100),
      stake INTEGER NOT NULL DEFAULT 0 CHECK (stake >= 0),
      pass_type TEXT CHECK (pass_type IN ('single', 'parlay')),
      pass_rule TEXT,
      combined_odds NUMERIC(12,4),
      reason TEXT NOT NULL DEFAULT '',
      expected_bonus NUMERIC(12,2),
      balance_before NUMERIC(12,2),
      balance_after NUMERIC(12,2),
      api_snapshot_id BIGINT REFERENCES match_snapshots(id),
      ai_output JSONB NOT NULL DEFAULT '{}'::jsonb,
      result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'win', 'loss', 'void')),
      payout NUMERIC(12,2) NOT NULL DEFAULT 0,
      api_snapshot_at TIMESTAMPTZ,
      api_source_url TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      settled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (season_id, agent_id, decision_date),
      FOREIGN KEY (season_id, agent_id) REFERENCES season_agents(season_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS decision_legs (
      id BIGSERIAL PRIMARY KEY,
      decision_id TEXT NOT NULL REFERENCES decisions(decision_id) ON DELETE CASCADE,
      leg_order INTEGER NOT NULL,
      match_id TEXT NOT NULL,
      match_num TEXT NOT NULL,
      league TEXT NOT NULL,
      kickoff TIMESTAMPTZ,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      pool_code TEXT NOT NULL CHECK (pool_code IN ('HAD', 'HHAD')),
      selection TEXT NOT NULL CHECK (selection IN ('H', 'D', 'A')),
      selection_label TEXT NOT NULL,
      goal_line TEXT,
      odds NUMERIC(12,4) NOT NULL CHECK (odds > 1),
      match_status TEXT,
      pool_status TEXT,
      single_eligible BOOLEAN,
      parlay_eligible BOOLEAN,
      result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'win', 'loss', 'void')),
      UNIQUE (decision_id, leg_order),
      UNIQUE (decision_id, match_id)
    );
  `);
  await pool.query(`
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS expected_bonus NUMERIC(12,2);
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS balance_before NUMERIC(12,2);
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS balance_after NUMERIC(12,2);
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS api_snapshot_id BIGINT REFERENCES match_snapshots(id);
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS ai_output JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);
  await pool.query(`
    UPDATE decisions d
    SET expected_bonus = COALESCE(d.expected_bonus, ROUND(d.stake * d.combined_odds, 2)),
        balance_after = COALESCE(d.balance_after, sa.current_balance),
        balance_before = COALESCE(d.balance_before, sa.current_balance + d.stake),
        ai_output = CASE WHEN d.ai_output = '{}'::jsonb THEN d.raw_payload ELSE d.ai_output END
    FROM season_agents sa
    WHERE sa.season_id = d.season_id AND sa.agent_id = d.agent_id;
  `);
  await pool.query("ALTER TABLE decision_legs ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'win', 'loss', 'void'))");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const seasons = [
      ["S01", "S01", "2026-09-03", "2026-10-02", "current", "当前赛季由 6 个 AI 模型共同参与。", { totalStaked: 21540, topTicketProfit: 5940, parlayCount: 34, singleCount: 14 }],
      ["S00", "S00", "2026-08-01", "2026-08-30", "completed", "Claude 4 在后 10 天主动降低单笔资金，靠连续 5 张稳健 2串1 反超夺冠。", { totalStaked: 18420, topTicketProfit: 2376, parlayCount: 26, singleCount: 18 }],
      ["S-01", "S-01", "2026-07-01", "2026-07-30", "completed", "DeepSeek R1 用极小资金命中两次高奖金 3串1，成为首个资金翻倍的模型。", { totalStaked: 15860, topTicketProfit: 5940, parlayCount: 31, singleCount: 8 }],
      ["S-02", "S-02", "2026-06-01", "2026-06-30", "completed", "GPT-5 全季没有使用超过当时资金 12% 的单笔投入，以最高命中率和最小回撤获胜。", { totalStaked: 20260, topTicketProfit: 1486, parlayCount: 19, singleCount: 28 }],
    ];
    for (const season of seasons) {
      await client.query(
        `INSERT INTO seasons (id, label, starts_on, ends_on, status, story, summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`, season,
      );
    }
    for (const agent of agentSeeds) {
      await client.query(
        `INSERT INTO agents (id,name,monogram,style,default_strategy,color,soft_color,active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, monogram=EXCLUDED.monogram,
         style='自主决策', default_strategy='custom', color=EXCLUDED.color, soft_color=EXCLUDED.soft_color`, agent,
      );
    }
    for (const [seasonId, rows] of Object.entries(historySeeds)) {
      for (const [agentId, balance, spent, wins, losses, tickets] of rows) {
        await client.query(
          `INSERT INTO season_agents (season_id,agent_id,current_balance,season_spent,wins,losses,tickets,recent_form)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'[]') ON CONFLICT (season_id,agent_id) DO NOTHING`,
          [seasonId, agentId, balance, spent, wins, losses, tickets],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function rolloverSeasonIfNeeded() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM seasons WHERE status='current' LIMIT 1 FOR UPDATE");
    const current = rows[0];
    const today = shanghaiDate();
    if (!current || dateOnly(current.ends_on) >= today) {
      await client.query("COMMIT");
      return false;
    }
    await client.query("UPDATE seasons SET status='completed' WHERE id=$1", [current.id]);
    const nextId = `S${today.replaceAll("-", "")}`;
    await client.query(
      `INSERT INTO seasons (id,label,starts_on,ends_on,status,initial_bankroll,story)
       VALUES ($1,$1,$2,$2::date + 29,'current',$3,'新赛季自动开启。')`,
      [nextId, today, current.initial_bankroll],
    );
    await client.query(
      `INSERT INTO season_agents (season_id,agent_id,current_balance)
       SELECT $1,id,$2 FROM agents WHERE active=TRUE`, [nextId, current.initial_bankroll],
    );
    await client.query("COMMIT");
    console.log(`已归档 ${current.id}，并开启 ${nextId}`);
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getCurrentSeason(client = pool) {
  const { rows } = await client.query("SELECT * FROM seasons WHERE status = 'current' LIMIT 1");
  if (!rows[0]) throw httpError(503, "NO_CURRENT_SEASON", "当前没有进行中的赛季");
  return rows[0];
}

async function dashboardData() {
  const season = await getCurrentSeason();
  const { rows: agents } = await pool.query(
    `SELECT a.*, sa.current_balance, sa.season_spent, sa.wins, sa.losses, sa.tickets, sa.recent_form,
      d.decision_id, d.strategy_mode, d.confidence, d.stake, d.pass_type, d.pass_rule, d.combined_odds, d.expected_bonus,
      d.balance_before, d.balance_after, d.api_snapshot_id, d.reason, d.result
     FROM season_agents sa JOIN agents a ON a.id = sa.agent_id
     LEFT JOIN LATERAL (
       SELECT * FROM decisions x WHERE x.season_id=sa.season_id AND x.agent_id=sa.agent_id AND x.status='placed'
       ORDER BY x.decided_at DESC LIMIT 1
     ) d ON TRUE
     WHERE sa.season_id=$1 AND a.active=TRUE ORDER BY a.name`, [season.id],
  );
  const decisionIds = agents.map((agent) => agent.decision_id).filter(Boolean);
  const { rows: legs } = decisionIds.length
    ? await pool.query("SELECT * FROM decision_legs WHERE decision_id = ANY($1::text[]) ORDER BY decision_id, leg_order", [decisionIds])
    : { rows: [] };
  const legsByDecision = Map.groupBy(legs, (leg) => leg.decision_id);
  const today = shanghaiDate();
  const start = dateOnly(season.starts_on);
  const day = Math.max(1, Math.min(30, Math.floor((new Date(`${today}T00:00:00+08:00`) - new Date(`${start}T00:00:00+08:00`)) / 86_400_000) + 1));
  return {
    season: { id: season.id, label: season.label, startDate: start, endDate: dateOnly(season.ends_on), day, totalDays: 30, initialBankroll: season.initial_bankroll },
    agents: agents.map((agent) => ({
      id: agent.id, name: agent.name, monogram: agent.monogram,
      color: agent.color, soft: agent.soft_color, currentBalance: Number(agent.current_balance), seasonSpent: Number(agent.season_spent),
      wins: agent.wins, losses: agent.losses, tickets: agent.tickets, form: agent.recent_form || [],
      decision: agent.decision_id ? {
        id: agent.decision_id, strategy: agent.strategy_mode, confidence: agent.confidence, stake: agent.stake,
        passType: agent.pass_type, passRule: agent.pass_rule, combinedOdds: Number(agent.combined_odds), expectedBonus: Number(agent.expected_bonus),
        balanceBefore: Number(agent.balance_before), balanceAfter: Number(agent.balance_after), apiSnapshotId: agent.api_snapshot_id,
        reason: agent.reason, result: agent.result,
        legs: (legsByDecision.get(agent.decision_id) || []).map((leg) => ({
          matchId: leg.match_id, matchNum: leg.match_num, league: leg.league, kickoff: leg.kickoff,
          homeTeam: leg.home_team, awayTeam: leg.away_team, poolCode: leg.pool_code, selection: leg.selection,
          selectionLabel: leg.selection_label, goalLine: leg.goal_line, odds: Number(leg.odds),
        })),
      } : null,
    })),
  };
}

app.get("/api/health", asyncRoute(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, database: "connected", time: new Date().toISOString() });
}));

app.get("/api/model-configs", asyncRoute(async (req, res) => {
  const config = await loadAiModelsConfig(undefined, { reload: req.query.reload === "1" });
  const sync = await syncConfiguredParticipants(pool, config);
  res.json({
    ok: true,
    configFile: "/app/config/ai-models.env",
    models: getPublicAiModelConfigs(config),
    participants: sync,
    warnings: config.warnings,
  });
}));

app.post("/api/ai/models/:modelId/generate", asyncRoute(async (req, res) => {
  requireAdmin(req);
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || !messages.length || messages.length > 50) throw httpError(400, "INVALID_AI_MESSAGES", "messages 必须是包含 1–50 条消息的数组");
  if (messages.some((message) => !["user", "assistant"].includes(message?.role) || typeof message?.content !== "string")) {
    throw httpError(400, "INVALID_AI_MESSAGE", "每条消息必须包含 user/assistant role 和字符串 content");
  }
  const output = await requestAiModel(req.params.modelId, {
    systemPrompt: typeof req.body.systemPrompt === "string" ? req.body.systemPrompt : "",
    messages,
    responseFormat: req.body.responseFormat,
  }, {
    reload: true,
    temperature: Number.isFinite(Number(req.body.temperature)) ? Number(req.body.temperature) : 0.2,
    maxTokens: Number.isInteger(req.body.maxTokens) && req.body.maxTokens > 0 ? req.body.maxTokens : undefined,
  });
  res.json({ ok: true, ...output });
}));

app.get("/api/matches", asyncRoute(async (req, res) => {
  try {
    const snapshot = await fetchMatches(req.query.refresh === "1");
    const selected = req.query.date ? snapshot.matches.filter((match) => match.matchDate === req.query.date) : snapshot.matches;
    res.json({ ok: true, source: snapshot.source, snapshotAt: snapshot.snapshotAt, count: selected.length, matches: selected });
  } catch (error) {
    const staleCache = matchService.getCache();
    if (staleCache.matches.length) {
      return res.status(200).json({ ok: true, source: "stale-cache", stale: true, snapshotAt: staleCache.snapshotAt, count: staleCache.matches.length, matches: staleCache.matches });
    }
    const saved = await loadLatestSavedSnapshot().catch(() => null);
    if (saved) return res.status(200).json({ ok: true, source: "database", stale: true, snapshotAt: saved.snapshotAt, count: saved.matches.length, matches: saved.matches });
    throw error;
  }
}));

app.get("/api/storage/summary", asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM match_snapshots) AS match_snapshots,
      (SELECT COUNT(*) FROM match_snapshot_matches) AS saved_matches,
      (SELECT COUNT(*) FROM match_results) AS match_results,
      (SELECT COUNT(*) FROM decisions) AS decisions,
      (SELECT COUNT(*) FROM decisions WHERE ai_output <> '{}'::jsonb) AS saved_ai_outputs,
      (SELECT COUNT(*) FROM decision_legs) AS decision_legs,
      (SELECT MAX(snapshot_at) FROM match_snapshots) AS latest_snapshot_at,
      (SELECT MAX(fetched_at) FROM match_results) AS latest_result_at
  `);
  const row = rows[0];
  res.json({
    ok: true,
    storage: {
      matchSnapshots: Number(row.match_snapshots), savedMatches: Number(row.saved_matches), matchResults: Number(row.match_results),
      decisions: Number(row.decisions), savedAiOutputs: Number(row.saved_ai_outputs), decisionLegs: Number(row.decision_legs),
      latestSnapshotAt: row.latest_snapshot_at, latestResultAt: row.latest_result_at,
    },
  });
}));

function resultDate(value, fallback) {
  const date = String(value || fallback);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00+08:00`).valueOf())) {
    throw httpError(400, "INVALID_DATE", "日期必须使用 YYYY-MM-DD 格式");
  }
  return date;
}

app.get("/api/results", asyncRoute(async (req, res) => {
  const endDate = resultDate(req.query.endDate, shanghaiDate());
  const beginDate = resultDate(req.query.beginDate, shiftDate(endDate, -2));
  if (beginDate > endDate) throw httpError(400, "INVALID_DATE_RANGE", "beginDate 不能晚于 endDate");
  const { rows } = await pool.query(
    `SELECT match_id,match_date,match_num,league,home_team,away_team,home_score,away_score,half_home_score,half_away_score,
            had_result,result_status,match_result_status,goal_line,is_void,fetched_at
     FROM match_results WHERE match_date BETWEEN $1 AND $2 ORDER BY match_date DESC,match_num DESC`,
    [beginDate, endDate],
  );
  res.json({ ok: true, beginDate, endDate, count: rows.length, results: rows.map((row) => ({
    matchId: row.match_id, matchDate: dateOnly(row.match_date), matchNum: row.match_num, league: row.league,
    homeTeam: row.home_team, awayTeam: row.away_team, homeScore: row.home_score, awayScore: row.away_score,
    halfHomeScore: row.half_home_score, halfAwayScore: row.half_away_score, hadResult: row.had_result,
    resultStatus: row.result_status, matchResultStatus: row.match_result_status, goalLine: row.goal_line,
    isVoid: row.is_void, fetchedAt: row.fetched_at,
  })) });
}));

app.post("/api/results/sync", asyncRoute(async (req, res) => {
  requireAdmin(req);
  const endDate = resultDate(req.body?.endDate, shanghaiDate());
  const beginDate = resultDate(req.body?.beginDate, shiftDate(endDate, -2));
  if (beginDate > endDate) throw httpError(400, "INVALID_DATE_RANGE", "beginDate 不能晚于 endDate");
  const synced = await syncResultsAndSettle(pool, { beginDate, endDate });
  res.json({ ok: true, ...synced });
}));

app.get("/api/dashboard", asyncRoute(async (_req, res) => res.json({ ok: true, ...(await dashboardData()) })));

app.get("/api/seasons/history", asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, json_agg(json_build_object(
       'id',a.id,'name',a.name,'monogram',a.monogram,'color',a.color,'softColor',a.soft_color,
       'balance',sa.current_balance,'spent',sa.season_spent,'wins',sa.wins,'losses',sa.losses,'tickets',sa.tickets
     ) ORDER BY sa.current_balance DESC) AS ranking
     FROM seasons s JOIN season_agents sa ON sa.season_id=s.id JOIN agents a ON a.id=sa.agent_id
     WHERE s.status='completed' GROUP BY s.id ORDER BY s.starts_on DESC`,
  );
  const seasons = rows.map((season) => ({
    id: season.id, label: season.label, startDate: dateOnly(season.starts_on), endDate: dateOnly(season.ends_on),
    initialBankroll: season.initial_bankroll, story: season.story, summary: season.summary,
    ranking: season.ranking.map((row) => ({ ...row, balance: Number(row.balance), spent: Number(row.spent), hitRate: row.wins + row.losses ? Math.round(row.wins / (row.wins + row.losses) * 100) : 0, returnRate: Number(((Number(row.balance) - season.initial_bankroll) / season.initial_bankroll * 100).toFixed(1)) })),
  }));
  res.json({ ok: true, seasons });
}));

app.get("/api/ai/context", asyncRoute(async (req, res) => {
  const agentId = String(req.query.agentId || "");
  if (!agentId) throw httpError(400, "AGENT_ID_REQUIRED", "缺少 agentId");
  const season = await getCurrentSeason();
  const { rows } = await pool.query(
    `SELECT a.id,a.name,sa.current_balance,COALESCE((SELECT SUM(stake) FROM decisions d WHERE d.season_id=sa.season_id AND d.agent_id=sa.agent_id AND d.decision_date=$3),0) AS spent_today
     FROM season_agents sa JOIN agents a ON a.id=sa.agent_id WHERE sa.season_id=$1 AND sa.agent_id=$2`,
    [season.id, agentId, shanghaiDate()],
  );
  if (!rows[0]) throw httpError(404, "AGENT_NOT_FOUND", "当前赛季不存在该 AI");
  const [prompt, gameplayReference] = await Promise.all([
    readFile(path.join(__dirname, "ai-足球竞技场-底层提示词与输出协议.md"), "utf8"),
    readFile(path.join(__dirname, "竞彩玩法记录.md"), "utf8"),
  ]);
  let matchesPayload;
  try {
    const snapshot = await fetchMatches();
    matchesPayload = { source: snapshot.source, snapshotAt: snapshot.snapshotAt, matches: snapshot.matches };
  } catch (error) {
    const saved = await loadLatestSavedSnapshot().catch(() => null);
    matchesPayload = saved
      ? { source: "database", stale: true, snapshotAt: saved.snapshotAt, matches: saved.matches }
      : { source: "unavailable", error: error.code || "UPSTREAM_UNAVAILABLE", matches: [] };
  }
  res.json({
    ok: true,
    systemPrompt: prompt,
    gameplayReference,
    input: {
      season: { id: season.id, startsOn: dateOnly(season.starts_on), endsOn: dateOnly(season.ends_on), initialBankroll: season.initial_bankroll, dailyMin: 2, dailyMax: 10000 },
      agent: { id: rows[0].id, name: rows[0].name },
      bankroll: { current: Number(rows[0].current_balance), spentToday: Number(rows[0].spent_today) },
      sporttery: matchesPayload,
    },
  });
}));

function validateDecisionShape(body) {
  if (!body || typeof body !== "object") throw httpError(400, "INVALID_JSON", "请求体必须是 JSON 对象");
  for (const field of ["decisionId", "seasonId", "agentId", "status"]) {
    if (!body[field]) throw httpError(400, "MISSING_FIELD", `缺少字段 ${field}`);
  }
  if (!/^[A-Za-z0-9._:-]{6,120}$/.test(body.decisionId)) throw httpError(400, "INVALID_DECISION_ID", "decisionId 格式无效");
  if (!["placed", "no_bet", "fallback", "error"].includes(body.status)) throw httpError(400, "INVALID_STATUS", "status 不在允许范围");
}

async function validatePlacedDecision(body, currentBalance, spentToday) {
  const stake = body.bankroll?.stake;
  if (!Number.isInteger(stake) || stake < 2) throw httpError(422, "INVALID_STAKE", "投入必须是大于等于 2 元的整数");
  if (stake > 10000 || stake + spentToday > 10000) throw httpError(422, "DAILY_LIMIT_EXCEEDED", "当日累计投入不能超过 10000 元");
  if (stake > currentBalance) throw httpError(422, "INSUFFICIENT_BALANCE", "当前余额不足");
  const ticket = body.ticket;
  const legs = ticket?.legs;
  if (!ticket || !Array.isArray(legs)) throw httpError(422, "MISSING_TICKET", "placed 状态必须包含 ticket.legs");
  if (ticket.passType === "single" && (legs.length !== 1 || ticket.passRule !== "single")) throw httpError(422, "SINGLE_NEEDS_1_LEG", "单关必须恰好一场且 passRule 为 single");
  if (ticket.passType === "parlay" && legs.length < 2) throw httpError(422, "PARLAY_NEEDS_2_LEGS", "串关至少需要两场比赛");
  if (!["single", "parlay"].includes(ticket.passType)) throw httpError(422, "INVALID_PASS_TYPE", "passType 仅允许 single 或 parlay");
  if (ticket.passType === "parlay" && ticket.passRule !== `${legs.length}串1`) throw httpError(422, "INVALID_PASS_RULE", "串关 passRule 必须与关数一致");
  const uniqueMatches = new Set(legs.map((leg) => String(leg.matchId)));
  if (uniqueMatches.size !== legs.length) throw httpError(422, "DUPLICATE_MATCH", "同一张串关不能重复比赛");

  const snapshot = await fetchMatches(true);
  const matchMap = new Map(snapshot.matches.map((match) => [match.matchId, match]));
  const checkedLegs = legs.map((leg, index) => {
    const match = matchMap.get(String(leg.matchId));
    if (!match) throw httpError(422, "MATCH_NOT_FOUND", `第 ${index + 1} 关比赛不存在于当前快照`);
    const poolCode = String(leg.poolCode || "").toUpperCase();
    const market = match.markets.find((item) => item.poolCode === poolCode);
    if (!market || !market.isSelling) throw httpError(422, "NO_SELLING_ODDS", `第 ${index + 1} 关玩法未开售或赔率不完整`);
    const selection = String(leg.selection || "").toUpperCase();
    if (!["H", "D", "A"].includes(selection)) throw httpError(422, "INVALID_SELECTION", `第 ${index + 1} 关选项无效`);
    const currentOdds = market.odds[selection];
    if (Math.abs(Number(leg.odds) - currentOdds) > 0.0001) throw httpError(409, "STALE_SNAPSHOT", `第 ${index + 1} 关赔率已经变化`);
    if (poolCode === "HHAD" && String(leg.goalLine) !== String(market.goalLine)) throw httpError(422, "INVALID_GOAL_LINE", `第 ${index + 1} 关让球值不一致`);
    if (ticket.passType === "single" && market.singleEligible !== true) throw httpError(422, "SINGLE_NOT_ELIGIBLE", "该玩法池不支持单关或资格无法确认");
    if (ticket.passType === "parlay" && market.parlayEligible !== true) throw httpError(422, "PARLAY_NOT_ELIGIBLE", `第 ${index + 1} 关不支持串关或资格无法确认`);
    return { ...leg, match, market, poolCode, selection, odds: currentOdds };
  });
  const combinedOdds = checkedLegs.reduce((total, leg) => total * leg.odds, 1);
  return { stake, checkedLegs, snapshot, combinedOdds, expectedBonus: Number((stake * combinedOdds).toFixed(2)) };
}

async function validateNoBet(currentBalance) {
  if (currentBalance < 2) return null;
  const snapshot = await fetchMatches(true);
  const candidates = snapshot.matches.flatMap((match) => match.markets).filter((market) =>
    market.isSelling && (market.singleEligible === true || market.parlayEligible === true),
  );
  if (candidates.length) throw httpError(422, "NO_BET_NOT_ALLOWED", "当前仍有合法单关或串关候选，不能返回 no_bet");
  return snapshot;
}

app.post("/api/decisions", asyncRoute(async (req, res) => {
  requireAdmin(req);
  const body = req.body;
  validateDecisionShape(body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const season = await getCurrentSeason(client);
    if (body.seasonId !== season.id) throw httpError(409, "SEASON_MISMATCH", "seasonId 不是当前赛季");
    const { rows } = await client.query(
      `SELECT sa.*,a.name FROM season_agents sa JOIN agents a ON a.id=sa.agent_id
       WHERE sa.season_id=$1 AND sa.agent_id=$2 FOR UPDATE OF sa`, [season.id, body.agentId],
    );
    if (!rows[0]) throw httpError(404, "AGENT_NOT_FOUND", "当前赛季不存在该 AI");
    const decidedAt = body.decidedAt ? new Date(body.decidedAt) : new Date();
    if (Number.isNaN(decidedAt.getTime())) throw httpError(400, "INVALID_DECIDED_AT", "decidedAt 不是有效时间");
    const decisionDate = shanghaiDate(decidedAt);
    if (decisionDate !== shanghaiDate()) throw httpError(409, "DECISION_DATE_MISMATCH", "只能提交当前自然日的 AI 决策");
    const { rows: spentRows } = await client.query(
      "SELECT COALESCE(SUM(stake),0) AS spent FROM decisions WHERE season_id=$1 AND agent_id=$2 AND decision_date=$3",
      [season.id, body.agentId, decisionDate],
    );
    const currentBalance = Number(rows[0].current_balance);
    const spentToday = Number(spentRows[0].spent);
    let validated = null;
    if (body.status === "placed") validated = await validatePlacedDecision(body, currentBalance, spentToday);
    if (body.status === "no_bet") await validateNoBet(currentBalance);
    const stake = validated?.stake || 0;
    const strategyMode = body.strategy?.mode || null;
    const confidence = body.strategy?.confidence ?? null;
    if (strategyMode && !["conservative", "steady", "aggressive", "high_return", "custom"].includes(strategyMode)) throw httpError(422, "INVALID_STRATEGY", "strategy.mode 不在允许范围");
    if (confidence != null && (!Number.isInteger(confidence) || confidence < 0 || confidence > 100)) throw httpError(422, "INVALID_CONFIDENCE", "confidence 必须是 0–100 的整数");
    const balanceAfter = currentBalance - stake;
    const expectedBonus = validated?.expectedBonus || null;
    const normalizedAiOutput = {
      ...body,
      bankroll: {
        ...(body.bankroll || {}),
        before: currentBalance,
        after: balanceAfter,
        stake,
        expectedBonus,
        currency: body.bankroll?.currency || "CNY",
      },
      ticket: validated ? { ...(body.ticket || {}), combinedOdds: validated.combinedOdds } : body.ticket,
    };
    await client.query(
      `INSERT INTO decisions
       (decision_id,season_id,agent_id,decision_date,decided_at,status,strategy_mode,confidence,stake,pass_type,pass_rule,combined_odds,reason,expected_bonus,balance_before,balance_after,api_snapshot_id,api_snapshot_at,api_source_url,ai_output,raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [body.decisionId, season.id, body.agentId, decisionDate, body.decidedAt || new Date(), body.status, strategyMode, confidence,
        stake, body.ticket?.passType || null, body.ticket?.passRule || null, validated?.combinedOdds || null, body.analysis?.thesis || body.reason || "",
        expectedBonus, currentBalance, balanceAfter, validated?.snapshot.snapshotId || null, validated?.snapshot.snapshotAt || null,
        validated ? SPORTTERY_URL : null, JSON.stringify(normalizedAiOutput), JSON.stringify(body)],
    );
    if (validated) {
      for (const [index, leg] of validated.checkedLegs.entries()) {
        const labels = { H: leg.poolCode === "HAD" ? "主胜" : "让胜", D: leg.poolCode === "HAD" ? "平" : "让平", A: leg.poolCode === "HAD" ? "客胜" : "让负" };
        await client.query(
          `INSERT INTO decision_legs
           (decision_id,leg_order,match_id,match_num,league,kickoff,home_team,away_team,pool_code,selection,selection_label,goal_line,odds,match_status,pool_status,single_eligible,parlay_eligible)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [body.decisionId, index + 1, leg.match.matchId, leg.match.matchNum, leg.match.league, leg.match.kickoff,
            leg.match.homeTeam, leg.match.awayTeam, leg.poolCode, leg.selection, labels[leg.selection], leg.market.goalLine,
            leg.odds, leg.match.matchStatus, leg.market.poolStatus, leg.market.singleEligible, leg.market.parlayEligible],
        );
      }
      await client.query(
        "UPDATE season_agents SET current_balance=current_balance-$1, season_spent=season_spent+$1, tickets=tickets+1 WHERE season_id=$2 AND agent_id=$3",
        [stake, season.id, body.agentId],
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ ok: true, decisionId: body.decisionId, status: body.status, acceptedStake: stake, combinedOdds: validated?.combinedOdds || null, expectedBonus, balanceBefore: currentBalance, balanceAfter });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") throw httpError(409, "DUPLICATE_DECISION", "该 AI 当天已有决策或 decisionId 已存在");
    throw error;
  } finally {
    client.release();
  }
}));

app.patch("/api/decisions/:decisionId/settle", asyncRoute(async (req, res) => {
  requireAdmin(req);
  const { rows } = await pool.query("SELECT decision_date,status,result FROM decisions WHERE decision_id=$1", [req.params.decisionId]);
  const decision = rows[0];
  if (!decision) throw httpError(404, "DECISION_NOT_FOUND", "投注单不存在");
  if (decision.status !== "placed" || decision.result !== "pending") throw httpError(409, "DECISION_NOT_SETTLEABLE", "投注单不是待结算状态");
  const decisionDate = dateOnly(decision.decision_date);
  const batch = await fetchMatchResults({ beginDate: decisionDate, endDate: decisionDate });
  await persistMatchResults(pool, batch);
  const verification = await verifyAndSettlePending(pool, { decisionId: req.params.decisionId });
  if (!verification.settled.length) {
    throw httpError(409, "RESULT_NOT_FINAL", "官方赛果尚未完整发布，投注单保持待结算", verification.pending[0]);
  }
  res.json({ ok: true, source: "sporttery-result-api", ...verification.settled[0] });
}));

app.use("/api", (_req, _res, next) => next(httpError(404, "API_NOT_FOUND", "接口不存在")));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], maxAge: 0, etag: true }));
app.get("*splat", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((error, _req, res, _next) => {
  const status = Number(error.status) || 500;
  console.error(`[${new Date().toISOString()}]`, error.code || error.name, error.message);
  res.status(status).json({ ok: false, error: { code: error.code || "INTERNAL_ERROR", message: status >= 500 ? "服务暂时不可用" : error.message, details: error.details } });
});

async function refreshFootballData() {
  const config = await loadAiModelsConfig(undefined, { reload: true });
  const season = await getCurrentSeason();
  const participantSync = await syncConfiguredParticipants(pool, config, { seasonId: season.id, initialBankroll: season.initial_bankroll });
  const snapshot = await fetchMatches(true);
  const today = shanghaiDate();
  const demo = await ensureDailyDemoDecisions(pool, {
    seasonId: season.id, decisionDate: today, snapshotId: snapshot.snapshotId, snapshotAt: snapshot.snapshotAt,
    sourceUrl: SPORTTERY_URL, matches: snapshot.matches,
  });
  const { rows } = await pool.query("SELECT MIN(decision_date) AS oldest FROM decisions WHERE status='placed' AND result='pending'");
  const beginDate = rows[0]?.oldest ? dateOnly(rows[0].oldest) : shiftDate(today, -2);
  const results = await syncResultsAndSettle(pool, { beginDate, endDate: today });
  return { participantSync, demo, results };
}

async function start() {
  await initDatabase();
  await syncConfiguredParticipants(pool, await loadAiModelsConfig(undefined, { reload: true }));
  await rolloverSeasonIfNeeded();
  await syncConfiguredParticipants(pool, await loadAiModelsConfig(undefined, { reload: true }));
  await removeLegacyDemoDecisions(pool);
  await refreshFootballData().catch((error) => console.error("足球数据首次同步失败：", error.code || error.message));
  const server = app.listen(PORT, "0.0.0.0", () => console.log(`AI 足彩竞技场运行于 http://0.0.0.0:${PORT}`));
  const seasonTimer = setInterval(() => rolloverSeasonIfNeeded().catch((error) => console.error("赛季轮换失败：", error)), 60 * 60 * 1000);
  const footballTimer = setInterval(() => refreshFootballData().catch((error) => console.error("足球数据定时同步失败：", error.code || error.message)), 30 * 60 * 1000);
  const modelTimer = setInterval(async () => {
    try {
      const season = await getCurrentSeason();
      await syncConfiguredParticipants(pool, await loadAiModelsConfig(undefined, { reload: true }), { seasonId: season.id, initialBankroll: season.initial_bankroll });
    } catch (error) {
      console.error("AI 模型配置同步失败：", error.code || error.message);
    }
  }, 5 * 60 * 1000);
  seasonTimer.unref();
  footballTimer.unref();
  const shutdown = async () => {
    clearInterval(seasonTimer);
    clearInterval(footballTimer);
    clearInterval(modelTimer);
    server.close(async () => { await pool.end(); process.exit(0); });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

start().catch((error) => {
  console.error("服务启动失败：", error);
  process.exit(1);
});
