#!/usr/bin/env node
/**
 * Render Disruption Thermostat (4K + 1080p) into WebP images.
 * Fixes:
 *  - Avoids page.waitForTimeout (not available in some puppeteer versions): uses delay()
 *  - Ensures local HTTP server serves repo root and template fetches absolute /data/* paths
 *  - Best-effort render-ready flag; continues even if not set
 */

import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const OUT_DIR = path.join(ROOT, "assets", "render");
const OUT_4K = path.join(OUT_DIR, "wxwi-thermostat-4k.webp");
const OUT_1080 = path.join(OUT_DIR, "wxwi-thermostat-1080p.webp");

const PAGE_PATH = path.join(ROOT, "render", "thermostat.html");
const PAGE_URL_PATH = "/render/thermostat.html";

const NAV_TIMEOUT_MS = 120_000;
const SETTLE_MS = 1_250;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function startServer(rootDir) {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      let pathname = decodeURIComponent(url.pathname);

      if (pathname.includes("..")) {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }
      if (pathname.endsWith("/")) pathname += "index.html";

      const filePath = path.join(rootDir, pathname);
      if (!filePath.startsWith(rootDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const mime =
        ext === ".html" ? "text/html; charset=utf-8" :
        ext === ".js"   ? "application/javascript; charset=utf-8" :
        ext === ".css"  ? "text/css; charset=utf-8" :
        ext === ".json" ? "application/json; charset=utf-8" :
        ext === ".txt"  ? "text/plain; charset=utf-8" :
        ext === ".svg"  ? "image/svg+xml" :
        ext === ".png"  ? "image/png" :
        ext === ".webp" ? "image/webp" :
        "application/octet-stream";

      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
      fs.createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(500);
      res.end("Server error");
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

async function waitForFonts(page) {
  try {
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    });
  } catch {}
}

async function tryWaitForRenderReady(page) {
  try {
    await page.waitForFunction(() => window.__RENDER_READY__ === true, { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function shot(page, outPath, viewport, quality) {
  await page.setViewport({ width: viewport.w, height: viewport.h, deviceScaleFactor: 1 });

  // Reload to let CSS media queries/layout settle for this viewport
  await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

  // Let fetches complete
  await delay(900);
  await waitForFonts(page);
  await tryWaitForRenderReady(page);
  await delay(SETTLE_MS);

  await page.screenshot({ path: outPath, type: "webp", quality, fullPage: false });
}

async function main() {
  if (!fs.existsSync(PAGE_PATH)) {
    console.error(`[RENDER ERROR] Missing template: ${PAGE_PATH}`);
    process.exit(1);
  }

  ensureDir(OUT_DIR);
  const { server, port } = await startServer(ROOT);
  const url = `http://127.0.0.1:${port}${PAGE_URL_PATH}`;

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  const consoleLogs = [];
  page.on("console", (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    consoleLogs.push(line);
    if (msg.type() === "error" || msg.type() === "warning") console.log(`[PAGE ${msg.type().toUpperCase()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    consoleLogs.push(`[pageerror] ${String(err)}`);
    console.log(`[PAGE ERROR] ${String(err)}`);
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

    await shot(page, OUT_4K, { w: 3840, h: 2160 }, 92);
    await shot(page, OUT_1080, { w: 1920, h: 1080 }, 90);

    console.log(`[RENDER OK] assets/render/wxwi-thermostat-4k.webp`);
    console.log(`[RENDER OK] assets/render/wxwi-thermostat-1080p.webp`);
  } catch (e) {
    console.error(`[RENDER ERROR] ${e?.name || "Error"}: ${e?.message || String(e)}`);
    try {
      const dbgDir = path.join(OUT_DIR, "debug");
      ensureDir(dbgDir);
      fs.writeFileSync(path.join(dbgDir, "url.txt"), url, "utf8");
      const html = await page.content();
      fs.writeFileSync(path.join(dbgDir, "last.html"), html, "utf8");
      await page.screenshot({ path: path.join(dbgDir, "last.png"), type: "png" });
      fs.writeFileSync(path.join(dbgDir, "console.log"), consoleLogs.join("\n"), "utf8");
      console.log(`[RENDER DEBUG] Wrote assets/render/debug/last.png`);
    } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  if (process.exitCode === 1) process.exit(1);
}

main();