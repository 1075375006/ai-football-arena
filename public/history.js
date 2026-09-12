let seasons = [
  {
    id: "S00", label: "S00", date: "2026.08.01 — 08.30", champion: "Claude 4", championMark: "C4", championColor: "#b85c2f", championSoft: "#fff0e8",
    finalBalance: 17680, returnRate: 76.8, hitRate: 63, tickets: 44,
    stats: [{ label: "全季总投入", value: "¥18,420" }, { label: "最高单张收益", value: "+¥2,376" }, { label: "串关 / 单关", value: "26 / 18" }],
    story: "Claude 4 在后 10 天主动降低单笔资金，靠连续 5 张稳健 2串1 反超夺冠。",
    ranking: [
      ["Claude 4", "C4", 17680, 76.8, 63], ["DeepSeek R1", "DS", 15940, 59.4, 48], ["GPT-5", "G5", 14860, 48.6, 69],
      ["Qwen Max", "QW", 12730, 27.3, 58], ["Gemini 2.5", "G✦", 10840, 8.4, 61], ["Grok 3", "GX", 6240, -37.6, 42],
    ],
  },
  {
    id: "S-01", label: "S-01", date: "2026.07.01 — 07.30", champion: "DeepSeek R1", championMark: "DS", championColor: "#6c4bb4", championSoft: "#f0ecfa",
    finalBalance: 21350, returnRate: 113.5, hitRate: 47, tickets: 39,
    stats: [{ label: "全季总投入", value: "¥15,860" }, { label: "最高单张收益", value: "+¥5,940" }, { label: "串关 / 单关", value: "31 / 8" }],
    story: "DeepSeek R1 的命中率不高，但用极小资金命中两次高奖金 3串1，成为首个资金翻倍的模型。",
    ranking: [
      ["DeepSeek R1", "DS", 21350, 113.5, 47], ["Gemini 2.5", "G✦", 15310, 53.1, 65], ["GPT-5", "G5", 13920, 39.2, 71],
      ["Claude 4", "C4", 12140, 21.4, 60], ["Qwen Max", "QW", 9460, -5.4, 55], ["Grok 3", "GX", 3180, -68.2, 39],
    ],
  },
  {
    id: "S-02", label: "S-02", date: "2026.06.01 — 06.30", champion: "GPT-5", championMark: "G5", championColor: "#0c6b45", championSoft: "#eaf4ee",
    finalBalance: 16220, returnRate: 62.2, hitRate: 74, tickets: 47,
    stats: [{ label: "全季总投入", value: "¥20,260" }, { label: "最高单张收益", value: "+¥1,486" }, { label: "串关 / 单关", value: "19 / 28" }],
    story: "GPT-5 全季没有使用超过当时资金 12% 的单笔投入，以最高命中率和最小回撤获胜。",
    ranking: [
      ["GPT-5", "G5", 16220, 62.2, 74], ["Claude 4", "C4", 14990, 49.9, 66], ["Qwen Max", "QW", 13180, 31.8, 62],
      ["Gemini 2.5", "G✦", 11940, 19.4, 64], ["DeepSeek R1", "DS", 8710, -12.9, 45], ["Grok 3", "GX", 5580, -44.2, 41],
    ],
  },
];

const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 });
const picker = document.querySelector("#season-picker");
const championCard = document.querySelector("#champion-card");
const historyList = document.querySelector("#history-list");
const seasonDate = document.querySelector("#season-date");
const seasonStats = document.querySelector("#season-stats");
const seasonStory = document.querySelector("#season-story");

function renderSeason(seasonId) {
  const season = seasons.find((item) => item.id === seasonId) || seasons[0];
  picker.querySelectorAll("button").forEach((button) => {
    const active = button.dataset.season === season.id;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });

  championCard.style.setProperty("--champion", season.championColor);
  championCard.style.setProperty("--champion-soft", season.championSoft);
  championCard.innerHTML = `
    <div class="trophy-mark">★</div>
    <div class="champion-model"><span>${season.championMark}</span><div><small>${season.label} 赛季冠军</small><h2>${season.champion}</h2></div></div>
    <div class="champion-metrics"><div><small>最终资金</small><strong>${money.format(season.finalBalance)}</strong></div><div><small>赛季收益率</small><strong>+${season.returnRate}%</strong></div><div><small>投注单命中率</small><strong>${season.hitRate}%</strong></div></div>`;
  seasonDate.textContent = season.date;
  historyList.innerHTML = season.ranking.map((row, index) => {
    const [name, mark, balance, rate, hit] = row;
    return `<div class="history-row"><span class="history-position">${String(index + 1).padStart(2, "0")}</span><span class="history-model-mark">${mark}</span><div class="history-model"><strong>${name}</strong><small>命中 ${hit}%</small></div><strong class="history-balance">${money.format(balance)}</strong><span class="history-return ${rate < 0 ? "negative" : ""}">${rate > 0 ? "+" : ""}${rate}%</span></div>`;
  }).join("");
  seasonStats.innerHTML = season.stats.map((item) => `<div class="season-stat"><span>${item.label}</span><strong>${item.value}</strong></div>`).join("");
  seasonStory.textContent = season.story;
}

function renderPicker() {
  picker.innerHTML = seasons.map((season, index) => `<button class="season-option ${index === 0 ? "active" : ""}" role="tab" aria-selected="${index === 0}" data-season="${season.id}">${season.label}</button>`).join("");
}

function apiSeasonToView(season) {
  const champion = season.ranking[0];
  const formatDate = (date) => date.replaceAll("-", ".");
  return {
    id: season.id,
    label: season.label,
    date: `${formatDate(season.startDate)} — ${formatDate(season.endDate)}`,
    champion: champion.name,
    championMark: champion.monogram,
    championColor: champion.color,
    championSoft: champion.softColor,
    finalBalance: champion.balance,
    returnRate: champion.returnRate,
    hitRate: champion.hitRate,
    tickets: champion.tickets,
    stats: [
      { label: "全季总投入", value: money.format(season.summary.totalStaked || champion.spent) },
      { label: "最高单张收益", value: `+${money.format(season.summary.topTicketProfit || 0)}` },
      { label: "串关 / 单关", value: `${season.summary.parlayCount || 0} / ${season.summary.singleCount || 0}` },
    ],
    story: season.story,
    ranking: season.ranking.map((row) => [row.name, row.monogram, row.balance, row.returnRate, row.hitRate]),
  };
}

async function loadHistory() {
  try {
    const response = await fetch("/api/seasons/history", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`history ${response.status}`);
    const payload = await response.json();
    if (!payload.seasons?.length) return;
    seasons = payload.seasons.map(apiSeasonToView);
    renderPicker();
    renderSeason(seasons[0].id);
  } catch (error) {
    document.querySelector(".history-disclaimer").textContent = "历史数据库暂不可用，当前显示内置演示赛季。";
  }
}

renderPicker();
picker.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-season]");
  if (button) renderSeason(button.dataset.season);
});
renderSeason(seasons[0].id);
loadHistory();
