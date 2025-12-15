import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "local");
const DEFAULT_STORAGE =
  process.env.STORAGE_STATE_PATH || path.join(STORAGE_DIR, "storageState.json");

function storagePathForAccount(account) {
  if (!account) return DEFAULT_STORAGE;
  const specific = path.join(STORAGE_DIR, "accounts", `${account}.json`);
  return existsSync(specific) ? specific : DEFAULT_STORAGE;
}

async function launchBrowser(storagePath) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    storageState: storagePath,
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
  });

  const page = await context.newPage();
  return { browser, page };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Servidor de diagnóstico TikTok activo",
    time: new Date().toISOString(),
  });
});

app.post("/debug-dom", async (req, res) => {
  const { video_url, account, search_text } = req.body;

  if (!video_url) {
    return res.json({ ok: false, error: "Falta video_url" });
  }

  const storagePath = storagePathForAccount(account);
  if (!existsSync(storagePath)) {
    return res.json({
      ok: false,
      error: "storageState no encontrado",
      storagePath,
    });
  }

  const debug = {
    video_url_requested: video_url,
    video_url_final: null,
    search_text,
    steps: {
      open_video: { ok: false, error: null },
      click_comment_button: { ok: false, tried: false, error: null },
      scroll_comments: { ok: false, scrolls: 0, error: null },
      capture_dom: { ok: false, error: null },
    },
  };

  let browser;

  try {
    const launched = await launchBrowser(storagePath);
    browser = launched.browser;
    const page = launched.page;

    // 1) Abrir video
    try {
      await page.goto(video_url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(2000);
      debug.video_url_final = page.url();
      debug.steps.open_video.ok = true;
    } catch (e) {
      debug.steps.open_video.error = e.message;
    }

    // 2) Click botón comentarios (robusto)
    try {
      debug.steps.click_comment_button.tried = true;

      const icon = page.locator('[data-e2e="comment-icon"]').first();
      await icon.waitFor({ state: "visible", timeout: 15000 });

      const parentButton = icon.locator("xpath=ancestor::button[1]");
      if ((await parentButton.count()) > 0) {
        await parentButton.first().click({ force: true, timeout: 15000 });
      } else {
        await icon.click({ force: true, timeout: 15000 });
      }

      await page.waitForTimeout(2000);
      debug.steps.click_comment_button.ok = true;
    } catch (e) {
      debug.steps.click_comment_button.error = e.message;
    }

    // 3) Scroll comentarios
    try {
      let scrolls = 0;
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(800);
        scrolls++;
      }
      debug.steps.scroll_comments.ok = true;
      debug.steps.scroll_comments.scrolls = scrolls;
    } catch (e) {
      debug.steps.scroll_comments.error = e.message;
    }

    // 4) Capturar DOM
    try {
      const body = await page.content();
      debug.steps.capture_dom.ok = true;
      debug.dom = {
        bodySnippet: body.slice(0, 12000),
      };
    } catch (e) {
      debug.steps.capture_dom.error = e.message;
    }

    await browser.close();
    return res.json({ ok: true, debug });
  } catch (e) {
    if (browser) await browser.close();
    return res.json({ ok: false, error: e.message, debug });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Servidor diagnóstico en http://${HOST}:${PORT}`);
});
