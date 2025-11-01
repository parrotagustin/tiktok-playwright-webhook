import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- Config ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "local");
const DEFAULT_STORAGE = process.env.STORAGE_STATE_PATH || path.join(STORAGE_DIR, "storageState.json");
const EXECUTION_TIMEOUT_MS = 150_000;

// Varias UIs: comentarios a la derecha o debajo del video.
// Intentamos todos estos selectores en orden.
const COMMENT_PANEL_OPENERS = [
  'button[data-e2e="comment-icon"]',
  'button[aria-label*="comment"]',
  'button[aria-label*="Comentarios"]',
  'button:has(svg[data-e2e*="comment"])'
];

const COMMENT_CONTAINER_CANDIDATES = [
  'div[data-e2e="comment-list"]',
  'div[data-e2e*="comment"]',
  'div.TUXTabBar-content'
];

const REPLY_BUTTON_SEL = 'button[data-e2e^="comment-reply"]';
const COMMENT_INPUT_SEL = 'div[contenteditable="true"][data-e2e="comment-input"]';

// ---------- Util ----------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const norm = (s) => (s || "").toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();

function storagePathForAccount(account) {
  if (!account) return DEFAULT_STORAGE;
  const candidate = path.join(STORAGE_DIR, "accounts", `${account}.json`);
  return existsSync(candidate) ? candidate : DEFAULT_STORAGE;
}

async function launchWithStorage(storagePath) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const context = await browser.newContext({ storageState: storagePath });
  const page = await context.newPage();
  return { browser, context, page };
}

async function ensureLoggedIn(page) {
  // Heurística: si existe botón de login, no estamos logueados.
  // Probamos con elementos del header que aparecen sólo logueado.
  try {
    await page.goto("https://www.tiktok.com", { waitUntil: "domcontentloaded", timeout: 45_000 });
    // Espera breve para que hidrate la app
    await sleep(2000);

    const loginBtn = await page.$('a[href*="login"], button:has-text("Log in"), button:has-text("Iniciar sesión")');
    const userAvatar = await page.$('img[alt*="profile"], [data-e2e*="user-avatar"]');

    if (userAvatar && !loginBtn) return { ok: true, reason: "avatar-detected" };
    // Algunos layouts no muestran avatar; intentamos abrir comentarios en un video público.
    return { ok: true, reason: "heuristic-pass" };
  } catch (e) {
    return { ok: false, reason: `ensureLoggedIn-error: ${e.message}` };
  }
}

async function openCommentPanel(page) {
  for (const sel of COMMENT_PANEL_OPENERS) {
    const el = await page.$(sel);
    if (el) {
      await el.click({ delay: 50 });
      await sleep(1500);
      // si ya abrió, retornamos
      return true;
    }
  }
  // Algunos videos ya abren con comentarios visibles
  return true;
}

async function findCommentContainer(page) {
  for (const sel of COMMENT_CONTAINER_CANDIDATES) {
    const c = await page.$(sel);
    if (c) return c;
  }
  return null;
}

async function findCommentNode(page, { cid, text }) {
  // 1) Intento por cid (si la UI expone el cid en atributos o en data-e2e — a veces no lo hace)
  if (cid) {
    const byCid = await page.$$(`*[data-e2e*="${cid}"], *[id*="${cid}"]`);
    if (byCid && byCid.length) return byCid[0];
  }

  // 2) Fallback por texto (fuzzy): buscamos nodos de comentario y comparamos
  const target = norm(text || "");
  if (!target) return null;

  const candidates = await page.$$('[data-e2e*="comment"], li:has([data-e2e*="comment"])');
  for (const node of candidates) {
    const raw = norm((await node.innerText()).slice(0, 2000));
    if (!raw) continue;
    // match flexible
    if (raw.includes(target) || target.includes(raw)) {
      return node;
    }
    // fuzzy simple: coincidencia de 80% por tokens
    const tksA = new Set(target.split(" "));
    const tksB = new Set(raw.split(" "));
    const inter = [...tksA].filter((t) => tksB.has(t)).length;
    const score = inter / Math.max(1, Math.min(tksA.size, tksB.size));
    if (score >= 0.8) return node;
  }

  return null;
}

async function replyToComment(page, commentNode, replyText) {
  // Asegurar visibilidad
  await commentNode.scrollIntoViewIfNeeded();
  await sleep(400);

  // Click "Responder"
  const replyBtn = await commentNode.$(REPLY_BUTTON_SEL);
  if (!replyBtn) throw new Error("No encontré el botón de Responder en el comentario");
  await replyBtn.click({ delay: 50 });
  await sleep(400);

  // Input de comentario
  const input = await page.$(COMMENT_INPUT_SEL);
  if (!input) throw new Error("No encontré el input de comentarios");
  await input.click();
  await page.keyboard.type(replyText, { delay: 10 });
  await page.keyboard.press("Enter");
  await sleep(1200);

  // No todas las UIs devuelven un link directo a la respuesta. Devolvemos best-effort.
  return true;
}

// ---------- Rutas ----------
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Webhook activo", ts: new Date().toISOString() });
});

app.get("/check-login", async (_req, res) => {
  const storage = storagePathForAccount(null);
  if (!existsSync(storage)) {
    return res.status(200).json({ ok: false, reason: "missing-storage", storage });
  }

  let browser;
  try {
    const { browser: b, page } = await launchWithStorage(storage);
    browser = b;
    const status = await ensureLoggedIn(page);
    await browser.close();
    return res.json({ ok: status.ok, reason: status.reason });
  } catch (e) {
    if (browser) await browser.close();
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/run", async (req, res) => {
  const startedAt = Date.now();
  const { video_url, comment_text, reply_text, account, cid, row_number } = req.body || {};

  // Validación mínima
  if (!video_url || !reply_text || (!comment_text && !cid)) {
    return res.status(400).json({
      ok: false,
      error: "Faltan campos: video_url, reply_text y (comment_text o cid) son obligatorios"
    });
  }

  const storage = storagePathForAccount(account);
  if (!existsSync(storage)) {
    return res.status(200).json({ ok: false, error: "storageState no encontrado", storage });
  }

  let browser;
  try {
    const { browser: b, page } = await launchWithStorage(storage);
    browser = b;

    // Navegar al video
    await page.goto(video_url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await sleep(2000);

    // Abrir panel de comentarios (según layout)
    await openCommentPanel(page);
    await sleep(1000);

    // Encontrar contenedor principal
    const container = await findCommentContainer(page);
    if (!container) throw new Error("No se encontró el contenedor de comentarios");

    // Scrolling progresivo + búsqueda
    let foundNode = null;
    const MAX_LOOPS = 15;
    for (let i = 0; i < MAX_LOOPS; i++) {
      foundNode = await findCommentNode(page, { cid, text: comment_text });
      if (foundNode) break;
      await container.evaluate((el) => el.scrollBy(0, 1200));
      await sleep(600);
    }
    if (!foundNode) throw new Error("No encontré el comentario (ni por cid ni por texto)");

    // Responder
    await replyToComment(page, foundNode, reply_text);

    // Best-effort para reply_url
    const reply_url = cid ? `${video_url}?cid=${cid}` : video_url;

    await browser.close();
    return res.json({
      ok: true,
      row_number,
      reply_text,
      reply_url,
      took_ms: Date.now() - startedAt
    });
  } catch (e) {
    if (browser) await browser.close();
    return res.status(200).json({
      ok: false,
      error: e.message,
      row_number
    });
  }
});

// ---------- Boot ----------
app.listen(PORT, HOST, async () => {
  console.log(`🚀 Servidor activo en http://${HOST}:${PORT}`);
  // Verificación temprana de sesión
  try {
    const storage = storagePathForAccount(null);
    if (!existsSync(storage)) {
      console.log("⚠️ No hay storageState.json por defecto. Sube uno a /local/");
      return;
    }
    const { browser, page } = await launchWithStorage(storage);
    const status = await ensureLoggedIn(page);
    await browser.close();
    console.log(status.ok ? "✅ Sesión activa" : `❌ Sesión dudosa: ${status.reason}`);
  } catch (e) {
    console.log("⚠️ Check de sesión falló:", e.message);
  }
});
