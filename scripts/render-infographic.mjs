#!/usr/bin/env node
/**
 * Render TV infographic (4K + 1080p) into WebP images.
 * Hardened for CI:
 * - Local HTTP server serving repo root
 * - Best-effort render-ready flag (doesn't hang)
 * - Downloads Wizz Air logo into assets/brand/ if missing
 */

import http from "node:http";
import https from "node:https";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const OUT_DIR = path.join(ROOT, "assets", "render");
const OUT_4K_WEBP = path.join(OUT_DIR, "wxwi-dashboard-4k.webp");
const OUT_1080_WEBP = path.join(OUT_DIR, "wxwi-dashboard-1080p.webp");
const OUT_4K_PNG = path.join(OUT_DIR, "wxwi-dashboard-4k.png");
const OUT_1080_PNG = path.join(OUT_DIR, "wxwi-dashboard-1080p.png");
const OUT_STATUS = path.join(OUT_DIR, "wxwi-dashboard.status.json");

const PAGE_PATH = path.join(ROOT, "render", "infographic.html");
const PAGE_URL_PATH = "/render/infographic.html";

const LOGO_DIR = path.join(ROOT, "assets", "brand");
const LOGO_PATH = path.join(LOGO_DIR, "wizzair-logo.png");
const LOGO_URL = "https://1000logos.net/wp-content/uploads/2021/04/Wizzair-logo.png";

const NAV_TIMEOUT_MS = 120_000;
const SETTLE_MS = 1_250;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function download(url, outFile) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // redirect
        return resolve(download(res.headers.location, outFile));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const file = fs.createWriteStream(outFile);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    }).on("error", reject);
  });
}

async function ensureLogo() {
  ensureDir(LOGO_DIR);
  // IMPORTANT: never mutate tracked assets in CI.
  // The repo ships with a logo at assets/brand/wizzair-logo.png.
  // Earlier versions tried to "upgrade" small logos by downloading a larger one,
  // which dirtied the working tree and could break the commit step.
  if (fs.existsSync(LOGO_PATH) && fs.statSync(LOGO_PATH).size > 0) return;

  // Only attempt download if the file is missing.
  console.log(`[LOGO] missing; downloading to assets/brand/wizzair-logo.png`);
  try {
    await download(LOGO_URL, LOGO_PATH);
  } catch (e) {
    console.log(`[LOGO] download failed (${e.message}). Continuing without.`);
  }
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

async function shotPair(page, viewport, outWebp, outPng, webpQuality) {
  await page.setViewport({ width: viewport.w, height: viewport.h, deviceScaleFactor: 1 });
  await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await delay(900);
  await waitForFonts(page);
  await tryWaitForRenderReady(page);
  await delay(SETTLE_MS);

  await page.screenshot({ path: outWebp, type: "webp", quality: webpQuality, fullPage: false });
  await page.screenshot({ path: outPng, type: "png", fullPage: false });
}

async function main() {
  if (!fs.existsSync(PAGE_PATH)) {
    console.error(`[RENDER ERROR] Missing template: ${PAGE_PATH}`);
    process.exit(1);
  }

  ensureDir(OUT_DIR);
  await ensureLogo();

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

    await shotPair(page, { w: 3840, h: 2160 }, OUT_4K_WEBP, OUT_4K_PNG, 92);
    await shotPair(page, { w: 1920, h: 1080 }, OUT_1080_WEBP, OUT_1080_PNG, 90);

    // Write a tiny status file that TV screens can poll (prevents long caching delays).
    const dataStatusPath = path.join(ROOT, "data", "status.json");
    let sourceGeneratedAt = null;
    try{
      if (fs.existsSync(dataStatusPath)){
        const j = JSON.parse(fs.readFileSync(dataStatusPath, "utf8"));
        sourceGeneratedAt = j && j.generatedAt ? String(j.generatedAt) : null;
      }
    }catch{}
    fs.writeFileSync(OUT_STATUS, JSON.stringify({
      renderedAt: new Date().toISOString(),
      sourceGeneratedAt,
      note: "dashboard"
    }, null, 2));

    console.log(`[RENDER OK] assets/render/wxwi-dashboard-4k.webp (+png)`);
    console.log(`[RENDER OK] assets/render/wxwi-dashboard-1080p.webp (+png)`);
    console.log(`[RENDER OK] assets/render/wxwi-dashboard.status.json`);
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
