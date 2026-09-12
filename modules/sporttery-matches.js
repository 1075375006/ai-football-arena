export const SPORTTERY_MATCH_URL = "https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=hhad,had";

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function parseFlag(value) {
  if (value === 1 || value === "1" || value === true) return true;
  if (value === 0 || value === "0" || value === false) return false;
  return null;
}

function getSingleEligibility(poolInfo) {
  const primary = parseFlag(poolInfo?.bettingSingle);
  const legacy = parseFlag(poolInfo?.single);
  if (primary !== null && legacy !== null && primary !== legacy) return { eligible: null, source: "conflict" };
  if (primary !== null) return { eligible: primary, source: "bettingSingle" };
  if (legacy !== null) return { eligible: legacy, source: "single" };
  return { eligible: null, source: "missing" };
}

function numberOdds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : null;
}

export function normalizeMarket(match, poolCode) {
  const rawMarket = poolCode === "HAD" ? match.had : match.hhad;
  const poolInfo = (match.poolList || []).find((item) => String(item.poolCode).toUpperCase() === poolCode);
  const odds = { H: numberOdds(rawMarket?.h), D: numberOdds(rawMarket?.d), A: numberOdds(rawMarket?.a) };
  const single = getSingleEligibility(poolInfo);
  const poolStatus = poolInfo?.poolStatus || null;
  const isSelling = match.matchStatus === "Selling" && poolStatus === "Selling" && Object.values(odds).every(Boolean);
  return {
    poolCode, poolId: poolInfo?.poolId ? String(poolInfo.poolId) : null,
    market: poolCode === "HAD" ? "胜平负" : "让球胜平负",
    goalLine: poolCode === "HHAD" && rawMarket?.goalLine != null ? String(rawMarket.goalLine) : null,
    odds, poolStatus, isSelling, singleEligible: single.eligible, eligibilitySource: single.source,
    parlayEligible: parseFlag(poolInfo?.bettingAllup),
  };
}

export function normalizeMatch(match) {
  return {
    matchId: String(match.matchId), matchNum: match.matchNumStr || "-",
    league: match.leagueAbbName || match.leagueAllName || "足球赛事",
    homeTeam: match.homeTeamAbbName || match.homeTeamAllName || "主队",
    awayTeam: match.awayTeamAbbName || match.awayTeamAllName || "客队",
    matchDate: match.matchDate || match.businessDate || null, matchTime: match.matchTime || null,
    kickoff: match.matchDate && match.matchTime ? `${match.matchDate}T${match.matchTime}+08:00` : null,
    matchStatus: match.matchStatus || null, sellStatus: match.sellStatus ?? null,
    markets: [normalizeMarket(match, "HAD"), normalizeMarket(match, "HHAD")],
  };
}

export function createSportteryMatchesService(db, { cacheTtl = 60_000, timeoutMs = 10_000 } = {}) {
  let cache = { fetchedAt: 0, snapshotAt: null, matches: [] };

  async function persistMatchSnapshot(rawPayload, matches, snapshotAt) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO match_snapshots (snapshot_at,source_url,source,match_count,raw_payload)
         VALUES ($1,$2,'sporttery',$3,$4) RETURNING id`,
        [snapshotAt, SPORTTERY_MATCH_URL, matches.length, JSON.stringify(rawPayload)],
      );
      const snapshotId = rows[0].id;
      for (const match of matches) {
        await client.query(
          `INSERT INTO match_snapshot_matches
            (snapshot_id,match_id,match_num,league,home_team,away_team,match_date,match_time,kickoff,match_status,sell_status,markets)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [snapshotId, match.matchId, match.matchNum, match.league, match.homeTeam, match.awayTeam,
            match.matchDate, match.matchTime, match.kickoff, match.matchStatus, match.sellStatus, JSON.stringify(match.markets)],
        );
      }
      await client.query("COMMIT");
      return snapshotId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function fetchMatches(force = false) {
    if (!force && cache.matches.length && Date.now() - cache.fetchedAt < cacheTtl) return { ...cache, source: "cache" };
    const response = await fetch(SPORTTERY_MATCH_URL, {
      headers: { Accept: "application/json", Origin: "https://www.sporttery.cn", Referer: "https://www.sporttery.cn/", "User-Agent": "AI-Football-Arena/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw Object.assign(new Error(`上游接口 HTTP ${response.status}`), { status: 502, code: "UPSTREAM_HTTP_ERROR" });
    const payload = await response.json();
    const rawMatches = (payload.value?.matchInfoList || []).flatMap((group) => group.subMatchList || []);
    if (!payload.success || !rawMatches.length) throw Object.assign(new Error("上游接口没有返回赛事"), { status: 502, code: "UPSTREAM_EMPTY" });
    const snapshotAt = new Date().toISOString();
    const matches = rawMatches.map(normalizeMatch);
    const snapshotId = await persistMatchSnapshot(payload, matches, snapshotAt);
    cache = { fetchedAt: Date.now(), snapshotAt, snapshotId, matches };
    return { ...cache, source: "upstream" };
  }

  async function loadLatestSavedSnapshot() {
    const { rows } = await db.query(`
      SELECT s.id,s.snapshot_at,m.match_id,m.match_num,m.league,m.home_team,m.away_team,
             m.match_date,m.match_time,m.kickoff,m.match_status,m.sell_status,m.markets
      FROM match_snapshots s JOIN match_snapshot_matches m ON m.snapshot_id=s.id
      WHERE s.id=(SELECT id FROM match_snapshots ORDER BY snapshot_at DESC,id DESC LIMIT 1)
      ORDER BY m.match_date NULLS LAST,m.match_time NULLS LAST,m.match_num
    `);
    if (!rows.length) return null;
    return {
      snapshotId: Number(rows[0].id), snapshotAt: new Date(rows[0].snapshot_at).toISOString(), source: "database",
      matches: rows.map((row) => ({
        matchId: row.match_id, matchNum: row.match_num, league: row.league, homeTeam: row.home_team, awayTeam: row.away_team,
        matchDate: dateOnly(row.match_date), matchTime: row.match_time, kickoff: row.kickoff ? new Date(row.kickoff).toISOString() : null,
        matchStatus: row.match_status, sellStatus: row.sell_status, markets: row.markets,
      })),
    };
  }

  return { fetchMatches, loadLatestSavedSnapshot, getCache: () => ({ ...cache }) };
}
