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
const DEFAULT_STORAGE = process.env.STORAGE_STATE_PATH || path.join(STORAGE_DIR, "storageState.json");

// Selección dinámica de archivo de cookies
function storagePathForAccount(account) {
  if (!account) return DEFAULT_STORAGE;
  const specific = path.join(STORAGE_DIR, "accounts", `${account}.json`);
  return existsSync(specific) ? specific : DEFAULT_STORAGE;
}

// Anti-detección y perfil realista
async function launchBrowser(storagePath) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars"
    ]
  });

  const context = await browser.newContext({
    storageState: storagePath,
    locale: "es-ES",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 1000 }
  });

  const page = await context.newPage();
  return { browser, page };
}

// Home
app.get("/", (_, res) => {
  res.json({ ok: true, message: "Servidor funcionando", time: new Date().toISOString() });
});

// Verifica que las cookies funcionan
app.get("/check-login", async (req, res) => {
  const storagePath = storagePathForAccount(req.query.account);
  if (!existsSync(storagePath)) {
    return res.json({ ok: false, error: "No existe storageState", storagePath });
  }

  try {
    const { browser, page } = await launchBrowser(storagePath);
    await page.goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 20000 });
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
    return res.status(400).json({ ok: false, error: "Faltan campos obligatorios" });
  }

  const storagePath = storagePathForAccount(account);
  if (!existsSync(storagePath)) {
    return res.json({ ok: false, error: "storageState no encontrado", storagePath });
  }

  let browser;
  try {
    const ctx = await launchBrowser(storagePath);
    browser = ctx.browser;
    const page = ctx.page;

    await page.goto(video_url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    // Abrir comentarios
    await page.click('[data-e2e="comment-icon"], [aria-label*="coment"]', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Buscar el comentario por texto aproximado
    const commentHandle = await page.locator(`text=${comment_text}`).first();
    await commentHandle.scrollIntoViewIfNeeded();
    await commentHandle.click({ delay: 60 });
    await page.waitForTimeout(800);

    // Escribir respuesta
    await page.keyboard.type(reply_text, { delay: 30 });
    await page.keyboard.press("Enter");

    await browser.close();
    return res.json({ ok: true, msg: "Respuesta enviada" });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.json({ ok: false, error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Servidor operativo en http://${HOST}:${PORT}`);
});
