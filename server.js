import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- Configuración ----------
const EXECUTION_TIMEOUT_MS = 180000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE =
  process.env.STORAGE_STATE_PATH ||
  (existsSync(path.join(__dirname, "storageState.json"))
    ? path.join(__dirname, "storageState.json")
    : path.join(__dirname, "local", "storageState.json"));

// ---------- Utilidades ----------
function normalize(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!.,:;'"`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function newBrowserContext() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await context.newPage();
  return { browser, context, page };
}

// ---------- Funciones auxiliares ----------
async function ensureLoggedIn(page) {
  await page.goto("https://www.tiktok.com/settings", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2000);
  if (page.url().includes("/login")) return { ok: false };

  const hasAvatar = await page
    .locator('[data-e2e="profile-icon"] img, a[href*="/@"] img')
    .first()
    .isVisible()
    .catch(() => false);

  return { ok: !!hasAvatar };
}

async function closeOverlays(page) {
  const selectors = [
    'div[role="dialog"] button:has-text("Cerrar")',
    'button:has-text("Aceptar todo")',
    '[data-e2e="gdpr_accept_button"]',
  ];
  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) await btn.click().catch(() => {});
  }
}

async function hydrateComments(page, iterations = 25) {
  console.log("💬 Abriendo panel lateral de comentarios...");
  const commentButtonSelectors = [
    'button[data-e2e="comment-icon"]',
    '[aria-label*="Comentario"]',
    '[aria-label*="comment"]',
  ];
  for (const sel of commentButtonSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click().catch(() => {});
      console.log(`✅ Click en botón (${sel})`);
      await page.waitForTimeout(2500);
      break;
    }
  }

  const container = await page.$("div.TUXTabBar-content, div[data-e2e*='comment']");
  if (!container) return;
  console.log("🧭 Scrolleando dentro del panel lateral...");
  for (let i = 0; i < iterations; i++) {
    await container.evaluate((el) => el.scrollBy(0, 1500));
    await page.waitForTimeout(600);
  }
  console.log("✅ Scroll completado.");
}

async function findCommentHandle(page, { cid, comment_text }) {
  const targetNorm = normalize(comment_text);

  if (cid) {
    const byCid = await page.$(`[data-cid="${cid}"], [data-e2e="comment-item-${cid}"]`);
    if (byCid) {
      console.log(`🎯 Comentario encontrado por CID (${cid})`);
      return byCid;
    }
  }

  const all = await page.$$('[data-e2e*="comment"], [data-cid]');
  for (const el of all) {
    const txt = normalize(await el.textContent());
    if (txt.includes(targetNorm)) {
      console.log("🎯 Comentario encontrado por texto (fuzzy).");
      return el;
    }
  }

  console.warn("⚠️ No se encontró el comentario.");
  return null;
}

// ---------- Endpoints ----------
app.get("/", (_req, res) => res.json({ status: "ok", message: "Webhook activo" }));

app.post("/run", async (req, res) => {
  const { video_url, comment_text, reply_text, row_number, cid } = req.body || {};
  if (!video_url || !reply_text)
    return res.status(400).json({ ok: false, error: "missing_required_fields" });

  console.log("🆕 Nuevo request:", { video_url, comment_text, reply_text, cid });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("⏱️ Timeout global alcanzado.")), EXECUTION_TIMEOUT_MS)
  );

  let browser;
  try {
    await Promise.race([
      (async () => {
        const { browser: b, page } = await newBrowserContext();
        browser = b;

        const status = await ensureLoggedIn(page);
        if (!status.ok) throw new Error("Sesión no activa en TikTok.");

        await page.goto(video_url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await closeOverlays(page);
        await hydrateComments(page, 25);

        const targetComment = await findCommentHandle(page, { cid, comment_text });
        if (!targetComment) throw new Error("Comentario no encontrado.");

        await targetComment.scrollIntoViewIfNeeded().catch(() => {});
        console.log("💬 Comentario visible, intentando responder...");

        const replyBtn =
          (await targetComment.$('[data-e2e*="comment-reply"]')) ||
          (await targetComment.$('button:has-text("Responder")'));
        if (!replyBtn) throw new Error("No se encontró botón 'Responder'.");

        await replyBtn.click({ delay: 150 });
        await page.waitForTimeout(1000);

        // Buscar campo editable real
        let input = await page.$('[data-e2e="comment-input"] [contenteditable="true"]');
        if (!input) input = await page.$('[contenteditable="true"]');
        if (!input) throw new Error("No se encontró campo editable real.");

        // Escribir manualmente mediante evaluate
        await page.evaluate(
          (el, text) => {
            el.focus();
            el.innerText = text;
            const event = new InputEvent("input", { bubbles: true, cancelable: true });
            el.dispatchEvent(event);
          },
          input,
          reply_text
        );

        console.log("📝 Texto ingresado correctamente.");
        await page.waitForTimeout(1000);
        await page.keyboard.press("Enter");
        console.log("⌨️ Enter presionado para enviar.");
        await page.waitForTimeout(3000);

        await browser.close();
        res.json({ ok: true, message: "✅ Respuesta publicada con éxito.", row_number });
      })(),
      timeoutPromise,
    ]);
  } catch (err) {
    console.error("❌ Error:", err.message);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Boot ----------
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => console.log(`🚀 Servidor activo en http://${HOST}:${PORT}`));
