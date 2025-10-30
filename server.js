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

    // Buscamos el comentario
    const commentSelector = `text="${comment_text}"`;
    const comment = await page.locator(commentSelector).first();

    if (await comment.count() === 0) {
      throw new Error("Comentario no encontrado");
    }

    await comment.scrollIntoViewIfNeeded();
    console.log("💬 Comentario encontrado, abriendo campo de respuesta...");

    // Abrir campo de respuesta
    const replyButton = await comment.locator('button:has-text("Responder")');
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
