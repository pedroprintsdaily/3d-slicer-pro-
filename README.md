# Seamline

Your own split-and-join tool for big 3D prints: cosplay, life-size statues, helmets, figures.
Drop in an STL/OBJ/GLB, set the size, pick your printer, and Seamline cuts the model so every
piece fits the bed, at the narrowest points so seams hide, with dowel/peg/magnet connectors and
engraved cut numbers. It exports a print kit: one STL per piece (laid flat), dowel pins,
a colored 3MF of the assembled model and an assembly sheet. Slice the kit in Luban, Orca,
Bambu Studio or PrusaSlicer.

**From a picture (like PartCrafter):** step 01 → "From a picture". Upload one image and pick an AI model:
- **PartCrafter** builds the 3D model already split into body parts (2–16). Runs on your own NVIDIA GPU (see below).
- **Tripo** image-to-3D with "Separate parts" (Tripo's `generate_parts`).
- **Meshy** image-to-3D, then Meshy's own print split.

When a model comes back in parts, Seamline merges the overlapping parts into one solid and turns
every part boundary (neck, shoulders, hips, armor plates) into a joint cut. Then set the real size,
pick your printer and split: the joints are cut first, then anything still too big is cut at its
narrowest point.

AI extras for 3D files (need the small server below, which holds your keys):
- **Tripo** labels body parts (head, arms, legs, armor plates). Seamline turns each boundary into
  a flat, local cut (only that limb, not everything at that height) with connectors.
- **Meshy** auto-split: for models you generated in Meshy, paste the task ID and Meshy splits
  it; Seamline then sizes, fits and labels the parts. (Meshy only splits Meshy-made models.)

## Folder

| Path | What it is |
|---|---|
| `server/index.html` | The whole app in one file (open it directly to use it without AI) |
| `server/server.py` | Tiny server: serves the app, runs Tripo / Meshy / PartCrafter jobs. Standard library only |
| `server/partcrafter_worker.py` | PartCrafter GPU worker (runs inside a PartCrafter checkout on an NVIDIA GPU) |
| `engine.js` | Geometry engine: plane cuts, caps, seam finder, connectors, labels, exports |
| `app/` | App source (`app.html`, `worker.js`). `python3 build.py` rebuilds `server/index.html` |
| `test/run.js` | Engine tests: `node test/run.js` |

## Put it online with the AI features (Railway, about 5 minutes)

1. Push this folder to a GitHub repo (or `railway init` from the `server` folder with the Railway CLI).
2. In Railway: **New Project → Deploy from GitHub repo**, set **Root Directory** to `server`.
3. In the service's **Variables**, add:
   - `APP_TOKEN` – any long password you make up (the app asks for it)
   - `TRIPO_API_KEY` – from developers.tripo3d.ai
   - `MESHY_API_KEY` – from meshy.ai → API (paid plan needed for API tasks)
   - `PARTCRAFTER_URL` and `PARTCRAFTER_TOKEN` – only if you set up the PartCrafter worker below
4. **Settings → Networking → Generate Domain**. Open that URL on your phone or PC.
5. Paste your `APP_TOKEN` in step 01. Then use "From a picture", or step 04 → **Find joints with Tripo** for a 3D file.

Costs: each Tripo generation/segmentation and each Meshy generation/split uses credits on your accounts.
Jobs are kept for 4 hours, and are lost if Railway restarts the server.

## PartCrafter (image → 3D in parts, on your GPU)

PartCrafter is a research model (github.com/wgsxm/PartCrafter). It needs an NVIDIA GPU with at least
8 GB of memory (12 GB+ is more comfortable). The weights download on first start. The repo doesn't state
a license, so check with the authors before you sell anything made with it.

On a PC with an NVIDIA card, or a rented GPU (RunPod, Vast.ai, Lambda), Linux or WSL2:

```bash
git clone https://github.com/wgsxm/PartCrafter && cd PartCrafter
bash settings/setup.sh                     # the repo's installer: Python 3.11, PyTorch 2.5.1 + CUDA 12.4
cp /path/to/seamline/server/partcrafter_worker.py .
WORKER_TOKEN=pick-a-long-password python partcrafter_worker.py     # listens on port 7861
```

Railway has to reach the worker over the internet:
- Rented GPU: expose port 7861 in the pod settings and use its public URL.
- Home PC: run `cloudflared tunnel --url http://localhost:7861` and use the https URL it prints.

Then set on Railway: `PARTCRAFTER_URL` = that URL, `PARTCRAFTER_TOKEN` = the same password.
Check it with `curl <url>/health`. A 6-part model takes about 1–3 minutes on a modern GPU.
Tips: a clean front view with a plain background works best. More parts means finer joints but more
GPU memory. Try another seed if a part comes out wrong.

PartCrafter's geometry is coarser than Tripo's or Meshy's and has no texture. It's great for
finding where the body splits. For a detailed print, use Tripo with separate parts, or set
Merge to Fine.

## How the cutting works

- **Fit to bed**: pieces are allowed to rotate 90° to fit. For each piece that's too big, Seamline
  measures the cross-section area along its longest direction and picks the set of cuts with the
  smallest total seam area that keeps every piece within the bed (a neck or wrist beats a chest).
- **Connectors**: placed at the thickest point of each cut face (plus a second one to stop
  rotation when there is room), only where there is enough wall all the way down the hole.
  Faces too thin (hollow shells) get a note instead. Dowels let both faces print flat.
- **Labels**: each cut number is engraved as a dot-matrix on both faces, mirrored so it reads
  correctly on each. Match numbers when assembling.
- **Merging AI parts**: each part is filled on a voxel grid (checked along X, Y and Z so small holes
  don't leak), the parts are joined, and one watertight surface is rebuilt and smoothed. "Fine" keeps
  more detail. Internal overlaps disappear, so pieces never collide at assembly.
- **Safety check**: every cut is verified closed. If a connector can't be placed cleanly, that joint
  is left for glue and the assembly sheet says so.
- Clearance defaults to 0.2 mm. Print one small test joint first and adjust for your printer.

## Not in this version

Slicing to G-code (use Luban/Orca on the kit), hollowing, dovetail/twist-lock connectors,
and non-planar seams. Models must be closed (watertight); use **Repair holes** for small gaps.
