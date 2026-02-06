#!/usr/bin/env node
/**
 * Render TV infographic (4K + 1080p) from render/infographic.html into WebP images.
 *
 * This version is hardened for CI:
 * - Starts a tiny local HTTP server (avoids file:// CORS issues)
 * - Does NOT hard-fail if window.__RENDER_READY__ is never set
 * - Waits for DOM + fonts + a short settling period, then screenshots anyway
 * - On failure, emits useful debug info (console/page errors) before exiting
 */

import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo root assumed: scripts/ is one level below root
const ROOT = path.resolve(__dirname, "..");

// Outputs
const OUT_DIR = path.join(ROOT, "assets", "render");
const OUT_4K = path.join(OUT_DIR, "wxwi-dashboard-4k.webp");
const OUT_1080 = path.join(OUT_DIR, "wxwi-dashboard-1080p.webp");

// Page to render
const PAGE_PATH = path.join(ROOT, "render", "infographic.html");
const PAGE_URL_PATH = "/render/infographic.html";

// Timeouts
const NAV_TIMEOUT_MS = 120_000;
const RENDER_SETTLE_MS = 1_250;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function startServer(rootDir) {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      let pathname = decodeURIComponent(url.pathname);

      // Prevent directory traversal
      if (pathname.includes("..")) {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }

      // Default to index.html if directory
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

      res.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control": "no-store",
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
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
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
    });
  } catch (_) {
    // ignore
  }
}

async function tryWaitForRenderReady(page) {
  // Best-effort only. If the template sets window.__RENDER_READY__ we honor it.
  try {
    await page.waitForFunction(
      () => (window.__RENDER_READY__ === true),
      { timeout: 30_000 }
    );
    return true;
  } catch (_) {
    return false;
  }
}

async function shot(page, viewport, outPath, webpQuality) {
  await page.setViewport({ width: viewport.w, height: viewport.h, deviceScaleFactor: 1 });

  // Navigate and wait for DOM to load; avoid hard dependency on networkidle0 (some pages keep connections open)
  await page.goto(page.url(), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

  // Give fetches a chance to complete
  await page.waitForTimeout(800);

  // Fonts + layout settle
  await waitForFonts(page);

  // If template exposes a render-ready flag, wait a bit for it; otherwise continue
  await tryWaitForRenderReady(page);

  // Small settle (animations, layout)
  await page.waitForTimeout(RENDER_SETTLE_MS);

  await page.screenshot({
    path: outPath,
    type: "webp",
    quality: webpQuality,
    fullPage: false
  });
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
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--font-render-hinting=medium",
    ],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  const consoleLogs = [];
  page.on("console", (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    consoleLogs.push(line);
    // Keep logs short in Actions output
    if (msg.type() === "error" || msg.type() === "warning") {
      console.log(`[PAGE ${msg.type().toUpperCase()}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleLogs.push(`[pageerror] ${String(err)}`);
    console.log(`[PAGE ERROR] ${String(err)}`);
  });

  try {
    // Set initial URL once; shot() uses page.url()
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

    // 4K
    await shot(page, { w: 3840, h: 2160 }, OUT_4K, 92);

    // 1080p
    await shot(page, { w: 1920, h: 1080 }, OUT_1080, 90);

    console.log(`[RENDER OK] ${path.relative(ROOT, OUT_4K)}`);
    console.log(`[RENDER OK] ${path.relative(ROOT, OUT_1080)}`);
  } catch (e) {
    console.error(`[RENDER ERROR] ${e?.name || "Error"}: ${e?.message || String(e)}`);

    // Dump a small debug artifact if possible
    try {
      const dbgDir = path.join(OUT_DIR, "debug");
      ensureDir(dbgDir);
      const html = await page.content();
      fs.writeFileSync(path.join(dbgDir, "last.html"), html, "utf8");
      await page.screenshot({ path: path.join(dbgDir, "last.png"), type: "png" });
      fs.writeFileSync(path.join(dbgDir, "console.log"), consoleLogs.join("\n"), "utf8");
      console.log(`[RENDER DEBUG] Wrote ${path.relative(ROOT, path.join(dbgDir, "last.png"))}`);
    } catch (_) {}

    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  if (process.exitCode === 1) process.exit(1);
}

main();
