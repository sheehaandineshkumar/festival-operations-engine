/* Festival Operations Engine: server. Zero dependencies (Node 18+).
   Login -> signed session cookie. Field crowd reports are stored here; the engine runs here. */
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { runEngine } = require("./engine");

const PORT = process.env.PORT || 3000;
const USER = process.env.FOE_USER || "Shortcircuits", PASS = process.env.FOE_PASS || "1234";
const SECRET = process.env.FOE_SECRET || crypto.randomBytes(32).toString("hex");
const STATE = path.join(process.env.DATA_DIR || __dirname, "state.json");

let reports = {};                                   /* { nodeId: { count, at } } latest report per location */
try { reports = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
const save = () => { try { fs.writeFileSync(STATE, JSON.stringify(reports)); } catch {} };

const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = v => crypto.createHmac("sha256", SECRET).update(v).digest("hex");
const loggedIn = req => {
  const m = /(?:^|;\s*)foe=([^;]+)/.exec(req.headers.cookie || ""); if (!m) return false;
  const [exp, sig] = m[1].split(".");
  return Number(exp) > Date.now() && !!sig && same(sig, sign(exp));
};

const fails = new Map();                            /* ip -> { n, t }  (5 bad logins per minute) */
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
      const f = fails.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - f.t > 60000) { f.n = 0; f.t = Date.now(); }
      if (f.n >= 5) return json(res, 429, { error: "Too many attempts. Wait a minute." });
      const b = await body(req);
      if (same(b.username || "", USER) && same(b.password || "", PASS)) {
        fails.delete(ip);
        const exp = String(Date.now() + 8 * 3600 * 1000), secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        return json(res, 200, { ok: true }, { "Set-Cookie": `foe=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}` });
      }
      f.n++; fails.set(ip, f);
      return json(res, 401, { error: "Incorrect username or password." });
    }
    if (url === "/api/logout" && req.method === "POST") return json(res, 200, { ok: true }, { "Set-Cookie": "foe=; HttpOnly; Path=/; Max-Age=0" });

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
    if (url === "/api/plan" && req.method === "POST") {
      const b = await body(req), counts = {};
      for (const k in reports) counts[k] = reports[k].count;
      const result = runEngine(b.profile, new Set(b.closed || []), counts);
      return json(res, 200, { result: { ...result, by: undefined }, reports });
    }
    json(res, 404, { error: "Not found" });
  } catch (e) { json(res, 400, { error: e.message }); }
}).listen(PORT, () => console.log("FOE listening on :" + PORT));
