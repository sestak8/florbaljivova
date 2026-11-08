// Supabase Edge Function: přijme zmenšené fotky z florbaljivova.cz/nahrat/
// a uloží je jako commit do GitHub repozitáře webu.
//
// Secrets (supabase secrets set …):
//   GITHUB_TOKEN   fine-grained token, jen repo florbaljivova, Contents: read & write
//   UPLOAD_CODE    kód, který zadávají lidé při nahrávání
//   ADMIN_CODE     heslo pro správu galerie na florbaljivova.cz/sprava/ (bez něj je správa vypnutá)
//   NTFY_TOPIC     tajný název ntfy kanálu pro upozornění (nepovinné)
//   NTFY_TOKEN     přístupový token z účtu na ntfy.sh (nepovinné, ale bez něj hrozí denní limit)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  upozornění přes Telegram (nepovinné; když jsou, ntfy se nepoužije)
//   GITHUB_BRANCH  větev (výchozí "main"; pro test např. "upload-test")
//   EXTRA_ORIGIN   další povolený původ pro testování (nepovinné)
//
// Deploy: supabase functions deploy florbal-upload --no-verify-jwt --project-ref <ref>
//
// Na jedno nahrání stačí 2 volání GitHubu: jeden GraphQL dotaz (stav větve, seznam
// fotek, nastavení, velikost repa) a jeden commit přes createCommitOnBranch.

const REPO = Deno.env.get("GITHUB_REPO") ?? "sestak8/florbaljivova";
const [OWNER, NAME] = REPO.split("/");
const BRANCH = Deno.env.get("GITHUB_BRANCH") ?? "main";
const TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
const CODE = Deno.env.get("UPLOAD_CODE") ?? "";
const ADMIN_CODE = Deno.env.get("ADMIN_CODE") ?? "";
const NTFY_TOPIC = Deno.env.get("NTFY_TOPIC") ?? "";
// Přístupový token z účtu na ntfy.sh: limity se pak počítají na účet, ne na sdílenou IP Supabase
const NTFY_TOKEN = Deno.env.get("NTFY_TOKEN") ?? "";
// Telegram bot (spolehlivější než ntfy): token od @BotFather a ID chatu
const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TG_CHAT = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const SITE = "https://www.florbaljivova.cz";

const ORIGINS = new Set(
  ["https://www.florbaljivova.cz", "https://florbaljivova.cz", Deno.env.get("EXTRA_ORIGIN") ?? ""].filter(Boolean),
);

const MAX_PER_REQUEST = 8;
const MAX_BIG_BYTES = 1_500_000;
const MAX_THUMB_BYTES = 300_000;
const MAX_REPO_KB = 900_000; // GitHub Pages: web do 1 GB

class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

function cors(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { "Vary": "Origin" };
  if (origin && ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "content-type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

// ---------- GitHub (GraphQL) ----------

async function graphql(query: string, variables: Record<string, unknown>) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "florbal-upload",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body as { data?: any; errors?: { type?: string; message: string }[] };
}

const STATE_QUERY = `
query($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    diskUsage
    ref(qualifiedName: $ref) {
      target {
        oid
        ... on Commit {
          manifest: file(path: "img/galerie.json") { object { ... on Blob { text } } }
          settings: file(path: "upload-settings.json") { object { ... on Blob { text } } }
        }
      }
    }
  }
}`;

const COMMIT_MUTATION = `
mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

async function readState() {
  const r = await graphql(STATE_QUERY, { owner: OWNER, name: NAME, ref: `refs/heads/${BRANCH}` });
  if (r.errors?.length) throw new Error(`GitHub state: ${r.errors[0].message}`);
  const repo = r.data?.repository;
  const target = repo?.ref?.target;
  if (!target) throw new Error("GitHub state: branch not found");
  return {
    head: target.oid as string,
    diskKb: repo.diskUsage as number,
    manifestText: target.manifest?.object?.text as string | undefined,
    settingsText: target.settings?.object?.text as string | undefined,
  };
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64utf8(text: string): string {
  return b64encode(new TextEncoder().encode(text));
}

// ---------- Kontroly ----------

async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0 && b.length > 0;
}

// Rozměry JPEGu z hlavičky SOF
function jpegSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    }
    i += 2 + len;
  }
  return null;
}

async function readJpeg(v: FormDataEntryValue | null, maxBytes: number, maxSide: number) {
  if (!(v instanceof File)) throw new HttpError(400, "bad_image");
  if (v.size > maxBytes) throw new HttpError(413, "bad_image");
  const bytes = new Uint8Array(await v.arrayBuffer());
  const size = jpegSize(bytes);
  if (!size || Math.max(size.w, size.h) > maxSide || Math.min(size.w, size.h) < 50) throw new HttpError(400, "bad_image");
  return { bytes, b64: b64encode(bytes), ...size };
}

function cleanName(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

type Photo = { file: string; w: number; h: number; alt?: string; by?: string };
type Year = { year: number; title?: string; photos: Photo[] };

// ---------- Upozornění ----------

async function notify(title: string, message: string, attach?: string, commitUrl?: string) {
  if (TG_TOKEN && TG_CHAT) return notifyTelegram(title, message, attach, commitUrl);
  return notifyNtfy(title, message, attach, commitUrl);
}

async function notifyTelegram(title: string, message: string, photo?: string, commitUrl?: string) {
  const api = `https://api.telegram.org/bot${TG_TOKEN}`;
  const text = `${title}\n${message}`;
  const reply_markup = {
    inline_keyboard: [
      [{ text: "Galerie", url: `${SITE}/galerie.html` }],
      ...(commitUrl ? [[{ text: "Commit", url: commitUrl }]] : []),
      [{ text: "Vypnout nahrávání", url: `https://github.com/${REPO}/edit/${BRANCH}/upload-settings.json` }],
    ],
  };
  const attempts: [string, Record<string, unknown>][] = [
    ...(photo ? [["sendPhoto", { chat_id: TG_CHAT, photo, caption: text, reply_markup }] as [string, Record<string, unknown>]] : []),
    ["sendMessage", { chat_id: TG_CHAT, text, reply_markup }],
  ];
  for (const [method, body] of attempts) {
    try {
      const r = await fetch(`${api}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) { console.log(`telegram: odesláno (${method})`); return; }
      console.error(`telegram: chyba ${r.status} (${method}): ${(await r.text()).slice(0, 300)}`);
    } catch (e) {
      console.error(`telegram: síťová chyba: ${(e as Error)?.message ?? e}`);
    }
  }
}

async function notifyNtfy(title: string, message: string, attach?: string, commitUrl?: string) {
  if (!NTFY_TOPIC) { console.log("ntfy: NTFY_TOPIC není nastavený, upozornění se neposílá"); return; }
  const full = {
    topic: NTFY_TOPIC,
    title,
    message,
    tags: ["camera_flash"],
    click: `${SITE}/galerie.html`,
    ...(attach ? { attach } : {}),
    actions: [
      { action: "view", label: "Galerie", url: `${SITE}/galerie.html` },
      ...(commitUrl ? [{ action: "view", label: "Commit", url: commitUrl }] : []),
      { action: "view", label: "Vypnout nahrávání", url: `https://github.com/${REPO}/edit/${BRANCH}/upload-settings.json` },
    ],
  };
  // Když ntfy odmítne plnou zprávu, zkusí se jednoduchá bez obrázku a tlačítek
  const simple = { topic: NTFY_TOPIC, title, message, click: `${SITE}/galerie.html` };
  for (const body of [full, simple]) {
    try {
      const r = await fetch("https://ntfy.sh/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(NTFY_TOKEN ? { Authorization: `Bearer ${NTFY_TOKEN}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const text = (await r.text()).slice(0, 300);
      if (r.ok) { console.log(`ntfy: odesláno (${r.status})`); return; }
      console.error(`ntfy: chyba ${r.status} (token ${NTFY_TOKEN ? "ano" : "ne"}): ${text}`);
    } catch (e) {
      console.error(`ntfy: síťová chyba: ${(e as Error)?.message ?? e}`);
    }
  }
}

// ---------- Správa galerie (/sprava/) ----------
//
// JSON požadavky s heslem ADMIN_CODE:
//   { action: "list" }                              → aktuální galerie a nastavení přímo z GitHubu
//   { action: "save", year, title, known, photos }  → uloží pořadí, popisky a smazání v jednom ročníku
//        known  = soubory, které správce viděl (smaže se jen to, co v known je a v photos není;
//                 fotky nahrané mezitím zůstanou a přidají se na konec)
//        photos = [{ file, alt }] v novém pořadí
//   { action: "settings", enabled }                 → zapne/vypne nahrávání

function cleanText(s: unknown, max: number): string {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function commitFiles(head: string, headline: string, additions: { path: string; contents: string }[], deletions: { path: string }[] = []) {
  const r = await graphql(COMMIT_MUTATION, {
    input: {
      branch: { repositoryNameWithOwner: REPO, branchName: BRANCH },
      message: { headline },
      expectedHeadOid: head,
      fileChanges: { additions, ...(deletions.length ? { deletions } : {}) },
    },
  });
  const oid: string | undefined = r.data?.createCommitOnBranch?.commit?.oid;
  const msg = r.errors?.map((e) => e.message).join("; ") ?? "";
  return { oid, stale: !oid && /expected|stale|head/i.test(msg), msg };
}

async function handleAdmin(body: any, origin: string | null): Promise<Response> {
  if (!ADMIN_CODE) throw new HttpError(403, "admin_off");
  if (!(await sameSecret(String(body?.code ?? ""), ADMIN_CODE))) {
    await new Promise((res) => setTimeout(res, 800)); // zpomalit hádání hesla
    throw new HttpError(401, "bad_code");
  }
  const action = String(body.action ?? "");

  if (action === "list") {
    const st = await readState();
    return json({
      ok: true,
      head: st.head,
      repo: REPO,
      years: (st.manifestText ? JSON.parse(st.manifestText) : { years: [] }).years,
      settings: st.settingsText ? JSON.parse(st.settingsText) : { enabled: false },
    }, 200, origin);
  }

  if (action === "settings") {
    for (let attempt = 0; attempt < 4; attempt++) {
      const st = await readState();
      const settings = st.settingsText ? JSON.parse(st.settingsText) : {};
      settings.enabled = !!body.enabled;
      const r = await commitFiles(st.head, `Nahrávání fotek: ${settings.enabled ? "zapnuto" : "vypnuto"}`,
        [{ path: "upload-settings.json", contents: b64utf8(JSON.stringify(settings, null, 2) + "\n") }]);
      if (r.oid) return json({ ok: true, settings }, 200, origin);
      if (!r.stale) throw new Error(`GitHub commit: ${r.msg}`);
    }
    throw new HttpError(503, "busy");
  }

  if (action === "save") {
    const year = Number(body.year);
    if (!Number.isInteger(year)) throw new HttpError(400, "bad_year");
    const known = new Set<string>((Array.isArray(body.known) ? body.known : []).map(String));
    const wanted: { file: string; alt: string }[] = (Array.isArray(body.photos) ? body.photos : [])
      .map((p: any) => ({ file: String(p?.file ?? ""), alt: cleanText(p?.alt, 200) }));

    for (let attempt = 0; attempt < 4; attempt++) {
      const st = await readState();
      const manifest: { years: Year[] } = st.manifestText ? JSON.parse(st.manifestText) : { years: [] };
      const entry = manifest.years.find((y) => y.year === year);
      if (!entry) throw new HttpError(404, "bad_year");

      const current = new Map(entry.photos.map((p) => [p.file, p]));
      const seen = new Set<string>();
      const photos: Photo[] = [];
      for (const w of wanted) {
        const p = current.get(w.file);
        if (!p || seen.has(w.file)) continue; // neznámé nebo zdvojené soubory se ignorují
        seen.add(w.file);
        photos.push({ ...p, alt: w.alt || undefined }); // prázdný popisek → výchozí text v galerii
      }
      // Fotky nahrané mezitím (správce je neviděl) zůstanou na konci
      for (const p of entry.photos) if (!known.has(p.file) && !seen.has(p.file)) { seen.add(p.file); photos.push(p); }
      const removed = entry.photos.filter((p) => !seen.has(p.file)).map((p) => p.file);

      entry.photos = photos;
      if (body.title !== undefined) entry.title = cleanText(body.title, 80);

      const additions = [{ path: "img/galerie.json", contents: b64utf8(JSON.stringify(manifest, null, 2) + "\n") }];
      const deletions = removed.flatMap((f) => [{ path: `img/${year}/${f}` }, { path: `img/${year}/nahledy/${f}` }]);
      const headline = `Galerie ${year}: úpravy` + (removed.length ? ` (smazáno ${removed.length})` : "");

      let r = await commitFiles(st.head, headline, additions, deletions);
      // Když některý soubor fyzicky neexistuje, aspoň skrýt fotky z galerie
      if (!r.oid && !r.stale && deletions.length) r = await commitFiles(st.head, headline, additions);
      if (r.oid) return json({ ok: true, removed: removed.length, photos: photos.length }, 200, origin);
      if (!r.stale) throw new Error(`GitHub commit: ${r.msg}`);
    }
    throw new HttpError(503, "busy");
  }

  throw new HttpError(400, "bad_action");
}

// ---------- Hlavní obsluha ----------

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "method" }, 405, origin);
  if (!origin || !ORIGINS.has(origin)) return json({ error: "origin" }, 403, origin);

  const t0 = Date.now();
  const timing: Record<string, number> = {};
  const mark = (k: string) => { timing[k] = Date.now() - t0; };

  try {
    if (!TOKEN || !CODE) throw new Error("Function is missing GITHUB_TOKEN or UPLOAD_CODE");

    // Správa galerie posílá JSON, nahrávání posílá formulář
    if ((req.headers.get("Content-Type") ?? "").startsWith("application/json")) {
      return await handleAdmin(await req.json().catch(() => ({})), origin);
    }

    const form = await req.formData();
    mark("form");
    if (!(await sameSecret(String(form.get("code") ?? ""), CODE))) throw new HttpError(401, "bad_code");

    const year = Number(form.get("year"));
    const count = Number(form.get("count"));
    if (!Number.isInteger(count) || count < 1 || count > MAX_PER_REQUEST) throw new HttpError(400, "too_many");
    const by = cleanName(String(form.get("name") ?? ""));
    const batch = Number(form.get("batch") ?? 0);
    const total = Number(form.get("total") ?? count);

    // Kontrola fotek a stav repa běží souběžně
    const [photos, firstState] = await Promise.all([
      Promise.all(Array.from({ length: count }, async (_, i) => ({
        big: await readJpeg(form.get(`photo${i}`), MAX_BIG_BYTES, 1600),
        thumb: await readJpeg(form.get(`thumb${i}`), MAX_THUMB_BYTES, 600),
      }))),
      readState(),
    ]);
    mark("state");

    let state = firstState;
    for (let attempt = 0; attempt < 4; attempt++) {
      const settings = state.settingsText ? JSON.parse(state.settingsText) : { enabled: false };
      if (!settings.enabled) throw new HttpError(403, "closed");
      if (!Number.isInteger(year) || year < settings.fromYear || year > settings.toYear) throw new HttpError(400, "bad_year");
      if (state.diskKb > MAX_REPO_KB) throw new HttpError(507, "year_full");

      const manifest: { years: Year[] } = state.manifestText ? JSON.parse(state.manifestText) : { years: [] };
      let entry = manifest.years.find((y) => y.year === year);
      if (!entry) {
        entry = { year, title: "", photos: [] };
        manifest.years.push(entry);
        manifest.years.sort((a, b) => b.year - a.year);
      }
      if (entry.photos.length + photos.length > (settings.maxPhotosPerYear ?? 400)) throw new HttpError(409, "year_full");

      let next = entry.photos.reduce((m, p) => Math.max(m, parseInt(p.file, 10) || 0), 0) + 1;
      const additions: { path: string; contents: string }[] = [];
      const added: string[] = [];
      for (const p of photos) {
        const file = `${String(next++).padStart(2, "0")}.jpg`;
        added.push(file);
        additions.push({ path: `img/${year}/${file}`, contents: p.big.b64 });
        additions.push({ path: `img/${year}/nahledy/${file}`, contents: p.thumb.b64 });
        entry.photos.push({
          file, w: p.thumb.w, h: p.thumb.h,
          alt: `Fotka z turnaje ${year}` + (by ? ` (foto: ${by})` : ""),
          ...(by ? { by } : {}),
        });
      }
      additions.push({ path: "img/galerie.json", contents: b64utf8(JSON.stringify(manifest, null, 2) + "\n") });

      const r = await graphql(COMMIT_MUTATION, {
        input: {
          branch: { repositoryNameWithOwner: REPO, branchName: BRANCH },
          message: { headline: `Fotky ${year}: +${photos.length}${by ? ` (${by})` : ""}` },
          expectedHeadOid: state.head,
          fileChanges: { additions },
        },
      });
      mark(`commit${attempt}`);
      const oid: string | undefined = r.data?.createCommitOnBranch?.commit?.oid;
      if (oid) {
        if (batch === 0) {
          const p = notify(
            `📸 Nové fotky – ${year}`,
            `${by || "Někdo"} nahrává ${total} ${total === 1 ? "fotku" : total < 5 ? "fotky" : "fotek"} do ročníku ${year}.`,
            `https://raw.githubusercontent.com/${REPO}/${oid}/img/${year}/nahledy/${added[0]}`,
            `https://github.com/${REPO}/commit/${oid}`,
          );
          // Počkat na odeslání (max. 5 s), ať ho běhové prostředí neukončí po odpovědi
          await Promise.race([p, new Promise((res) => setTimeout(res, 5000))]);
        }
        console.log(JSON.stringify({ upload: added.length, timing }));
        return json({ ok: true, added: added.length, files: added, timing }, 200, origin);
      }

      // Někdo jiný commitnul mezitím: načíst nový stav a zkusit znovu
      const msg = r.errors?.map((e) => e.message).join("; ") ?? "unknown";
      if (!/expected|stale|head/i.test(msg)) throw new Error(`GitHub commit: ${msg}`);
      await new Promise((res) => setTimeout(res, 200 + Math.random() * 500));
      state = await readState();
    }
    throw new HttpError(503, "busy");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code }, e.status, origin);
    console.error(e);
    // Podrobnosti chyby jen pro testovací původ (EXTRA_ORIGIN), nikdy pro veřejný web
    const testOrigin = Deno.env.get("EXTRA_ORIGIN");
    const detail = testOrigin && origin === testOrigin ? String((e as Error)?.message ?? e).slice(0, 400) : undefined;
    return json({ error: "server", ...(detail ? { detail } : {}) }, 500, origin);
  }
});
