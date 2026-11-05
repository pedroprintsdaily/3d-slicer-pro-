// Worker side: keeps all geometry, runs the engine. Concatenated after engine.js at build time.
/* global Seam */
'use strict';
const W = {
  base: null,        // mesh as loaded (mm, Z up)
  baseParts: null,   // optional pre-split parts from a GLB (Meshy split result)
  current: null,     // base after scale/rotation
  pieces: [],        // [{mesh, name}]
  reports: [], notes: [], cutId: 0,
  xf: { scale: 1, up: 'z' },
  name: 'model',
};

function sampleFigure() {
  // a 600 mm display bust: torso, narrow neck, head, and two arm stubs joined at the shoulders
  const H = 600, steps = 120, segs = 96, P = [], T = [], rings = [];
  for (let i = 0; i <= steps; i++) {
    const z = H * i / steps, t = z / H; let rx, ry;
    if (i === 0 || i === steps) { rings.push([P.length / 3]); P.push(0, 0, z); continue; }
    const base = t < 0.06 ? 0.15 + t * 2 : 0;
    const torso = Math.sqrt(Math.max(0, 1 - ((t - 0.38) / 0.33) ** 2));
    const head = Math.sqrt(Math.max(0, 1 - ((t - 0.855) / 0.145) ** 2));
    rx = Math.max(0.21 * torso * (1 + 0.35 * Math.max(0, 1 - Math.abs(t - 0.62) / 0.1)), 0.105 * head, (t > 0.68 && t < 0.76) ? 0.05 : 0, base * 0.35, 0.004);
    ry = Math.max(0.15 * torso, 0.12 * head, (t > 0.68 && t < 0.76) ? 0.052 : 0, base * 0.3, 0.004);
    const ring = [];
    for (let s = 0; s < segs; s++) { const a = 2 * Math.PI * s / segs; ring.push(P.length / 3); P.push(rx * H * Math.cos(a), ry * H * Math.sin(a), z); }
    rings.push(ring);
  }
  for (let k = 0; k + 1 < rings.length; k++) {
    const A = rings[k], B = rings[k + 1];
    if (A.length === 1) for (let s = 0; s < segs; s++) T.push(A[0], B[(s + 1) % segs], B[s]);
    else if (B.length === 1) for (let s = 0; s < segs; s++) T.push(A[s], A[(s + 1) % segs], B[0]);
    else for (let s = 0; s < segs; s++) { const j = (s + 1) % segs; T.push(A[s], A[j], B[j], A[s], B[j], B[s]); }
  }
  return Seam.orientMesh(Seam.makeMesh(P, T));
}

function info(m) {
  const b = Seam.bbox(m), es = Seam.edgeStats(m);
  return { tris: m.T.length / 3, size: b.size, min: b.min, max: b.max, watertight: es.watertight, open: es.open, dup: es.dup, volume: Math.abs(Seam.volume(m)) };
}
// Model transform: p' = s * R * p + t (rotation for the up axis, uniform scale, then sit on the bed centred)
const ROT = { z: [1, 0, 0, 0, 1, 0, 0, 0, 1], y: [1, 0, 0, 0, 0, -1, 0, 1, 0], x: [0, 0, -1, 0, 1, 0, 1, 0, 0] };
function computeXf() {
  const R = ROT[W.xf.up] || ROT.z, s = W.xf.scale;
  const b = Seam.bbox(Seam.scaleMesh(Seam.rotateMesh(W.base, R), s));
  W.X = { R, s, t: [-b.center[0], -b.center[1], -b.min[2]] };
}
function applyXf(m) { const X = W.X; return Seam.translateMesh(Seam.scaleMesh(Seam.rotateMesh(m, X.R), X.s), X.t); }
const rotV = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
const rotVT = (R, v) => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];
// guided joint cuts are kept in the model's own frame so resizing afterwards keeps them in place
const ptToBase = q => rotVT(W.X.R, [0, 1, 2].map(a => (q[a] - W.X.t[a]) / W.X.s));
const ptToWorld = q => { const r = rotV(W.X.R, q); return [0, 1, 2].map(a => r[a] * W.X.s + W.X.t[a]); };
function cutToBase(c) { const p = ptToBase(c.c), n = rotVT(W.X.R, c.n); return { ...c, c: p, n, d: n[0] * p[0] + n[1] * p[1] + n[2] * p[2], spots: (c.spots || []).map(ptToBase) }; }
function cutToWorld(c) { const p = ptToWorld(c.c), n = rotV(W.X.R, c.n); return { ...c, c: p, n, d: n[0] * p[0] + n[1] * p[1] + n[2] * p[2], spots: (c.spots || []).map(ptToWorld) }; }
function piecesPayload() {
  const transfer = [];
  const pieces = W.pieces.map((p, i) => {
    const rd = Seam.renderData(p.mesh); transfer.push(rd.pos.buffer, rd.nrm.buffer, rd.cut.buffer);
    const b = Seam.bbox(p.mesh);
    const cuts = [...new Set(p.mesh.G)].filter(g => g > 0).sort((a, b) => a - b);
    return { name: p.name, render: rd, size: b.size, center: b.center, min: b.min, max: b.max, volume: Math.abs(Seam.volume(p.mesh)), tris: p.mesh.T.length / 3, cuts };
  });
  const dowels = {}; let magnets = 0; const notes = W.notes.slice();
  for (const r of W.reports) { for (const d of r.dowels) { const k = `${d.d}x${d.len}`; dowels[k] = (dowels[k] || 0) + 1; } magnets += r.magnets; notes.push(...r.notes); }
  const joints = W.reports.filter(r => r.joint).map(r => ({ cut: r.cutId, joint: r.joint }));
  return { msg: { pieces, cutCount: W.cutId, dowels, magnets, notes, joints }, transfer };
}
function nameAll() { W.pieces.forEach((p, i) => { p.name = 'P' + (i + 1); }); }
function resetPieces() {
  W.reports = []; W.notes = []; W.cutId = 0;
  W.pieces = W.baseParts ? W.baseParts.map(p => ({ mesh: applyXf(p.mesh) })) : [{ mesh: W.current }];
  nameAll();
}
function rebuild() { computeXf(); W.current = applyXf(W.base); resetPieces(); }
// AI models come out about 1 unit tall: make them a visible 300 mm until the user sets a size
function normalizeTiny(mesh, parts) {
  const b = Seam.bbox(mesh), m = Math.max(...b.size);
  if (m >= 20 || m <= 0) return { mesh, parts, scaled: false };
  const k = 300 / b.size[2] > 0 && b.size[2] > m * 0.3 ? 300 / b.size[2] : 300 / m;
  return { mesh: Seam.scaleMesh(mesh, k), parts: parts && parts.map(p => ({ ...p, mesh: Seam.scaleMesh(p.mesh, k) })), scaled: true };
}

const handlers = {
  sample() {
    W.base = sampleFigure(); W.baseParts = null; W.name = 'sample-bust'; W.xf = { scale: 1, up: 'z' };
    rebuild(); return { info: info(W.base), name: W.name, parts: 1 };
  },
  load({ name, buf }) {
    const ext = name.toLowerCase().split('.').pop();
    let mesh, parts = null;
    if (ext === 'stl') mesh = Seam.parseSTL(buf);
    else if (ext === 'obj') mesh = Seam.parseOBJ(buf);
    else if (ext === 'glb') { parts = Seam.parseGLB(buf); if (!parts.length) throw new Error('No meshes found in this GLB.'); mesh = Seam.mergeMeshes(parts.map(p => p.mesh)); }
    else throw new Error('Use an STL, OBJ or GLB file.');
    if (!mesh.T.length) throw new Error('This file has no triangles.');
    mesh = Seam.orientMesh(mesh);
    // parts from a split service should be closed; close small gaps so they can be cut further
    let bp = parts && parts.length > 1 ? parts.map(p => { let m = Seam.orientMesh(p.mesh); if (!Seam.edgeStats(m).watertight) m = Seam.fillHoles(m).mesh; return { mesh: m, name: p.name }; }) : null;
    if (bp) mesh = Seam.mergeMeshes(bp.map(p => p.mesh));
    let scaled = false;
    if (ext === 'glb') { const nt = normalizeTiny(mesh, bp); mesh = nt.mesh; bp = nt.parts; scaled = nt.scaled; }
    W.base = mesh; W.baseParts = bp; W.guides = null;
    W.name = name.replace(/\.[^.]+$/, ''); W.xf = { scale: 1, up: 'z' };
    rebuild(); return { info: info(W.base), name: W.name, parts: W.baseParts ? W.baseParts.length : 1, scaled };
  },
  // AI result made of overlapping parts: merge into one solid, keep the parts as joint guides
  loadParts({ name, buf, res }) {
    let parts = Seam.parseGLB(buf).filter(p => p.mesh.T.length >= 12);
    if (!parts.length) throw new Error('The AI result had no usable geometry.');
    parts = parts.map(p => ({ ...p, mesh: Seam.orientMesh(p.mesh) }));
    let whole;
    if (parts.length === 1) whole = parts[0].mesh;
    else whole = Seam.voxelUnion(parts.map(p => p.mesh), res || 192, 6, p => postMessage({ progress: { text: p.stage === 'fill' ? `Merging parts… ${p.part}/${p.of}` : 'Building the surface…' } })).mesh;
    const nt = normalizeTiny(whole, parts);
    W.base = nt.mesh; W.baseParts = null; W.name = name; W.xf = { scale: 1, up: 'z' };
    rebuild();
    let cuts = [];
    if (parts.length > 1) {
      const r = Seam.proposeGuidedCuts(W.current, nt.parts.map(p => ({ ...p, mesh: applyXf(p.mesh) })));
      if (!r.error) cuts = r.cuts.map(c => cutToBase({ a: c.a, b: c.b, c: c.c, n: c.n, d: c.d, size: c.size, spots: c.spots }));
    }
    return { info: info(W.base), name: W.name, parts: parts.length, scaled: nt.scaled, cuts };
  },
  repair() {
    const r = Seam.fillHoles(W.base); W.base = r.mesh;
    if (W.baseParts) W.baseParts = W.baseParts.map(p => ({ ...p, mesh: Seam.fillHoles(p.mesh).mesh }));
    rebuild(); return { filled: r.filled, info: info(W.base) };
  },
  transform({ scale, up }) { W.xf = { scale, up }; rebuild(); return { info: info(W.current) }; },
  reset() { resetPieces(); return {}; },
  split({ settings, guided }) {
    resetPieces(); // every auto split starts again from the whole model
    let list = W.pieces.map(p => ({ mesh: p.mesh }));
    if (guided && guided.length) {
      const g = Seam.applyGuidedCuts(list, guided.map(cutToWorld), { ...settings, startCutId: W.cutId });
      list = g.pieces; W.reports.push(...g.reports); W.notes.push(...g.notes); W.cutId = g.lastCutId;
    }
    const res = Seam.autoSplit(list, { ...settings, startCutId: W.cutId }, p => postMessage({ progress: p }));
    W.pieces = res.pieces.map(p => ({ mesh: p.mesh })); W.reports.push(...res.reports); W.notes.push(...res.notes); W.cutId = res.lastCutId;
    nameAll(); return {};
  },
  cutPart({ index, axis, pos, settings }) {
    const p = W.pieces[index]; if (!p) throw new Error('Pick a part first.');
    const n = [0, 0, 0]; n[axis] = 1;
    const r = Seam.cutMesh(p.mesh, { n, d: pos }, { cutId: W.cutId + 1, connector: settings.connector, label: settings.label, wall: settings.wall });
    if (r.error) throw new Error(r.error);
    W.cutId++; W.reports.push(r.report);
    const fresh = [];
    for (const half of [r.below, r.above]) for (const c of Seam.components(half)) if (c.T.length >= 12) fresh.push({ mesh: c });
    W.pieces.splice(index, 1, ...fresh); nameAll(); return {};
  },
  guided({ buf }) {
    const parts = Seam.parseGLB(buf);
    if (parts.length < 2) throw new Error('The segmentation came back as a single part.');
    const r = Seam.proposeGuidedCuts(W.current, parts);
    if (r.error) throw new Error(r.error);
    return { cuts: r.cuts.map(c => cutToBase({ a: c.a, b: c.b, c: c.c, n: c.n, d: c.d, size: c.size, spots: c.spots })), partNames: parts.map(p => p.name) };
  },
  bodyJoints({ secondary }) {
    const r = Seam.findBodyJoints(W.current, { res: 96, secondary: !!secondary });
    return { cuts: r.cuts.map(c => cutToBase(c)), note: r.note };
  },
  toWorld({ cuts }) { return { rings: cuts.map(c => { const w = cutToWorld(c); return { c: w.c, n: w.n, r: (c.r || 0) * W.X.s }; }) }; },
  wholeSTL() {
    const m = W.current;
    return { stl: Seam.stlBinary(m, W.name).buffer };
  },
  exportKit({ colors, layFlat, settings }) {
    const files = [];
    const parts3mf = [];
    W.pieces.forEach((p, i) => {
      const m = layFlat ? Seam.layFlat(p.mesh, null) : p.mesh;
      files.push({ name: `parts/${W.name}_${p.name}.stl`, data: Seam.stlBinary(m, p.name) });
      parts3mf.push({ name: p.name, mesh: p.mesh, color: colors[i] || '#cccccc' });
    });
    const dw = {}; for (const r of W.reports) for (const d of r.dowels) { const k = d.d + 'x' + d.len; dw[k] = (dw[k] || 0) + 1; }
    for (const [k, count] of Object.entries(dw)) {
      const [dia, l] = k.split('x').map(Number);
      const pin = Seam.dowelMesh(dia, Math.max(4, l - 1));
      files.push({ name: `dowels/dowel_${dia}mm_x${Math.max(4, l - 1)}mm_print_${count}.stl`, data: Seam.stlBinary(pin, 'dowel') });
    }
    files.push({ name: `${W.name}_assembled_colors.3mf`, data: Seam.threeMF(parts3mf) });
    files.push({ name: 'ASSEMBLY.txt', data: new TextEncoder().encode(assemblyText(settings)) });
    return { zip: Seam.zipStore(files), transfer: true };
  },
};

function assemblyText(settings) {
  const lines = [];
  lines.push(`Seamline print kit: ${W.name}`, `Pieces: ${W.pieces.length}   Cuts: ${W.cutId}`, `Printer bed: ${settings.bed.join(' x ')} mm (margin ${settings.margin} mm)`, '');
  lines.push('PIECES');
  W.pieces.forEach(p => { const b = Seam.bbox(p.mesh); lines.push(`  ${p.name}  ${b.size.map(v => v.toFixed(0)).join(' x ')} mm   ${(Math.abs(Seam.volume(p.mesh)) / 1000).toFixed(0)} cm3`); });
  lines.push('', 'JOINS  (each cut face is engraved with its cut number; match the numbers)');
  const join = Seam.assemblyMap(W.pieces);
  for (const [cut, idx] of [...join.entries()].sort((a, b) => a[0] - b[0])) {
    const r = W.reports.find(x => x.cutId === cut);
    lines.push(`  Cut ${cut}: ${idx.map(i => W.pieces[i].name).join(' + ')}` + (r && r.joint ? `   (${r.joint})` : '') + (r ? `   connectors: ${r.connectors}` : ''));
  }
  const conn = settings.connector;
  lines.push('', 'CONNECTORS');
  if (conn.type === 'dowel') lines.push('  Print the dowel pins in /dowels (count is in the file name). Glue pins into one side first.', `  Hole clearance: ${conn.tolerance} mm. Too tight? Sand the pin or reprint with more tolerance.`);
  if (conn.type === 'magnet') lines.push(`  Magnet pockets: ${conn.magnetD} x ${conn.magnetH} mm. Check polarity before gluing the second side.`);
  if (conn.type === 'peg') lines.push('  Pegs are printed on one side of each cut. Print that face up or add supports under the peg.');
  if (conn.type === 'none') lines.push('  No connectors. Glue faces with CA glue or epoxy.');
  const notes = W.notes.concat(...W.reports.map(r => r.notes));
  if (notes.length) { lines.push('', 'NOTES'); notes.forEach(n => lines.push('  - ' + n)); }
  lines.push('', 'Tips: print each piece on its largest cut face (files are already laid flat if you chose that).', 'Fill seams with filler primer, sand 220 -> 400, then paint.');
  return lines.join('\n');
}

onmessage = (e) => {
  const { id, cmd, args } = e.data;
  try {
    const out = handlers[cmd](args || {}) || {};
    if (cmd === 'exportKit') { postMessage({ id, ok: true, zip: out.zip }, [out.zip.buffer]); return; }
    if (cmd === 'wholeSTL') { postMessage({ id, ok: true, stl: out.stl }, [out.stl]); return; }
    const wantsPieces = ['sample', 'load', 'loadParts', 'repair', 'transform', 'reset', 'split', 'cutPart'].includes(cmd);
    if (wantsPieces) { const { msg, transfer } = piecesPayload(); postMessage({ id, ok: true, ...out, ...msg }, transfer); }
    else postMessage({ id, ok: true, ...out });
  } catch (err) {
    postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
