const fs = require("fs");

(async () => {
  try {
    const cookies = JSON.parse(fs.readFileSync("cookies.json", "utf8"));

    const storageState = {
      cookies: cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: ".tiktok.com",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "None"
      })),
      origins: []
    };

    fs.writeFileSync("storageState.json", JSON.stringify(storageState, null, 2));
    console.log("✅ Archivo storageState.json creado correctamente");
  } catch (err) {
    console.error("❌ Error al convertir cookies:", err);
  }
})();
