import { chromium } from "playwright";

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www.tiktok.com/login");
  console.log("➡️ Inicia sesión manualmente (Google, QR, o correo).");
  console.log("⏳ Tienes 90 segundos para hacerlo...");

  // Espera 90 segundos para que completes el login
  await page.waitForTimeout(90000);

  // Guarda las cookies y el estado
  await context.storageState({ path: "storageState.json" });
  await browser.close();
  console.log("✅ storageState.json guardado con sesión activa");
})();
