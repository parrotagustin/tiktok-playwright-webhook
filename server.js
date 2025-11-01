import express from "express";
import cors from "cors";
import { chromium, devices } from "playwright";
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
const DEBUG_HTML_CHARS = 3000;

// Selectores amplios/robustos
const COOKIE_ACCEPT_SELECTORS = [
  'button[data-e2e="cookie-banner-accept-button"]',
  'button:has-text("Accept all")',
  'button:has-text("Aceptar todo")',
  'button:has-text("Aceptar")'
];

const COMMENT_PANEL_OPENERS = [
  'button[data-e2e="comment-icon"]',
  'button[data-e2e="browse-video-comments"]',
  'button[aria-label*="comment"]',
  'button:has(svg[data-e2e*="comment"])',
  'div[data-e2e="comment-top-hover"]',
  'span:has-text("Comentarios")'
];

const COMMENT_LIST_CANDIDATES = [
  'div[data-e2e="comment-list"]',
  'div[data-e2e="comment-group-list"]',
  'div[data-e2e="comment-container"]',
  'div.TUXTabBar-content'
];

const COMMENT_ITEM_SELECTOR = 'div[data-e2e="comment-item"]';
const COMMENT_TEXT_SELECTORS = [
  'p[data-e2e="comment-level-1"]',
  'span[data-e2e="comment-text"]',
  '[data-e2e="comment-text"]'
];

const REPLY_BUTTON_SEL = 'button[data-e2e^="comment-reply"]';
const COMMENT_INPUT_SEL = 'div[contenteditable="true"][data-e2e="comment-input"], div[contenteditable="true"][role="textbox"]';

// ---------- Util ----------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!.,;:()"'`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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
  const context = await browser.newContext({
    storageState: storagePath,
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
    locale: "es-ES",
    hasTouch: false
  });
  const page = await context.newPage();
  return { browser, context, page };
}

async function acceptCookiesIfAny(page) {
  for (const sel of COOKIE_ACCEPT_SELECTORS) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click().catch(() => {});
      await sleep(500);
      break;
    }
  }
}

async function ensureLoggedIn(page) {
  try {
    await page.goto("https://www.tiktok.com", { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(1500);
    await acceptCookiesIfAny(page);

    const loginBtn = await page.$('a[href*="login"], button:has-text("Log in"), button:has-text("Iniciar sesión")');
    const userAvatar = await page.$('img[alt*="profile"], [data-e2e*="user-avatar"]');
    if (userAvatar && !loginBtn) return { ok: true, reason: "avatar-detected" };
    return { ok: true, reason: "heuristic-pass" };
  } catch (e) {
    return { ok: false, reason: `ensureLoggedIn-error: ${e.message}` };
  }
}

async function openCommentPanel(page) {
  for (const sel of COMMENT_PANEL_OPENERS) {
    const el = await page.$(sel);
    if (el) {
      await el.click({ delay: 40 }).catch(() => {});
      await sleep(1000);
    }
  }
  return true;
}

async function getCommentContainer(page) {
  for (const sel of COMMENT_LIST_CANDIDATES) {
    const c = await page.$(sel);
    if (c) return c;
  }
  return null;
}

async function robustScroll(page, container) {
  for (let i = 0; i < 2; i++) {
    const didScroll = await container.evaluate((el) => {
      const before = el.scrollTop;
      el.scrollBy(0, 1200);
      return el.scrollTop !== before;
    }).catch(() => false);
    if (didScroll) return true;
  }
  await page.mouse.wheel(0, 1200);
  return true;
}

async function waitCommentItems(page, timeout = 15000) {
  await page.waitForSelector(COMMENT_ITEM_SELECTOR, { timeout }).catch(() => {});
}

async function getItemText(node) {
  for (const sel of COMMENT_TEXT_SELECTORS) {
    const t = await node.$(sel);
    if (t) {
      const s = await t.innerText();
      if (s) return s;
    }
  }
  return await node.innerText();
}

function fuzzyScore(a, b) {
  const A = new Set(norm(a).split(" "));
  const B = new Set(norm(b).split(" "));
  const inter = [...A].filter((t) => B.has(t)).length;
  return inter / Math.max(1, Math.min(A.size, B.size));
}

async function findCommentNode(page, { cid, text }) {
  if (cid) {
    const byCid = await page.$$(`*[data-e2e*="${cid}"], *[id*="${cid}"], [data-cid*="${cid}"]`);
    if (byCid?.length) return byCid[0];
  }
  const target = norm(text || "");
  if (!target) return null;
  const items = await page.$$(COMMENT_ITEM_SELECTOR);
  for (const node of items) {
    const raw = await getItemText(node);
    const nraw = norm(raw);
    if (!nraw) continue;
    if (nraw.includes(target) || target.includes(nraw)) return node;
    if (fuzzyScore(nraw, target) >= 0.55) return node;
  }
  return null;
}

async function replyToComment(page, commentNode, replyText) {
  await commentNode.scrollIntoViewIfNeeded();
  await sleep(300);
  await page.mouse.move(10, 10);
  const box = await commentNode.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + 10);
  const replyBtn = await commentNode.$(REPLY_BUTTON_SEL);
  if (!replyBtn) throw new Error("No encontré el botón de Responder en el comentario");
  await replyBtn.click({ delay: 40 });
  await sleep(300);
  const input = await page.$(COMMENT_INPUT_SEL);
  if (!input) throw new Error("No encontré el input de comentarios");
  await input.click();
  await page.keyboard.type(replyText, { delay: 8 });
  await page.keyboard.press("Enter");
  await sleep(1000);
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
  const { video_url, comment_text, reply_text, account, cid, row_number } = req.body || {};
  if (!video_url || !reply_text || (!comment_text && !cid)) {
    return res.status(400).json({ ok: false, error: "Faltan: video_url, reply_text y (comment_text o cid)" });
  }
  const storage = storagePathForAccount(account);
  if (!existsSync(storage)) {
    return res.status(200).json({ ok: false, error: "storageState no encontrado", storage, row_number });
  }
  let browser;
  try {
    const { browser: b, page } = await launchWithStorage(storage);
    browser = b;
    await page.goto(video_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(1500);
    await acceptCookiesIfAny(page);
    await openCommentPanel(page);
    await waitCommentItems(page, 15000);
    const container = await getCommentContainer(page);
    if (!container) throw new Error("No se encontró el contenedor de comentarios");
    let found = null;
    for (let i = 0; i < 20; i++) {
      found = await findCommentNode(page, { cid, text: comment_text });
      if (found) break;
      await robustScroll(page, container);
      await sleep(500);
    }
    if (!found) {
      const debugHtml = container ? await container.innerHTML() : "";
      throw new Error("No encontré el comentario (ni por cid ni por texto) ::DEBUG:: " + debugHtml.slice(0, DEBUG_HTML_CHARS));
    }
    await replyToComment(page, found, reply_text);
    const reply_url = cid ? `${video_url}?cid=${cid}` : video_url;
    await browser.close();
    return res.json({ ok: true, row_number, reply_text, reply_url });
  } catch (e) {
    if (browser) await browser.close();
    return res.status(200).json({ ok: false, error: e.message, row_number });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`🚀 Servidor activo en http://${HOST}:${PORT}`);
});
