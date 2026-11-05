// Seamline server as a single-file Railway Function (Bun). Built by build.py, which inlines the app.
// Variables: APP_TOKEN, TRIPO_API_KEY, MESHY_API_KEY, HF_TOKEN (PartPacker), PARTCRAFTER_URL + PARTCRAFTER_TOKEN (optional GPU worker)

import { AsyncLocalStorage } from "node:async_hooks";
const INDEX_GZ_B64 = "__INDEX_GZ_B64__";
const INDEX_HTML = new TextDecoder().decode(Bun.gunzipSync(Uint8Array.from(atob(INDEX_GZ_B64), c => c.charCodeAt(0))));

const env = (k: string, d = "") => (Bun.env[k] ?? d).trim();
const TRIPO_BASE = env("TRIPO_BASE", "https://openapi.tripo3d.com/v3");
const MESHY_BASE = env("MESHY_BASE", "https://api.meshy.ai/openapi/v1");
const TRIPO_KEY = env("TRIPO_API_KEY"), MESHY_KEY = env("MESHY_API_KEY"), APP_TOKEN = env("APP_TOKEN");
const TRIPO_SEG_MODEL = env("TRIPO_SEG_MODEL", "v2.0-20260430"), TRIPO_IMG_MODEL = env("TRIPO_IMG_MODEL", "v3.1-20260211");
const PARTCRAFTER_URL = env("PARTCRAFTER_URL").replace(/\/$/, ""), PARTCRAFTER_TOKEN = env("PARTCRAFTER_TOKEN");
const HF_TOKEN = env("HF_TOKEN");
const PARTPACKER_URL = env("PARTPACKER_URL", "https://cpuai-partpacker.hf.space").replace(/\/$/, "");
const FETCH_HOSTS = env("FETCH_HOSTS", "tripo3d.ai,tripo3d.com,meshy.ai,hf.space").split(",").map(s => s.trim());
const MAX_UPLOAD = 150 * 1024 * 1024;
type Keys = { tripo: string; meshy: string; hf: string };
const als = new AsyncLocalStorage<Keys>();
const K = (): Keys => als.getStore() || { tripo: TRIPO_KEY, meshy: MESHY_KEY, hf: HF_TOKEN };
const keysFrom = (req: Request): Keys => ({ tripo: TRIPO_KEY || (req.headers.get("X-Tripo-Key") || "").trim(), meshy: MESHY_KEY || (req.headers.get("X-Meshy-Key") || "").trim(), hf: HF_TOKEN || (req.headers.get("X-HF-Token") || "").trim() });

class UpErr extends Error { constructor(public status: number, msg: string) { super(msg); } }
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-App-Token, X-Tripo-Key, X-Meshy-Key, X-HF-Token", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });
const bin = (b: Uint8Array | ArrayBuffer, type = "application/octet-stream") => new Response(b, { headers: { "Content-Type": type, ...CORS } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function call(method: string, url: string, key: string, body?: unknown, headers: Record<string, string> = {}, raw = false, timeoutMs = 120000): Promise<any> {
  const h: Record<string, string> = { Authorization: `Bearer ${key}`, ...headers };
  let data: any = body;
  if (body && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer) && !(body instanceof FormData) && typeof body === "object") { data = JSON.stringify(body); h["Content-Type"] = "application/json"; }
  let r: Response;
  try { r = await fetch(url, { method, headers: h, body: data, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e: any) { throw new UpErr(502, `Could not reach the AI service: ${e?.message || e}`); }
  if (!r.ok) {
    let t = (await r.text()).slice(0, 600);
    try { const j = JSON.parse(t); t = j.message || j.data?.message || j.error || t; } catch {}
    throw new UpErr(r.status, String(t));
  }
  return raw ? new Uint8Array(await r.arrayBuffer()) : r.json().catch(() => ({}));
}
const tripoData = (resp: any) => { if ((resp.code ?? 0) !== 0) throw new UpErr(400, resp.message || JSON.stringify(resp).slice(0, 300)); return resp.data || {}; };
async function tripoUpload(name: string, data: Uint8Array) {
  const fd = new FormData(); fd.append("file", new Blob([data]), name);
  const t = tripoData(await call("POST", `${TRIPO_BASE}/files`, K().tripo, fd, {}, false, 300000)).file_token;
  if (!t) throw new UpErr(502, "Tripo did not return a file token");
  return t;
}

// ---------------------------------------------------------------- jobs
type Job = { t: number; status: string; stage: string; progress: number; kind: string | null; error: string | null; parts: number | null; glb?: Uint8Array };
const JOBS = new Map<string, Job>();
const newJob = () => {
  const now = Date.now();
  for (const [k, j] of JOBS) if (now - j.t > 4 * 3600e3) JOBS.delete(k);
  const id = crypto.getRandomValues(new Uint8Array(8)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  JOBS.set(id, { t: now, status: "running", stage: "Starting", progress: 0, kind: null, error: null, parts: null });
  return id;
};
const jobSet = (id: string, kw: Partial<Job>) => Object.assign(JOBS.get(id)!, kw);
const glbMeshes = (d: Uint8Array) => { try { const n = new DataView(d.buffer, d.byteOffset).getUint32(12, true); return JSON.parse(new TextDecoder().decode(d.subarray(20, 20 + n))).meshes?.length ?? null; } catch { return null; } };

async function tripoWait(id: string, task: string, label: string) {
  for (let i = 0; i < 400; i++) {
    const d = tripoData(await call("GET", `${TRIPO_BASE}/tasks/${task}`, K().tripo));
    const st = String(d.status || "").toLowerCase();
    if (st === "success") return d.output?.model_url || d.output?.pbr_model || d.output?.base_model;
    if (["failed", "cancelled", "canceled", "banned", "expired", "unknown"].includes(st)) throw new UpErr(502, `${label} failed (${st}) ${d.error_msg || ""}`.trim());
    jobSet(id, { stage: label, progress: Number(d.progress || 0) }); await sleep(4000);
  }
  throw new UpErr(504, `${label} timed out`);
}
async function meshyWait(id: string, path: string, task: string, label: string) {
  for (let i = 0; i < 400; i++) {
    const d = await call("GET", `${MESHY_BASE}/${path}/${task}`, K().meshy);
    if (d.status === "SUCCEEDED") return d;
    if (["FAILED", "CANCELED", "EXPIRED"].includes(d.status)) throw new UpErr(502, `${label} failed: ${d.task_error?.message || d.status}`);
    jobSet(id, { stage: label, progress: Number(d.progress || 0) }); await sleep(4000);
  }
  throw new UpErr(504, `${label} timed out`);
}

// PartPacker (NVIDIA, image -> 3D in parts) through its Hugging Face Space (free GPU time with an HF token)
async function gradio(base: string, name: string, data: unknown[], token: string) {
  // queue API: unlike /call, it reports the Space's actual error text (quota, size limits, crashes)
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const cfg = await fetch(`${base}/config`, { headers: auth }).then(r => r.json()) as any;
  const dep = cfg.dependencies.findIndex((d: any) => d.api_name === name);
  if (dep < 0) throw new UpErr(502, `PartPacker has no ${name} step (the demo changed)`);
  const session = Math.random().toString(36).slice(2, 12);
  const j = await fetch(`${base}/gradio_api/queue/join`, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ data, fn_index: dep, trigger_id: cfg.dependencies[dep].targets?.[0]?.[0] ?? null, session_hash: session, event_data: null }) });
  if (!j.ok) throw new UpErr(j.status, `PartPacker ${name}: ${(await j.text()).slice(0, 300)}`);
  const s = await fetch(`${base}/gradio_api/queue/data?session_hash=${session}`, { headers: auth, signal: AbortSignal.timeout(900000) });
  const txt = await s.text();
  let last: any = null;
  for (const line of txt.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try { const m = JSON.parse(line.slice(5)); if (m.msg === "process_completed") last = m; } catch {}
  }
  if (!last) throw new UpErr(502, `PartPacker ${name}: no result (${txt.slice(-200).replace(/\s+/g, " ")})`);
  if (!last.success) {
    const msg = last.output?.error || last.title || "the demo reported an error with no details";
    throw new UpErr(502, `PartPacker ${name}: ${msg}`);
  }
  return last.output.data;
}
async function runPartPacker(id: string, name: string, data: Uint8Array, opts: Record<string, string>) {
  jobSet(id, { stage: "Uploading the picture to PartPacker" });
  const fd = new FormData(); fd.append("files", new Blob([data]), name);
  const up = await fetch(`${PARTPACKER_URL}/gradio_api/upload`, { method: "POST", body: fd, headers: K().hf ? { Authorization: `Bearer ${K().hf}` } : {} });
  if (!up.ok) throw new UpErr(up.status, `PartPacker upload failed: ${(await up.text()).slice(0, 200)}`);
  const [path] = await up.json() as string[];
  const file = { path, meta: { _type: "gradio.FileData" } };
  jobSet(id, { stage: "PartPacker is cleaning up the picture", progress: 5 });
  const [img] = await gradio(PARTPACKER_URL, "process_image", [file], K().hf);
  jobSet(id, { stage: "PartPacker is building the parts (1 to 3 minutes)", progress: 15 });
  const seed = Number(opts.seed || 0);
  // the demo's own mesh-simplify step can crash; fall back to its unsimplified output
  let model: any;
  try { [model] = await gradio(PARTPACKER_URL, "process_3d", [img, 50, 7, 384, seed, false, 100000], K().hf); }
  catch (e: any) {
    if (!/AttributeError|TypeError/.test(e?.message || "")) throw e;
    jobSet(id, { stage: "PartPacker is retrying at a lower grid", progress: 20 });
    [model] = await gradio(PARTPACKER_URL, "process_3d", [img, 50, 7, 256, seed, false, 100000], K().hf);
  }
  const url = model.url || `${PARTPACKER_URL}/gradio_api/file=${model.path}`;
  return url as string;
}

async function runImageJob(id: string, engine: string, name: string, data: Uint8Array, opts: Record<string, string>) {
  try {
    let url: string | null = null, kind = "parts", glb: Uint8Array | null = null;
    if (engine === "tripo") {
      jobSet(id, { stage: "Uploading the picture to Tripo" });
      const token = await tripoUpload(name, data);
      const parts = (opts.parts ?? "1") === "1";
      const req: any = { model: TRIPO_IMG_MODEL, input: token, texture: false, pbr: false };
      if (parts) req.generate_parts = true;
      if (opts.quality === "detailed") req.geometry_quality = "detailed";
      const task = tripoData(await call("POST", `${TRIPO_BASE}/generation/image-to-model`, K().tripo, req));
      url = await tripoWait(id, task.task_id, "Tripo is building the 3D model" + (parts ? " in parts" : ""));
    } else if (engine === "meshy") {
      const ext = name.split(".").pop()!.toLowerCase(), mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      jobSet(id, { stage: "Sending the picture to Meshy" });
      const r = await call("POST", `${MESHY_BASE}/image-to-3d`, K().meshy, { image_url: `data:${mime};base64,${Buffer.from(data).toString("base64")}`, ai_model: "latest", should_texture: false });
      let d = await meshyWait(id, "image-to-3d", r.result, "Meshy is building the 3D model");
      if ((opts.split ?? "1") === "1") {
        jobSet(id, { stage: "Meshy is splitting it for printing", progress: 0 });
        const sp = await call("POST", `${MESHY_BASE}/print/split`, K().meshy, { input_task_id: d.id || r.result, mode: "auto", target_formats: ["glb"], layout: "assembled" });
        d = await meshyWait(id, "print/split", sp.result, "Meshy is splitting it for printing");
        kind = "split";
      }
      url = d.model_urls?.glb;
    } else if (engine === "partpacker") {
      url = await runPartPacker(id, name, data, opts);
    } else if (engine === "partcrafter") {
      if (!PARTCRAFTER_URL) throw new UpErr(400, "PARTCRAFTER_URL is not set on the server");
      jobSet(id, { stage: "PartCrafter is building the parts (1 to 3 minutes)", progress: 10 });
      const q = new URLSearchParams({ num_parts: opts.num_parts || "6", seed: opts.seed || "0", steps: opts.steps || "50", rmbg: "1" });
      glb = await call("POST", `${PARTCRAFTER_URL}/generate?${q}`, PARTCRAFTER_TOKEN, data, { "Content-Type": "application/octet-stream", "X-Worker-Token": PARTCRAFTER_TOKEN }, true, 1200000);
    } else throw new UpErr(400, "Unknown engine");
    if (url) {
      jobSet(id, { stage: "Downloading the model", progress: 100 });
      const r = await fetch(url, { headers: engine === "partpacker" && K().hf ? { Authorization: `Bearer ${K().hf}` } : {}, signal: AbortSignal.timeout(600000) });
      if (!r.ok) throw new UpErr(502, `Model download failed (${r.status})`);
      glb = new Uint8Array(await r.arrayBuffer());
    }
    if (!glb || new TextDecoder().decode(glb.subarray(0, 4)) !== "glTF") throw new UpErr(502, "The AI service did not return a GLB model");
    jobSet(id, { status: "done", stage: "Done", progress: 100, kind, parts: glbMeshes(glb), glb });
  } catch (e: any) {
    jobSet(id, { status: "failed", error: e instanceof UpErr ? e.message : `${e?.name}: ${e?.message}` });
  }
}

// ---------------------------------------------------------------- routes
async function route(req: Request): Promise<Response> {
  const u = new URL(req.url), path = u.pathname, q = u.searchParams, method = req.method;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (method === "GET" && (path === "/" || path === "/index.html")) return new Response(INDEX_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (path === "/api/health") return json({ ok: true, tripo: !!TRIPO_KEY, meshy: !!MESHY_KEY, partcrafter: !!PARTCRAFTER_URL, partpacker: !!HF_TOKEN, hf_token: !!HF_TOKEN, keys_from_app: true, token_required: !!APP_TOKEN });
  if (!path.startsWith("/api/")) return json({ error: "not found" }, 404);
  if (APP_TOKEN && req.headers.get("X-App-Token") !== APP_TOKEN) return json({ error: "Wrong or missing app token. Set it in the app (step 01)." }, 401);
  const body = async (limit = MAX_UPLOAD) => { const b = new Uint8Array(await req.arrayBuffer()); if (b.length > limit) throw new UpErr(413, "File too large"); return b; };
  let m: RegExpMatchArray | null;

  if (method === "POST" && path === "/api/image3d") {
    const engine = q.get("engine") || "";
    const need: Record<string, string | boolean> = { tripo: K().tripo, meshy: K().meshy, partcrafter: PARTCRAFTER_URL, partpacker: K().hf };
    if (!(engine in need)) throw new UpErr(400, "Pick PartPacker, PartCrafter, Tripo or Meshy");
    if (!need[engine]) throw new UpErr(400, ({ tripo: "Add your Tripo API key in step 01 (AI keys).", meshy: "Add your Meshy API key in step 01 (AI keys).", partpacker: "Add a free Hugging Face token in step 01 (AI keys). Hugging Face only gives GPU time to signed-in users.", partcrafter: "PARTCRAFTER_URL is not set on the server." } as any)[engine]);
    const name = (q.get("filename") || "picture.png").replace(/[^\w.\-]/g, "_");
    if (!/\.(png|jpe?g|webp)$/i.test(name)) throw new UpErr(400, "Use a PNG, JPG or WebP picture");
    const data = await body(20 * 1024 * 1024); if (!data.length) throw new UpErr(400, "No picture received");
    const opts: Record<string, string> = {}; for (const k of ["parts", "quality", "split", "num_parts", "seed", "steps"]) { const v = q.get(k); if (v !== null) opts[k] = v; }
    const id = newJob(); runImageJob(id, engine, name, data, opts);
    return json({ job: id });
  }
  if (method === "GET" && (m = path.match(/^\/api\/jobs\/([0-9a-f]{16})$/))) {
    const j = JOBS.get(m[1]); if (!j) throw new UpErr(404, "That job is gone (the server restarted or it expired). Start it again.");
    const { glb, t, ...rest } = j; return json(rest);
  }
  if (method === "GET" && (m = path.match(/^\/api\/jobs\/([0-9a-f]{16})\/model\.glb$/))) {
    const j = JOBS.get(m[1]); if (!j?.glb) throw new UpErr(404, "Result not ready"); return bin(j.glb, "model/gltf-binary");
  }
  if (method === "POST" && path === "/api/tripo/segment") {
    if (!K().tripo) throw new UpErr(400, "Add your Tripo API key in step 01 (AI keys).");
    const filename = (q.get("filename") || "model.stl").replace(/[^\w.\-]/g, "_");
    const token = await tripoUpload(filename, await body());
    const req2: any = { model: TRIPO_SEG_MODEL, input: token };
    const g = q.get("granularity"); if (TRIPO_SEG_MODEL.startsWith("v2") && g && ["simple", "balanced", "detailed"].includes(g)) { req2.segmentation_granularity = g; req2.split_by_connectivity = true; }
    const task = tripoData(await call("POST", `${TRIPO_BASE}/mesh/segment`, K().tripo, req2));
    return json({ task_id: task.task_id });
  }
  if (method === "GET" && (m = path.match(/^\/api\/tripo\/task\/([\w-]+)$/))) {
    const d = tripoData(await call("GET", `${TRIPO_BASE}/tasks/${m[1]}`, K().tripo)); const st = String(d.status || "").toLowerCase();
    const status = st === "success" ? "done" : ["failed", "cancelled", "canceled", "banned", "expired", "unknown"].includes(st) ? "failed" : "running";
    return json({ status, raw_status: st, progress: d.progress || 0, model_url: d.output?.model_url || d.output?.pbr_model || d.output?.base_model, error: d.error_msg });
  }
  if (method === "POST" && path === "/api/meshy/split") {
    if (!K().meshy) throw new UpErr(400, "Add your Meshy API key in step 01 (AI keys).");
    const j = JSON.parse(new TextDecoder().decode(await body(1e6)) || "{}");
    if (!j.input_task_id) throw new UpErr(400, "Paste the Meshy task ID of the model");
    const r: any = { input_task_id: j.input_task_id, mode: j.mode || "auto", target_formats: ["glb"], layout: "assembled" };
    if (["by_parts", "by_color"].includes(r.mode)) r.prompt = String(j.prompt || "").slice(0, 600);
    if (j.connectors) Object.assign(r, { connectors: true, connector_type: j.connector_type || "cylinder", connector_size: Number(j.connector_size ?? 0.4), connector_height: Number(j.connector_height ?? 0.1) });
    return json({ task_id: (await call("POST", `${MESHY_BASE}/print/split`, K().meshy, r)).result });
  }
  if (method === "GET" && (m = path.match(/^\/api\/meshy\/split\/([\w-]+)$/))) {
    const d = await call("GET", `${MESHY_BASE}/print/split/${m[1]}`, K().meshy);
    const status = d.status === "SUCCEEDED" ? "done" : ["FAILED", "CANCELED"].includes(d.status) ? "failed" : "running";
    return json({ status, raw_status: d.status, progress: d.progress || 0, model_url: d.model_urls?.glb, parts: d.part_count, error: d.task_error?.message });
  }
  if (method === "GET" && path === "/api/fetch") {
    const t = new URL(q.get("url") || "about:blank");
    if (t.protocol !== "https:" || !FETCH_HOSTS.some(h => t.hostname === h || t.hostname.endsWith("." + h))) throw new UpErr(400, "Only Tripo / Meshy result files can be fetched");
    const r = await fetch(t); if (!r.ok) throw new UpErr(r.status, "Result file download failed (it may have expired)");
    return bin(await r.arrayBuffer());
  }
  return json({ error: "not found" }, 404);
}

Bun.serve({
  port: Number(Bun.env.PORT || 8080),
  idleTimeout: 255,
  maxRequestBodySize: MAX_UPLOAD,
  async fetch(req) {
    try { return await als.run(keysFrom(req), () => route(req)); }
    catch (e: any) { const s = e instanceof UpErr ? e.status : 500; return json({ error: e instanceof UpErr ? e.message : `${e?.name}: ${e?.message}` }, s >= 400 && s < 600 ? s : 502); }
  },
});
console.log(`Seamline on :${Bun.env.PORT || 8080} tripo=${!!TRIPO_KEY} meshy=${!!MESHY_KEY} hf=${!!HF_TOKEN} partcrafter=${!!PARTCRAFTER_URL} token=${!!APP_TOKEN}`);
