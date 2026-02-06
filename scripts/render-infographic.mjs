#!/usr/bin/env node
/* Render TV infographic as WebP images (4K + 1080p).
   - Starts a tiny local HTTP server to avoid file:// CORS issues
   - Opens render/infographic.html in headless Chrome via Puppeteer
   - Waits for window.__RENDER_READY__ then screenshots

   Outputs:
     assets/render/wxwi-dashboard-4k.webp
     assets/render/wxwi-dashboard-1080p.webp
*/

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.cwd();

const PORT = process.env.RENDER_PORT ? Number(process.env.RENDER_PORT) : 4173;
const HOST = "127.0.0.1";

const OUT_DIR = path.join(ROOT, "assets", "render");
const OUT_4K = path.join(OUT_DIR, "wxwi-dashboard-4k.webp");
const OUT_1080 = path.join(OUT_DIR, "wxwi-dashboard-1080p.webp");

// Very small static file server rooted at repo root
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function safeJoin(root, urlPath){
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const p = path.normalize(decoded).replace(/^(\.\.[\/\\])+/, "");
  const full = path.join(root, p);
  if(!full.startsWith(root)) return null;
  return full;
}

function startServer(){
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = req.url || "/";
      const f = u === "/" ? "/render/infographic.html" : u;
      const full = safeJoin(ROOT, f);
      if(!full){ res.writeHead(400); res.end("Bad path"); return; }
      if(!fs.existsSync(full) || fs.statSync(full).isDirectory()){
        res.writeHead(404); res.end("Not found"); return;
      }
      const ext = path.extname(full).toLowerCase();
      res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      fs.createReadStream(full).pipe(res);
    });
    server.listen(PORT, HOST, () => resolve(server));
  });
}

async function shot(page, width, height, outPath, quality){
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(`http://${HOST}:${PORT}/render/infographic.html?ts=${Date.now()}`, { waitUntil: "networkidle0" });
  // Wait for render-ready flag
  await page.waitForFunction(() => window.__RENDER_READY__ === true, { timeout: 60000 });
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath, type: "webp", quality });
  console.log("[OK] wrote", outPath);
}

async function main(){
  const server = await startServer();
  let browser;
  try{
    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();

    // 4K primary
    await shot(page, 3840, 2160, OUT_4K, 92);
    // 1080p fallback
    await shot(page, 1920, 1080, OUT_1080, 90);

  } finally {
    try{ if(browser) await browser.close(); } catch {}
    try{ server.close(); } catch {}
  }
}

main().catch((e) => {
  console.error("[RENDER ERROR]", e);
  process.exit(1);
});
