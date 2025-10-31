import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- Utilidades ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE =
  process.env.STORAGE_STATE_PATH ||
  (existsSync(path.join(__dirname, "storageState.json"))
    ? path.join(__dirname, "storageState.json")
    : path.join(__dirname, "local", "storageState.json"));

async function newBrowserContext() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await context.newPage();
  return { browser, context, page };
}

// Comprueba sesión y devuelve { ok, reason }
async function ensureLoggedIn(page) {
  // Ir a una página que exige login. Si redirige a /login, no hay sesión
  await page.goto("https://www.tiktok.com/settings", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2000);

  const url = page.url();
  if (url.includes("/login")) {
    return { ok: false, reason: "redirected_to_login" };
  }

  // Detección adicional (por si no redirige): presencia de elementos de settings
  const settingsVisible = await page
    .locator('[data-e2e*="settings"], [data-e2e*="account"], h2:has-text("Settings"), h1:has-text("Settings")')
    .first()
    .isVisible()
    .catch(() => false);

  if (settingsVisible) return { ok: true };

  // Último intento: ir a home y buscar avatar
  await page.goto("https://www.tiktok.com", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  const hasAvatar = await page
    .locator('[data-e2e="profile-icon"] img, [data-e2e="top-login-avatar"] img, a[href*="/@"] img')
    .first()
    .isVisible()
    .catch(() => false);

  return { ok: !!hasAvatar, reason: hasAvatar ? undefined : "no_avatar_detected" };
}

// Cierra overlays comunes
async function closeOverlays(page) {
  const selectors = [
    'div[role="dialog"] button:has-text("Cerrar")',
    'div[role="dialog"] button:has-text("Close")',
    'button:has-text("Aceptar todo")',
    'button:has-text("Accept all")',
    '[data-e2e="gdpr_accept_button"]',
  ];
  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(800);
    }
  }
}

// Scroll extendido + expandir respuestas
async function hydrateComments(page, iterations = 30) {
  // Abrir panel si aplica
  const commentBtn = page.locator(
    '[data-e2e="browse-comment-icon"], [aria-label*="Comentario"], [aria-label*="comment"]'
  );
  if (await commentBtn.first().isVisible().catch(() => false)) {
    await commentBtn.first().click({ delay: 120 }).catch(() => {});
    await page.waitForTimeout(1200);
  }

  // Scroll largo
  for (let i = 0; i < iterations; i++) {
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(900);
    // Expandir "Ver más respuestas"
    const moreReplies = page.locator(
      'button:has-text("Ver más respuestas"), button:has-text("More replies")'
    );
    if ((await moreReplies.count()) > 0) {
      const n = await moreReplies.count();
      for (let j = 0; j < n; j++) {
        await moreReplies.nth(j).click().catch(() => {});
        await page.waitForTimeout(400);
      }
    }
  }

  // Esperar a que haya algo que parezca comentario
  await page
    .waitForSelector(
      'div[data-e2e*="comment"], [data-cid], [data-e2e*="comment-item"], [data-e2e*="reply-item"], li:has([data-e2e*="comment"])',
      { timeout: 60000 }
    )
    .catch(() => {});
}

// Buscar comentario por cid o por texto (incluye replies)
async function findCommentHandle(page, { cid, comment_text }) {
  if (cid) {
    const byCid =
      (await page.$(`[data-e2e*="comment-item-${cid}"]`)) ||
      (await page.$(`[data-cid="${cid}"]`)) ||
      (await page.$(`div:has([data-cid="${cid}"])`));
    if (byCid) return byCid;
  }

  // Fallback por texto (flexible)
  const target = (comment_text || "").toLowerCase().trim();
  if (!target) return null;

  const candidates = await page.$$(
    [
      'div[data-e2e*="comment"]',
      '[data-cid]',
      '[data-e2e*="comment-item"]',
      '[data-e2e*="reply-item"]',
      'li:has([data-e2e*="comment"])',
      "p",
      "span",
    ].join(",")
  );

  for (const el of candidates) {
    const txt = ((await el.textContent()) || "").toLowerCase();
    if (txt.includes(target)) return el;
    // También probar con una versión recortada para evitar emojis/espacios raros
    const compact = txt.replace(/\s+/g, " ").trim();
    if (compact.includes(target)) return el;
  }
  return null;
}

// ---------- Endpoints ----------
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Webhook activo" });
});

// Verificación de sesión (robusta)
app.get("/check-login", async (_req, res) => {
  try {
    const { browser, page } = await newBrowserContext();
    console.log("🗂️ Usando storageState:", STORAGE_STATE);

    const status = await ensureLoggedIn(page);
    await browser.close();

    if (status.ok) return res.json({ ok: true, message: "Sesión TikTok activa ✅" });
    return res.json({ ok: false, message: "No se detectó sesión activa ❌", reason: status.reason || "unknown" });
  } catch (err) {
    console.error("❌ check-login error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/run", async (req, res) => {
  const { video_url, comment_text, reply_text, account, row_number, cid } = req.body || {};

  if (!video_url || !reply_text || !row_number) {
    return res.status(400).json({
      ok: false,
      error: "missing_required_fields",
      details: { video_url, reply_text, row_number },
    });
  }
  console.log("🆕 Nuevo request:", { video_url, comment_text, reply_text, account, row_number, cid });
  console.log("🗂️ Usando storageState:", STORAGE_STATE);

  let browser;
  try {
    const ctx = await newBrowserContext();
    browser = ctx.browser;
    const page = ctx.page;

    // 1) Validar sesión antes de ir al video
    const status = await ensureLoggedIn(page);
    if (!status.ok) {
      await browser.close();
      return res.status(401).json({
        ok: false,
        error: "session_expired",
        message: "La sesión de TikTok no está activa. Sube un storageState.json reciente.",
        row_number,
      });
    }

    // 2) Ir al video y preparar comentarios
    await page.goto(video_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    await closeOverlays(page);
    await hydrateComments(page, 30);

    // 3) Buscar el comentario
    const targetComment = await findCommentHandle(page, { cid, comment_text });
    if (!targetComment) {
      throw new Error("Comentario no encontrado ni por cid ni por texto");
    }
    await targetComment.scrollIntoViewIfNeeded().catch(() => {});

    // 4) Responder
    const replyButton =
      (await targetComment.$('button:has-text("Responder")')) ||
      (await targetComment.$('[data-e2e*="reply"]')) ||
      (await targetComment.$('button:has-text("Reply")')) ||
      (await targetComment.$('[aria-label*="Reply"]'));
    if (!replyButton) throw new Error("No se encontró el botón de Responder");
    await replyButton.click({ delay: 200 });
    await page.waitForTimeout(1200);

    const input =
      (await page.$("textarea")) ||
      (await page.$('[contenteditable="true"]')) ||
      (await page.$('[data-e2e="comment-input"]'));
    if (!input) throw new Error("No se encontró el campo de texto para responder");

    await input.click();
    await input.fill(reply_text);
    await page.waitForTimeout(500);

    const publishBtn =
      (await page.$('button:has-text("Publicar")')) ||
      (await page.$('button:has-text("Post")')) ||
      (await page.$('[data-e2e*="post"]'));
    if (!publishBtn) throw new Error("No se encontró el botón de publicar");
    await publishBtn.click({ delay: 250 });
    await page.waitForTimeout(4000);

    const reply_url = video_url;
    await browser.close();

    return res.status(200).json({
      ok: true,
      message: "Comentario respondido correctamente",
      reply_text,
      reply_url,
      row_number,
    });
  } catch (err) {
    console.error("❌ Error en Playwright:", err);
    try {
      if (browser) await browser.close();
    } catch {}
    return res.status(500).json({
      ok: false,
      error: err.message || "unknown_error",
      step: "playwright_flow",
      row_number,
    });
  }
});

// ---------- Boot ----------
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => console.log(`🚀 Servidor activo en http://${HOST}:${PORT}`));
