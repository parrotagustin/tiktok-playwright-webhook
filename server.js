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
    message: "Servidor de diagnóstico funcionando",
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

    return res.json({
      ok: true,
      session: "valid",
      storagePath,
      currentUrl,
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

// Endpoint de diagnóstico paso a paso
app.post("/debug-run", async (req, res) => {
  const { video_url, account } = req.body;

  if (!video_url) {
    return res
      .status(400)
      .json({ ok: false, error: "Falta el campo video_url" });
  }

  const storagePath = storagePathForAccount(account);
  if (!existsSync(storagePath)) {
    return res.json({
      ok: false,
      error: "storageState no encontrado",
      storagePath,
    });
  }

  let browser;
  const steps = {
    open_video: {
      ok: false,
      url: null,
      error: null,
    },
    click_comment_button: {
      ok: false,
      tried: false,
      error: null,
    },
    load_comments: {
      ok: false,
      scrolls: 0,
      selectors: {},
      error: null,
    },
  };

  const COMMENT_SELECTORS = {
    comment_level_1: '[data-e2e="comment-level-1"]',
    comment_exact: '[data-e2e="comment"]',
    comment_contains: '[data-e2e*="comment"]',
  };

  try {
    const ctx = await launchBrowser(storagePath);
    browser = ctx.browser;
    const page = ctx.page;

    // 1) Ir al vídeo
    try {
      await page.goto(video_url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(2000);
      steps.open_video.ok = true;
      steps.open_video.url = page.url();
    } catch (e) {
      steps.open_video.error = e.message;
      throw new Error("open_video_failed");
    }

    // 2) Buscar y clicar el botón de comentarios
    try {
      steps.click_comment_button.tried = true;
      await page.waitForSelector('[data-e2e="comment-icon"]', {
        timeout: 10000,
        state: "attached",
      });
      const commentButton = page.locator('[data-e2e="comment-icon"]').first();
      await commentButton.click({ timeout: 8000 });
      await page.waitForTimeout(2000);
      steps.click_comment_button.ok = true;
    } catch (e) {
      steps.click_comment_button.error = e.message;
      // seguimos igual para ver qué selectores hay aunque no se haya podido clicar
    }

    // 3) Scroll progresivo y medición de posibles selectores de comentario
    try {
      let scrolls = 0;
      const maxScrolls = 10;

      for (const key of Object.keys(COMMENT_SELECTORS)) {
        steps.load_comments.selectors[key] = {
          selector: COMMENT_SELECTORS[key],
          counts: [],
          samples: [],
        };
      }

      while (scrolls < maxScrolls) {
        for (const [key, selector] of Object.entries(COMMENT_SELECTORS)) {
          const locator = page.locator(selector);
          const count = await locator.count();
          steps.load_comments.selectors[key].counts.push(count);

          if (
            count > 0 &&
            steps.load_comments.selectors[key].samples.length === 0
          ) {
            const maxSamples = Math.min(count, 3);
            for (let i = 0; i < maxSamples; i++) {
              let rawText = "";
              try {
                rawText = await locator.nth(i).innerText();
              } catch {
                continue;
              }
              steps.load_comments.selectors[key].samples.push(
                rawText.slice(0, 160)
              );
            }
          }
        }

        const anySelectorHasComments = Object.values(
          steps.load_comments.selectors
        ).some((info) => info.counts[info.counts.length - 1] > 0);

        if (anySelectorHasComments && scrolls >= 2) {
          break;
        }

        await page.mouse.wheel(0, 800);
        await page.waitForTimeout(800);
        scrolls++;
      }

      steps.load_comments.scrolls = scrolls;
      steps.load_comments.ok = true;
    } catch (e) {
      steps.load_comments.error = e.message;
      throw new Error("load_comments_failed");
    }

    await browser.close();

    const globalOk =
      steps.open_video.ok && steps.click_comment_button.ok && steps.load_comments.ok;

    return res.json({
      ok: globalOk,
      steps,
    });
  } catch (err) {
    if (browser) {
      await browser.close().catch(() => {});
    }

    return res.json({
      ok: false,
      error: err.message || "unknown_error",
      steps,
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Servidor operativo en http://${HOST}:${PORT}`);
});
