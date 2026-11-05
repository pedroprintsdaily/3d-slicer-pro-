"""PartCrafter GPU worker for Seamline.

Runs PartCrafter (github.com/wgsxm/PartCrafter) on an NVIDIA GPU and returns one GLB whose
nodes are the generated parts (part_00, part_01, ...). Seamline's server calls it; the app then
merges the parts into one solid and turns the part boundaries into anatomical cut lines.

Setup (on the GPU machine, see README "PartCrafter"):
  git clone https://github.com/wgsxm/PartCrafter && cd PartCrafter
  bash settings/setup.sh            # the repo's own installer (PyTorch 2.5.1 + CUDA 12.4, Python 3.11)
  copy this file into the PartCrafter folder, then:
  WORKER_TOKEN=some-long-password python partcrafter_worker.py

Environment
  WORKER_TOKEN   required password; Seamline's server sends it (set PARTCRAFTER_TOKEN to the same value)
  PORT           default 7861
"""
import io, json, os, secrets, sys, threading, time, traceback, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch
import trimesh
from PIL import Image
from huggingface_hub import snapshot_download

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from src.pipelines.pipeline_partcrafter import PartCrafterPipeline  # noqa: E402
from src.utils.image_utils import prepare_image  # noqa: E402
from src.models.briarmbg import BriaRMBG  # noqa: E402

TOKEN = os.environ.get("WORKER_TOKEN", "")
PORT = int(os.environ.get("PORT", "7861"))
MAX_NUM_PARTS = 16
if not TOKEN:
    sys.exit("Set WORKER_TOKEN to a long password before starting the worker.")

device = "cuda"
dtype = torch.float16
weights = os.path.join("pretrained_weights", "PartCrafter")
rmbg_weights = os.path.join("pretrained_weights", "RMBG-1.4")
print("Downloading / loading weights (first start takes a few minutes)...", flush=True)
snapshot_download(repo_id="wgsxm/PartCrafter", local_dir=weights)
snapshot_download(repo_id="briaai/RMBG-1.4", local_dir=rmbg_weights)
rmbg_net = BriaRMBG.from_pretrained(rmbg_weights).to(device)
rmbg_net.eval()
pipe = PartCrafterPipeline.from_pretrained(weights).to(device, dtype)
GPU = threading.Lock()
print("PartCrafter ready.", flush=True)


@torch.no_grad()
def generate(image_bytes, num_parts, seed, steps, tokens, guidance, rmbg):
    tmp = f"/tmp/pc_{secrets.token_hex(6)}.png"
    Image.open(io.BytesIO(image_bytes)).convert("RGBA").save(tmp)
    try:
        if rmbg:
            img = prepare_image(tmp, bg_color=np.array([1.0, 1.0, 1.0]), rmbg_net=rmbg_net)
        else:
            img = Image.open(tmp).convert("RGB")
        t0 = time.time()
        meshes = pipe(
            image=[img] * num_parts,
            attention_kwargs={"num_parts": num_parts},
            num_tokens=tokens,
            generator=torch.Generator(device=pipe.device).manual_seed(seed),
            num_inference_steps=steps,
            guidance_scale=guidance,
            max_num_expanded_coords=int(1e9),
            use_flash_decoder=False,
        ).meshes
        print(f"generated {num_parts} parts in {time.time() - t0:.1f}s", flush=True)
    finally:
        try: os.remove(tmp)
        except OSError: pass
    scene = trimesh.Scene()
    kept = 0
    for i, m in enumerate(meshes):
        if m is None or len(m.faces) < 4:
            continue
        scene.add_geometry(m, node_name=f"part_{i:02d}", geom_name=f"part_{i:02d}")
        kept += 1
    if not kept:
        raise RuntimeError("PartCrafter produced no parts for this picture. Try another seed or fewer parts.")
    return scene.export(file_type="glb")


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self.reply(200, {"ok": True, "gpu": torch.cuda.get_device_name(0), "busy": GPU.locked()})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/generate":
            return self.reply(404, {"error": "not found"})
        if not secrets.compare_digest(self.headers.get("X-Worker-Token", ""), TOKEN):
            return self.reply(401, {"error": "wrong worker token"})
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        n = int(self.headers.get("Content-Length") or 0)
        if not n or n > 20 * 1024 * 1024:
            return self.reply(400, {"error": "send a picture under 20 MB"})
        data = self.rfile.read(n)
        try:
            num_parts = max(1, min(MAX_NUM_PARTS, int(q.get("num_parts", 6))))
            args = dict(num_parts=num_parts, seed=int(q.get("seed", 0)), steps=max(10, min(100, int(q.get("steps", 50)))),
                        tokens=int(q.get("tokens", 1024)), guidance=float(q.get("guidance", 7.0)), rmbg=q.get("rmbg", "1") == "1")
            with GPU:  # one job at a time on the GPU
                glb = generate(data, **args)
            self.reply(200, glb, "model/gltf-binary")
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            self.reply(507, {"error": "The GPU ran out of memory. Use fewer parts."})
        except Exception as e:
            traceback.print_exc()
            self.reply(500, {"error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    print(f"PartCrafter worker on :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
