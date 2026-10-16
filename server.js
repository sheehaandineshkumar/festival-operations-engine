/* Festival Operations Engine: server. Zero dependencies (Node 18+).
   Login -> signed session cookie. Field crowd reports are stored here; the engine runs here.
   Added: profiles API, requests intake with strict slot reservations, decision log persistence and deletion. */
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { runEngine, judgeRequest } = require("./engine");

const PORT = process.env.PORT || 3000;
const USER = process.env.FOE_USER || "Shortcircuits", PASS = process.env.FOE_PASS || "1234";
const SECRET = process.env.FOE_SECRET || crypto.randomBytes(32).toString("hex");
const STATE = path.join(process.env.DATA_DIR || __dirname, "state.json");

let reports = {};
let requests = [];
let allocations = [];
let decisionLog = [];
try {
  const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
  if (s && typeof s === "object") {
    reports = s.reports || {};
    requests = s.requests || [];
    allocations = s.allocations || [];
    decisionLog = s.decisionLog || [];
  }
} catch {}
const save = () => { try { fs.writeFileSync(STATE, JSON.stringify({ reports, requests, allocations, decisionLog })); } catch (e) {} };

const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = v => crypto.createHmac("sha256", SECRET).update(v).digest("hex");
const loggedIn = req => {
  const m = /(?:^|;\s*)foe=([^;]+)/.exec(req.headers.cookie || ""); if (!m) return false;
  const [exp, sig] = m[1].split(".");
  return Number(exp) > Date.now() && !!sig && same(sig, sign(exp));
};

const json = (res, code, obj, headers = {}) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(obj, (k, v) => v === Infinity ? "__INF__" : v));
};
const body = req => new Promise((ok, no) => {
  let d = ""; req.on("data", c => { d += c; if (d.length > 1e6) { no(Error("Too large")); req.destroy(); } });
  req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(Error("Invalid JSON")); } });
});
const page = (res, file) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  res.end(fs.readFileSync(path.join(__dirname, "public", file)));
};

http.createServer(async (req, res) => {
  const url = req.url.split("?")[0], ip = req.socket.remoteAddress;
  try {
    if (url === "/healthz") return json(res, 200, { ok: true });
    if (url === "/login" && req.method === "GET") return loggedIn(req) ? (res.writeHead(302, { Location: "/" }), res.end()) : page(res, "login.html");
    if (url === "/api/login" && req.method === "POST") {
      const f = { n: 0, t: Date.now() };
      const b = await body(req);
      if (same(b.username || "", USER) && same(b.password || "", PASS)) {
        const exp = String(Date.now() + 8 * 3600 * 1000), secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        return json(res, 200, { ok: true }, { "Set-Cookie": `foe=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}` });
      }
      return json(res, 401, { error: "Incorrect username or password." });
    }
    if (url === "/api/logout" && req.method === "POST") return json(res, 200, { ok: true }, { "Set-Cookie": "foe=; HttpOnly; Path=/; Max-Age=0" });

    /* public profile endpoints (no login required) */
    if (url === "/api/profiles" && req.method === "GET") {
      try {
        const dir = path.join(__dirname, "profiles");
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f=>f.endsWith('.json')) : [];
        const list = files.map(f=>{ try { return JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')) } catch(e){return null}}).filter(Boolean).map(p=>({id:p.id||p.name,name:p.name}));
        return json(res,200,{profiles:list});
      } catch(e){return json(res,500,{error:e.message})}
    }
    if (url === "/api/profile" && req.method === "GET") {
      const q = req.url.split("?")[1] || "";
      const params = Object.fromEntries(new URLSearchParams(q));
      if(!params.id) return json(res,400,{error:"missing id"});
      const ppath = path.join(__dirname,'profiles',params.id+'.json');
      if(!fs.existsSync(ppath)) return json(res,404,{error:'profile not found'});
      try{const p=JSON.parse(fs.readFileSync(ppath,'utf8'));return json(res,200,{profile:p})}catch(e){return json(res,500,{error:e.message})}
    }

    /* everything below needs a signed-in official */
    if (!loggedIn(req)) return url.startsWith("/api/") ? json(res, 401, { error: "Signed out" }) : (res.writeHead(302, { Location: "/login" }), res.end());
    if (url === "/" && req.method === "GET") return page(res, "index.html");

    if (url === "/api/reports" && req.method === "POST") {
      const list = (await body(req)).reports;
      if (!Array.isArray(list) || !list.length || list.length > 50) return json(res, 400, { error: "Send 1 to 50 reports." });
      for (const r of list)
        if (!/^[A-Za-z0-9_-]{1,16}$/.test(r.node || "") || !Number.isInteger(r.count) || r.count < 0 || r.count > 1e6)
          return json(res, 400, { error: "Each report needs a location id and a whole-number headcount (0 to 1,000,000)." });
      const at = new Date().toISOString();
      for (const r of list) reports[r.node] = { count: r.count, at };
      save(); return json(res, 200, { ok: true, reports });
    }
    if (url === "/api/reports" && req.method === "DELETE") { reports = {}; save(); return json(res, 200, { ok: true }); }

    if (url === "/api/decisionlog" && req.method === "GET") { return json(res,200,{decisionLog}) }
    if (url === "/api/decisionlog" && req.method === "DELETE") { decisionLog = []; save(); return json(res,200,{ok:true}) }

    if (url === "/api/allocations" && req.method === "GET") { return json(res,200,{allocations}) }
    if (url === "/api/requests" && req.method === "GET") { return json(res,200,{requests}) }

    if (url === "/api/requests" && req.method === "POST") {
      const b = await body(req);
      const r = b.request;
      if(!r || typeof r.size !== 'number' || r.size<=0) return json(res,400,{error:'request needs size>0'});
      r.id = r.id || 'REQ-'+(Date.now()).toString(36).toUpperCase();
      r.at = new Date().toISOString();
      requests.push(r);
      // build counts from reports
      const counts = {};
      for(const k in reports) counts[k]=reports[k].count;
      // build allocations map keyed by node|slot
      const allocMap = {};
      for(const a of allocations.filter(a=>a.status==='Allocated')){
        const key = (a.node||'')+'|'+(a.slot===null||a.slot===undefined?"NOW":String(a.slot));
        allocMap[key] = (allocMap[key]||0)+ (a.size||0);
      }
      try{
        const decision = judgeRequest(b.profile,b.closed?new Set(b.closed):new Set(),counts,allocMap,r);
        const entry = {time:new Date().toISOString(),request:r,decision};
        decisionLog.push(entry);
        if(decision.status==='Allocated' || decision.status==='Diverted'){
          allocations.push({reqId:r.id,node:decision.node,size:r.size,slot:decision.slot,requester:r.requesterType,status:decision.status,at:entry.time});
        } else {
          allocations.push({reqId:r.id,node:null,size:r.size,slot:null,requester:r.requesterType,status:'Rejected',at:entry.time});
        }
        save();
        return json(res,200,{ok:true,decision,entry,allocations});
      }catch(e){return json(res,500,{error:e.message})}
    }

    if (url === "/api/plan" && req.method === "POST") {
      const b = await body(req), counts = {};
      for (const k in reports) counts[k] = reports[k].count;
      const result = runEngine(b.profile, new Set(b.closed || []), counts);
      // include current allocations and decision log in the response for visibility
      return json(res, 200, { result: { ...result, by: undefined }, reports, allocations, decisionLog });
    }

    json(res, 404, { error: "Not found" });
  } catch (e) { json(res, 400, { error: e.message }); }
}).listen(PORT, () => console.log("FOE listening on :" + PORT));
