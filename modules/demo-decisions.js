function selectionForMarket(market, variant) {
  const entries = Object.entries(market.odds).filter(([, odds]) => Number.isFinite(Number(odds)) && Number(odds) > 1);
  entries.sort((a, b) => Number(a[1]) - Number(b[1]));
  return entries[Math.min(variant, entries.length - 1)] || null;
}

function strategyForOdds(odds) {
  if (odds <= 2.2) return "conservative";
  if (odds <= 4) return "steady";
  if (odds <= 8) return "aggressive";
  return "high_return";
}

function stakeForOdds(odds, balance, seed) {
  const target = odds <= 2.2 ? 300 : odds <= 4 ? 180 : odds <= 8 ? 80 : 20;
  return Math.max(2, Math.min(Math.floor(Number(balance)), target + (seed % 4) * 20));
}

function availableMarkets(matches) {
  return matches.flatMap((match) => (match.markets || [])
    .filter((market) => market.isSelling)
    .map((market) => ({ match, market })));
}

function chooseTicket(matches, seed) {
  const markets = availableMarkets(matches);
  const singleMarkets = markets.filter(({ market }) => market.singleEligible);
  if (seed % 3 === 1 && singleMarkets.length) {
    const item = singleMarkets[seed % singleMarkets.length];
    const selection = selectionForMarket(item.market, seed % 2);
    return selection ? { passType: "single", passRule: "single", legs: [{ ...item, selection }] } : null;
  }
  const parlayMarkets = markets.filter(({ market }) => market.parlayEligible);
  const legs = [];
  for (let offset = 0; offset < parlayMarkets.length && legs.length < 2; offset += 1) {
    const item = parlayMarkets[(seed * 3 + offset) % parlayMarkets.length];
    if (legs.some((leg) => leg.match.matchId === item.match.matchId)) continue;
    const selection = selectionForMarket(item.market, (seed + offset) % 2);
    if (selection) legs.push({ ...item, selection });
  }
  return legs.length === 2 ? { passType: "parlay", passRule: "2串1", legs } : null;
}

export async function removeLegacyDemoDecisions(db) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: affected } = await client.query(`
      SELECT DISTINCT d.season_id,d.agent_id
      FROM decisions d JOIN decision_legs l ON l.decision_id=d.decision_id
      WHERE l.match_id LIKE 'demo-%'
    `);
    await client.query(`DELETE FROM decisions d WHERE EXISTS (
      SELECT 1 FROM decision_legs l WHERE l.decision_id=d.decision_id AND l.match_id LIKE 'demo-%'
    )`);
    for (const row of affected) {
      const { rows: remaining } = await client.query(
        "SELECT COUNT(*)::int AS count FROM decisions WHERE season_id=$1 AND agent_id=$2",
        [row.season_id, row.agent_id],
      );
      if (remaining[0].count === 0) {
        await client.query(
          `UPDATE season_agents sa SET current_balance=s.initial_bankroll,season_spent=0,wins=0,losses=0,tickets=0,recent_form='[]'::jsonb
           FROM seasons s WHERE sa.season_id=s.id AND sa.season_id=$1 AND sa.agent_id=$2`,
          [row.season_id, row.agent_id],
        );
      }
    }
    await client.query("COMMIT");
    return affected.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureDailyDemoDecisions(db, { seasonId, decisionDate, snapshotId, snapshotAt, sourceUrl, matches }) {
  const sameDay = matches.filter((match) => match.matchDate === decisionDate);
  const candidates = availableMarkets(sameDay).length >= 2 ? sameDay : matches;
  if (!candidates.length) return { created: 0, reason: "没有可用赛事" };
  const client = await db.connect();
  let created = 0;
  try {
    await client.query("BEGIN");
    const { rows: agents } = await client.query(
      `SELECT a.id,a.name,sa.current_balance FROM season_agents sa JOIN agents a ON a.id=sa.agent_id
       WHERE sa.season_id=$1 AND a.active=TRUE ORDER BY a.id FOR UPDATE OF sa`,
      [seasonId],
    );
    for (let index = 0; index < agents.length; index += 1) {
      const agent = agents[index];
      const { rows: existing } = await client.query(
        "SELECT 1 FROM decisions WHERE season_id=$1 AND agent_id=$2 AND decision_date=$3",
        [seasonId, agent.id, decisionDate],
      );
      if (existing.length || Number(agent.current_balance) < 2) continue;
      const ticket = chooseTicket(candidates, index + Number(decisionDate.replaceAll("-", "")));
      if (!ticket) continue;
      const combinedOdds = Number(ticket.legs.reduce((total, leg) => total * Number(leg.selection[1]), 1).toFixed(4));
      const strategy = strategyForOdds(combinedOdds);
      const stake = stakeForOdds(combinedOdds, agent.current_balance, index);
      const expectedBonus = Number((stake * combinedOdds).toFixed(2));
      const balanceAfter = Number(agent.current_balance) - stake;
      const confidence = Math.max(45, Math.min(90, Math.round(96 - combinedOdds * 5)));
      const decisionId = `${seasonId}-${agent.id}-${decisionDate.replaceAll("-", "")}-sample`;
      const reason = `演示决策基于 ${decisionDate} 官方在售赛事快照，策略随本轮组合倍率和资金动态生成。`;
      const outputLegs = ticket.legs.map(({ match, market, selection }, legIndex) => ({
        matchId: match.matchId, matchNum: match.matchNum, league: match.league, kickoff: match.kickoff,
        homeTeam: match.homeTeam, awayTeam: match.awayTeam, poolCode: market.poolCode, market: market.market,
        selection: selection[0], selectionLabel: market.poolCode === "HHAD"
          ? { H: "让胜", D: "让平", A: "让负" }[selection[0]]
          : { H: "主胜", D: "平", A: "客胜" }[selection[0]],
        goalLine: market.goalLine, odds: Number(selection[1]), matchStatus: match.matchStatus,
        poolStatus: market.poolStatus, singleEligible: market.singleEligible, parlayEligible: market.parlayEligible,
      }));
      const aiOutput = {
        schemaVersion: "1.0", decisionId, seasonId, agentId: agent.id, status: "placed",
        decidedAt: new Date().toISOString(), source: "dynamic-sample",
        strategy: { mode: strategy, confidence, summary: reason },
        bankroll: { before: Number(agent.current_balance), stake, after: balanceAfter, expectedBonus, currency: "CNY" },
        ticket: { passType: ticket.passType, passRule: ticket.passRule, legCount: outputLegs.length, combinedOdds, legs: outputLegs },
      };
      await client.query(
        `INSERT INTO decisions
          (decision_id,season_id,agent_id,decision_date,decided_at,status,strategy_mode,confidence,stake,pass_type,pass_rule,
           combined_odds,reason,expected_bonus,balance_before,balance_after,api_snapshot_id,api_snapshot_at,api_source_url,ai_output,raw_payload)
         VALUES ($1,$2,$3,$4,NOW(),'placed',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
        [decisionId, seasonId, agent.id, decisionDate, strategy, confidence, stake, ticket.passType, ticket.passRule,
          combinedOdds, reason, expectedBonus, agent.current_balance, balanceAfter, snapshotId, snapshotAt, sourceUrl, JSON.stringify(aiOutput)],
      );
      for (let legIndex = 0; legIndex < outputLegs.length; legIndex += 1) {
        const leg = outputLegs[legIndex];
        await client.query(
          `INSERT INTO decision_legs
            (decision_id,leg_order,match_id,match_num,league,kickoff,home_team,away_team,pool_code,selection,selection_label,
             goal_line,odds,match_status,pool_status,single_eligible,parlay_eligible)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [decisionId, legIndex + 1, leg.matchId, leg.matchNum, leg.league, leg.kickoff, leg.homeTeam, leg.awayTeam,
            leg.poolCode, leg.selection, leg.selectionLabel, leg.goalLine, leg.odds, leg.matchStatus, leg.poolStatus,
            leg.singleEligible, leg.parlayEligible],
        );
      }
      await client.query(
        "UPDATE season_agents SET current_balance=$1,season_spent=season_spent+$2,tickets=tickets+1 WHERE season_id=$3 AND agent_id=$4",
        [balanceAfter, stake, seasonId, agent.id],
      );
      created += 1;
    }
    await client.query("COMMIT");
    return { created, sourceMatches: candidates.length, decisionDate };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
