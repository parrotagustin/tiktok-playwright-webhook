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
  const { video_url, comment_text, reply_text, account, row_number, cid } = req.body || {};

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
    cid,
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

    // 🔹 Cerrar posibles popups de login o consentimiento
    const selectorsToClose = [
      'div[role="dialog"] button:has-text("Cerrar")',
      'div[role="dialog"] button:has-text("Close")',
      'button:has-text("Aceptar todo")',
      'button:has-text("Accept all")',
      '[data-e2e="gdpr_accept_button"]',
    ];
    for (const sel of selectorsToClose) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click().catch(() => {});
        console.log(`🔹 Cerrado overlay con selector: ${sel}`);
        await page.waitForTimeout(1000);
      }
    }

    // 🔹 Intentar abrir panel de comentarios
    const commentBtn = page.locator(
      '[data-e2e="browse-comment-icon"], [aria-label*="Comentario"], [aria-label*="comment"]'
    );
    if (await commentBtn.first().isVisible().catch(() => false)) {
      await commentBtn.first().click({ delay: 120 }).catch(() => {});
      console.log("💬 Panel de comentarios abierto manualmente");
      await page.waitForTimeout(2000);
    }

    // 🔹 Scroll largo y progresivo
    for (let i = 0; i < 15; i++) {
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(1200);
    }

    // 🔹 Esperar realmente a que carguen comentarios
    await page.waitForSelector(
      'div[data-e2e*="comment"], li:has([data-e2e*="comment"]), [data-cid], [data-e2e*="comment-item"], p, span',
      { timeout: 60000 }
    ).catch(() => {});
    console.log("🔎 Buscando comentario...");

    // 🔹 Buscar comentario por cid si está disponible
    let targetComment = null;
    if (cid) {
      console.log(`🧩 Buscando comentario por cid: ${cid}`);
      targetComment =
        (await page.$(`[data-e2e*="comment-item-${cid}"]`)) ||
        (await page.$(`[data-cid="${cid}"]`)) ||
        (await page.$(`div:has([data-cid="${cid}"])`));
    }

    // 🔹 Fallback a búsqueda por texto
    if (!targetComment) {
      console.log("🔍 Buscando comentario por texto (fallback)");
      const lowerTarget = (comment_text || "").toLowerCase().slice(0, 20).trim();
      const elements = await page.$$(
        'div[data-e2e*="comment"], li:has([data-e2e*="comment"]), [data-cid], [data-e2e*="comment-item"], p, span'
      );
      for (const el of elements) {
        const text = (await el.textContent())?.toLowerCase() || "";
        if (text.includes(lowerTarget)) {
          targetComment = el;
          break;
        }
      }
    }

    if (!targetComment) {
      throw new Error("Comentario no encontrado ni por cid ni por texto");
    }

    await targetComment.scrollIntoViewIfNeeded().catch(() => {});
    console.log("💬 Comentario encontrado, abriendo campo de respuesta...");

    // 🔹 Botón de respuesta
    const replyButton =
      (await targetComment.$('button:has-text("Responder")')) ||
      (await targetComment.$('[data-e2e*="reply"]')) ||
      (await targetComment.$('button:has-text("Reply")')) ||
      (await targetComment.$('[aria-label*="Reply"]'));
    if (!replyButton) throw new Error("No se encontró el botón de Responder");
    await replyButton.click({ delay: 200 });
    await page.waitForTimeout(1500);

    // 🔹 Campo de texto
    const input =
      (await page.$('textarea')) ||
      (await page.$('[contenteditable="true"]')) ||
      (await page.$('[data-e2e="comment-input"]'));
    if (!input) throw new Error("No se encontró el campo de texto para responder");

    await input.click();
    await input.fill(reply_text);
    await page.waitForTimeout(800);

    // 🔹 Publicar
    const publishBtn =
      (await page.$('button:has-text("Publicar")')) ||
      (await page.$('button:has-text("Post")')) ||
      (await page.$('[data-e2e*="post"]'));
    if (!publishBtn) throw new Error("No se encontró el botón de publicar");
    await publishBtn.click({ delay: 300 });
    await page.waitForTimeout(4000);

    console.log("✅ Respuesta publicada con éxito");

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
