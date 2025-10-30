import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Webhook activo" });
});

app.post("/run", async (req, res) => {
  const { video_url, comment_text, reply_text, account } = req.body || {};

  if (!video_url) {
    return res.status(400).json({ ok: false, error: "Falta video_url" });
  }

  console.log("🆕 Nuevo request recibido:", { video_url, comment_text, reply_text, account });

  try {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    // Usamos tus cookies guardadas
    const context = await browser.newContext({
      storageState: "storageState.json"
    });

    const page = await context.newPage();
    await page.goto(video_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log("✅ Video cargado correctamente");

    // Espera breve para asegurar carga de comentarios
    await page.waitForTimeout(5000);

    // Esperar a que los comentarios carguen
    await page.waitForSelector('[data-e2e="comment-item"]', { timeout: 15000 });

    // Buscar el comentario por coincidencia parcial
    const comments = await page.$$('[data-e2e="comment-item"]');
    let targetComment = null;

    for (const el of comments) {
      const text = await el.textContent();
      if (text && text.toLowerCase().includes(comment_text.toLowerCase().slice(0, 10))) {
        targetComment = el;
        break;
      }
    }

    if (!targetComment) {
      throw new Error("Comentario no encontrado o no visible");
    }

    await targetComment.scrollIntoViewIfNeeded();
    console.log("💬 Comentario encontrado, abriendo campo de respuesta...");

    // Abrir campo de respuesta
    const replyButton = await targetComment.locator('button:has-text("Responder")');
    await replyButton.click({ delay: 300 });
    await page.waitForTimeout(1000);

    // Escribir la respuesta
    const input = page.locator('textarea');
    await input.fill(reply_text);
    await page.waitForTimeout(800);

    // Publicar comentario
    const publishBtn = page.locator('button:has-text("Publicar")');
    await publishBtn.click({ delay: 300 });
    await page.waitForTimeout(2000);

    console.log("✅ Respuesta publicada con éxito");

    await browser.close();

    res.json({ ok: true, message: "Comentario respondido correctamente" });
  } catch (err) {
    console.error("❌ Error en Playwright:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => console.log(`🚀 Servidor activo en http://${HOST}:${PORT}`));
