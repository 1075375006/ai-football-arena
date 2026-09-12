const RESULT_API_BASE = "https://webapi.sporttery.cn/gateway/uniform/football/getUniformMatchResultV1.qry";
const DEFAULT_RESULT_DAYS = 3;

function asText(value) {
  return value == null ? "" : String(value).trim();
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return asText(value).slice(0, 10);
}

function shanghaiDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const read = (type) => parts.find((part) => part.type === type)?.value;
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function shiftDate(value, days) {
  const date = new Date(`${dateOnly(value)}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function resultUrl({ beginDate, endDate, pageNo = 1, pageSize = 30, leagueId = "" }) {
  const params = new URLSearchParams({
    matchBeginDate: beginDate,
    matchEndDate: endDate,
    leagueId,
    pageSize: String(pageSize),
    pageNo: String(pageNo),
    isFix: "0",
    matchPage: "1",
    pcOrWap: "1",
  });
  return `${RESULT_API_BASE}?${params}`;
}

function resultHeaders() {
  return {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Origin: "https://www.sporttery.cn",
    Pragma: "no-cache",
    Referer: "https://www.sporttery.cn/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36",
  };
}

function parseScore(value) {
  const match = asText(value).match(/^(\d+)\s*[:：]\s*(\d+)$/);
  return match ? { home: Number(match[1]), away: Number(match[2]) } : { home: null, away: null };
}

export function normalizeMatchResult(raw, sourceUrl, fetchedAt = new Date().toISOString()) {
  const full = parseScore(raw.sectionsNo999);
  const half = parseScore(raw.sectionsNo1);
  const hadResult = ["H", "D", "A"].includes(asText(raw.winFlag).toUpperCase()) ? asText(raw.winFlag).toUpperCase() : null;
  const status = asText(raw.matchResultStatus);
  const resultStatus = asText(raw.resultStatus);
  const voidResult = /取消|延期|腰斩|无效|void|cancel/i.test(`${status} ${resultStatus}`);
  return {
    matchId: asText(raw.matchId), matchNum: asText(raw.matchNumStr || raw.matchNum),
    matchDate: dateOnly(raw.matchDate), league: asText(raw.leagueNameAbbr || raw.leagueName),
    homeTeam: asText(raw.allHomeTeam || raw.homeTeam), awayTeam: asText(raw.allAwayTeam || raw.awayTeam),
    homeScore: full.home, awayScore: full.away, halfHomeScore: half.home, halfAwayScore: half.away,
    hadResult, resultStatus, matchResultStatus: status, isVoid: voidResult,
    odds: { H: asNumber(raw.h), D: asNumber(raw.d), A: asNumber(raw.a) },
    goalLine: raw.goalLine == null || raw.goalLine === "" ? null : asText(raw.goalLine),
    singleEligible: raw.bettingSingle === 1 || raw.bettingSingle === "1",
    sourceUrl, fetchedAt, raw,
  };
}

export async function fetchMatchResults({ beginDate, endDate, pageSize = 30, leagueId = "", timeoutMs = 15_000 } = {}) {
  const end = endDate || shanghaiDate();
  const begin = beginDate || shiftDate(end, -(DEFAULT_RESULT_DAYS - 1));
  const firstUrl = resultUrl({ beginDate: begin, endDate: end, pageNo: 1, pageSize, leagueId });
  const fetchPage = async (pageNo) => {
    const url = resultUrl({ beginDate: begin, endDate: end, pageNo, pageSize, leagueId });
    const response = await fetch(url, { headers: resultHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw Object.assign(new Error(`赛果接口 HTTP ${response.status}`), { status: 502, code: "RESULT_UPSTREAM_HTTP_ERROR" });
    const payload = await response.json();
    if (!payload.success || !payload.value) throw Object.assign(new Error(payload.errorMessage || "赛果接口返回失败"), { status: 502, code: "RESULT_UPSTREAM_ERROR" });
    return { url, payload };
  };
  const first = await fetchPage(1);
  const totalPages = Math.max(1, Number(first.payload.value.pages) || 1);
  const pages = [first];
  for (let pageNo = 2; pageNo <= totalPages; pageNo += 1) pages.push(await fetchPage(pageNo));
  const fetchedAt = new Date().toISOString();
  const results = pages.flatMap(({ payload, url }) => (payload.value.matchResult || []).map((item) => normalizeMatchResult(item, url, fetchedAt)));
  const unique = [...new Map(results.filter((item) => item.matchId).map((item) => [item.matchId, item])).values()];
  return { beginDate: begin, endDate: end, fetchedAt, sourceUrl: firstUrl, pages: pages.length, total: unique.length, rawPages: pages, results: unique };
}

export async function persistMatchResults(db, batch) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const result of batch.results) {
      await client.query(
        `INSERT INTO match_results
          (match_id,match_date,match_num,league,home_team,away_team,home_score,away_score,half_home_score,half_away_score,
           had_result,result_status,match_result_status,odds,goal_line,single_eligible,is_void,source_url,fetched_at,raw_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (match_id) DO UPDATE SET
           match_date=EXCLUDED.match_date,match_num=EXCLUDED.match_num,league=EXCLUDED.league,
           home_team=EXCLUDED.home_team,away_team=EXCLUDED.away_team,home_score=EXCLUDED.home_score,
           away_score=EXCLUDED.away_score,half_home_score=EXCLUDED.half_home_score,half_away_score=EXCLUDED.half_away_score,
           had_result=EXCLUDED.had_result,result_status=EXCLUDED.result_status,match_result_status=EXCLUDED.match_result_status,
           odds=EXCLUDED.odds,goal_line=EXCLUDED.goal_line,single_eligible=EXCLUDED.single_eligible,
           is_void=EXCLUDED.is_void,source_url=EXCLUDED.source_url,fetched_at=EXCLUDED.fetched_at,
           raw_payload=EXCLUDED.raw_payload,updated_at=NOW()`,
        [result.matchId, result.matchDate || null, result.matchNum, result.league, result.homeTeam, result.awayTeam,
          result.homeScore, result.awayScore, result.halfHomeScore, result.halfAwayScore, result.hadResult,
          result.resultStatus, result.matchResultStatus, JSON.stringify(result.odds), result.goalLine,
          result.singleEligible, result.isVoid, result.sourceUrl, result.fetchedAt, JSON.stringify(result.raw)],
      );
    }
    await client.query("COMMIT");
    return batch.results.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function legOutcome(result, leg) {
  if (!result) return null;
  const isVoid = result.isVoid ?? result.is_void;
  const hadResult = result.hadResult ?? result.had_result;
  const homeScore = result.homeScore ?? result.home_score;
  const awayScore = result.awayScore ?? result.away_score;
  const matchResultStatus = result.matchResultStatus ?? result.match_result_status;
  const poolCode = leg.poolCode ?? leg.pool_code;
  const selection = leg.selection;
  const goalLine = leg.goalLine ?? leg.goal_line;
  if (isVoid) return "void";
  if (String(matchResultStatus) !== "2") return null;
  if (hadResult && poolCode === "HAD") return hadResult === selection ? "win" : "loss";
  if (homeScore == null || awayScore == null) return null;
  if (poolCode === "HHAD") {
    const line = Number(goalLine);
    if (!Number.isFinite(line)) return null;
    const difference = Number(homeScore) + line - Number(awayScore);
    const outcome = difference > 0 ? "H" : difference < 0 ? "A" : "D";
    return outcome === selection ? "win" : "loss";
  }
  const outcome = Number(homeScore) > Number(awayScore) ? "H" : Number(homeScore) < Number(awayScore) ? "A" : "D";
  return outcome === selection ? "win" : "loss";
}

async function settleDecisionClient(client, decision, legs, outcomes) {
  const result = outcomes.includes("loss") ? "loss" : outcomes.every((item) => item === "void") ? "void" : "win";
  const effectiveOdds = legs.reduce((total, leg, index) => outcomes[index] === "void" ? total : total * Number(leg.odds), 1);
  const payout = result === "void" ? Number(decision.stake) : result === "win" ? Number((Number(decision.stake) * effectiveOdds).toFixed(2)) : 0;
  for (const leg of legs) await client.query("UPDATE decision_legs SET result=$1 WHERE id=$2", [outcomes[leg.leg_order - 1], leg.id]);
  const { rows: accountRows } = await client.query("SELECT recent_form FROM season_agents WHERE season_id=$1 AND agent_id=$2 FOR UPDATE", [decision.season_id, decision.agent_id]);
  const form = Array.isArray(accountRows[0]?.recent_form) ? accountRows[0].recent_form : [];
  const nextForm = result === "void" ? form : [...form, result === "win" ? 1 : 0].slice(-10);
  await client.query("UPDATE decisions SET result=$1,payout=$2,settled_at=NOW() WHERE decision_id=$3", [result, payout, decision.decision_id]);
  await client.query(
    `UPDATE season_agents SET current_balance=current_balance+$1,wins=wins+$2,losses=losses+$3,recent_form=$4
     WHERE season_id=$5 AND agent_id=$6`,
    [payout, result === "win" ? 1 : 0, result === "loss" ? 1 : 0, JSON.stringify(nextForm), decision.season_id, decision.agent_id],
  );
  return { decisionId: decision.decision_id, result, payout, outcomes };
}

export async function verifyAndSettlePending(db, { decisionId = null } = {}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const params = decisionId ? [decisionId] : [];
    const where = decisionId ? "AND d.decision_id=$1" : "";
    const { rows: decisions } = await client.query(`SELECT d.* FROM decisions d WHERE d.status='placed' AND d.result='pending' ${where} FOR UPDATE`, params);
    const settled = [];
    const pending = [];
    for (const decision of decisions) {
      const { rows: legs } = await client.query("SELECT * FROM decision_legs WHERE decision_id=$1 ORDER BY leg_order FOR UPDATE", [decision.decision_id]);
      const { rows: results } = await client.query("SELECT * FROM match_results WHERE match_id = ANY($1::text[])", [legs.map((leg) => leg.match_id)]);
      const byMatch = new Map(results.map((item) => [item.match_id, item]));
      const outcomes = legs.map((leg) => legOutcome(byMatch.get(leg.match_id), leg));
      if (outcomes.some((outcome) => !outcome)) {
        pending.push({ decisionId: decision.decision_id, outcomes });
        continue;
      }
      settled.push(await settleDecisionClient(client, decision, legs, outcomes));
    }
    await client.query("COMMIT");
    return { settled, pending };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function syncResultsAndSettle(db, options = {}) {
  const batch = await fetchMatchResults(options);
  await persistMatchResults(db, batch);
  const settlement = await verifyAndSettlePending(db, { decisionId: options.decisionId || null });
  return { batch: { beginDate: batch.beginDate, endDate: batch.endDate, fetchedAt: batch.fetchedAt, pages: batch.pages, total: batch.total, sourceUrl: batch.sourceUrl }, settlement };
}

export { RESULT_API_BASE, resultUrl, shanghaiDate, shiftDate };
