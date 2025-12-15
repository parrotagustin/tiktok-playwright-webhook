cd /opt/tiktok-scraper/app
cat > server.js <<'EOF'
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

// Marker para verificar que ES ESTE ARCHIVO
const MARKER = "NO_WAITFORSELECTOR_v2";

// Paths y defaults
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "local");
const DEFAULT_STORAGE =
  process.env.STORAGE_STATE_PATH || path.join(STORAGE_DIR, "storageState.json");

// Selección dinámica de archivo de cookies
function storagePathForAccount(account) {
  if (!account) return DEFAULT_STORAGE;
  const specific = path.join(STORAGE_DIR, "accounts", `${account}.json`);
  return existsSync(specific) ? specific : DEFAULT_STORAGE;
}

// Lanzar navegador con perfil "humano"
async function launchBrowser(storagePath) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
    ],
  });

  const context = await browser.newContext({
    storageState: storagePath,
    locale: "es-ES",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 1000 },
  });

  const page = await context.newPage();
  return { browser, page };
}

// Home
app.get("/", (_, res) => {
  res.json({
    ok: true,
    marker: MARKER,
    message: "Servidor de diagnóstico TikTok activo",
    time: new Date().toISOString(),
  });
});

// Verifica que las cookies funcionan y que entra a TikTok
app.get("/check-login", async (req, res) => {
  const storagePath = storagePathForAccount(req.query.account);
  if (!existsSync(storagePath)) {
    return res.json({ ok: false, error: "No existe storageState", storagePath });
  }

  try {
    const { browser, page } = await launchBrowser(storagePath);
    await page.goto("https://www.tiktok.com/", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    await browser.close();

    const probablyLoggedIn = !/login/i.test(currentUrl);

    return res.json({
      ok: true,
      marker: MARKER,
      session: probablyLoggedIn ? "likely_logged_in" : "maybe_logged_out",
      storagePath,
      currentUrl,
    });
  } catch (err) {
    return res.json({ ok: false, marker: MARKER, error: err.message });
  }
});

// Debug DOM
app.post("/debug-dom", async (req, res) => {
  const { video_url, account, search_text } = req.body;

  if (!video_url) {
    return res.status(400).json({ ok: false, error: "Falta el campo video_url" });
  }

  const storagePath = storagePathForAccount(account);
  if (!existsSync(storagePath)) {
    return res.json({ ok: false, error: "storageState no encontrado", storagePath });
  }

  let browser;
  const debug = {
    marker: MARKER,
    video_url_requested: video_url,
    video_url_final: null,
    search_text: search_text || null,
    text_search: null,
    steps: {
      open_video: { ok: false, error: null },
      click_comment_button: { ok: false, tried: false, error: null },
      scroll_comments: { ok: false, scrolls: 0, error: null },
      capture_dom: { ok: false, error: null },
    },
  };

  try {
    const { browser: b, page } = await launchBrowser(storagePath);
    browser = b;

    // 1) Ir al vídeo
    try {
      await page.goto(video_url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2000);
      debug.video_url_final = page.url();
      debug.steps.open_video.ok = true;
    } catch (e) {
      debug.steps.open_video.error = e.message;
      throw new Error("open_video_failed");
    }

    // 2) Click comentarios (SIN waitForSelector)
    try {
      debug.steps.click_comment_button.tried = true;

      const icon = page.locator('[data-e2e="comment-icon"]').first();
      await icon.waitFor({ state: "visible", timeout: 20000 });

      const parentButton = icon.locator("xpath=ancestor::button[1]");

      if (await parentButton.count()) {
        await parentButton.first().click({ force: true, timeout: 15000 });
      } else {
        await icon.click({ force: true, timeout: 15000 });
      }

      await page.waitForTimeout(2000);
      debug.steps.click_comment_button.ok = true;
    } catch (e) {
      debug.steps.click_comment_button.error = e.message;
    }

    // 3) Scroll
    try {
      let scrolls = 0;
      while (scrolls < 10) {
        await page.mouse.wheel(0, 800);
        await page.waitForTimeout(800);
        scrolls++;
      }
      debug.steps.scroll_comments.scrolls = scrolls;
      debug.steps.scroll_comments.ok = true;
    } catch (e) {
      debug.steps.scroll_comments.error = e.message;
    }

    // 4) Capturar DOM
    const MAX_HTML = 8000;

    let bodyHtml = "";
    try {
      bodyHtml = await page.innerHTML("body");
    } catch {
      bodyHtml = "<error-reading-body-innerHTML>";
    }

    if (search_text && typeof search_text === "string") {
      const rawIndex = bodyHtml.indexOf(search_text);
      const lowerIndex = bodyHtml.toLowerCase().indexOf(search_text.toLowerCase());
      debug.text_search = {
        search_text,
        found_raw: rawIndex !== -1,
        index_raw: rawIndex,
        found_lowercase: lowerIndex !== -1,
        index_lowercase: lowerIndex,
      };
    }

    debug.steps.capture_dom.ok = true;

    await browser.close();

    return res.json({
      ok: true,
      debug,
      dom: { bodySnippet: bodyHtml.slice(0, MAX_HTML) },
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.json({ ok: false, error: err.message || "unknown_error", debug });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Servidor activo en http://${HOST}:${PORT} (${MARKER})`);
});
EOF
