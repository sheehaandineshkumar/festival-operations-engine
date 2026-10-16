const { runEngine } = require("./engine"), fs = require("fs");
const src = fs.readFileSync("public/index.html", "utf8");
const P = new Function(src.match(/const DEFAULT_PROFILE=[\s\S]*?\n\/\* The engine/)[0].replace(/\n\/\* The engine$/, "") + ";return DEFAULT_PROFILE")();
const ok = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } };
const hops = (g, a, b) => { // BFS hops over open nodes
  const adj = {}; P.edges.forEach(([x, y]) => { (adj[x] ??= []).push(y); (adj[y] ??= []).push(x); });
  const d = { [g]: 0 }, q = [g]; while (q.length) { const u = q.shift(); for (const v of adj[u]) if (!(v in d)) { d[v] = d[u] + 1; q.push(v); } } return d; };
let n = 0;
for (const mult of [.6, 1, 1.4, 2]) for (const thr of [.7, .85, 1]) for (const cs of [[], ["LB"], ["GC"], ["LB", "GR"], ["WL"]]) {
  n++; const counts = Object.fromEntries(P.nodes.map(x => [x.id, Math.round(x.crowd * mult)]));
  const r = runEngine({ ...P, threshold: thr }, new Set(cs), counts), tag = `${mult}/${thr}/${cs}`;
  ok(r.summary.people_conserved, "conserved " + tag);
  for (const d of r.directives.filter(d => d.type === "CROWD_DIVERT")) {
    ok(!cs.includes(d.to), "closed receives " + tag);
    const g = r.by[d.from].goal; if (g && !cs.includes(g)) { const D = hops(g); ok(D[d.to] < D[d.from] || (D[d.from] === 0 && D[d.to] === 1), `moved away from goal ${d.from}>${d.to} ` + tag); }
  }
  for (const w of r.volunteers.rows) for (const k in w.have) ok(w.have[k] <= w.need[k], "over-assigned " + tag);
  for (const k in r.volunteers.pool) ok(r.volunteers.rows.reduce((s, w) => s + w.have[k], 0) <= r.volunteers.pool[k], "pool exceeded " + tag);
}
const d = runEngine(P, new Set(), {});
console.log(n + " scenarios checked. Baseline:", d.directives.filter(x => x.type === "CROWD_DIVERT").map(x => `${x.from}>${x.to} ${x.people} (goal ${x.goal})`).join("; "));
const pk = runEngine(P, new Set(), Object.fromEntries(P.nodes.map(x => [x.id, x.crowd * 2])));
console.log("Peak: unresolved", pk.summary.people_unresolved, "| volunteers short", JSON.stringify(pk.volunteers.short));
