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
    console.error("⚠️ Cuenta no especificada, usando 'main_account' por defecto");
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

    // Esperar panel de comentarios
    try {
      await page.waitForSelector(
        'div[data-e2e="comment-list"], div[data-e2e*="comment"], ul:has(li:has([data-e2e*="comment"]))',
        { timeout: 45000 }
      );
      console.log("💬 Comentarios detectados correctamente");
    } catch {
      console.warn("⚠️ No se detectaron comentarios visibles. Reintentando scroll...");
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(5000);
    }

    // Buscar comentario por texto parcial
    const comments = await page.$$(
      'div[data-e2e*="comment"], li:has([data-e2e*="comment"])'
    );
    let targetComment = null;

    for (const el of comments) {
      const text = (await el.textContent()) || "";
      if (text.toLowerCase().includes(comment_text.toLowerCase().slice(0, 10))) {
        targetComment = el;
        break;
      }
    }

    if (!targetComment) {
      throw new Error("Comentario no encontrado o no visible");
    }

    await targetComment.scrollIntoViewIfNeeded().catch(() => {});
    console.log("💬 Comentario encontrado, abriendo campo de respuesta...");

    // Botón de responder (varias variantes)
    const replyButton =
      (await targetComment.$('button:has-text("Responder")')) ||
      (await targetComment.$('[data-e2e*="reply"]')) ||
      (await targetComment.$('button:has-text("Reply")')) ||
      (await targetComment.$('[aria-label*="Reply"]'));

    if (!replyButton) throw new Error("No se encontró el botón de Responder");

    await replyButton.click({ delay: 200 });
    await page.waitForTimeout(1200);

    // Campo de texto (textarea o contenteditable)
    const input =
      (await page.$('textarea')) ||
      (await page.$('[contenteditable="true"]')) ||
      (await page.$('[data-e2e="comment-input"]'));

    if (!input) throw new Error("No se encontró el campo de entrada de texto");

    await input.click();
    await input.fill(reply_text);
    await page.waitForTimeout(800);

    // Botón de publicar (varias variantes)
    const publishBtn =
      (await page.$('button:has-text("Publicar")')) ||
      (await page.$('button:has-text("Post")')) ||
      (await page.$('[data-e2e*="post"]'));

    if (!publishBtn) throw new Error("No se encontró el botón de Publicar/Enviar");

    await publishBtn.click({ delay: 300 });
    await page.waitForTimeout(3000);

    console.log("✅ Respuesta publicada con éxito");

    // Intento de capturar el enlace del comentario respondido
    const reply_url = video_url; // fallback al video
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
