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

// Normalización de texto para comparar comentarios (sin acentos, signos, etc.)
function normalizeText(str) {
  if (!str) return "";
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quitar acentos
    .replace(/[¿?¡!.,:;"]/g, "") // quitar signos de puntuación típicos
    .toLowerCase()
    .replace(/\s+/g, " ") // colapsar espacios múltiples
    .trim();
}

// Anti-detección y perfil realista
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
    message: "Servidor funcionando",
    time: new Date().toISOString(),
  });
});

// Verifica que las cookies funcionan
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
    await browser.close();

    return res.json({ ok: true, session: "valid", storagePath });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

// Responder comentario en TikTok
app.post("/run", async (req, res) => {
  const { video_url, reply_text, comment_text, account } = req.body;

  if (!video_url || !reply_text || !comment_text) {
    return res
      .status(400)
      .json({ ok: false, error: "Faltan campos obligatorios" });
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
  // info de depuración para entender qué ve Playwright
  const debugInfo = {
    target_raw: comment_text,
    target_normalized: normalizeText(comment_text),
    checked: 0,
    samples: [],
  };

  try {
    const ctx = await launchBrowser(storagePath);
    browser = ctx.browser;
    const page = ctx.page;

    // Ir al video
    await page.goto(video_url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    // Abrir panel de comentarios
    await page
      .click('[data-e2e="comment-icon"], [aria-label*="oment"]', {
        timeout: 8000,
      })
      .catch(() => {});
    await page.waitForTimeout(2000);

    // Usar sólo los comentarios de nivel 1
    let commentLocator = page.locator('[data-e2e="comment-level-1"]');
    let initialCount = await commentLocator.count();

    debugInfo.initial_count = initialCount;

    if (initialCount === 0) {
      const error = new Error("comments_panel_not_opened_or_no_comments");
      error.debugInfo = debugInfo;
      throw error;
    }

    const targetNormalized = debugInfo.target_normalized;
    let foundComment = null;
    const maxScrolls = 20;
    let scrolls = 0;

    // Búsqueda aproximada con normalización y scroll
    while (!foundComment && scrolls < maxScrolls) {
      commentLocator = page.locator('[data-e2e="comment-level-1"]');
      const count = await commentLocator.count();

      for (let i = 0; i < count; i++) {
        const handle = commentLocator.nth(i);
        let rawText = "";
        try {
          rawText = await handle.innerText();
        } catch {
          continue;
        }

        const normalized = normalizeText(rawText);
        debugInfo.checked += 1;

        // Guardamos algunas muestras para inspeccionar (máx. 10)
        if (debugInfo.samples.length < 10) {
          debugInfo.samples.push({
            raw: rawText.slice(0, 160),
            normalized,
          });
        }

        if (normalized.includes(targetNormalized)) {
          foundComment = handle;
          debugInfo.matched = {
            raw: rawText.slice(0, 200),
            normalized,
          };
          break;
        }
      }

      if (foundComment) break;

      // Scroll suave hacia el último comentario y esperar que carguen más
      try {
        await commentLocator.last().scrollIntoViewIfNeeded();
      } catch {
        break;
      }
      await page.waitForTimeout(800);
      scrolls++;
    }

    debugInfo.scrolls = scrolls;

    if (!foundComment) {
      const error = new Error("comment_not_found_normalized");
      error.debugInfo = debugInfo;
      throw error;
    }

    // Asegurarse de que el comentario está en vista y hacer click para responder
    await foundComment.scrollIntoViewIfNeeded();
    await foundComment.click({ delay: 60 });
    await page.waitForTimeout(800);

    // Escribir respuesta
    await page.keyboard.type(reply_text, { delay: 30 });
    await page.keyboard.press("Enter");

    await page.waitForTimeout(1500);

    await browser.close();
    return res.json({
      ok: true,
      msg: "Respuesta enviada",
      debug: debugInfo,
    });
  } catch (err) {
    if (browser) {
      await browser.close().catch(() => {});
    }

    const payload = {
      ok: false,
      error: err.message || "unknown_error",
      debug: err.debugInfo || debugInfo,
    };

    return res.json(payload);
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Servidor operativo en http://${HOST}:${PORT}`);
});
