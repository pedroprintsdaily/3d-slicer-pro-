const S = require('../engine.js');
const sh = require('./shapes.js');
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

console.log('earcut');
{
  // square with square hole
  const outer = [0, 0, 10, 0, 10, 10, 0, 10], hole = [3, 3, 3, 7, 7, 7, 7, 3];
  const tri = S.earcut(outer.concat(hole), [4]);
  const pts = outer.concat(hole); let a = 0;
  for (let k = 0; k < tri.length; k += 3) { const [i, j, l] = [tri[k], tri[k + 1], tri[k + 2]]; a += Math.abs((pts[j * 2] - pts[i * 2]) * (pts[l * 2 + 1] - pts[i * 2 + 1]) - (pts[l * 2] - pts[i * 2]) * (pts[j * 2 + 1] - pts[i * 2 + 1])) / 2; }
  ok(near(a, 84, 1e-9) && tri.length / 3 === 8, 'square with hole area 84, 8 tris');
  // big star polygon (hashed path) with many circle holes
  let worst = 0;
  for (let trial = 0; trial < 20; trial++) {
    const N = 300 + trial * 40, poly = [];
    for (let i = 0; i < N; i++) { const t = 2 * Math.PI * i / N, r = 100 + 25 * Math.sin(7 * t + trial) + 5 * Math.cos(31 * t); poly.push([r * Math.cos(t), r * Math.sin(t)]); }
    const holes = []; for (let h = 0; h < 5; h++) { const c = [Math.cos(h * 1.3) * 40, Math.sin(h * 1.3) * 40]; holes.push(Array.from({ length: 24 }, (_, i) => [c[0] + 8 * Math.cos(-2 * Math.PI * i / 24), c[1] + 8 * Math.sin(-2 * Math.PI * i / 24)])); }
    const flat = poly.flat(); const hi = []; for (const h of holes) { hi.push(flat.length / 2); flat.push(...h.flat()); }
    const tri = S.earcut(flat, hi);
    let a = 0; for (let k = 0; k < tri.length; k += 3) { const [i, j, l] = [tri[k], tri[k + 1], tri[k + 2]]; a += Math.abs((flat[j * 2] - flat[i * 2]) * (flat[l * 2 + 1] - flat[i * 2 + 1]) - (flat[l * 2] - flat[i * 2]) * (flat[j * 2 + 1] - flat[i * 2 + 1])) / 2; }
    const expect = Math.abs(S.loopArea(poly)) - holes.reduce((s, h) => s + Math.abs(S.loopArea(h)), 0);
    worst = Math.max(worst, Math.abs(a - expect) / expect);
  }
  ok(worst < 1e-9, 'random polygons with holes: area error ' + worst.toExponential(2));
}

function check(name, m) {
  const es = S.edgeStats(m);
  ok(es.watertight, `${name} watertight (open ${es.open}, dup ${es.dup})`);
  ok(S.volume(m) > 0, `${name} positive volume`);
}

console.log('shapes');
const fig = sh.figure(600); check('figure', fig);
const H = sh.letterH(); check('letterH', H);
const torus = sh.revolveClosed(Array.from({ length: 24 }, (_, i) => [60 + 20 * Math.cos(2 * Math.PI * i / 24), 20 * Math.sin(2 * Math.PI * i / 24)]), 48); check('torus', torus);
// hollow helmet-like dome shell 3mm thick
const shellProf = []; for (let i = 0; i <= 20; i++) { const a = Math.PI / 2 * i / 20; shellProf.push([110 * Math.cos(a) + 0.01, 110 * Math.sin(a)]); }
for (let i = 20; i >= 0; i--) { const a = Math.PI / 2 * i / 20; shellProf.push([107 * Math.cos(a) + 0.01, 107 * Math.sin(a)]); }
// close at the top: profile hits near-zero radius -> use revolve-closed with small r (approximate)
const shell = sh.revolveClosed(shellProf.map(([r, z]) => [Math.max(r, 1), z]), 48); check('shell', shell);

console.log('plain cuts preserve volume');
for (const [name, m, n, d] of [['figure z=300', fig, [0, 0, 1], 300], ['H x=150', H, [1, 0, 0], 150], ['H y=200', H, [0, 1, 0], 200], ['torus z=5', torus, [0, 0, 1], 5], ['torus x=0', torus, [1, 0, 0], 0.3], ['figure tilted', fig, [0.3, 0.2, 1], 280], ['shell z=50', shell, [0, 0, 1], 50]]) {
  const r = S.cutMesh(m, { n, d }, { cutId: 1, connector: { type: 'none' } });
  if (r.error) { ok(false, name + ': ' + r.error); continue; }
  check(name + ' below', r.below); check(name + ' above', r.above);
  const v0 = S.volume(m), v1 = S.volume(r.below) + S.volume(r.above);
  ok(near(v1, v0, 1e-6), `${name} volume ${v0.toFixed(1)} -> ${v1.toFixed(1)}`);
}

console.log('connectors + labels');
for (const type of ['dowel', 'peg', 'magnet']) {
  const conn = { type, diameter: 6, depth: 10, tolerance: 0.2, magnetD: 8, magnetH: 3 };
  const r = S.cutMesh(fig, { n: [0, 0, 1], d: 250 }, { cutId: 7, connector: conn, label: true, wall: 1.6 });
  if (r.error) { ok(false, type + ': ' + r.error); continue; }
  check(type + ' below', r.below); check(type + ' above', r.above);
  ok(r.report.connectors >= 1, `${type}: ${r.report.connectors} connectors, labeled ${r.report.labeled}`);
  const v0 = S.volume(fig), vb = S.volume(r.below), va = S.volume(r.above);
  const rr = 3.2;
  if (type === 'dowel') { const hole = Math.PI * rr * rr * 10.5 * 2 * r.report.connectors; ok(vb + va < v0 - hole * 0.9, 'dowel holes removed material'); }
  if (type === 'peg') { ok(vb > S.volume(S.cutMesh(fig, { n: [0, 0, 1], d: 250 }, { cutId: 7 }).below), 'peg added to lower piece'); }
}

console.log('local cut (only the island at a point)');
{
  // H shape, plane y=100 crosses both legs; cut only the left leg
  const r = S.cutMesh(H, { n: [0, 1, 0], d: 100 }, { cutId: 2, localPoint: [40, 100, 30], connector: { type: 'none' } });
  if (r.error) ok(false, 'local: ' + r.error);
  else {
    check('local below', r.below); check('local above', r.above);
    const cb = S.components(r.below).length, ca = S.components(r.above).length;
    const bb = S.bbox(r.below);
    ok(cb === 1 && ca === 1 && bb.max[0] < 81, `only left leg foot cut off (below bbox x ${bb.min[0].toFixed(0)}..${bb.max[0].toFixed(0)})`);
    ok(near(S.volume(r.below) + S.volume(r.above), S.volume(H), 1e-6), 'local cut volume preserved');
  }
}

console.log('auto split: seam at the neck');
{
  const settings = { bed: [256, 256, 256], margin: 5, mode: 'seams', connector: { type: 'dowel', diameter: 0, depth: 0, tolerance: 0.2 }, label: true, wall: 1.6 };
  const t0 = Date.now();
  const res = S.autoSplit([{ mesh: fig }], settings);
  console.log(`  ${res.pieces.length} pieces, ${res.reports.length} cuts in ${Date.now() - t0}ms; notes:`, res.notes, res.reports.map(r => r.notes).flat());
  ok(res.pieces.every(p => S.fitsBed(p.mesh, settings.bed, settings.margin)), 'all pieces fit 256 bed');
  ok(res.pieces.every(p => S.edgeStats(p.mesh).watertight), 'all pieces watertight');
  const zs = res.reports.filter(r => Math.abs(r.plane.n[2]) === 1).map(r => r.d.toFixed(0));
  console.log('  horizontal cut heights:', zs.join(', '), ' (neck is near 432)');
  ok(zs.some(z => Math.abs(z - 432) < 30), 'a horizontal cut lands at the neck');
  const joins = S.assemblyMap(res.pieces);
  ok([...joins.values()].every(l => l.length >= 2), 'every cut joins at least two pieces');
}

console.log('guided cuts from segmentation');
{
  // fake segmentation: split figure geometry at neck into "body" and "head" by vertex z, rotated to Y-up and rescaled like an AI service might
  const body = [], head = [];
  for (let t = 0; t < fig.T.length / 3; t++) { const z = (fig.P[fig.T[t * 3] * 3 + 2] + fig.P[fig.T[t * 3 + 1] * 3 + 2] + fig.P[fig.T[t * 3 + 2] * 3 + 2]) / 3; (z > 440 ? head : body).push(t); }
  const R = [1, 0, 0, 0, 0, 1, 0, -1, 0];
  const toSeg = tris => S.scaleMesh(S.rotateMesh(S.subMesh(fig, tris), R), 1 / 600);
  const prop = S.proposeGuidedCuts(fig, [{ name: 'body', mesh: toSeg(body) }, { name: 'head', mesh: toSeg(head) }]);
  if (prop.error) ok(false, prop.error);
  else {
    ok(prop.cuts.length === 1, `found ${prop.cuts.length} joint(s): ${prop.cuts.map(c => c.a + '/' + c.b + ' at z=' + c.c[2].toFixed(0)).join(', ')}`);
    const res = S.applyGuidedCuts([{ mesh: fig }], prop.cuts, { connector: { type: 'dowel', diameter: 0, depth: 0, tolerance: 0.2 }, label: true, wall: 1.6 });
    ok(res.pieces.length === 2 && res.pieces.every(p => S.edgeStats(p.mesh).watertight), `guided split -> ${res.pieces.length} watertight pieces ${res.notes.join(' ')}`);
  }
}

console.log('subdivided box (collinear cap points)');
{
  // box with every face split into a 6x6 grid of quads
  const P = [], T = [], key = new Map(); const n = 6, sz = 100;
  const vid = (x, y, z) => { const k = x + ',' + y + ',' + z; let i = key.get(k); if (i === undefined) { i = P.length / 3; key.set(k, i); P.push(x * sz / n, y * sz / n, z * sz / n); } return i; };
  const face = (f) => { for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const a = f(i, j), b = f(i + 1, j), c = f(i + 1, j + 1), d = f(i, j + 1); T.push(a, b, c, a, c, d); } };
  face((i, j) => vid(i, j, 0)); face((i, j) => vid(i, j, n)); face((i, j) => vid(i, 0, j)); face((i, j) => vid(i, n, j)); face((i, j) => vid(0, i, j)); face((i, j) => vid(n, i, j));
  const box = S.orientMesh(S.makeMesh(P, T)); check('grid box', box);
  for (const conn of ['none', 'dowel']) {
    const r = S.cutMesh(box, { n: [0, 0, 1], d: 41 }, { cutId: 12, connector: { type: conn, diameter: 8, depth: 10, tolerance: 0.2 }, label: true });
    check('grid box cut ' + conn + ' below', r.below); check('grid box cut ' + conn + ' above', r.above);
  }
}

console.log('voxel union of overlapping parts');
{
  const R = 100, sph = (cx) => S.translateMesh(sh.revolve(sh.sphereProfile(R, 0, 40), 64), [cx, 0, 0]);
  const a = sph(0), b = sph(120); // overlap 80 mm
  // analytic union volume: 2*V - lens; lens for d=120: pi(4R+d)(2R-d)^2/12
  const V = 4 / 3 * Math.PI * R ** 3, d = 120, lens = Math.PI * (4 * R + d) * (2 * R - d) ** 2 / 12, expect = 2 * V - lens;
  const t0 = Date.now(); const u = S.voxelUnion([a, b], 160, 6);
  check('union', u.mesh);
  const v = S.volume(u.mesh);
  ok(Math.abs(v - expect) / expect < 0.03, `union volume ${(v / 1e3).toFixed(0)} cm3 vs ${(expect / 1e3).toFixed(0)} (${Date.now() - t0} ms, ${u.mesh.T.length / 3} tris)`);
  ok(S.components(u.mesh).length === 1, 'one solid');
  // an open part (cap missing) must not leak
  const open = S.subMesh(b, Array.from({ length: b.T.length / 3 - 64 }, (_, i) => i + 64));
  const u2 = S.voxelUnion([a, open], 160, 6); check('union with open part', u2.mesh);
  ok(Math.abs(S.volume(u2.mesh) - expect) / expect < 0.05, 'open part filled by majority vote');
  // union is cuttable and parts guide the joint cut
  const prop = S.proposeGuidedCuts(u.mesh, [{ name: 'left', mesh: a }, { name: 'right', mesh: b }]);
  ok(!prop.error && prop.cuts.length === 1 && Math.abs(Math.abs(prop.cuts[0].n[0]) - 1) < 0.1, 'parts give a joint plane across X: ' + (prop.cuts && prop.cuts.map(c => c.c.map(x => x.toFixed(0)).join(',')).join(' ')));
  const g = S.applyGuidedCuts([{ mesh: u.mesh }], prop.cuts, { connector: { type: 'dowel', diameter: 0, depth: 0, tolerance: 0.2 }, label: true });
  ok(g.pieces.length === 2 && g.pieces.every(p => S.edgeStats(p.mesh).watertight), 'guided split of union -> 2 watertight pieces ' + g.notes.join(' '));
}

console.log('io');
{
  const stl = S.stlBinary(fig, 'fig'); const back = S.parseSTL(stl.buffer.slice(0));
  ok(back.T.length === fig.T.length && S.edgeStats(back).watertight, 'STL round trip');
  const z = S.threeMF([{ name: 'a', mesh: H, color: '#ff8800' }]);
  require('fs').writeFileSync(__dirname + '/out.3mf', z);
  ok(z.length > 1000, '3MF written ' + z.length + ' bytes');
  const holey = S.subMesh(fig, Array.from({ length: fig.T.length / 3 - 64 }, (_, i) => i + 64));
  const fh = S.fillHoles(holey); ok(fh.filled === 1 && S.edgeStats(fh.mesh).watertight, 'fillHoles repairs open pole');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
