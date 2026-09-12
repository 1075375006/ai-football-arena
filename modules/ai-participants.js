const COLOR_PALETTE = [
  ["#0c6b45", "#eaf4ee"], ["#b85c2f", "#fff0e8"], ["#315aa6", "#ebf0fb"],
  ["#6c4bb4", "#f0ecfa"], ["#c73f3a", "#faecea"], ["#9a7220", "#f7f0df"],
  ["#2b728e", "#e8f4f7"], ["#8d4f83", "#f7eaf4"],
];

function hash(value) {
  return [...String(value)].reduce((sum, char) => ((sum * 31) + char.charCodeAt(0)) >>> 0, 7);
}

function monogram(name, id) {
  const words = String(name || id).trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((word) => [...word][0]).join("").toUpperCase();
  return [...String(name || id)].slice(0, 2).join("").toUpperCase();
}

function visualFor(model, index) {
  const [color, soft] = COLOR_PALETTE[index % COLOR_PALETTE.length] || COLOR_PALETTE[hash(model.id) % COLOR_PALETTE.length];
  return { monogram: monogram(model.name, model.id), color, softColor: soft };
}

export async function syncConfiguredParticipants(db, config, { seasonId = null, initialBankroll = 10000 } = {}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: currentRows } = await client.query("SELECT id FROM seasons WHERE status='current' LIMIT 1");
    const activeSeasonId = seasonId || currentRows[0]?.id || null;
    const configuredIds = new Set(config.models.map((model) => model.id));
    const existing = await client.query("SELECT id,monogram,color,soft_color FROM agents");
    const existingById = new Map(existing.rows.map((row) => [row.id, row]));
    let added = 0;
    let updated = 0;
    let disabled = 0;
    for (let index = 0; index < config.models.length; index += 1) {
      const model = config.models[index];
      const current = existingById.get(model.id);
      const visual = current
        ? { monogram: current.monogram, color: current.color, softColor: current.soft_color }
        : visualFor(model, index);
      const active = Boolean(model.enabled);
      await client.query(
        `INSERT INTO agents (id,name,monogram,style,default_strategy,color,soft_color,active)
         VALUES ($1,$2,$3,'自主决策','custom',$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, color=EXCLUDED.color, soft_color=EXCLUDED.soft_color,
           monogram=EXCLUDED.monogram, style='自主决策', default_strategy='custom', active=EXCLUDED.active`,
        [model.id, model.name || model.id, visual.monogram, visual.color, visual.softColor, active],
      );
      if (current) updated += 1; else added += 1;
      if (active && activeSeasonId) {
        await client.query(
          `INSERT INTO season_agents (season_id,agent_id,current_balance)
           VALUES ($1,$2,$3) ON CONFLICT (season_id,agent_id) DO NOTHING`,
          [activeSeasonId, model.id, initialBankroll],
        );
      }
    }
    const stale = await client.query(
      `UPDATE agents SET active=FALSE WHERE active=TRUE AND NOT (id = ANY($1::text[])) RETURNING id`,
      [configuredIds.size ? [...configuredIds] : ["__none__"]],
    );
    disabled = stale.rowCount;
    await client.query("COMMIT");
    return { configured: config.models.length, added, updated, disabled, active: config.models.filter((model) => model.enabled).map((model) => model.id), warnings: config.warnings };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
