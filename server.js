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

// Verifica sesión activa
async function ensureLoggedIn(page) {
  await page.goto("https://www.tiktok.com/settings", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2000);

  const url = page.url();
  if (url.includes("/login")) return { ok: false, reason: "redirected_to_login" };

  const settingsVisible = await page
    .locator(
      '[data-e2e*="settings"], [data-e2e*="account"], h2:has-text("Settings"), h1:has-text("Settings")'
    )
    .first()
    .isVisible()
    .catch(() => false);

  if (settingsVisible) return { ok: true };

  await page.goto("https://www.tiktok.com", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2000);

  const hasAvatar = await page
    .locator(
      '[data-e2e="profile-icon"] img, [data-e2e="top-login-avatar"] img, a[href*="/@"] img'
    )
    .first()
    .isVisible()
    .catch(() => false);

  return { ok: !!hasAvatar, reason: hasAvatar ? undefined : "no_avatar_detected" };
}

// Cierra popups comunes
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

// Abre y recorre el panel lateral de comentarios
async function hydrateComments(page, iterations = 40) {
  console.log("💬 Intentando abrir panel lateral de comentarios...");

  // Abrir el panel lateral
  const commentButtonSelectors = [
    'button[data-e2e="comment-icon"]',
    '[aria-label*="Comentario"]',
    '[aria-label*="comment"]',
    '[data-e2e="browse-comment-icon"]',
  ];

  for (const sel of commentButtonSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click({ delay: 120 }).catch(() => {});
      console.log(`✅ Click en botón de comentarios (${sel})`);
      await page.waitForTimeout(2500);
      break;
    }
  }

  // Esperar contenedor lateral
  const containerSelector = "div.TUXTabBar-content, div[data-e2e*='comment']";
  await page.waitForSelector(containerSelector, { timeout: 15000 });
  const container = await page.$(containerSelector);
  if (!container) {
    console.warn("⚠️ No se encontró el contenedor de comentarios.");
    return;
  }

  console.log("🧭 Panel de comentarios detectado. Realizando scroll interno...");

  // Scroll interno dentro del panel lateral
  for (let i = 0; i < iterations; i++) {
    await container.evaluate((el) => el.scrollBy(0, 1500));
    await page.waitForTimeout(1000);

    // Expandir “Ver más respuestas”
    const moreReplies = await page.$$(
      'button:has-text("Ver más respuestas"), button:has-text("More replies")'
    );
    for (const btn of moreReplies) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(400);
    }
  }

  console.log("✅ Scroll completado dentro del panel lateral de comentarios.");
}

// Buscar comentario por cid o por texto
async function findCommentHandle(page, { cid, comment_text }) {
  if (cid) {
    const byCid =
      (await page.$(`[data-e2e*="comment-item-${cid}"]`)) ||
      (await page.$(`[data-cid="${cid}"]`)) ||
      (await page.$(`div:has([data-cid="${cid}"])`));
    if (byCid) return byCid;
  }

  const target = (comment_text || "").toLowerCase().trim();
  if (!target) return null;

  const candidates = await page.$$(
    [
      "div[data-e2e*='comment']",
      "[data-cid]",
      "[data-e2e*='comment-item']",
      "[data-e2e*='reply-item']",
      "li:has([data-e2e*='comment'])",
      "p",
      "span",
    ].join(",")
  );

  for (const el of candidates) {
    const txt = ((await el.textContent()) || "").toLowerCase();
    if (txt.includes(target)) return el;
    const compact = txt.replace(/\s+/g, " ").trim();
    if (compact.includes(target)) return el;
  }
  return null;
}

// ---------- Endpoints ----------
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Webhook activo" });
});

// Verificar sesión
app.get("/check-login", async (_req, res) => {
  try {
    const { browser, page } = await newBrowserContext();
    console.log("🗂️ Usando storageState:", STORAGE_STATE);

    const status = await ensureLoggedIn(page);
    await browser.close();

    if (status.ok)
      return res.json({ ok: true, message: "Sesión TikTok activa ✅" });
    return res.json({
      ok: false,
      message: "No se detectó sesión activa ❌",
      reason: status.reason || "unknown",
    });
  } catch (err) {
    console.error("❌ check-login error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Ejecutar respuesta automática
app.post("/run", async (req, res) => {
  const { video_url, comment_text, reply_text, account, row_number, cid } =
    req.body || {};

  if (!video_url || !reply_text || !row_number) {
    return res.status(400).json({
      ok: false,
      error: "missing_required_fields",
      details: { video_url, reply_text, row_number },
    });
  }

  console.log("🆕 Nuevo request:", {
    video_url,
    comment_text,
    reply_text,
    account,
    row_number,
    cid,
  });
  console.log("🗂️ Usando storageState:", STORAGE_STATE);

  let browser;
  try {
    const ctx = await newBrowserContext();
    browser = ctx.browser;
    const page = ctx.page;

    const status = await ensureLoggedIn(page);
    if (!status.ok) {
      await browser.close();
      return res.status(401).json({
        ok: false,
        error: "session_expired",
        message:
          "La sesión de TikTok no está activa. Sube un storageState.json reciente.",
        row_number,
      });
    }

    await page.goto(video_url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    await closeOverlays(page);
    await hydrateComments(page, 40);

    const targetComment = await findCommentHandle(page, { cid, comment_text });
    if (!targetComment)
      throw new Error("Comentario no encontrado ni por cid ni por texto");

    await targetComment.scrollIntoViewIfNeeded().catch(() => {});

    // --- Nueva lógica de respuesta (2024) ---
    console.log("💬 Comentario encontrado, intentando responder...");

    const replyButton =
      (await targetComment.$('[data-e2e^="comment-reply"]')) ||
      (await targetComment.$('span:has-text("Responder")')) ||
      (await targetComment.$('button:has-text("Responder")')) ||
      (await targetComment.$('[aria-label*="Reply"]'));

    if (!replyButton)
      throw new Error("No se encontró el botón 'Responder' en el comentario");

    await replyButton.click({ delay: 150 });
    console.log("✅ Click en botón 'Responder' realizado.");
    await page.waitForTimeout(1500);

    await page.waitForSelector(
      '[data-e2e="comment-input"] div[contenteditable="true"]',
      { timeout: 10000 }
    );
    const inputBox = await page.$(
      '[data-e2e="comment-input"] div[contenteditable="true"]'
    );
    if (!inputBox)
      throw new Error("No se encontró el campo editable para escribir la respuesta.");

    await inputBox.click();
    await inputBox.fill(reply_text);
    console.log("📝 Texto de respuesta ingresado.");
    await page.waitForTimeout(800);

    // Simular tecla Enter para enviar
    await page.keyboard.press("Enter");
    console.log("⌨️ Enter presionado para enviar la respuesta.");
    await page.waitForTimeout(3000);

    // Intento adicional: click en botón 'Publicar'
    const publishBtn =
      (await page.$('[data-e2e="comment-post"]')) ||
      (await page.$('button:has-text("Publicar")')) ||
      (await page.$('button:has-text("Post")'));
    if (publishBtn) {
      await publishBtn.click({ delay: 250 }).catch(() => {});
      console.log("🚀 Click en 'Publicar' (opcional) realizado.");
    }

    await page.waitForTimeout(4000);
    console.log("✅ Respuesta publicada con éxito.");

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
app.listen(PORT, HOST, () =>
  console.log(`🚀 Servidor activo en http://${HOST}:${PORT}`)
);
