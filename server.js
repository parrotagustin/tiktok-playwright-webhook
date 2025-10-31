import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Webhook activo" });
});

app.post("/run", async (req, res) => {
  const { video_url, comment_text, reply_text, account, row_number } = req.body || {};

  // ✅ Validación robusta de parámetros
  if (!video_url || !reply_text || !row_number) {
    console.error("❌ Campos faltantes:", { video_url, reply_text, row_number });
    return res.status(400).json({
      ok: false,
      error: "missing_required_fields",
      details: { video_url, reply_text, row_number },
    });
  }

  if (!account || !account.trim()) {
    console.warn("⚠️ Cuenta no especificada, usando 'main_account' por defecto");
  }

  console.log("🆕 Nuevo request recibido:", {
    video_url,
    comment_text,
    reply_text,
    account: account || "main_account",
    row_number,
  });

  try {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      storageState: "storageState.json",
    });

    const page = await context.newPage();
    await page.goto(video_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    console.log("✅ Video cargado correctamente");

    // 🟢 Intentar abrir sección de comentarios si está colapsada
    try {
      const openComments = page.locator(
        '[data-e2e="browse-comment-icon"], [data-e2e*="comment"] button, [aria-label*="Comentarios"], [aria-label*="comment"]'
      );
      if (await openComments.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await openComments.first().click({ delay: 80 }).catch(() => {});
        console.log("💬 Panel de comentarios abierto");
      }
    } catch (e) {
      console.log("⚠️ No se detectó botón para abrir comentarios");
    }

    // 🟢 Esperar contenedor de comentarios
    await page.waitForSelector(
      'div[data-e2e="comment-list"], div[data-e2e*="comment"], ul:has(li:has([data-e2e*="comment"]))',
      { timeout: 45000 }
    ).catch(() => console.warn("⚠️ Comentarios no visibles aún"));

    // 🟢 Scroll incremental para forzar carga completa
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(1000);
    }
    console.log("🔎 Buscando comentario...");

    // 🟢 Buscar comentario de forma flexible
    const lowerTarget = (comment_text || "").toLowerCase().slice(0, 20).trim();
    const comments = await page.$$(
      'div[data-e2e*="comment"], li:has([data-e2e*="comment"]), p, span'
    );

    let targetComment = null;
    for (const el of comments) {
      const text = (await el.textContent())?.toLowerCase() || "";
      if (text.includes(lowerTarget)) {
        targetComment = el;
        break;
      }
    }

    if (!targetComment) {
      throw new Error("Comentario no encontrado o no visible después de scrollear");
    }

    await targetComment.scrollIntoViewIfNeeded().catch(() => {});
    console.log("💬 Comentario encontrado, abriendo campo de respuesta...");

    // 🟢 Botón de responder (varias variantes)
    const replyButton =
      (await targetComment.$('button:has-text("Responder")')) ||
      (await targetComment.$('[data-e2e*="reply"]')) ||
      (await targetComment.$('button:has-text("Reply")')) ||
      (await targetComment.$('[aria-label*="Reply"]')) ||
      (await targetComment.$('[role="button"]:has-text("Responder")'));

    if (!replyButton) throw new Error("No se encontró el botón de Responder");

    await replyButton.click({ delay: 200 });
    await page.waitForTimeout(1500);

    // 🟢 Campo de texto
    const input =
      (await page.$('textarea')) ||
      (await page.$('[contenteditable="true"]')) ||
      (await page.$('[data-e2e="comment-input"]')) ||
      (await page.$('div[role="textbox"]'));

    if (!input) throw new Error("No se encontró el campo de texto para responder");

    await input.click();
    await input.fill(reply_text);
    await page.waitForTimeout(800);

    // 🟢 Botón de publicar
    const publishBtn =
      (await page.$('button:has-text("Publicar")')) ||
      (await page.$('button:has-text("Post")')) ||
      (await page.$('[data-e2e*="post"]')) ||
      (await page.$('[aria-label*="Post"]')) ||
      (await page.$('button:has-text("Enviar")'));

    if (!publishBtn) throw new Error("No se encontró el botón de Publicar/Enviar");

    await publishBtn.click({ delay: 300 });
    await page.waitForTimeout(4000);
    console.log("✅ Respuesta publicada con éxito");

    // 🟢 Intentar capturar URL (fallback al video)
    const reply_url = video_url;
    await browser.close();

    res.status(200).json({
      ok: true,
      message: "Comentario respondido correctamente",
      reply_text,
      reply_url,
      row_number,
    });
  } catch (err) {
    console.error("❌ Error en Playwright:", err);
    res.status(500).json({
      ok: false,
      error: err.message || "unknown_error",
      step: "playwright_flow",
      row_number,
    });
  }
});

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () =>
  console.log(`🚀 Servidor activo en http://${HOST}:${PORT}`)
);
