// Supabase Edge Function: přijme zmenšené fotky z florbaljivova.cz/nahrat/
// a uloží je jako commit do GitHub repozitáře webu.
//
// Secrets (supabase secrets set …):
//   GITHUB_TOKEN   fine-grained token, jen repo florbaljivova, Contents: read & write
//   UPLOAD_CODE    kód, který zadávají lidé při nahrávání
//   NTFY_TOPIC     tajný název ntfy kanálu pro upozornění (nepovinné)
//   GITHUB_BRANCH  větev (výchozí "main"; pro test např. "upload-test")
//   EXTRA_ORIGIN   další povolený původ pro testování (nepovinné)
//
// Deploy: supabase functions deploy florbal-upload --no-verify-jwt --project-ref <ref>

const REPO = Deno.env.get("GITHUB_REPO") ?? "sestak8/florbaljivova";
const BRANCH = Deno.env.get("GITHUB_BRANCH") ?? "main";
const TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
const CODE = Deno.env.get("UPLOAD_CODE") ?? "";
const NTFY_TOPIC = Deno.env.get("NTFY_TOPIC") ?? "";
const SITE = "https://www.florbaljivova.cz";

const ORIGINS = new Set(
  ["https://www.florbaljivova.cz", "https://florbaljivova.cz", Deno.env.get("EXTRA_ORIGIN") ?? ""].filter(Boolean),
);

const MAX_PER_REQUEST = 6;
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

// ---------- GitHub ----------

async function gh(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "florbal-upload",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  return res;
}

async function ghJson(path: string, init: RequestInit = {}) {
  const res = await gh(path, init);
  if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64decodeUtf8(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function readFile(path: string, ref: string): Promise<string | null> {
  const res = await gh(`/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read ${path}: ${res.status}`);
  const data = await res.json();
  return b64decodeUtf8(data.content);
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
  return { bytes, ...size };
}

function cleanName(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

type Photo = { file: string; w: number; h: number; alt?: string; by?: string };
type Year = { year: number; title?: string; photos: Photo[] };

// ---------- Upozornění ----------

async function notify(title: string, message: string, attach?: string, commitUrl?: string) {
  if (!NTFY_TOPIC) return;
  try {
    await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
      }),
    });
  } catch (_) { /* upozornění nesmí shodit nahrávání */ }
}

// ---------- Hlavní obsluha ----------

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "method" }, 405, origin);
  if (!origin || !ORIGINS.has(origin)) return json({ error: "origin" }, 403, origin);

  try {
    if (!TOKEN || !CODE) throw new Error("Function is missing GITHUB_TOKEN or UPLOAD_CODE");

    const form = await req.formData();
    if (!(await sameSecret(String(form.get("code") ?? ""), CODE))) throw new HttpError(401, "bad_code");

    const settingsText = await readFile("upload-settings.json", BRANCH);
    const settings = settingsText ? JSON.parse(settingsText) : { enabled: false };
    if (!settings.enabled) throw new HttpError(403, "closed");

    const year = Number(form.get("year"));
    if (!Number.isInteger(year) || year < settings.fromYear || year > settings.toYear) throw new HttpError(400, "bad_year");

    const count = Number(form.get("count"));
    if (!Number.isInteger(count) || count < 1 || count > MAX_PER_REQUEST) throw new HttpError(400, "too_many");

    const by = cleanName(String(form.get("name") ?? ""));
    const batch = Number(form.get("batch") ?? 0);
    const total = Number(form.get("total") ?? count);

    const photos: { big: { bytes: Uint8Array; w: number; h: number }; thumb: { bytes: Uint8Array; w: number; h: number } }[] = [];
    for (let i = 0; i < count; i++) {
      photos.push({
        big: await readJpeg(form.get(`photo${i}`), MAX_BIG_BYTES, 1600),
        thumb: await readJpeg(form.get(`thumb${i}`), MAX_THUMB_BYTES, 600),
      });
    }

    const repo = await ghJson("");
    if (repo.size > MAX_REPO_KB) throw new HttpError(507, "year_full");

    // Bloby nezávisí na názvech souborů, nahrajeme je jednou
    const blobs = await Promise.all(photos.map(async (p) => {
      const [big, thumb] = await Promise.all([p.big, p.thumb].map((x) =>
        ghJson("/git/blobs", { method: "POST", body: JSON.stringify({ content: b64encode(x.bytes), encoding: "base64" }) })
      ));
      return { big: big.sha as string, thumb: thumb.sha as string };
    }));

    // Commit; při souběžném nahrávání to zkusíme znovu nad novějším stavem
    for (let attempt = 0; attempt < 4; attempt++) {
      const ref = await ghJson(`/git/ref/heads/${BRANCH}`);
      const parentSha: string = ref.object.sha;
      const parent = await ghJson(`/git/commits/${parentSha}`);

      const manifestText = await readFile("img/galerie.json", parentSha);
      const manifest: { years: Year[] } = manifestText ? JSON.parse(manifestText) : { years: [] };
      let entry = manifest.years.find((y) => y.year === year);
      if (!entry) {
        entry = { year, title: "", photos: [] };
        manifest.years.push(entry);
        manifest.years.sort((a, b) => b.year - a.year);
      }
      if (entry.photos.length + photos.length > (settings.maxPhotosPerYear ?? 400)) throw new HttpError(409, "year_full");

      let next = entry.photos.reduce((m, p) => Math.max(m, parseInt(p.file, 10) || 0), 0) + 1;
      const tree: unknown[] = [];
      const added: string[] = [];
      photos.forEach((p, i) => {
        const file = `${String(next++).padStart(2, "0")}.jpg`;
        added.push(file);
        tree.push({ path: `img/${year}/${file}`, mode: "100644", type: "blob", sha: blobs[i].big });
        tree.push({ path: `img/${year}/nahledy/${file}`, mode: "100644", type: "blob", sha: blobs[i].thumb });
        entry!.photos.push({
          file, w: p.thumb.w, h: p.thumb.h,
          alt: `Fotka z turnaje ${year}` + (by ? ` (foto: ${by})` : ""),
          ...(by ? { by } : {}),
        });
      });
      tree.push({ path: "img/galerie.json", mode: "100644", type: "blob", content: JSON.stringify(manifest, null, 2) + "\n" });

      const newTree = await ghJson("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: parent.tree.sha, tree }) });
      const commit = await ghJson("/git/commits", {
        method: "POST",
        body: JSON.stringify({
          message: `Fotky ${year}: +${photos.length}${by ? ` (${by})` : ""}`,
          tree: newTree.sha,
          parents: [parentSha],
        }),
      });
      const upd = await gh(`/git/refs/heads/${BRANCH}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
      if (upd.ok) {
        if (batch === 0) {
          await notify(
            `📸 Nové fotky – ${year}`,
            `${by || "Někdo"} nahrává ${total} ${total === 1 ? "fotku" : total < 5 ? "fotky" : "fotek"} do ročníku ${year}.`,
            `https://raw.githubusercontent.com/${REPO}/${commit.sha}/img/${year}/nahledy/${added[0]}`,
            `https://github.com/${REPO}/commit/${commit.sha}`,
          );
        }
        return json({ ok: true, added: added.length, files: added }, 200, origin);
      }
      if (upd.status !== 422 && upd.status !== 409) throw new Error(`GitHub update ref: ${upd.status} ${await upd.text()}`);
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
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
