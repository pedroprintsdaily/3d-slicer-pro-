"""Seamline backend: keeps your Tripo + Meshy API keys off the phone and relays the AI calls.

No third-party packages needed (Python 3.9+ standard library only).

Environment variables
  TRIPO_API_KEY   your Tripo key (developers.tripo3d.ai)
  MESHY_API_KEY   your Meshy key (meshy.ai -> API)
  APP_TOKEN       any password you choose; the app sends it with every request
  PARTCRAFTER_URL     optional: address of your PartCrafter GPU worker (partcrafter_worker.py)
  PARTCRAFTER_TOKEN   optional: the WORKER_TOKEN you set on that worker
  PORT            set automatically by Railway
"""
import base64, json, os, re, secrets, tempfile, threading, time, urllib.error, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TRIPO_BASE = os.environ.get("TRIPO_BASE", "https://openapi.tripo3d.com/v3")
MESHY_BASE = os.environ.get("MESHY_BASE", "https://api.meshy.ai/openapi/v1")
TRIPO_KEY = os.environ.get("TRIPO_API_KEY", "")
MESHY_KEY = os.environ.get("MESHY_API_KEY", "")
APP_TOKEN = os.environ.get("APP_TOKEN", "")
# result files may only be fetched from these hosts (stops the relay being used as an open proxy)
FETCH_HOSTS = tuple(h.strip() for h in os.environ.get("FETCH_HOSTS", "tripo3d.ai,tripo3d.com,meshy.ai").split(","))
TRIPO_SEG_MODEL = os.environ.get("TRIPO_SEG_MODEL", "v2.0-20260430")
TRIPO_IMG_MODEL = os.environ.get("TRIPO_IMG_MODEL", "v3.1-20260211")
PARTCRAFTER_URL = os.environ.get("PARTCRAFTER_URL", "").rstrip("/")
PARTCRAFTER_TOKEN = os.environ.get("PARTCRAFTER_TOKEN", "")
JOB_DIR = tempfile.mkdtemp(prefix="seamline-jobs-")
JOBS = {}
JOBS_LOCK = threading.Lock()
MAX_UPLOAD = 150 * 1024 * 1024
HERE = os.path.dirname(os.path.abspath(__file__))


class UpstreamError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def call(method, url, key, body=None, headers=None, raw=False, timeout=120):
    h = {"Authorization": f"Bearer {key}"}
    h.update(headers or {})
    data = body
    if isinstance(body, (dict, list)):
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = r.read()
            return payload if raw else json.loads(payload or b"{}")
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")[:600]
        try:
            j = json.loads(text)
            text = j.get("message") or (j.get("data") or {}).get("message") or text
        except Exception:
            pass
        raise UpstreamError(e.code, text)
    except urllib.error.URLError as e:
        raise UpstreamError(502, f"Could not reach the AI service: {e.reason}")


def multipart(field, filename, content):
    boundary = "----seamline" + secrets.token_hex(8)
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\n"
            "Content-Type: application/octet-stream\r\n\r\n").encode()
    return head + content + f"\r\n--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"


def tripo_data(resp):
    if resp.get("code", 0) != 0:
        raise UpstreamError(400, resp.get("message") or json.dumps(resp)[:300])
    return resp.get("data") or {}


# ---------------------------------------------------------------- image -> 3D jobs (run in the background, the app polls)
def new_job():
    jid = secrets.token_hex(8)
    with JOBS_LOCK:
        now = time.time()
        for k in [k for k, j in JOBS.items() if now - j["t"] > 4 * 3600]:
            JOBS.pop(k, None)
            try: os.remove(os.path.join(JOB_DIR, k + ".glb"))
            except OSError: pass
        JOBS[jid] = {"t": now, "status": "running", "stage": "Starting", "progress": 0, "kind": None, "error": None, "parts": None}
    return jid


def job_set(jid, **kw):
    with JOBS_LOCK:
        JOBS[jid].update(kw)


def download(url, timeout=600):
    with urllib.request.urlopen(urllib.request.Request(url), timeout=timeout) as r:
        return r.read(MAX_UPLOAD + 1)


def glb_node_count(data):
    try:
        n = int.from_bytes(data[12:16], "little")
        j = json.loads(data[20:20 + n])
        return len(j.get("meshes", []))
    except Exception:
        return None


def tripo_upload(name, data):
    body, ctype = multipart("file", name, data)
    token = tripo_data(call("POST", f"{TRIPO_BASE}/files", TRIPO_KEY, body, {"Content-Type": ctype}, timeout=300)).get("file_token")
    if not token:
        raise UpstreamError(502, "Tripo did not return a file token")
    return token


def tripo_wait(jid, task_id, label):
    for _ in range(400):
        d = tripo_data(call("GET", f"{TRIPO_BASE}/tasks/{task_id}", TRIPO_KEY))
        st = str(d.get("status", "")).lower()
        if st == "success":
            out = d.get("output") or {}
            return out.get("model_url") or out.get("pbr_model") or out.get("base_model")
        if st in ("failed", "cancelled", "canceled", "banned", "expired", "unknown"):
            raise UpstreamError(502, f"{label} failed ({st}) {d.get('error_msg') or ''}".strip())
        job_set(jid, stage=label, progress=int(d.get("progress") or 0))
        time.sleep(4)
    raise UpstreamError(504, f"{label} timed out")


def meshy_wait(jid, path, task_id, label):
    for _ in range(400):
        d = call("GET", f"{MESHY_BASE}/{path}/{task_id}", MESHY_KEY)
        st = d.get("status", "")
        if st == "SUCCEEDED":
            return d
        if st in ("FAILED", "CANCELED", "EXPIRED"):
            err = d.get("task_error")
            raise UpstreamError(502, f"{label} failed: {(err or {}).get('message', st) if isinstance(err, dict) else st}")
        job_set(jid, stage=label, progress=int(d.get("progress") or 0))
        time.sleep(4)
    raise UpstreamError(504, f"{label} timed out")


def run_image_job(jid, engine, name, data, opts):
    try:
        if engine == "tripo":
            job_set(jid, stage="Uploading the picture to Tripo")
            token = tripo_upload(name, data)
            parts = opts.get("parts", "1") == "1"
            req = {"model": TRIPO_IMG_MODEL, "input": token, "texture": False, "pbr": False}
            if parts:
                req["generate_parts"] = True
            if opts.get("quality") == "detailed":
                req["geometry_quality"] = "detailed"
            task = tripo_data(call("POST", f"{TRIPO_BASE}/generation/image-to-model", TRIPO_KEY, req))
            url = tripo_wait(jid, task.get("task_id"), "Tripo is building the 3D model" + (" in parts" if parts else ""))
            kind = "parts"
        elif engine == "meshy":
            mime = {"png": "image/png", "webp": "image/webp"}.get(name.rsplit(".", 1)[-1].lower(), "image/jpeg")
            job_set(jid, stage="Sending the picture to Meshy")
            r = call("POST", f"{MESHY_BASE}/image-to-3d", MESHY_KEY,
                     {"image_url": f"data:{mime};base64," + base64.b64encode(data).decode(), "ai_model": "latest", "should_texture": False})
            d = meshy_wait(jid, "image-to-3d", r.get("result"), "Meshy is building the 3D model")
            if opts.get("split", "1") == "1":
                job_set(jid, stage="Meshy is splitting it for printing", progress=0)
                sp = call("POST", f"{MESHY_BASE}/print/split", MESHY_KEY,
                          {"input_task_id": d.get("id") or r.get("result"), "mode": "auto", "target_formats": ["glb"], "layout": "assembled"})
                d = meshy_wait(jid, "print/split", sp.get("result"), "Meshy is splitting it for printing")
                kind = "split"
            else:
                kind = "parts"
            url = (d.get("model_urls") or {}).get("glb")
        elif engine == "partcrafter":
            if not PARTCRAFTER_URL:
                raise UpstreamError(400, "PARTCRAFTER_URL is not set on the server")
            job_set(jid, stage="PartCrafter is building the parts (1 to 3 minutes)", progress=10)
            q = urllib.parse.urlencode({"num_parts": opts.get("num_parts", "6"), "seed": opts.get("seed", "0"), "steps": opts.get("steps", "50"), "rmbg": "1"})
            glb = call("POST", f"{PARTCRAFTER_URL}/generate?{q}", PARTCRAFTER_TOKEN, data,
                       {"Content-Type": "application/octet-stream", "X-Worker-Token": PARTCRAFTER_TOKEN}, raw=True, timeout=1200)
            url, kind = None, "parts"
        else:
            raise UpstreamError(400, "Unknown engine")
        if url:
            job_set(jid, stage="Downloading the model", progress=100)
            glb = download(url)
        if not glb or glb[:4] != b"glTF":
            raise UpstreamError(502, "The AI service did not return a GLB model")
        with open(os.path.join(JOB_DIR, jid + ".glb"), "wb") as f:
            f.write(glb)
        job_set(jid, status="done", stage="Done", progress=100, kind=kind, parts=glb_node_count(glb))
    except UpstreamError as e:
        job_set(jid, status="failed", error=e.message)
    except Exception as e:
        job_set(jid, status="failed", error=f"{type(e).__name__}: {e}")


class Handler(BaseHTTPRequestHandler):
    server_version = "Seamline/1.0"

    # ---------------------------------------------------------------- plumbing
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-App-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def send_json(self, status, obj):
        b = json.dumps(obj).encode()
        self.send_response(status); self.cors()
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def body(self, limit=MAX_UPLOAD):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise UpstreamError(413, "File too large (150 MB max)")
        return self.rfile.read(n) if n else b""

    def authed(self):
        if not APP_TOKEN:
            return True
        if secrets.compare_digest(self.headers.get("X-App-Token", ""), APP_TOKEN):
            return True
        self.send_json(401, {"error": "Wrong or missing app token. Set it in the app's AI settings."})
        return False

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def route(self, method):
        url = urllib.parse.urlparse(self.path)
        path, q = url.path, urllib.parse.parse_qs(url.query)
        try:
            if method == "GET" and path in ("/", "/index.html"):
                return self.static("index.html", "text/html; charset=utf-8")
            if path == "/api/health":
                return self.send_json(200, {"ok": True, "tripo": bool(TRIPO_KEY), "meshy": bool(MESHY_KEY), "partcrafter": bool(PARTCRAFTER_URL), "token_required": bool(APP_TOKEN)})
            if not path.startswith("/api/"):
                return self.send_json(404, {"error": "not found"})
            if not self.authed():
                return
            if method == "POST" and path == "/api/tripo/segment":
                return self.tripo_segment(q)
            m = re.fullmatch(r"/api/tripo/task/([\w-]+)", path)
            if method == "GET" and m:
                return self.tripo_task(m.group(1))
            if method == "POST" and path == "/api/meshy/split":
                return self.meshy_split()
            m = re.fullmatch(r"/api/meshy/split/([\w-]+)", path)
            if method == "GET" and m:
                return self.meshy_task(m.group(1))
            if method == "POST" and path == "/api/image3d":
                return self.image3d(q)
            m = re.fullmatch(r"/api/jobs/([0-9a-f]{16})", path)
            if method == "GET" and m:
                return self.job_status(m.group(1))
            m = re.fullmatch(r"/api/jobs/([0-9a-f]{16})/model\.glb", path)
            if method == "GET" and m:
                return self.job_file(m.group(1))
            if method == "GET" and path == "/api/fetch":
                return self.fetch((q.get("url") or [""])[0])
            self.send_json(404, {"error": "not found"})
        except UpstreamError as e:
            self.send_json(e.status if 400 <= e.status < 600 else 502, {"error": e.message})
        except Exception as e:  # keep the server alive, report plainly
            self.send_json(500, {"error": f"{type(e).__name__}: {e}"})

    def static(self, name, ctype):
        p = os.path.join(HERE, name)
        if not os.path.exists(p):
            return self.send_json(404, {"error": "index.html not deployed next to server.py"})
        b = open(p, "rb").read()
        self.send_response(200); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    # ---------------------------------------------------------------- Tripo: semantic segmentation of an uploaded model
    def tripo_segment(self, q):
        if not TRIPO_KEY:
            raise UpstreamError(400, "TRIPO_API_KEY is not set on the server")
        filename = re.sub(r"[^\w.\-]", "_", (q.get("filename") or ["model.stl"])[0])
        ext = filename.rsplit(".", 1)[-1].lower()
        if ext not in ("stl", "obj", "glb", "gltf", "fbx"):
            raise UpstreamError(400, "Tripo accepts STL, OBJ, GLB, GLTF or FBX")
        data = self.body()
        if not data:
            raise UpstreamError(400, "No file received")
        body, ctype = multipart("file", filename, data)
        token = tripo_data(call("POST", f"{TRIPO_BASE}/files", TRIPO_KEY, body, {"Content-Type": ctype}, timeout=300)).get("file_token")
        if not token:
            raise UpstreamError(502, "Tripo did not return a file token")
        req = {"model": TRIPO_SEG_MODEL, "input": token}
        gran = (q.get("granularity") or [""])[0]
        if TRIPO_SEG_MODEL.startswith("v2") and gran in ("simple", "balanced", "detailed"):
            req["segmentation_granularity"] = gran
            req["split_by_connectivity"] = True
        task = tripo_data(call("POST", f"{TRIPO_BASE}/mesh/segment", TRIPO_KEY, req))
        self.send_json(200, {"task_id": task.get("task_id")})

    def tripo_task(self, task_id):
        d = tripo_data(call("GET", f"{TRIPO_BASE}/tasks/{task_id}", TRIPO_KEY))
        st = str(d.get("status", "")).lower()
        out = d.get("output") or {}
        status = "done" if st == "success" else "failed" if st in ("failed", "cancelled", "canceled", "banned", "expired", "unknown") else "running"
        self.send_json(200, {"status": status, "raw_status": st, "progress": d.get("progress", 0),
                             "model_url": out.get("model_url") or out.get("pbr_model") or out.get("base_model"),
                             "preview": out.get("rendered_image_url"), "error": d.get("error_msg") or d.get("message")})

    # ---------------------------------------------------------------- Meshy: print split of a Meshy-generated model
    def meshy_split(self):
        if not MESHY_KEY:
            raise UpstreamError(400, "MESHY_API_KEY is not set on the server")
        j = json.loads(self.body(1_000_000) or b"{}")
        if not j.get("input_task_id"):
            raise UpstreamError(400, "Paste the Meshy task ID of the model (from a Meshy text/image-to-3D task)")
        req = {"input_task_id": j["input_task_id"], "mode": j.get("mode", "auto"), "target_formats": ["glb"], "layout": "assembled"}
        if req["mode"] in ("by_parts", "by_color"):
            req["prompt"] = (j.get("prompt") or "")[:600]
        if j.get("connectors"):
            req.update({"connectors": True, "connector_type": j.get("connector_type", "cylinder"),
                        "connector_size": float(j.get("connector_size", 0.4)), "connector_height": float(j.get("connector_height", 0.1))})
        if j.get("keep_texture"):
            req["keep_texture"] = True
        r = call("POST", f"{MESHY_BASE}/print/split", MESHY_KEY, req)
        self.send_json(200, {"task_id": r.get("result")})

    def meshy_task(self, task_id):
        d = call("GET", f"{MESHY_BASE}/print/split/{task_id}", MESHY_KEY)
        st = d.get("status", "")
        status = {"SUCCEEDED": "done", "FAILED": "failed", "CANCELED": "failed"}.get(st, "running")
        err = (d.get("task_error") or {}).get("message") if isinstance(d.get("task_error"), dict) else None
        self.send_json(200, {"status": status, "raw_status": st, "progress": d.get("progress", 0),
                             "model_url": (d.get("model_urls") or {}).get("glb"), "preview": d.get("thumbnail_url"),
                             "parts": d.get("part_count"), "error": err})

    # ---------------------------------------------------------------- image -> 3D
    def image3d(self, q):
        engine = (q.get("engine") or [""])[0]
        need = {"tripo": TRIPO_KEY, "meshy": MESHY_KEY, "partcrafter": PARTCRAFTER_URL}
        if engine not in need:
            raise UpstreamError(400, "Pick PartCrafter, Tripo or Meshy")
        if not need[engine]:
            raise UpstreamError(400, {"tripo": "TRIPO_API_KEY", "meshy": "MESHY_API_KEY", "partcrafter": "PARTCRAFTER_URL"}[engine] + " is not set on the server")
        name = re.sub(r"[^\w.\-]", "_", (q.get("filename") or ["picture.png"])[0])
        if name.rsplit(".", 1)[-1].lower() not in ("png", "jpg", "jpeg", "webp"):
            raise UpstreamError(400, "Use a PNG, JPG or WebP picture")
        data = self.body(20 * 1024 * 1024)
        if not data:
            raise UpstreamError(400, "No picture received")
        opts = {k: v[0] for k, v in q.items() if k in ("parts", "quality", "split", "num_parts", "seed", "steps")}
        jid = new_job()
        threading.Thread(target=run_image_job, args=(jid, engine, name, data, opts), daemon=True).start()
        self.send_json(200, {"job": jid})

    def job_status(self, jid):
        with JOBS_LOCK:
            j = dict(JOBS.get(jid) or {})
        if not j:
            raise UpstreamError(404, "That job is gone (the server restarted or it expired). Start it again.")
        j.pop("t", None)
        self.send_json(200, j)

    def job_file(self, jid):
        p = os.path.join(JOB_DIR, jid + ".glb")
        if not os.path.exists(p):
            raise UpstreamError(404, "Result not ready")
        data = open(p, "rb").read()
        self.send_response(200); self.cors()
        self.send_header("Content-Type", "model/gltf-binary"); self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)

    # ---------------------------------------------------------------- download a result file (browsers can't, CORS)
    def fetch(self, target):
        u = urllib.parse.urlparse(target)
        host = (u.hostname or "").lower()
        if u.scheme != "https" or not any(host == h or host.endswith("." + h) for h in FETCH_HOSTS):
            raise UpstreamError(400, "Only Tripo / Meshy result files can be fetched")
        try:
            with urllib.request.urlopen(urllib.request.Request(target), timeout=300) as r:
                data = r.read(MAX_UPLOAD + 1)
        except urllib.error.HTTPError as e:
            raise UpstreamError(e.code, "Result file download failed (it may have expired)")
        self.send_response(200); self.cors()
        self.send_header("Content-Type", "application/octet-stream"); self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    print(f"Seamline backend on :{port}  tripo={'yes' if TRIPO_KEY else 'no'} meshy={'yes' if MESHY_KEY else 'no'} partcrafter={'yes' if PARTCRAFTER_URL else 'no'} token={'yes' if APP_TOKEN else 'NO (set APP_TOKEN!)'}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
