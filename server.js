import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ===== Config =====
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "local");
const DEFAULT_STORAGE_STATE_PATH =
  process.env.STORAGE_STATE_PATH || path.join(STORAGE_DIR, "storageState.json");

const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || "45000", 10);
const WAIT_TIMEOUT = parseInt(process.env.WAIT_TIMEOUT || "15000", 10);
const ACTION_TIMEOUT = parseInt(process.env.ACTION_TIMEOUT || "15000", 10);

const DEFAULT_SCROLLS = parseInt(process.env.SCROLLS || "12", 10);
const DEFAULT_MAX_COMMENTS = parseInt(process.env.MAX_COMMENTS || "80", 10);

function nowIso() {
  return new Date().toISOString();
}

function storagePathForAccount(account) {
  if (!account) return DEFAULT_STORAGE_STATE_PATH;
  const specific = path.join(STORAGE_DIR, "accounts", `${account}.json`);
  return existsSync(specific) ? specific : DEFAULT_STORAGE_STATE_PATH;
}

function cleanText(s) {
  if (!s) return "";
  return String(s)
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

async function launchBrowser(storageStatePath) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const context = await browser.newContext({
    storageState: storageStatePath,
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    locale: "es-ES",
  });

  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  return { browser, page };
}

async function openVideo(page, videoUrl) {
  await page.goto(videoUrl, { waitUntil: "domcontentloaded" });
  // un toque de aire para que cargue la UI
  await page.waitForTimeout(1500);
}

async function openCommentsIfPossible(page) {
  // Intento 1: data-e2e clásico
  const e2e = page.locator('[data-e2e="comment-icon"]').first();
  if (await e2e.count()) {
    try {
      await e2e.click({ timeout: 4000 });
      await page.waitForTimeout(1000);
      return { ok: true, method: 'data-e2e="comment-icon"' };
    } catch {}
  }

  // Intento 2: aria-label (ES/EN)
  const ariaCandidates = [
    'button[aria-label*="coment"]',
    'button[aria-label*="Comment"]',
    'button[aria-label*="comment"]',
    'div[role="button"][aria-label*="coment"]',
    'div[role="button"][aria-label*="comment"]',
  ];
  for (const sel of ariaCandidates) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      try {
        await loc.click({ timeout: 4000 });
        await page.waitForTimeout(1000);
        return { ok: true, method: sel };
      } catch {}
    }
  }

  // Intento 3: texto visible cercano
  const textCandidates = ["Comentarios", "Comment", "Comments"];
  for (const t of textCandidates) {
    const loc = page.getByText(t, { exact: false }).first();
    if (await loc.count()) {
      try {
        await loc.click({ timeout: 4000 });
        await page.waitForTimeout(1000);
        return { ok: true, method: `text:${t}` };
      } catch {}
    }
  }

  return { ok: false, method: null };
}

async function scrollCommentsArea(page, scrolls) {
  // Varias heurísticas para “zona comentarios”
  const containers = [
    '[data-e2e="comment-list"]',
    '[data-e2e="comment-container"]',
    'div:has([data-e2e="comment-item"])',
    'div[role="dialog"]',
    "#app",
  ];

  for (let i = 0; i < scrolls; i++) {
    let did = false;

    for (const sel of containers) {
      const c = page.locator(sel).first();
      if (await c.count()) {
        try {
          await c.evaluate((el) => {
            el.scrollBy(0, 1200);
          });
          did = true;
          break;
        } catch {}
      }
    }

    if (!did) {
      // fallback: scroll global
      try {
        await page.mouse.wheel(0, 1400);
      } catch {}
    }

    await page.waitForTimeout(700);
  }
}

async function extractCleanComments(page, maxComments) {
  const data = await page.evaluate(() => {
    // TikTok cambia el DOM todo el tiempo. Esto es “multi-red” de selectores.
    const itemSelectors = [
      '[data-e2e="comment-item"]',
      '[data-e2e="commentItem"]',
      'div[class*="DivCommentItemContainer"]',
      'div:has(span[data-e2e="comment-level-1"])',
      'div:has(p)',
    ];

    function pickItems() {
      for (const sel of itemSelectors) {
        const nodes = Array.from(document.querySelectorAll(sel));
        // Si son muchos “basura”, filtramos por contenido textual mínimo
        const good = nodes.filter((n) => (n?.innerText || "").trim().length > 10);
        if (good.length >= 3) return good;
      }
      return [];
    }

    const items = pickItems();

    function clean(s) {
      return String(s || "")
        .replace(/\s+/g, " ")
        .replace(/\u00a0/g, " ")
        .trim();
    }

    const results = [];
    for (const el of items) {
      const raw = clean(el.innerText || "");
      if (!raw) continue;

      // Intento de separar “usuario” y “comentario” sin romper:
      // Muchas veces el innerText viene tipo:
      // "usuario\nhace 3d\ncomentario...\nResponder\n..."
      const lines = raw
        .split("\n")
        .map((x) => clean(x))
        .filter(Boolean);

      // comentario: elegimos la línea más larga que no sea UI típica
      const uiNoise = new Set([
        "Responder",
        "Me gusta",
        "Compartir",
        "Ver traducción",
        "Traducción",
        "Enviar",
        "Reportar",
        "Copiar enlace",
        "Editar",
        "Eliminar",
      ]);

      let bestComment = "";
      for (const ln of lines) {
        if (uiNoise.has(ln)) continue;
        if (ln.length > bestComment.length) bestComment = ln;
      }

      // usuario: primera línea si parece username
      let username = "";
      if (lines.length) {
        const first = lines[0];
        if (first && first.length <= 40) username = first;
      }

      // timestamp heurístico (si aparece algo tipo "hace", "d", "h", "min")
      let time = "";
      const timeLine = lines.find((l) =>
        /hace\s+\d+|^\d+\s*(s|min|h|d|w)$|^\d+\s*(seg|min|hora|día|sem)/i.test(l)
      );
      if (timeLine) time = timeLine;

      results.push({
        username,
        text: bestComment,
        raw,
        time,
      });
    }

    return {
      countFound: items.length,
      results,
    };
  });

  // Limpieza final + dedupe
  const out = [];
  const seen = new Set();

  for (const r of data.results) {
    const text = cleanText(r.text);
    if (!text || text.length < 3) continue;

    const key = (cleanText(r.username).toLowerCase() + "|" + text.toLowerCase()).slice(0, 500);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      username: cleanText(r.username),
      text,
      time: cleanText(r.time),
      raw: undefined, // no mandamos raw por defecto
    });

    if (out.length >= maxComments) break;
  }

  return { countFound: data.countFound, comments: out };
}

// ===== Routes =====
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    message: "Servidor de diagnóstico TikTok activo",
    time: nowIso(),
  });
});

/**
 * POST /debug-dom
 * body: { video_url, account?, search_text? }
 * Devuelve snippet del body y un snapshot de selectores “clave”.
 */
app.post("/debug-dom", async (req, res) => {
  const video_url = req.body?.video_url;
  const account = req.body?.account || "default";
  const search_text = req.body?.search_text || null;

  if (!video_url) {
    return res.status(400).json({ ok: false, error: "Falta el campo video_url" });
  }

  const storagePath = storagePathForAccount(account);
  if (!existsSync(storagePath)) {
    return res.status(400).json({
      ok: false,
      error: "storageState no encontrado",
      storagePath,
    });
  }

  let browser;
  const debug = {
    video_url_requested: video_url,
    video_url_final: null,
    search_text,
    storagePath,
    steps: {
      open_video: { ok: false, error: null },
      click_comment_button: { ok: false, tried: false, method: null, error: null },
      scroll_comments: { ok: false, scrolls: 0, error: null },
      capture_dom: { ok: false, error: null },
    },
    time: nowIso(),
  };

  try {
    const launched = await launchBrowser(storagePath);
    browser = launched.browser;
    const page = launched.page;

    // 1) abrir video
    try {
      await openVideo(page, video_url);
      debug.video_url_final = page.url();
      debug.steps.open_video.ok = true;
    } catch (e) {
      debug.steps.open_video.error = e?.message || "open_video_failed";
      throw new Error("open_video_failed");
    }

    // 2) click comments (best effort)
    debug.steps.click_comment_button.tried = true;
    const clickRes = await openCommentsIfPossible(page);
    debug.steps.click_comment_button.ok = clickRes.ok;
    debug.steps.click_comment_button.method = clickRes.method;

    // 3) scroll
    try {
      await scrollCommentsArea(page, DEFAULT_SCROLLS);
      debug.steps.scroll_comments.ok = true;
      debug.steps.scroll_comments.scrolls = DEFAULT_SCROLLS;
    } catch (e) {
      debug.steps.scroll_comments.error = e?.message || "scroll_failed";
    }

    // 4) capture DOM + selector snapshots
    const MAX_HTML = 2000;

    const selectorSnapshots = await page.evaluate((searchText) => {
      const candidates = [
        '[data-e2e="comment-icon"]',
        '[data-e2e="comment-item"]',
        '[data-e2e="comment-list"]',
        'button[aria-label*="comment"]',
        'button[aria-label*="coment"]',
        'div[role="button"][aria-label*="comment"]',
        'div[role="button"][aria-label*="coment"]',
        searchText ? searchText : null,
      ].filter(Boolean);

      const snaps = {};
      for (const sel of candidates) {
        try {
          const nodes = Array.from(document.querySelectorAll(sel));
          snaps[sel] = {
            count: nodes.length,
            firstText: nodes[0] ? (nodes[0].innerText || nodes[0].textContent || "").slice(0, 200) : "",
          };
        } catch (e) {
          snaps[sel] = { error: String(e?.message || e) };
        }
      }
      return snaps;
    }, search_text);

    const bodyHtml = await page.content();
    debug.steps.capture_dom.ok = true;

    await browser.close().catch(() => {});
    browser = null;

    return res.json({
      ok: true,
      debug,
      dom: {
        bodySnippet: bodyHtml.slice(0, MAX_HTML),
        selectors: selectorSnapshots,
      },
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({
      ok: false,
      error: err?.message || "unknown_error",
      debug,
    });
  }
});

/**
 * POST /extract-comments
 * body: { video_url, account?, max_comments?, scrolls? }
 * Devuelve comentarios “limpios” (username, text, time).
 */
app.post("/extract-comments", async (req, res) => {
  const video_url = req.body?.video_url;
  const account = req.body?.account || "default";
  const max_comments = parseInt(req.body?.max_comments || DEFAULT_MAX_COMMENTS, 10);
  const scrolls = parseInt(req.body?.scrolls || DEFAULT_SCROLLS, 10);

  if (!video_url) {
    return res.status(400).json({ ok: false, error: "Falta el campo video_url" });
  }

  const storagePath = storagePathForAccount(account);
  if (!existsSync(storagePath)) {
    return res.status(400).json({
      ok: false,
      error: "storageState no encontrado",
      storagePath,
    });
  }

  let browser;
  const debug = {
    video_url_requested: video_url,
    video_url_final: null,
    storagePath,
    max_comments,
    scrolls,
    steps: {
      open_video: { ok: false, error: null },
      click_comment_button: { ok: false, tried: false, method: null, error: null },
      scroll_comments: { ok: false, scrolls: 0, error: null },
      extract_comments: { ok: false, found: 0, returned: 0, error: null },
    },
    time: nowIso(),
  };

  try {
    const launched = await launchBrowser(storagePath);
    browser = launched.browser;
    const page = launched.page;

    try {
      await openVideo(page, video_url);
      debug.video_url_final = page.url();
      debug.steps.open_video.ok = true;
    } catch (e) {
      debug.steps.open_video.error = e?.message || "open_video_failed";
      throw new Error("open_video_failed");
    }

    debug.steps.click_comment_button.tried = true;
    const clickRes = await openCommentsIfPossible(page);
    debug.steps.click_comment_button.ok = clickRes.ok;
    debug.steps.click_comment_button.method = clickRes.method;

    try {
      await scrollCommentsArea(page, scrolls);
      debug.steps.scroll_comments.ok = true;
      debug.steps.scroll_comments.scrolls = scrolls;
    } catch (e) {
      debug.steps.scroll_comments.error = e?.message || "scroll_failed";
    }

    const extracted = await extractCleanComments(page, max_comments);
    debug.steps.extract_comments.ok = true;
    debug.steps.extract_comments.found = extracted.countFound;
    debug.steps.extract_comments.returned = extracted.comments.length;

    await browser.close().catch(() => {});
    browser = null;

    return res.json({
      ok: true,
      debug,
      comments: extracted.comments,
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    debug.steps.extract_comments.error = err?.message || "unknown_error";
    return res.status(500).json({
      ok: false,
      error: err?.message || "unknown_error",
      debug,
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Servidor diagnóstico en http://${HOST}:${PORT}`);
});
