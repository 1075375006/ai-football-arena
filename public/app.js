const fallbackModels = [
  ["gpt-5", "GPT-5", "G5", "#0c6b45", "#eaf4ee"],
  ["claude-4", "Claude 4", "C4", "#b85c2f", "#fff0e8"],
  ["gemini-2-5", "Gemini 2.5", "G✦", "#315aa6", "#ebf0fb"],
  ["deepseek-r1", "DeepSeek R1", "DS", "#6c4bb4", "#f0ecfa"],
  ["grok-3", "Grok 3", "GX", "#c73f3a", "#faecea"],
  ["qwen-max", "Qwen Max", "QW", "#9a7220", "#f7f0df"],
].map(([id, name, monogram, color, soft]) => ({ id, name, monogram, color, soft, confidence: 0, betType: "single", passLabel: "待决策", stake: 0, currentBalance: 10000, seasonSpent: 0, legs: [], combinedOdds: "--", reason: "正在读取本轮真实赛事与 AI 决策。", form: [], hitRate: 0 }));

let models = [...fallbackModels];
let activeRanking = "form";
const currency = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 });
const bonusCurrency = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 });
const pickGrid = document.querySelector("#pick-grid");
const rankingList = document.querySelector("#ranking-list");
const metricLabel = document.querySelector("#metric-label");
const valueLabel = document.querySelector("#value-label");
const rankingPanel = document.querySelector("#ranking-panel");
const rankingNote = document.querySelector("#ranking-note");
const apiStatus = document.querySelector("#api-status");
const availabilityNote = document.querySelector("#availability-note");
const matchCount = document.querySelector("#match-count");
const todayList = document.querySelector("#today-list");
const todaySummary = document.querySelector("#today-summary");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function setApiStatus(connected, message) {
  apiStatus.className = `api-status ${connected ? "connected" : "fallback"}`;
  apiStatus.innerHTML = `<span class="status-dot"></span>${connected ? "服务数据已连接" : "演示数据"}`;
  availabilityNote.textContent = message;
}

function marketLabel(leg) {
  const base = leg.poolCode === "HHAD" ? "让球胜平负" : "胜平负";
  const label = leg.selectionLabel || ({ H: "主胜", D: "平", A: "客胜" }[leg.selection] || leg.selection);
  return `${base} · ${label}${leg.goalLine == null ? "" : `(${leg.goalLine})`}`;
}

function estimatedBonus(model) {
  if (Number.isFinite(Number(model.expectedBonus)) && Number(model.expectedBonus) > 0) return bonusCurrency.format(Number(model.expectedBonus));
  const odds = Number(model.combinedOdds);
  return Number.isFinite(odds) && odds > 0 ? bonusCurrency.format(model.stake * odds) : "--";
}

function dashboardAgentToModel(agent) {
  const decision = agent.decision;
  const settled = agent.wins + agent.losses;
  const strategyLabels = { conservative: "保守", steady: "稳健", aggressive: "激进", high_return: "高收益", custom: "自定义" };
  return {
    ...agent,
    strategy: strategyLabels[decision?.strategy] || decision?.strategy || "本轮未决策",
    confidence: decision?.confidence ?? 0,
    betType: decision?.passType || "single",
    passLabel: decision?.passType === "single" ? "单关" : `串关 · ${decision?.passRule || "待定"}`,
    stake: decision?.stake || 0,
    combinedOdds: decision?.combinedOdds || "--",
    expectedBonus: decision?.expectedBonus ?? null,
    balanceBefore: decision?.balanceBefore ?? null,
    balanceAfter: decision?.balanceAfter ?? null,
    reason: decision?.reason || "今日尚未提交合法投注单。",
    hitRate: settled ? Math.round(agent.wins / settled * 100) : 0,
    legs: (decision?.legs || []).map((leg) => ({
      league: leg.league,
      time: leg.kickoff ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(leg.kickoff)).replace("/", "-") : "--",
      fixture: `${leg.homeTeam} vs ${leg.awayTeam}`,
      market: marketLabel(leg),
      odds: leg.odds,
    })),
  };
}

function renderPicks() {
  pickGrid.innerHTML = models.map((model) => `
    <article class="pick-card" style="--accent:${escapeHtml(model.color)};--accent-soft:${escapeHtml(model.soft)}">
      <div class="model-row">
        <div class="model-identity"><span class="model-icon">${escapeHtml(model.monogram)}</span><div><div class="model-name">${escapeHtml(model.name)}</div></div></div>
        <span class="confidence">信心 ${escapeHtml(model.confidence)}%</span>
      </div>
      <div class="decision-row"><span class="bet-type ${model.betType === "single" ? "single" : "parlay"}">${escapeHtml(model.passLabel)}</span><span class="strategy">本轮策略 · ${escapeHtml(model.strategy || "未决策")}</span>${model.result && model.result !== "pending" ? `<span class="strategy">${model.result === "win" ? "已命中" : model.result === "loss" ? "未命中" : "无效退回"}</span>` : ""}</div>
      <div class="legs">${model.legs.length ? model.legs.map((leg, index) => `
        <div class="leg"><span class="leg-index">${model.betType === "single" ? "单" : index + 1}</span><div class="leg-main"><div class="leg-meta">${escapeHtml(leg.league)} · ${escapeHtml(leg.time)}</div><div class="fixture">${escapeHtml(leg.fixture)}</div><span class="market">${escapeHtml(leg.market)}</span></div><span class="leg-odds">${escapeHtml(leg.odds)}</span></div>`).join("") : '<div class="empty-state">等待今日决策</div>'}</div>
      <div class="stake-row"><div><small>本次虚拟投入</small><strong>${currency.format(model.stake)}</strong></div><div class="combined-odds"><small>${model.betType === "single" ? "参考倍率" : "串关参考倍率"}</small><strong>${escapeHtml(model.combinedOdds)}</strong></div><div class="estimated-bonus"><small>预计奖金</small><strong>${escapeHtml(estimatedBonus(model))}</strong></div></div>
      <div class="reason-row">${escapeHtml(model.reason)}</div>
    </article>`).join("");
}

function renderRanking(type) {
  activeRanking = type;
  const ranked = [...models].sort((a, b) => type === "form" ? b.hitRate - a.hitRate || b.currentBalance - a.currentBalance : b.currentBalance - a.currentBalance);
  metricLabel.textContent = type === "form" ? "近 10 张投注单" : "当前资金 / 赛季已投入";
  valueLabel.textContent = type === "form" ? "命中率" : "净收益";
  rankingNote.textContent = type === "form" ? "红黑按整张投注单结算：串关须全部命中才计红" : "初始资金 ¥10,000 · 收益率 = 净收益 ÷ 初始资金";
  rankingList.innerHTML = ranked.map((model, index) => {
    const form = Array.isArray(model.form) ? model.form : [];
    const metric = type === "form"
      ? `<div class="form-strip" aria-label="近 ${form.length} 张">${form.length ? form.map((item) => `<span class="form-dot ${item ? "win" : "loss"}">${item ? "红" : "黑"}</span>`).join("") : '<span class="no-form">暂无结算</span>'}</div>`
      : `<div class="bankroll-metric"><strong>${currency.format(model.currentBalance)}</strong><span>已投入 ${currency.format(model.seasonSpent)}</span></div>`;
    const netProfit = model.currentBalance - 10000;
    const value = type === "form" ? `${model.hitRate}%` : `${netProfit >= 0 ? "+" : "-"}${currency.format(Math.abs(netProfit))}<small>${netProfit >= 0 ? "+" : ""}${(netProfit / 100).toFixed(1)}%</small>`;
    return `<div class="ranking-row"><div class="rank-model"><span class="rank-number">${String(index + 1).padStart(2, "0")}</span><span class="rank-avatar" style="--avatar:${escapeHtml(model.color)};--avatar-soft:${escapeHtml(model.soft)}">${escapeHtml(model.monogram)}</span><span class="rank-name">${escapeHtml(model.name)}</span></div>${metric}<span class="rank-value ${type === "profit" ? (netProfit >= 0 ? "positive" : "negative") : ""}">${value}</span></div>`;
  }).join("");
}

function renderTodayMatches(matches) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const sameDay = matches.filter((match) => match.matchDate === today);
  const list = (sameDay.length ? sameDay : matches).slice(0, 12);
  todaySummary.textContent = list.length ? `${list.length} 场赛事 · 开赛时间与赔率随官网更新` : "暂时没有可展示的赛事";
  todayList.innerHTML = list.length ? list.map((match) => {
    const market = match.markets.find((item) => item.poolCode === "HAD" && item.isSelling) || match.markets.find((item) => item.poolCode === "HHAD" && item.isSelling) || match.markets[0];
    const selling = Boolean(market?.isSelling);
    const odds = selling ? `${market.odds.H} / ${market.odds.D} / ${market.odds.A}` : "-- / -- / --";
    const line = market?.poolCode === "HHAD" ? ` · 让 ${market.goalLine}` : "";
    return `<article class="today-match ${selling ? "selling" : "unavailable"}"><div class="today-time"><strong>${escapeHtml(match.matchTime?.slice(0, 5) || "--:--")}</strong><span>${escapeHtml(match.matchNum)}</span></div><div class="today-fixture"><span>${escapeHtml(match.league)}</span><strong>${escapeHtml(match.homeTeam)} <em>VS</em> ${escapeHtml(match.awayTeam)}</strong></div><div class="today-market"><span>${escapeHtml(market?.market || "待开售")}${escapeHtml(line)}</span><strong>${escapeHtml(odds)}</strong></div><span class="today-status">${selling ? "在售" : "未开售"}</span></article>`;
  }).join("") : '<div class="list-empty">上游赛事暂不可用，请稍后刷新</div>';
}

async function loadDashboard() {
  const response = await fetch("/api/dashboard", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`dashboard ${response.status}`);
  const payload = await response.json();
  models = payload.agents.map(dashboardAgentToModel);
  document.querySelector("#season-progress").textContent = `${payload.season.label} · 第 ${payload.season.day}/${payload.season.totalDays} 天`;
  document.querySelector("#round-status-text").textContent = `${payload.season.label} · 第 ${payload.season.day} 日决策中`;
  document.querySelector("#initial-bankroll").textContent = `每个 AI 初始资金 ${currency.format(payload.season.initialBankroll)}`;
  renderPicks();
  renderRanking(activeRanking);
}

async function loadMatches() {
  const response = await fetch("/api/matches", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`matches ${response.status}`);
  const payload = await response.json();
  matchCount.textContent = payload.count;
  setApiStatus(true, payload.source === "stale-cache" ? "官网暂不可用，显示最近一次赛事快照" : "玩法与赔率经本地服务代理自竞彩网");
  renderTodayMatches(payload.matches || []);
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((item) => { const active = item === tab; item.classList.toggle("active", active); item.setAttribute("aria-selected", String(active)); });
  rankingPanel.setAttribute("aria-labelledby", tab.id);
  renderRanking(tab.dataset.ranking);
}));

renderPicks();
renderRanking("form");
renderTodayMatches([]);
Promise.allSettled([loadDashboard(), loadMatches()]).then((results) => {
  if (results[0].status === "rejected") setApiStatus(false, "数据库服务不可用，显示演示赛季数据");
  if (results[1].status === "rejected") { matchCount.textContent = "--"; renderTodayMatches([]); setApiStatus(false, "官网赛事暂不可用，AI 选择仍取自赛季数据"); }
});
