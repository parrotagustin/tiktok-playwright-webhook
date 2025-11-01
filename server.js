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
const DEBUG_HTML_CHARS = 4000;
const MAX_RUN_MS = 180000; // 3 minutos

// ---------- Selectores ----------
const COOKIE_ACCEPT_SELECTORS = [
  'button[data-e2e="cookie-banner-accept-button"]',
  'button:has-text("Accept all")',
  'button:has-text("Aceptar todo")',
  'button:has-text("Aceptar")'
];

const OVERLAY_CLOSE_SELECTORS = [
  'button:has-text("Not now")',
  'button:has-text("Ahora no")',
  'button:has-text("Cerrar")',
  'button:has-text("Close")',
  'button:has-text("Descargar")',
  'button:has-text("Download")',
  'button:has-text("Iniciar sesión")',
  'button:has-text("Log in")'
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
  'div[role="dialog"] div[data-e2e*="comment"]',
  'div.TUXTabBar-content'
];

const COMMENT_ITEM_SELECTORS = [
  'div[data-e2e="comment-item"]',
  'li[data-e2e="comment-item"]',
  'div[data-e2e^="comment-item"]'
];

const COMMENT_TEXT_SELECTORS = [
  'p[data-e2e="comment-level-1"]',
  'span[data-e2e="comment-text"]',
  '[data-e2e="comment-text"]',
  'p[title][data-e2e*="comment"]'
];

const REPLY_BUTTON_SELECTORS = [
  'button[data-e2e^="comment-reply"]',
  'button:has-text("Responder")'
];

const COMMENT_INPUT_SELECTORS = [
  'div[contenteditable="true"][data-e2e="comment-input"]',
  'div[contenteditable="true"][role="textbox"]',
  'p[contenteditable="true"]'
];

// ---------- Utilidades ----------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const nowIso = () => new Date().toISOString();
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const humanDelay = async () => sleep(randInt(400, 1200));

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!.,;:()"'`]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function storagePathForAccount(account) {
  if (!account) return DEFAULT_STORAGE;
  const candidate = path.join(STORAGE_DIR, "accounts", `${account}.json`);
  return existsSync(candidate) ? candidate : DEFAULT_STORAGE;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15"
];

async function launchWithStorage(storagePath) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const context = await browser.newContext({
    storageState: storagePath,
    viewport: { width: 1440, height: 1000 },
    userAgent: USER_AGENTS[randInt(0, USER_AGENTS.length - 1)],
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

async function closeOverlaysIfAny(page) {
  for (const sel of OVERLAY_CLOSE_SELECTORS) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click().catch(() => {});
      await sleep(250);
    }
  }
}

async function pauseMainVideo(page) {
  try {
    const video = await page.waitForSelector("video", { timeout: 5000 });
    if (video) {
      await page.$eval("video", (el) => el.pause());
      await sleep(500);
    }
  } catch (_) {}
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

async function ensureCommentPanelOpen(page) {
  for (let round = 0; round < 5; round++) {
    for (const sel of COMMENT_PANEL_OPENERS) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ delay: 40 }).catch(() => {});
        await sleep(800);
      }
    }
    const container = await getCommentContainer(page);
    if (container) return container;
    await page.mouse.wheel(0, 1500);
    await sleep(600);
  }
  return null;
}

async function getCommentContainer(page) {
  for (const sel of COMMENT_LIST_CANDIDATES) {
    const c = await page.$(sel);
    if (c) return c;
  }
  return null;
}

async function waitRealComments(page, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const items = await page.$$("div[data-e2e='comment-item']");
    if (items.length > 0) {
      const texts = await page.$$eval("div[data-e2e='comment-item']", els =>
        els.filter(e => (e.innerText || '').trim().length > 0).length
      );
      if (texts > 0) return true;
    }
    await sleep(700);
  }
  return false;
}

async function robustScroll(page, container) {
  for (let i = 0; i < 2; i++) {
    const didScroll = await container.evaluate(el => {
      const before = el.scrollTop;
      el.scrollTop = el.scrollTop + 1200;
      return el.scrollTop !== before;
    }).catch(() => false);
    if (didScroll) return true;
  }
  await page.mouse.wheel(0, 1300);
  return true;
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
    const cidMatches = await page.$$(`*[data-e2e*="${cid}"], *[id*="${cid}"], [data-cid*="${cid}"]`);
    if (cidMatches?.length) return cidMatches[0];
  }
  const target = norm(text || "");
  if (!target) return null;
  let items = [];
  for (const sel of COMMENT_ITEM_SELECTORS) {
    const batch = await page.$$(sel);
    if (batch?.length) items = items.concat(batch);
  }
  for (const node of items) {
    const raw = await getItemText(node);
    const nraw = norm(raw);
    if (!nraw) continue;
    if (nraw.includes(target) || target.includes(nraw)) return node;
    if (fuzzyScore(nraw, target) >= 0.5) return node;
  }
  return null;
}

async function replyToComment(page, commentNode, replyText) {
  await commentNode.scrollIntoViewIfNeeded();
  await sleep(250);
  const box = await commentNode.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, Math.max(0, box.y + 10));
    await sleep(200);
  }
  let replyBtn = null;
  for (const sel of REPLY_BUTTON_SELECTORS) {
    replyBtn = await commentNode.$(sel);
    if (replyBtn) break;
  }
  if (!replyBtn) throw new Error("No encontré el botón de Responder en el comentario");
  await replyBtn.click({ delay: 30 });
  await sleep(300);
  let input = null;
  for (const sel of COMMENT_INPUT_SELECTORS) {
    input = await page.$(sel);
    if (input) break;
  }
  if (!input) throw new Error("No encontré el input de comentarios");
  await input.click();
  for (const ch of replyText.split("")) {
    await page.keyboard.type(ch, { delay: randInt(5, 20) });
  }
  await humanDelay();
  await page.keyboard.press("Enter");
  await sleep(900);
  return true;
}

// ---------- Rutas ----------
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Webhook activo", ts: nowIso() });
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
  const killer = setTimeout(() => {
    try { browser?.close(); } catch {}
  }, MAX_RUN_MS);
  try {
    const { browser: b, page } = await launchWithStorage(storage);
    browser = b;
    await page.goto(video_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(1500);
    await acceptCookiesIfAny(page);
    await closeOverlaysIfAny(page);
    await pauseMainVideo(page);
    let container = await ensureCommentPanelOpen(page);
    if (!container) {
      await page.mouse.wheel(0, 2000);
      await sleep(700);
      container = await ensureCommentPanelOpen(page);
    }
    if (!container) throw new Error("No pude abrir el panel de comentarios");
    const ready = await waitRealComments(page, 25000);
    if (!ready) throw new Error("La lista de comentarios no terminó de cargar");
    let found = null;
    for (let i = 0; i < 30; i++) {
      found = await findCommentNode(page, { cid, text: comment_text });
      if (found) break;
      await robustScroll(page, container);
      await sleep(450);
    }
    if (!found) {
      const debugHtml = container ? await container.innerHTML() : await page.content();
      throw new Error("No encontré el comentario (ni por cid ni por texto) ::DEBUG:: " + debugHtml.slice(0, DEBUG_HTML_CHARS));
    }
    await replyToComment(page, found, reply_text);
    const reply_url = cid ? `${video_url}?cid=${cid}` : video_url;
    clearTimeout(killer);
    await browser.close();
    return res.json({ ok: true, row_number, reply_text, reply_url });
  } catch (e) {
    clearTimeout(killer);
    if (browser) await browser.close();
    return res.status(200).json({ ok: false, error: e.message, row_number });
  }
});

// ---------- Boot ----------
app.listen(PORT, HOST, () => {
  console.log(`🚀 Servidor activo en http://${HOST}:${PORT}`);
});
