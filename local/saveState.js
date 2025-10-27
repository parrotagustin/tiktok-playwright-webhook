import { chromium } from "playwright";

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www.tiktok.com/login");
  console.log("➡️ Iniciá sesión en TikTok manualmente (usuario/clave/2FA si corresponde).");

  // Tenés 2 minutos para completar el login
  await page.waitForTimeout(120000);

  await context.storageState({ path: "storageState.json" });
  console.log("✅ Guardado: storageState.json");

  await browser.close();
})();
