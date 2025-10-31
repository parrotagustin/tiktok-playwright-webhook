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
const EXECUTION_TIMEOUT_MS = 180000; // 3 minutos máximo
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

// ---------- Verificación de sesión ----------
async function ensureLoggedIn(page) {
  await page.goto("https://www.tiktok.com/settings", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2000);

  if (page.url().includes("/login")) return { ok: false, reason: "redirected_to_login" };

  const settingsVisible = await page
    .locator('[data-e2e*="settings"], [data-e2e*="account"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (settingsVisible) return { ok: true };

  await page.goto("https://www.tiktok.com", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);

  const hasAvatar = await page
    .locator('[data-e2e="profile-icon"] img, [data-e2e="top-login-avatar"] img, a[href*="/@"] img')
    .first()
    .isVisible()
    .catch(() => false);

  return { ok: !!hasAvatar, reason: hasAvatar ? undefined : "no_avatar_detected" };
}

// ---------- Cierra popups ----------
async function closeOverlays(page) {
  const selectors = [
    'div[role="dialog"] button:has-text("Cerrar")',
    'button:has-text("Aceptar todo")',
    '[data-e2e="gdpr_accept_button"]',
  ];
  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(600);
    }
  }
}

// ---------- Deep DOM (Shadow DOM aware) ----------
async function queryDeepHandle(page, predicate, args = {}) {
  return await page.evaluateHandle(
    ({ predicate, args }) => {
      const norm = (t) =>
        (t || "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[¿?¡!.,:;'"`]/g, "")
          .replace(/\s+/g, " ")
          .trim();

      const pred = new Function("node", "norm", "args", predicate);
      const visited = new Set();

      function* deepChildren(root) {
        if (!root || visited.has(root)) return;
        visited.add(root);
        const kids = root.children ? Array.from(root.children) : [];
        for (const k of kids) {
          yield k;
          yield* deepChildren(k);
        }
        const sr = root.shadowRoot;
        if (sr) {
          const skids = Array.from(sr.children || []);
          for (const sk of skids) {
            yield sk;
            yield* deepChildren(sk);
          }
        }
      }

      const roots = [document.documentElement];
      for (const r of roots) {
        if (pred(r, norm, args)) return r;
        for (const n of deepChildren(r)) {
          if (pred(n, norm, args)) return n;
        }
      }
      return null;
    },
    { predicate: String(predicate), args }
  );
}

async function queryAllDeepHandles(page, predicate, args = {}) {
  return await page.evaluateHandle(
    ({ predicate, args }) => {
      const norm = (t) =>
        (t || "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[¿?¡!.,:;'"`]/g, "")
          .replace(/\s+/g, " ")
          .trim();

      const pred = new Function("node", "norm", "args", predicate);
      const out = [];
      const visited = new Set();

      function* deepChildren(root) {
        if (!root || visited.has(root)) return;
        visited.add(root);
        const kids = root.children ? Array.from(root.children) : [];
        for (const k of kids) {
          yield k;
          yield* deepChildren(k);
        }
        const sr = root.shadowRoot;
        if (sr) {
          const skids = Array.from(sr.children || []);
          for (const sk of skids) {
            yield sk;
            yield* deepChildren(sk);
          }
        }
      }

      const roots = [document.documentElement];
      for (const r of roots) {
        if (pred(r, norm, args)) out.push(r);
        for (const n of deepChildren(r)) {
          if (pred(n, norm, args)) out.push(n);
        }
      }
      return out;
    },
    { predicate: String(predicate), args }
  );
}

// ---------- Panel de comentarios ----------
async function hydrateComments(page, iterations = 25) {
  console.log("💬 Abriendo panel lateral de comentarios...");

  const commentButtonSelectors = [
    'button[data-e2e="comment-icon"]',
    '[aria-label*="Comentario"]',
    '[aria-label*="comment"]',
    '[data-e2e="browse-comment-icon"]',
  ];
  for (const sel of commentButtonSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click({ delay: 120 }).catch(() => {});
      console.log(`✅ Click en botón de comentarios (${sel})`);
      await page.waitForTimeout(2500);
      break;
    }
  }

  const containerSelector = "div.TUXTabBar-content, div[data-e2e*='comment']";
  await page.waitForSelector(containerSelector, { timeout: 15000 }).catch(() => {});
  const container = await page.$(containerSelector);
  if (!container) {
    console.warn("⚠️ No se encontró el contenedor de comentarios.");
    return;
  }

  console.log("🧭 Scrolleando dentro del panel lateral...");
  for (let i = 0; i < iterations; i++) {
    await container.evaluate((el) => el.scrollBy(0, 1600));
    await page.waitForTimeout(700);
  }
  console.log("✅ Scroll completado.");
}

// ---------- Buscar comentario (CID + DOM + Fuzzy Deep) ----------
async function findCommentHandle(page, { cid, comment_text }) {
  const targetNorm = normalize(comment_text);

  if (cid) {
    const byCid = await queryDeepHandle(
      page,
      `
      return (node, norm, args) => {
        const de = node.getAttribute && node.getAttribute('data-e2e');
        const dc = node.getAttribute && node.getAttribute('data-cid');
        if (de === 'comment-item-' + args.cid) return true;
        if (dc === args.cid) return true;
        return false;
      }
      `,
      { cid }
    );
    const el = await byCid.asElement();
    if (el) {
      console.log(`🎯 Comentario encontrado por CID (${cid})`);
      return el;
    }
  }

  const structCandidates = await queryAllDeepHandles(
    page,
    `
    return (node, norm, args) => {
      const de = node.getAttribute && node.getAttribute('data-e2e');
      const dc = node.getAttribute && node.getAttribute('data-cid');
      if (de && de.startsWith('comment-item')) return true;
      if (dc) return true;
      return false;
    }
    `
  );

  const props = await structCandidates.getProperties();
  for (const v of props.values()) {
    const el = v.asElement();
    if (!el) continue;
    const txt = await el.evaluate((n) => n.textContent || "");
    if (normalize(txt).includes(targetNorm)) {
      console.log("🎯 Comentario encontrado por estructura DOM (deep).");
      return el;
    }
  }

  const fuzzy = await queryAllDeepHandles(
    page,
    `
    return (node, norm, args) => {
      const txt = norm(node.textContent || '');
      if (!txt) return false;
      return txt.includes(args.targetNorm);
    }
    `,
    { targetNorm }
  );

  const propsFuzzy = await fuzzy.getProperties();
  for (const v of propsFuzzy.values()) {
    const el = v.asElement();
    if (el) {
      console.log("🎯 Comentario encontrado por texto (fuzzy deep).");
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
  if (!video_url || !reply_text || !row_number)
    return res.status(400).json({ ok: false, error: "missing_required_fields" });

  console.log("🆕 Nuevo request:", { video_url, comment_text, reply_text, cid });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("⏱️ Timeout global de ejecución alcanzado.")), EXECUTION_TIMEOUT_MS)
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
        await page.waitForLoadState("networkidle").catch(() => {});
        await closeOverlays(page);
        await hydrateComments(page, 25);

        const targetComment = await findCommentHandle(page, { cid, comment_text });
        if (!targetComment) throw new Error("Comentario no encontrado.");
        await targetComment.scrollIntoViewIfNeeded().catch(() => {});

        console.log("💬 Comentario visible, intentando responder...");
        const replyBtn = await queryDeepHandle(
          page,
          `return (n, norm, a) => {
            const de = n.getAttribute && n.getAttribute('data-e2e');
            const txt = norm(n.textContent || '');
            if (de && de.startsWith('comment-reply')) return true;
            if (txt.includes('responder') || txt.includes('reply')) return true;
            return false;
          }`
        );
        const replyEl = replyBtn ? await replyBtn.asElement() : null;
        if (!replyEl) throw new Error("No se encontró botón 'Responder'.");
        await replyEl.click({ delay: 150 });
        await page.waitForTimeout(1000);

        const inputHandle = await queryDeepHandle(
          page,
          `return (n, norm, a) => {
            const de = n.getAttribute && n.getAttribute('data-e2e');
            if (de === 'comment-input') {
              const e = n.querySelector('[contenteditable=\"true\"]');
              return e || false;
            }
            if (n.getAttribute('contenteditable') === 'true') return true;
            return false;
          }`
        );
        const inputEl = inputHandle ? await inputHandle.asElement() : null;
        if (!inputEl) throw new Error("No se encontró campo editable.");

        await inputEl.click();
        await inputEl.fill(reply_text);
        console.log("📝 Texto ingresado.");
        await page.waitForTimeout(500);

        await page.keyboard.press("Enter");
        console.log("⌨️ Enter presionado para enviar.");
        await page.waitForTimeout(2000);

        const publishBtn = await queryDeepHandle(
          page,
          `return (n, norm, a) => {
            if (n.tagName !== 'BUTTON') return false;
            const de = n.getAttribute && n.getAttribute('data-e2e');
            const txt = norm(n.textContent || '');
            if (de === 'comment-post') return true;
            if (txt.includes('publicar') || txt.includes('post')) return true;
            return false;
          }`
        );
        const pubEl = publishBtn ? await publishBtn.asElement() : null;
        if (pubEl) {
          await pubEl.click({ delay: 150 }).catch(() => {});
          console.log("🚀 Click en 'Publicar' (fallback).");
        }

        await browser.close();
        res.json({ ok: true, message: "✅ Respuesta publicada con éxito.", row_number });
      })(),
      timeoutPromise,
    ]);
  } catch (err) {
    console.error("❌ Error en Playwright:", err.message);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Boot ----------
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => console.log(`🚀 Servidor activo en http://${HOST}:${PORT}`));
