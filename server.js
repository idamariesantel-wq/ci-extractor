// server.js — tiny HTTP server exposing GET /extract?url=<site>
// CORS is enabled so the standalone CI Generator HTML can call it from the browser.
import http from "node:http";
import { extractCI } from "./extract.js";
import { planLayout } from "./plan.js";
import { extractDatasheet } from "./datasheet.js";
import { generateBackground } from "./image.js";

const PORT = process.env.PORT || 8787;

// read a JSON request body (for POST /plan)
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  // --- CORS: allow the browser HTML (any origin) to call this service ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const u = new URL(req.url, `http://localhost:${PORT}`);

  if (u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, planner: !!process.env.ANTHROPIC_API_KEY, images: !!process.env.OPENAI_API_KEY }));
  }

  // --- AI layout planner (Step 3 + 4): POST { ci, product } -> { plan } ---
  if (u.pathname === "/plan") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Use POST with JSON body { ci, product }" }));
    }
    const bodyJson = await readJsonBody(req);
    const { ci, product } = bodyJson;
    if (!ci || !product || !product.trim) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Body must include ci and product (with product.trim.w/h)" }));
    }
    try {
      const result = await planLayout(ci, product);
      res.writeHead(result.error ? 502 : 200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: String(e) }));
    }
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

  // --- Datasheet parser (Step 1, generalized): GET /datasheet?url=<product> ---
  if (u.pathname === "/datasheet") {
    const target = u.searchParams.get("url");
    if (!target) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing ?url= parameter" }));
    }
    try {
      const data = await extractDatasheet(target);
      res.writeHead(data.error ? 502 : 200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  // --- AI background image (Step 4): POST { ci, product } -> { image, prompt } ---
  if (u.pathname === "/image") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Use POST with JSON body { ci, product }" }));
    }
    const bodyJson = await readJsonBody(req);
    const { ci, product } = bodyJson;
    if (!ci || !product || !product.trim) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Body must include ci and product (with product.trim.w/h)" }));
    }
    try {
      const result = await generateBackground(ci, product);
      res.writeHead(result.error ? 502 : 200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
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
