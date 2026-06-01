// server.js — tiny HTTP server exposing GET /extract?url=<site>
// CORS is enabled so the standalone CI Generator HTML can call it from the browser.
import http from "node:http";
import { extractCI } from "./extract.js";

const PORT = process.env.PORT || 8787;

const server = http.createServer(async (req, res) => {
  // --- CORS: allow the browser HTML (any origin) to call this service ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const u = new URL(req.url, `http://localhost:${PORT}`);

  if (u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (u.pathname === "/extract") {
    const target = u.searchParams.get("url");
    if (!target) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing ?url= parameter" }));
    }
    try {
      const data = await extractCI(target);
      res.writeHead(data.error ? 502 : 200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found. Use /extract?url=https://brand.com" }));
});

server.listen(PORT, () => {
  console.log(`CI extractor running on http://localhost:${PORT}`);
  console.log(`Try: http://localhost:${PORT}/extract?url=https://stripe.com`);
});
