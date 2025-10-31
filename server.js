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

// ---------- Normalizador de texto (fuzzy) ----------
function normalize(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD") // separa acentos
    .replace(/[\u0300-\u036f]/g, "") // elimina tildes
    .replace(/[¿?¡!.,:;]/g, "") // elimina signos
    .replace(/\s+/g, " ") // colapsa espacios
    .trim();
}

// ---------- Verificación de sesión ----------
async function ensureLoggedIn(page) {
  await page.goto("https://www.tiktok.com/settings", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2000);

  if (page.url().includes("/login")) return { ok: false, reason: "redirected_to_login" };

  const settingsVisible = await page
    .locator('[data-e2e*="settings"], [data-e2e*="account"]')
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
    .locator('[data-e2e="profile-icon"] img, [data-e2e="top-login-avatar"] img, a[href*="/@"] img')
    .first()
    .isVisible()
    .catch(() => false);
  return { ok: !!hasAvatar };
}

// ---------- Cierra popups ----------
async function closeOverlays(page) {
  const selectors = [
    'div[role="dialog"] button:has-text("Cerrar")',
    'button:has-text("Aceptar todo")',
    '[data-e2e="gdpr_accept_button"]',
  ];
  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(600);
    }
  }
}

// ---------- Abre y recorre el panel lateral ----------
async function hydrateComments(page, iterations = 50) {
  console.log("💬 Intentando abrir panel lateral de comentarios...");

  const buttonSelectors = [
    'button[data-e2e="comment-icon"]',
    '[aria-label*="Comentario"]',
    '[data-e2e="browse-comment-icon"]',
  ];
  for (const sel of buttonSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click({ delay: 100 }).catch(() => {});
      console.log(`✅ Click en botón (${sel})`);
      await page.waitForTimeout(2500);
      break;
    }
  }

  const containerSelector = "div.TUXTabBar-content, div[data-e2e*='comment']";
  await page.waitForSelector(containerSelector, { timeout: 15000 });
  const container = await page.$(containerSelector);
  if (!container) {
    console.warn("⚠️ No se encontró contenedor de comentarios.");
    return;
  }

  console.log("🧭 Scrolleando comentarios...");
  for (let i = 0; i < iterations; i++) {
    await container.evaluate((el) => el.scrollBy(0, 1500));
    await page.waitForTimeout(900);
    const expand = await page.$$(
      'button:has-text("Ver más respuestas"), button:has-text("More replies")'
    );
    for (const btn of expand) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }
  console.log("✅ Scroll completado.");
}

// ---------- Búsqueda combinada del comentario ----------
async function findCommentHandle(page, { cid, comment_text }) {
  // 1️⃣ Buscar por CID exacto
  if (cid) {
    const byCid =
      (await page.$(`[data-e2e="comment-item-${cid}"]`)) ||
      (await page.$(`[data-cid="${cid}"]`)) ||
      (await page.$(`div:has([data-cid="${cid}"])`));
    if (byCid) {
      console.log(`🎯 Comentario encontrado por CID (${cid})`);
      return byCid;
    }
  }

  // 2️⃣ Buscar por estructura DOM conocida
  const structuralCandidates = await page.$$(
    'div[data-e2e^="comment-item"], div[data-cid], li:has([data-e2e^="comment-item"])'
  );
  const targetNorm = normalize(comment_text);
  for (const el of structuralCandidates) {
    const inner = normalize(await el.textContent());
    if (inner.includes(targetNorm)) {
      console.log("🎯 Comentario encontrado por patrón estructural DOM.");
      return el;
    }
  }

  // 3️⃣ Fuzzy matching global (fallback)
  console.log("🔎 Buscando comentario por texto (fuzzy)...");
  const allNodes = await page.$$(
    "span, p, div[data-e2e*='comment'], [data-cid], [data-e2e*='comment-item'], [data-e2e*='reply-item']"
  );
  for (const el of allNodes) {
    const txt = normalize(await el.textContent());
    if (txt.includes(targetNorm)) {
      console.log("🎯 Comentario encontrado por texto (fuzzy).");
      return el;
    }
  }

  console.warn("⚠️ No se encontró el comentario por ninguna estrategia.");
  return null;
}

// ---------- Endpoints ----------
app.get("/", (_req, res) => res.json({ status: "ok", message: "Webhook activo" }));

// Verificación de sesión
app.get("/check-login", async (_req, res) => {
  try {
    const { browser, page } = await newBrowserContext();
    const status = await ensureLoggedIn(page);
    await browser.close();
    res.json(
      status.ok
        ? { ok: true, message: "Sesión TikTok activa ✅" }
        : { ok: false, message: "No se detectó sesión activa ❌" }
    );
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Automatización principal ----------
app.post("/run", async (req, res) => {
  const { video_url, comment_text, reply_text, account, row_number, cid } = req.body || {};
  if (!video_url || !reply_text || !row_number)
    return res.status(400).json({ ok: false, error: "missing_required_fields" });

  console.log("🆕 Nuevo request recibido:", { video_url, comment_text, reply_text, cid });
  console.log("🗂️ Usando storageState:", STORAGE_STATE);

  let browser;
  try {
    const { browser: b, page } = await newBrowserContext();
    browser = b;

    const status = await ensureLoggedIn(page);
    if (!status.ok) {
      await browser.close();
      return res.status(401).json({
        ok: false,
        error: "session_expired",
        message: "La sesión de TikTok no está activa. Sube un storageState.json reciente.",
      });
    }

    await page.goto(video_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    await closeOverlays(page);
    await hydrateComments(page, 50);

    const targetComment = await findCommentHandle(page, { cid, comment_text });
    if (!targetComment) throw new Error("Comentario no encontrado.");

    await targetComment.scrollIntoViewIfNeeded().catch(() => {});
    console.log("💬 Comentario visible, intentando responder...");

    const replyButton =
      (await targetComment.$('[data-e2e^="comment-reply"]')) ||
      (await targetComment.$('span:has-text("Responder")')) ||
      (await targetComment.$('button:has-text("Responder")')) ||
      (await targetComment.$('[aria-label*="Reply"]'));
    if (!replyButton) throw new Error("No se encontró botón 'Responder'.");

    await replyButton.click({ delay: 150 });
    await page.waitForTimeout(1500);

    await page.waitForSelector('[data-e2e="comment-input"] div[contenteditable="true"]', {
      timeout: 10000,
    });
    const inputBox = await page.$('[data-e2e="comment-input"] div[contenteditable="true"]');
    if (!inputBox) throw new Error("No se encontró el campo editable.");

    await inputBox.click();
    await inputBox.fill(reply_text);
    console.log("📝 Texto ingresado en el campo.");
    await page.waitForTimeout(800);

    await page.keyboard.press("Enter");
    console.log("⌨️ Enter presionado para enviar la respuesta.");
    await page.waitForTimeout(3000);

    const publishBtn =
      (await page.$('[data-e2e="comment-post"]')) ||
      (await page.$('button:has-text("Publicar")'));
    if (publishBtn) {
      await publishBtn.click({ delay: 200 }).catch(() => {});
      console.log("🚀 Click en 'Publicar' (opcional).");
    }

    await page.waitForTimeout(3000);
    await browser.close();
    res.json({
      ok: true,
      message: "✅ Respuesta publicada con éxito.",
      reply_text,
      row_number,
    });
  } catch (err) {
    console.error("❌ Error en flujo Playwright:", err);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ ok: false, error: err.message || "unknown_error" });
  }
});

// ---------- Boot ----------
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => console.log(`🚀 Servidor activo en http://${HOST}:${PORT}`));
