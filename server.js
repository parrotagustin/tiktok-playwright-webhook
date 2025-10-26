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

  console.log("Nuevo request recibido:", { video_url, comment_text, reply_text, account });

  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(video_url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Aquí luego añadiremos la lógica real (login, comentar, etc.)
    await browser.close();

    res.json({ ok: true, message: "Ejecución Playwright completada (modo test)" });
  } catch (err) {
    console.error("Error en Playwright:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
