// ============================================================================
// BlitzProxy — Local Dashboard (served at /dashboard, token-gated)
// A dependency-free status page: provider health, current routing,
// request stats, estimated costs, fallback events. Binds localhost only.
// ============================================================================

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BlitzProxy Dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: ui-monospace, Consolas, monospace; background: #0d1117; color: #c9d1d9; margin: 0; padding: 24px; }
  h1 { font-size: 20px; color: #58a6ff; margin: 0 0 4px; }
  .sub { color: #8b949e; font-size: 12px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #8b949e; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 600; }
  .ok { color: #3fb950; } .warn { color: #d29922; } .err { color: #f85149; } .dim { color: #8b949e; }
  .pill { padding: 1px 8px; border-radius: 10px; font-size: 11px; }
  .pill.online { background: #1b3a25; color: #3fb950; }
  .pill.degraded { background: #3a2f1b; color: #d29922; }
  .pill.rate-limited { background: #3a2f1b; color: #d29922; }
  .pill.auth-failed { background: #3a1b1b; color: #f85149; }
  .pill.offline { background: #3a1b1b; color: #f85149; }
  .pill.unknown, .pill.no-key, .pill.not-configured { background: #21262d; color: #8b949e; }
  #status { margin: 8px 0 24px; font-size: 12px; }
  a { color: #58a6ff; }
</style>
</head>
<body>
<h1>&#9889; BlitzProxy Dashboard</h1>
<div class="sub">local-only &bull; token-protected &bull; aggregate stats &mdash; prompts are never stored</div>
<div id="status" class="dim">loading…</div>
<div class="grid">
  <div class="card"><h2>Current Routing</h2><div id="health">—</div></div>
  <div class="card"><h2>Requests Today</h2><div id="today">—</div></div>
  <div class="card"><h2>All Time (90 days)</h2><div id="alltime">—</div></div>
  <div class="card"><h2>Provider Health</h2><div id="providers">—</div></div>
</div>
<div class="grid" style="margin-top:16px">
  <div class="card"><h2>Usage & Context</h2><div id="usage">—</div></div>
  <div class="card"><h2>Sessions</h2><div id="sessions">—</div></div>
  <div class="card"><h2>Models & Agents</h2><div id="breakdown">—</div></div>
</div>
<script>
const TOKEN = new URLSearchParams(location.search).get('token') || '';
async function getJson(path) {
  const res = await fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN));
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}
function esc(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
function fmt(n) { return typeof n === 'number' ? n.toLocaleString() : '—'; }
function table(headers, rows) {
  if (!rows.length) return '<div class="dim">no data</div>';
  return '<table><tr>' + headers.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr>' +
    rows.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</table>';
}
async function refresh() {
  try {
    const [health, stats, healthMap] = await Promise.all([
      getJson('/health'),
      getJson('/admin/stats'),
      getJson('/admin/health'),
    ]);
    document.getElementById('status').innerHTML =
      '<span class="' + (health.status === 'ok' ? 'ok' : 'err') + '">&#9679; ' + esc(health.status) + '</span>' +
      ' &bull; v' + esc(health.version) + ' &bull; provider: <b>' + esc(health.provider) + '</b>' +
      ' &bull; model: <b>' + esc(health.model || '—') + '</b>' +
      ' &bull; routing: <b>' + esc(health.routing) + '</b>' +
      ' &bull; uptime: ' + fmt(health.uptimeSec) + 's' +
      (health.privacy ? ' &bull; <span class="warn">privacy mode ON</span>' : '') +
      (stats.privacy ? ' &bull; <span class="warn">stats in-memory only (privacy)</span>' : '');
    document.getElementById('health').innerHTML = table(
      ['Provider', 'Status', 'Latency'],
      Object.entries(healthMap).map(([id, h]) => [
        esc(id),
        '<span class="pill ' + esc(h.status || 'unknown') + '">' + esc(String(h.status || 'unknown').toUpperCase()) + '</span>',
        h.latencyMs != null ? esc(h.latencyMs + 'ms') : '<span class="dim">—</span>',
      ]));
    const statRows = (rows) => rows.map(r => [
      esc(r.providerId), fmt(r.requests), '<span class="ok">' + fmt(r.ok) + '</span>',
      '<span class="err">' + fmt(r.fail) + '</span>', fmt(r.rateLimited),
      r.avgLatencyMs != null ? esc(r.avgLatencyMs + 'ms') : '—',
      fmt(r.inputTokens), fmt(r.outputTokens),
      r.costUsd != null ? '<span title="estimate only">$' + r.costUsd.toFixed(4) + '</span>' : '<span class="dim">n/a</span>',
    ]);
    document.getElementById('today').innerHTML = table(
      ['Provider', 'Req', 'OK', 'Fail', 'RL', 'Avg lat', 'In tok', 'Out tok', 'Est cost'],
      statRows(stats.today));
    document.getElementById('alltime').innerHTML = table(
      ['Provider', 'Req', 'OK', 'Fail', 'RL', 'Avg lat', 'In tok', 'Out tok', 'Est cost'],
      statRows(stats.allTime));

    // ── Usage & Context (normalized token accounting — EXACT vs ESTIMATED) ──
    const tok = (a, k) => fmt(a && a[k]);
    const todayUsage = (stats.today || []).reduce((acc, r) => ({
      in: acc.in + (r.inputTokens || 0), out: acc.out + (r.outputTokens || 0),
      cached: acc.cached + (r.cachedTokens || 0), reason: acc.reason + (r.reasoningTokens || 0),
      ctxSaved: acc.ctxSaved + (r.contextSavedTokens || 0),
      est: acc.est + (r.estimatedRequests || 0), req: acc.req + r.requests,
    }), { in: 0, out: 0, cached: 0, reason: 0, ctxSaved: 0, est: 0, req: 0 });
    const exactPct = todayUsage.req > 0 ? Math.round(((todayUsage.req - todayUsage.est) / todayUsage.req) * 100) : 100;
    document.getElementById('usage').innerHTML =
      '<table>' +
      '<tr><th>Input</th><td>' + fmt(todayUsage.in) + '</td><th>Output</th><td>' + fmt(todayUsage.out) + '</td></tr>' +
      '<tr><th>Cached</th><td>' + fmt(todayUsage.cached) + '</td><th>Reasoning</th><td>' + fmt(todayUsage.reason) + '</td></tr>' +
      '<tr><th>Context saved</th><td>' + fmt(todayUsage.ctxSaved) + '</td><th>Context mode</th><td>' + esc(stats.contextOptimization || 'safe') + '</td></tr>' +
      '<tr><th>Usage source</th><td colspan="3"><span class="ok">' + exactPct + '% EXACT</span>' +
      (todayUsage.est ? ' <span class="dim">+ ' + todayUsage.est + ' ESTIMATED</span>' : '') + '</td></tr>' +
      '</table>';

    // ── Sessions (recovery metadata only) ──
    let sessionsHtml = '<div class="dim">no sessions recorded</div>';
    try {
      const sess = await getJson('/admin/sessions');
      if (sess.counts) {
        sessionsHtml =
          '<div style="margin-bottom:8px">' +
          '<span class="pill online">' + sess.counts.active + ' active</span> ' +
          '<span class="pill offline">' + sess.counts.interrupted + ' interrupted</span> ' +
          '<span class="pill unknown">' + sess.counts.completed + ' completed</span></div>' +
          table(
            ['Project', 'Agent', 'Model', 'Status'],
            (sess.sessions || []).slice(0, 8).map(s => [
              esc(s.projectName || '—'), esc(s.agent || '—'), esc(s.model || '—'),
              '<span class="pill ' + (s.status === 'ACTIVE' ? 'online' : s.status === 'INTERRUPTED' ? 'offline' : 'unknown') + '">' + esc(s.status) + '</span>',
            ]));
      }
    } catch (e) {
      sessionsHtml = '<div class="dim">' + esc(e.message) + '</div>';
    }
    document.getElementById('sessions').innerHTML = sessionsHtml;

    // ── By model / by agent breakdown ──
    const bdRows = [];
    for (const m of (stats.models || []).slice(0, 6)) {
      bdRows.push(['<span class="pill unknown">model</span> ' + esc(m.model), fmt(m.requests), fmt((m.inputTokens || 0) + (m.outputTokens || 0)), fmt(m.contextSavedTokens)]);
    }
    for (const a of (stats.agents || []).filter(a => a.agent !== 'unknown').slice(0, 6)) {
      bdRows.push(['<span class="pill degraded">agent</span> ' + esc(a.agent), fmt(a.requests), fmt((a.inputTokens || 0) + (a.outputTokens || 0)), fmt(a.contextSavedTokens)]);
    }
    document.getElementById('breakdown').innerHTML = bdRows.length
      ? table(['Dimension', 'Req', 'Tokens', 'Ctx saved'], bdRows)
      : '<div class="dim">no data</div>';
  } catch (err) {
    document.getElementById('status').innerHTML = '<span class="err">failed to load: ' + esc(err.message) + '</span>';
  }
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
