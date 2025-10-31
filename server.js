import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- Paths / Context ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE =
  process.env.STORAGE_STATE_PATH ||
  (existsSync(path.join(__dirname, "storageState.json"))
    ? path.join(__dirname, "storageState.json")
    : path.join(__dirname, "local", "storageState.json"));

// ---------- Helpers (Node) ----------
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

// ---------- Session check ----------
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

// ---------- Close overlays ----------
async function closeOverlays(page) {
  const selectors = [
    'div[role="dialog"] button:has-text("Cerrar")',
    'div[role="dialog"] button:has-text("Close")',
    'button:has-text("Aceptar todo")',
    'button:has-text("Accept all")',
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

// ---------- Deep DOM utilities (Shadow DOM aware) ----------
/**
 * Ejecuta en el contexto de la página y devuelve el PRIMER elemento que
 * cumpla el predicado, explorando DOM normal + Shadow DOM en profundidad.
 */
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
        // Light DOM
        const kids = root.children ? Array.from(root.children) : [];
        for (const k of kids) {
          yield k;
          yield* deepChildren(k);
        }
        // Shadow DOM
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

/**
 * Devuelve TODOS los elementos que cumplan el predicado (deep + shadow).
 */
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

// ---------- Open & scroll comments panel ----------
async function hydrateComments(page, iterations = 50) {
  console.log("💬 Abriendo panel lateral de comentarios...");

  // Intentar con selectores “normales”
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

  // Si el botón estuviera en Shadow DOM, intentar clic profundo
  if (!(await page.$('div.TUXTabBar-content, div[data-e2e*="comment"]'))) {
    const h = await queryDeepHandle(
      page,
      `
      return (node, norm, args) => {
        if (node.tagName === 'BUTTON') {
          const de = node.getAttribute('data-e2e') || '';
          const ar = (node.getAttribute('aria-label') || '').toLowerCase();
          if (de.includes('comment') || ar.includes('comentario') || ar.includes('comment')) return true;
        }
        return false;
      }
      `
    );
    const deepBtn = await h.asElement();
    if (deepBtn) {
      await deepBtn.click().catch(() => {});
      console.log("✅ Click deep en botón de comentarios (Shadow DOM).");
      await page.waitForTimeout(2500);
    }
  }

  // Buscar contenedor (deep)
  let containerEl =
    (await page.$("div.TUXTabBar-content")) || (await page.$("div[data-e2e*='comment']"));

  if (!containerEl) {
    const ch = await queryDeepHandle(
      page,
      `
      return (node, norm, args) => {
        const cn = (node.className || '').toString();
        const de = (node.getAttribute && node.getAttribute('data-e2e')) || '';
        if (cn.includes('TUXTabBar-content')) return true;
        if (de.includes('comment')) return true;
        return false;
      }
      `
    );
    containerEl = await ch.asElement();
  }

  if (!containerEl) {
    console.warn("⚠️ No se encontró contenedor de comentarios.");
    return;
  }

  console.log("🧭 Scrolleando dentro del panel lateral...");
  for (let i = 0; i < iterations; i++) {
    await containerEl.evaluate((el) => el.scrollBy(0, 1600));
    await page.waitForTimeout(900);

    // Expandir "ver más respuestas" (deep)
    const moreList = await queryAllDeepHandles(
      page,
      `
      return (node, norm, args) => {
        if (node.tagName !== 'BUTTON') return false;
        const txt = norm(node.textContent || '');
        return txt.includes(norm('ver mas respuestas')) || txt.includes('more replies');
      }
      `
    );
    const els = await moreList.getProperties();
    for (const el of els.values()) {
      const e = el.asElement();
      if (e) {
        await e.click().catch(() => {});
        await page.waitForTimeout(300);
      }
    }
  }
  console.log("✅ Scroll completado.");
}

// ---------- Find comment (CID + DOM + Fuzzy) with Deep search ----------
async function findCommentHandle(page, { cid, comment_text }) {
  const targetNorm = normalize(comment_text);

  // 1) Por CID exacto (deep)
  if (cid) {
    const byCidDeep = await queryDeepHandle(
      page,
      `
      return (node, norm, args) => {
        if (!(node.getAttribute instanceof Function)) return false;
        const de = node.getAttribute('data-e2e') || '';
        const dc = node.getAttribute('data-cid') || '';
        if (de === 'comment-item-' + args.cid) return true;
        if (dc === args.cid) return true;
        // También permitir contenedor que contenga un hijo con data-cid
        const has = node.querySelector && node.querySelector('[data-cid="'+args.cid+'"]');
        return !!has;
      }
      `,
      { cid }
    );
    const elCid = await byCidDeep.asElement();
    if (elCid) {
      console.log(`🎯 Comentario encontrado por CID (${cid})`);
      return elCid;
    }
  }

  // 2) Estructural: cualquier comment-item / data-cid cuyo texto contenga el target (deep)
  const structDeep = await queryAllDeepHandles(
    page,
    `
    return (node, norm, args) => {
      if (!(node.getAttribute instanceof Function)) return false;
      const de = node.getAttribute('data-e2e') || '';
      const dc = node.getAttribute('data-cid') || '';
      if (de && de.startsWith('comment-item')) return true;
      if (dc) return true;
      return false;
    }
    `
  );

  {
    const props = await structDeep.getProperties();
    for (const v of props.values()) {
      const el = v.asElement();
      if (!el) continue;
      const txt = await el.evaluate((n) => n.textContent || "");
      if (normalize(txt).includes(targetNorm)) {
        console.log("🎯 Comentario encontrado por patrón estructural DOM (deep).");
        return el;
      }
    }
  }

  // 3) Fuzzy global (deep): buscar cualquier nodo cuyo texto contenga el target
  const fuzzyDeep = await queryAllDeepHandles(
    page,
    `
    return (node, norm, args) => {
      const txt = norm((node.textContent || '').toString());
      if (!txt) return false;
      return txt.includes(args.targetNorm);
    }
    `,
    { targetNorm: targetNorm }
  );
  {
    const props = await fuzzyDeep.getProperties();
    for (const v of props.values()) {
      const el = v.asElement();
      if (el) {
        console.log("🎯 Comentario encontrado por texto (fuzzy deep).");
        return el;
      }
    }
  }

  console.warn("⚠️ No se encontró el comentario por ninguna estrategia.");
  return null;
}

// ---------- Endpoints ----------
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Webhook activo" });
});

app.get("/check-login", async (_req, res) => {
  try {
    const { browser, page } = await newBrowserContext();
    const status = await ensureLoggedIn(page);
    await browser.close();
    if (status.ok) return res.json({ ok: true, message: "Sesión TikTok activa ✅" });
    return res.json({ ok: false, message: "No se detectó sesión activa ❌", reason: status.reason || "unknown" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/run", async (req, res) => {
  const { video_url, comment_text, reply_text, account, row_number, cid } = req.body || {};
  if (!video_url || !reply_text || !row_number) {
    return res.status(400).json({
      ok: false,
      error: "missing_required_fields",
      details: { video_url, reply_text, row_number },
    });
  }

  console.log("🆕 Nuevo request:", { video_url, comment_text, reply_text, account, row_number, cid });
  console.log("🗂️ Usando storageState:", STORAGE_STATE);

  let browser;
  try {
    const ctx = await newBrowserContext();
    browser = ctx.browser;
    const page = ctx.page;

    // 1) Sesión
    const status = await ensureLoggedIn(page);
    if (!status.ok) {
      await browser.close();
      return res.status(401).json({
        ok: false,
        error: "session_expired",
        message: "La sesión de TikTok no está activa. Sube un storageState.json reciente.",
        row_number,
      });
    }

    // 2) Ir al video
    await page.goto(video_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    await closeOverlays(page);

    // 3) Abrir panel y scrollear
    await hydrateComments(page, 55);

    // 4) Buscar comentario
    const targetComment = await findCommentHandle(page, { cid, comment_text });
    if (!targetComment) throw new Error("Comentario no encontrado.");

    await targetComment.scrollIntoViewIfNeeded().catch(() => {});
    console.log("💬 Comentario visible, intentando responder...");

    // 5) Click en "Responder" (deep)
    const replyBtnHandle = await queryDeepHandle(
      page,
      `
      return (node, norm, args) => {
        if (!(node.getAttribute instanceof Function)) return false;
        const de = node.getAttribute('data-e2e') || '';
        const txt = norm(node.textContent || '');
        if (de && de.startsWith('comment-reply')) return true;
        if (txt.includes('responder') || txt.includes('reply')) return true;
        return false;
      }
      `
    );
    const replyButton = replyBtnHandle ? await replyBtnHandle.asElement() : null;
    if (!replyButton) throw new Error("No se encontró botón 'Responder'.");
    await replyButton.click({ delay: 150 });
    await page.waitForTimeout(1200);

    // 6) Campo input (deep) y escribir
    const inputHandle = await queryDeepHandle(
      page,
      `
      return (node, norm, args) => {
        if (!(node.getAttribute instanceof Function)) return false;
        const de = node.getAttribute('data-e2e') || '';
        if (de === 'comment-input') {
          const editable = node.querySelector('[contenteditable="true"]');
          return editable || false;
        }
        // También permitir directamente el editable
        if (node.getAttribute('contenteditable') === 'true') return true;
        return false;
      }
      `
    );
    const inputEl = inputHandle ? await inputHandle.asElement() : null;
    if (!inputEl) throw new Error("No se encontró el campo editable para responder.");

    // Si el handle corresponde al contenedor, obtener el editable interno
    let editable = inputEl;
    const isContainer = await inputEl.evaluate((n) => (n.getAttribute("data-e2e") || "") === "comment-input");
    if (isContainer) {
      const inner = await inputEl.evaluateHandle((n) => n.querySelector('[contenteditable="true"]'));
      editable = await inner.asElement();
    }

    await editable.click();
    await editable.fill(reply_text);
    console.log("📝 Texto de respuesta ingresado.");
    await page.waitForTimeout(600);

    // 7) Enviar con Enter y fallback "Publicar"
    await page.keyboard.press("Enter");
    console.log("⌨️ Enter presionado para enviar.");
    await page.waitForTimeout(2500);

    const publishHandle = await queryDeepHandle(
      page,
      `
      return (node, norm, args) => {
        if (node.tagName !== 'BUTTON') return false;
        const de = (node.getAttribute && node.getAttribute('data-e2e')) || '';
        const txt = norm(node.textContent || '');
        if (de === 'comment-post') return true;
        if (txt.includes('publicar') || txt.includes('post')) return true;
        return false;
      }
      `
    );
    const publishBtn = publishHandle ? await publishHandle.asElement() : null;
    if (publishBtn) {
      await publishBtn.click({ delay: 180 }).catch(() => {});
      console.log("🚀 Click en 'Publicar' (fallback).");
      await page.waitForTimeout(2500);
    }

    // 8) Done
    await browser.close();
    return res.status(200).json({
      ok: true,
      message: "✅ Respuesta publicada con éxito.",
      reply_text,
      reply_url: video_url,
      row_number,
    });
  } catch (err) {
    console.error("❌ Error en Playwright:", err);
    try {
      if (browser) await browser.close();
    } catch {}
    return res.status(500).json({
      ok: false,
      error: err.message || "unknown_error",
      step: "playwright_flow",
      row_number,
    });
  }
});

// ---------- Boot ----------
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => console.log(`🚀 Servidor activo en http://${HOST}:${PORT}`));
