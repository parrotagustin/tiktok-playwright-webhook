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
    storageState: storagePath, // acá se usan las cookies guardadas
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
    message: "Servidor de diagnóstico TikTok activo",
    time: new Date().toISOString(),
  });
});

// Verifica que las cookies funcionan y que entra a TikTok logueado
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

    // si currentUrl contiene "login" o similar, sabremos que no está logueado
    const probablyLoggedIn = !/login/i.test(currentUrl);

    return res.json({
      ok: true,
      session: probablyLoggedIn ? "likely_logged_in" : "maybe_logged_out",
      storagePath,
      currentUrl,
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

// Diagnóstico específico de comentarios: extraer HTML/texto de cada comentario
app.post("/debug-comments", async (req, res) => {
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
  const debug = {
    video_url_requested: video_url,
    video_url_final: null,
    steps: {
      open_video: { ok: false, error: null },
      click_comment_button: { ok: false, tried: false, error: null },
      load_comments: { ok: false, scrolls: 0, error: null },
    },
    selectors_used: {
      container: '[data-e2e="comment-level-1"]',
    },
  };

  try {
    const { browser: b, page } = await launchBrowser(storagePath);
    browser = b;

    // 1) Ir al vídeo
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
      throw new Error("open_video_failed");
    }

    // 2) Buscar y clicar el botón de comentarios
    try {
      debug.steps.click_comment_button.tried = true;
      await page.waitForSelector('[data-e2e="comment-icon"]', {
        timeout: 10000,
        state: "attached",
      });
      const commentButton = page.locator('[data-e2e="comment-icon"]').first();
      await commentButton.click({ timeout: 8000 });
      await page.waitForTimeout(2000);
      debug.steps.click_comment_button.ok = true;
    } catch (e) {
      debug.steps.click_comment_button.error = e.message;
      // seguimos igual para ver qué hay, aunque no se haya podido clicar
    }

    // 3) Scroll progresivo para cargar comentarios
    try {
      let scrolls = 0;
      const maxScrolls = 10;

      while (scrolls < maxScrolls) {
        const locator = page.locator('[data-e2e="comment-level-1"]');
        const count = await locator.count();
        if (count > 0) break;

        await page.mouse.wheel(0, 800);
        await page.waitForTimeout(800);
        scrolls++;
      }

      debug.steps.load_comments.scrolls = scrolls;
      debug.steps.load_comments.ok = true;
    } catch (e) {
      debug.steps.load_comments.error = e.message;
      throw new Error("load_comments_failed");
    }

    // 4) Extraer innerHTML + innerText de los comentarios detectados
    const containerLocator = page.locator('[data-e2e="comment-level-1"]');
    const total = await containerLocator.count();
    const maxToReturn = Math.min(total, 10); // por si hay muchos

    const comments = [];
    for (let i = 0; i < maxToReturn; i++) {
      const handle = containerLocator.nth(i);
      let innerHTML = "";
      let innerText = "";
      try {
        innerHTML = await handle.innerHTML();
      } catch {
        innerHTML = "<error-reading-innerHTML>";
      }
      try {
        innerText = await handle.innerText();
      } catch {
        innerText = "<error-reading-innerText>";
      }

      comments.push({
        index: i,
        innerHTML: innerHTML.slice(0, 2000), // truncamos para no romper la respuesta
        innerText,
      });
    }

    await browser.close();

    return res.json({
      ok: true,
      debug,
      total_containers: total,
      comments,
    });
  } catch (err) {
    if (browser) {
      await browser.close().catch(() => {});
    }

    return res.json({
      ok: false,
      error: err.message || "unknown_error",
      debug,
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Servidor diagnóstico en http://${HOST}:${PORT}`);
});
