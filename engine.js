/* FOE engine (written from scratch). Pure calculation, no DOM, no network; runs on the server.
   runEngine(profile, closedSet, counts) -> result the dashboard draws; counts = latest reported headcount per location.
   This file now also exposes judgeRequest(profile, closedSet, counts, allocatedMap, request) which returns a per-request decision.
   Pipeline: 1 prepare > 2 links > 3 divert toward destination > 4 status > 5 waste > 6 trucks > 7 volunteers > 8 summary */

/* STEP 1: working nodes. raw = latest REPORTED headcount (falls back to the baseline in the profile) */
function prepareNodes(profile, closedSet, counts) {
  return profile.nodes.map(n => {
    const raw = Math.round(counts[n.id] ?? n.crowd), closed = closedSet.has(n.id);
    return { ...n, base: n.crowd, raw, load: raw, closed, safe: closed ? 0 : Math.floor(n.cap * profile.threshold) };
  });
}

/* STEP 2: neighbours (adj) and how many people each link can still carry per direction (left) */
function buildLinks(profile, by) {
  const adj = {}, left = {};
  for (const id in by) adj[id] = [];
  const factor = profile.edgeCapFactor ?? 0.5;
  for (const e of profile.edges) {
    const a = e[0], b = e[1];
    if (a === b || adj[a].includes(b)) continue;
    const cap = Number.isFinite(e[2]) ? Math.max(0, Math.round(e[2]))
                                      : Math.round(Math.min(by[a].cap, by[b].cap) * factor);
    adj[a].push(b); adj[b].push(a);
    left[a + "|" + b] = cap; left[b + "|" + a] = cap;
  }
  return { adj, left };
}

/* STEP 3a: hops-to-goal for every open node (BFS outward from the goal) */
function distFrom(goal, by, adj) {
  const d = { [goal]: 0 }, q = [goal];
  while (q.length) { const u = q.shift(); for (const v of adj[u]) if (!(v in d) && !by[v].closed) { d[v] = d[u] + 1; q.push(v); } }
  return d;
}

/* STEP 3b: nearest open node with room, but every hop must get CLOSER to the crowd's goal (D),
   so nobody is sent away from where they are trying to go. People already at their goal may only
   be held at a direct neighbour. D = null means "no goal known": any open node will do. */
function findPath(src, by, adj, left, D) {
  const d0 = !D ? 0 : src.id in D ? D[src.id] : 1 + Math.min(...adj[src.id].map(v => D[v] ?? 99));
  const parent = { [src.id]: null }, queue = [src.id];
  while (queue.length) {
    const u = queue.shift(), du = u === src.id ? d0 : D && D[u];
    for (const v of adj[u]) {
      if (v in parent || by[v].closed || left[u + "|" + v] <= 0) continue;
      if (D && !(D[v] !== undefined && (D[v] < du || (u === src.id && d0 === 0 && D[v] === 1)))) continue;
      parent[v] = u;
      if (by[v].safe - by[v].load > 0) { const p = [v]; while (p[0] !== src.id) p.unshift(parent[p[0]]); return p; }
      queue.push(v);
    }
  }
  return null;
}

/* STEP 3c: closed sites first, then the most overloaded; move people toward their goal until fixed or stuck */
function divertCrowd(N, by, adj, left) {
  const excess = x => x.closed ? x.load : Math.max(0, x.load - x.safe);
  const order = [...N.filter(x => x.closed), ...N.filter(x => !x.closed).sort((a, b) => excess(b) - excess(a))];
  const moves = new Map(), flows = {}, cache = {};
  const goalDist = g => !g || !by[g] || by[g].closed ? null : (cache[g] ??= distFrom(g, by, adj));
  for (const src of order) {
    const D = goalDist(src.goal);
    while (excess(src) > 0) {
      const path = findPath(src, by, adj, left, D);
      if (!path) break;
      const dst = by[path[path.length - 1]];
      let amt = Math.min(excess(src), dst.safe - dst.load);
      for (let i = 0; i < path.length - 1; i++) amt = Math.min(amt, left[path[i] + "|" + path[i + 1]]);
      for (let i = 0; i < path.length - 1; i++) { const k = path[i] + "|" + path[i + 1]; left[k] -= amt; flows[k] = (flows[k] || 0) + amt; }
      src.load -= amt; dst.load += amt;
      const key = src.id + "|" + dst.id;
      const m = moves.get(key) || { type: "CROWD_DIVERT", from: src.id, to: dst.id, goal: src.goal || null, people: 0, via: [], hops: 0,
                                    evac: src.closed, ward: src.ward, to_ward: dst.ward, best: 0 };
      m.people += amt;
      if (amt > m.best) { m.best = amt; m.via = path.slice(1, -1); m.hops = path.length - 1; }
      moves.set(key, m);
    }
  }
  const directives = [...moves.values()].map(m => { delete m.best; return m; }).sort((a, b) => (b.evac - a.evac) || (b.people - a.people));
  const edgeFlows = Object.keys(flows).map(k => { const [from, to] = k.split("|"); return { from, to, people: flows[k], evac: by[from].closed }; });
  const anySpare = N.some(x => !x.closed && x.safe - x.load > 0);
  for (const x of N.filter(x => excess(x) > 0))
    directives.push({ type: "ESCALATE", node: x.id, ward: x.ward, unresolved: excess(x), closed: x.closed,
      reason: anySpare ? "No room on the way to their destination: meter entry upstream and hold people at the last open point"
                       : "Network saturated: no open location has room left" });
  return { directives, edgeFlows };
}

/* STEP 4: status label (colour) from load / capacity */
function labelStatus(N, thr) {
  const cls = (load, x) => x.closed ? "closed" : load / x.cap > 1 ? "critical"
                         : load / x.cap > thr ? "over" : load / x.cap >= thr - .15 ? "watch" : "ok";
  for (const x of N) {
    x.ratio0 = x.raw / x.cap; x.ratio = x.load / x.cap;
    x.st0 = cls(x.raw, x); x.st = cls(x.load, x);
    x.over0 = !x.closed && x.raw > Math.floor(x.cap * thr);
    x.over = !x.closed && x.load > x.safe;
    x.stranded = x.closed ? x.load : 0;
    x.evacuated = x.closed ? x.raw - x.load : 0;
  }
}

/* STEP 5: waste. kg/hour = people arriving per hour (load / dwell) x kg per person (wasteK) */
function estimateWaste(N, profile, win) {
  const wk = profile.wasteK ?? 0.06;
  for (const x of N) {
    x.binCap = x.bins * x.binKg;
    x.binNow = x.binCap * x.fill / 100;
    // wk may be an object of types or a single number; use food as a reasonable baseline if object
    const baseline = typeof wk === 'number' ? wk : (wk.food || Object.values(wk)[0] || 0.06);
    x.rate = x.closed ? 0 : x.load * 60 / Math.max(1, x.dwell) * baseline;
    const room = Math.max(0, x.binCap - x.binNow);
    x.fullIn = x.rate > 0 ? room / x.rate * 60 : Infinity;                          /* minutes */
    x.proj = x.binCap > 0 ? (x.binNow + x.rate * win / 60) / x.binCap : 0;
    x.wst = x.closed ? "closed" : x.fullIn < 45 ? "critical" : x.fullIn < win ? "watch" : "ok";
  }
}

/* STEP 6: trucks. Most urgent bins first; each gets the truck that can arrive earliest */
function dispatchTrucks(N, by, adj, profile, win) {
  const travel = profile.travelMin ?? 8, service = profile.serviceMin ?? 10;
  const route = (a, b) => {                       /* shortest path that avoids closed sites */
    const parent = { [a]: null }, q = [a];
    while (q.length) {
      const u = q.shift();
      if (u === b) { const p = []; for (let c = b; c !== null; c = parent[c]) p.unshift(c); return p; }
      for (const v of adj[u]) if (!(v in parent) && !by[v].closed) { parent[v] = u; q.push(v); }
    }
    return null;
  };
  const trucks = profile.trucks.map(t => ({ id: t.id, at: t.at, freeAt: 0, legs: 0 }));
  const urgent = N.filter(x => !x.closed && x.fullIn < win).sort((a, b) => a.fullIn - b.fullIn);
  const out = [];
  for (const x of urgent) {
    let best = null;
    for (const t of trucks) {
      const r = route(t.at, x.id); if (!r) continue;
      const arrive = t.freeAt + (r.length - 1) * travel;
      if (!best || arrive < best.arrive) best = { t, r, arrive };
    }
    if (!best) {
      const d = { type: "SWM_UNSERVED", to: x.id, ward: x.ward, bins_full_in_min: Math.round(x.fullIn) };
      x.truck = d; out.push(d); continue;
    }
    const late = Math.max(0, Math.ceil(best.arrive - x.fullIn));
    const d = { type: "SWM_DISPATCH", truck: best.t.id, leg: ++best.t.legs, start: best.t.at, to: x.id, route: best.r,
      eta_min: Math.round(best.arrive), bins_full_in_min: Math.round(x.fullIn), on_time: best.arrive <= x.fullIn,
      late_min: late, overflow_kg: Math.round(late / 60 * x.rate), ward: x.ward };
    x.truck = d; out.push(d);
    best.t.at = x.id; best.t.freeAt = best.arrive + service;
  }
  return out;
}

/* STEP 7: volunteers. People per volunteer by role; hot sites need 1.5x; closed sites get a 2-officer cordon.
   Highest-pressure sites are staffed first, so a short pool is always short at the quietest sites. */
const VOL_RATIO = { police: 500, crowd_control: 400, medic: 1000 };
function deployVolunteers(N, pool, thr) {
  const left = { police: 0, medic: 0, crowd_control: 0, ...pool }, total = { ...left };
  const rows = [...N].sort((a, b) => (b.closed - a.closed) || (b.ratio - a.ratio)).map(x => {
    const hot = !x.closed && x.ratio >= thr - .15;
    const row = { node: x.id, name: x.name, ward: x.ward, load: x.load, status: x.st, change: x.raw - x.base, need: {}, have: {} };
    for (const r in VOL_RATIO) {
      row.need[r] = x.closed ? (r === "police" ? 2 : 0) : Math.ceil(x.load / VOL_RATIO[r] * (hot ? 1.5 : 1));
      row.have[r] = Math.min(row.need[r], left[r]); left[r] -= row.have[r];
    }
    return row;
  });
  const short = {}; for (const r in VOL_RATIO) short[r] = rows.reduce((s, w) => s + w.need[r] - w.have[r], 0);
  return { rows, pool: total, spare: left, short };
}

/* STEP 8: run everything in order and build the summary */
function runEngine(profile, closedSet, counts = {}) {
  const win = Math.round((profile.decayHours || 3) * 60);
  const N = prepareNodes(profile, closedSet, counts);
  const by = Object.fromEntries(N.map(x => [x.id, x]));
  const { adj, left } = buildLinks(profile, by);
  const { directives, edgeFlows } = divertCrowd(N, by, adj, left);
  labelStatus(N, profile.threshold);
  estimateWaste(N, profile, win);
  const waste = dispatchTrucks(N, by, adj, profile, win);
  directives.push(...waste);
  const volunteers = deployVolunteers(N, profile.volunteers || {}, profile.threshold);
  const open = N.filter(x => !x.closed), sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const dispatched = waste.filter(d => d.type === "SWM_DISPATCH");
  const before = sum(N, x => x.raw), after = sum(N, x => x.load);
  const summary = {
    people_total: after, open_nodes: open.length, closed_nodes: N.length - open.length,
    over_before: N.filter(x => x.over0).length, over_after: N.filter(x => x.over).length,
    people_rerouted: sum(directives.filter(d => d.type === "CROWD_DIVERT"), d => d.people),
    people_unresolved: sum(directives.filter(d => d.type === "ESCALATE"), d => d.unresolved),
    safe_capacity_open: sum(open, x => x.safe), load_open: sum(open, x => x.load),
    headroom: sum(open, x => Math.max(0, x.safe - x.load)), demand_total: before,
    trucks_dispatched: dispatched.length, trucks_on_time: dispatched.filter(d => d.on_time).length,
    trucks_at_risk: dispatched.filter(d => !d.on_time).length + waste.filter(d => d.type === "SWM_UNSERVED").length,
    overflow_kg: sum(dispatched, d => d.overflow_kg), window_min: win, people_conserved: before === after,
    volunteers_short: Object.values(volunteers.short).reduce((a, b) => a + b, 0)
  };
  return { nodes: N, by, directives, summary, edgeFlows, trucks: profile.trucks, win, volunteers };
}

/* New: judgeRequest(profile, closedSet, counts, allocatedMap, request)
   - allocatedMap: { node|slot: number } current already-allocated people at nodes per slot (slot may be 'NOW' for immediate)
   - request: { id, requesterType: 'citizen'|'volunteer', size: number, preferredSites: [id,...], preferredSlots: [slotIndex,...] }
   Returns: { status: 'Allocated'|'Diverted'|'Rejected', node: id|null, slot: slotIndex|null, reason }
*/
function judgeRequest(profile, closedSet, counts = {}, allocatedMap = {}, request = {}){
  // Build current loads per node (these are "now" loads independent of slots)
  const N = prepareNodes(profile, closedSet, counts);
  const by = Object.fromEntries(N.map(x=>[x.id,x]));
  // compute available now at each node
  const availableNow = {}; for(const id in by) availableNow[id] = Math.max(0, by[id].safe - by[id].load);
  // timeslot handling
  const slotMinutes = profile.timeslotMinutes || 15;
  const nowSlot = Math.floor(Date.now() / (slotMinutes*60000));
  const prefSites = Array.isArray(request.preferredSites)&&request.preferredSites.length?request.preferredSites:[];
  const prefSlots = Array.isArray(request.preferredSlots)&&request.preferredSlots.length?request.preferredSlots:[];
  const relax = request.requesterType==='volunteer'?1.05:1.0;
  const horizonSlots = 48; // check next 48 slots (~12 hours for 15min)

  // helper to check capacity for a node at a given slotIndex
  const capacityAt = (nodeId, slotIndex)=>{
    const node = by[nodeId]; if(!node || node.closed) return 0;
    const baseLoad = node.load; // current load influences all slots
    // sum allocations for that node at that slot
    const key = nodeId+'|'+String(slotIndex);
    const allocHere = allocatedMap[key]||0;
    const avail = Math.max(0, node.safe - (baseLoad + allocHere));
    return avail;
  };

  // If preferred slots provided, check those first
  if(prefSlots.length){
    for(const slot of prefSlots){
      for(const p of prefSites){
        if(capacityAt(p,slot) >= Math.ceil(request.size/relax)) return {status:'Allocated',node:p,slot,reason:'Preferred site/slot has room'};
      }
    }
  }
  // try preferred sites for ASAP allocation (search upcoming slots)
  const sitesToTry = prefSites.length?prefSites:Object.keys(by).filter(id=>!by[id].closed);
  for(let offset=0; offset<horizonSlots; offset++){
    const sIdx = nowSlot+offset;
    for(const nodeId of sitesToTry){
      if(capacityAt(nodeId,sIdx) >= request.size) return {status:'Allocated',node:nodeId,slot:sIdx,reason: offset===0? 'Allocated now':'Allocated future slot'};
    }
  }
  // if no preferred sites or failed, search all nodes by nearest-to-pref or by safe capacity
  const { adj } = buildLinks(profile, by);
  // BFS distance from preferred sites (or treat all equally)
  const q=[]; const seen=new Set();
  if(prefSites.length){ for(const p of prefSites){ if(by[p] && !by[p].closed){ q.push(p); seen.add(p);} } }
  else { for(const id in by) if(!by[id].closed){ q.push(id); seen.add(id);} }
  const dist={}; let head=0;
  while(head<q.length){ const u=q[head++]; for(const v of adj[u]||[]) if(!seen.has(v)&&!by[v].closed){ seen.add(v); dist[v]=(dist[u]||0)+1; q.push(v);} }
  const cand = Object.keys(by).filter(id=>!by[id].closed).map(id=>({id,dist:dist[id]??99,availNow:capacityAt(id,nowSlot)})).sort((a,b)=>a.dist-b.dist||b.availNow-b.availNow);
  for(const c of cand){ for(let offset=0; offset<horizonSlots; offset++){ const sIdx=nowSlot+offset; if(capacityAt(c.id,sIdx)>=request.size) return {status:'Diverted',node:c.id,slot:sIdx,reason:'Suggested alternative slot/node'} } }
  // nothing found
  return {status:'Rejected',node:null,slot:null,reason:'No capacity in network for requested group within horizon'};
}

module.exports = { runEngine, judgeRequest };
