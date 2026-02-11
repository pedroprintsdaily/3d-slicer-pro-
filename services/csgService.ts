
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { Brush, Evaluator, INTERSECTION, ADDITION, SUBTRACTION } from 'three-bvh-csg';
import { SlicingConfig, ConnectorConfig, HollowConfig, LabelConfig, ModelPart } from '../types';

const evaluator = new Evaluator();
evaluator.useGroups = false;

const wait = () => new Promise(res => requestAnimationFrame(res));

const raycaster = new THREE.Raycaster();
const tempVec = new THREE.Vector3();
const tempNormal = new THREE.Vector3();

/**
 * Normalizes geometry for robust CSG operations.
 * CRITICAL FIX: The "i.array" error occurs when three-mesh-bvh (used by three-bvh-csg)
 * attempts to access geometry.index.array and the index is missing or null.
 * This function forces a standard indexed 32-bit layout.
 */
function ensureValidForCSG(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geo || !geo.attributes.position || geo.attributes.position.count === 0) {
    return new THREE.BufferGeometry();
  }

  // 1. Force convert to non-indexed first to ensure we start from a clean topological state
  let cleanGeo = geo.toNonIndexed();

  // 2. Strip all attributes except position to prevent layout mismatches in CSG
  const posAttr = cleanGeo.getAttribute('position');
  const freshGeo = new THREE.BufferGeometry();
  freshGeo.setAttribute('position', posAttr.clone());

  // 3. Weld vertices using BufferGeometryUtils. This creates a clean indexed geometry.
  // This is the most reliable way to produce a manifold mesh for boolean operations.
  let indexedGeo: THREE.BufferGeometry;
  try {
    indexedGeo = BufferGeometryUtils.mergeVertices(freshGeo, 1e-4);
  } catch (e) {
    // Fallback: Manually index if mergeVertices fails
    console.warn("mergeVertices failed, manually indexing...");
    const count = freshGeo.attributes.position.count;
    const indices = new Uint32Array(count);
    for (let i = 0; i < count; i++) indices[i] = i;
    freshGeo.setIndex(new THREE.BufferAttribute(indices, 1));
    indexedGeo = freshGeo;
  }

  // 4. Ensure the index is specifically a Uint32Array and has the .array property explicitly
  if (!indexedGeo.index) {
    const count = indexedGeo.attributes.position.count;
    const indices = new Uint32Array(count);
    for (let i = 0; i < count; i++) indices[i] = i;
    indexedGeo.setIndex(new THREE.BufferAttribute(indices, 1));
  } else if (!(indexedGeo.index.array instanceof Uint32Array)) {
    const existing = indexedGeo.index.array;
    const indices = new Uint32Array(existing.length);
    for (let i = 0; i < existing.length; i++) indices[i] = existing[i];
    indexedGeo.setIndex(new THREE.BufferAttribute(indices, 1));
  }

  // 5. Final housekeeping
  indexedGeo.computeVertexNormals();
  indexedGeo.computeBoundingBox();
  indexedGeo.clearGroups();

  return indexedGeo;
}

/**
 * Prepares a Brush for CSG operations with guaranteed indexed geometry.
 */
function createBrush(geo: THREE.BufferGeometry): Brush | null {
  try {
    const validGeo = ensureValidForCSG(geo);
    if (validGeo.attributes.position.count === 0 || !validGeo.index) return null;
    
    const brush = new Brush(validGeo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
    brush.updateMatrixWorld();
    
    // Explicitly update structure to ensure BVH is built before evaluation
    if ('updateStructure' in brush && typeof brush.updateStructure === 'function') {
      (brush as any).updateStructure();
    }
    
    return brush;
  } catch (e) {
    console.error("Brush preparation failed:", e);
    return null;
  }
}

/**
 * Performs Hollowing by subtracting a slightly scaled-down internal shell.
 */
async function applyHollowing(baseBrush: Brush, bounds: THREE.Box3, config: HollowConfig): Promise<Brush> {
  if (!config.enabled) return baseBrush;

  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const wall = config.wallThickness;

  // 1. Create the internal shell geometry
  const innerGeo = baseBrush.geometry.clone();
  innerGeo.translate(-center.x, -center.y, -center.z);
  
  // Calculate scaling to maintain wall thickness
  // Wall is on both sides, so size - 2*wall
  const scaleX = Math.max(0.01, (size.x - wall * 2) / size.x);
  const scaleY = Math.max(0.01, (size.y - wall * 2) / size.y);
  const scaleZ = Math.max(0.01, (size.z - wall * 2) / size.z);
  
  innerGeo.scale(scaleX, scaleY, scaleZ);
  innerGeo.translate(center.x, center.y, center.z);
  
  const innerBrush = createBrush(innerGeo);
  if (!innerBrush) return baseBrush;

  try {
    // 2. Perform the boolean subtraction
    const result = evaluator.evaluate(baseBrush, innerBrush, SUBTRACTION);
    let resultBrush = createBrush(result.geometry) || baseBrush;

    // 3. Optional: Add drain holes (useful for Resin printing)
    if (config.drainHoleEnabled) {
      const holeRadius = config.drainHoleDiameter / 2;
      const holeHeight = size.y + 100; // Oversized to ensure punch through
      const holeGeo = new THREE.CylinderGeometry(holeRadius, holeRadius, holeHeight, 16);
      
      // Position at bottom center
      holeGeo.translate(center.x, bounds.min.y, center.z);
      
      const holeBrush = createBrush(holeGeo);
      if (holeBrush) {
        const withDrain = evaluator.evaluate(resultBrush, holeBrush, SUBTRACTION);
        resultBrush = createBrush(withDrain.geometry) || resultBrush;
      }
    }

    return resultBrush;
  } catch (e) {
    console.error("Hollowing operation failure:", e);
    return baseBrush;
  }
}

/**
 * Check if a feature (like a connector) can be placed safely on the mesh.
 */
function isValidPlacement(mesh: THREE.Mesh, point: THREE.Vector3, normal: THREE.Vector3, minDepth: number): boolean {
  tempVec.copy(point).addScaledVector(normal, 0.5);
  tempNormal.copy(normal).negate();
  raycaster.set(tempVec, tempNormal);
  raycaster.far = 1.0;
  let hits = raycaster.intersectObject(mesh);
  if (hits.length === 0) return false;

  tempVec.copy(point).addScaledVector(normal, -0.1);
  tempNormal.copy(normal).negate();
  raycaster.set(tempVec, tempNormal);
  raycaster.far = minDepth;
  hits = raycaster.intersectObject(mesh);
  return hits.length === 0 || hits[0].distance > minDepth;
}

/**
 * Adds registration pins (pegs) and sockets to parts.
 */
async function applyConnectors(
  geo: THREE.BufferGeometry,
  ix: number, iy: number, iz: number,
  stepsX: number, stepsY: number, stepsZ: number,
  config: SlicingConfig,
  connectors: ConnectorConfig,
  boundsMin: THREE.Vector3
): Promise<THREE.BufferGeometry> {
  let resultBrush = createBrush(geo);
  if (!resultBrush) return geo;

  const box = new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position') as THREE.BufferAttribute);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const tempMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());

  const addFeatures = async (faceAxis: 'x' | 'y' | 'z', isPeg: boolean) => {
    const r = isPeg ? connectors.diameter / 2 : (connectors.diameter / 2) + connectors.tolerance;
    const h = connectors.length;
    const cylGeo = new THREE.CylinderGeometry(r, r, h, 16);
    if (faceAxis === 'x') cylGeo.rotateZ(Math.PI / 2);
    else if (faceAxis === 'z') cylGeo.rotateX(Math.PI / 2);

    const spacing = Math.max(5, connectors.spacing);
    const margin = connectors.edgeMargin;
    
    let faceW = 0, faceH = 0;
    if (faceAxis === 'x') { faceW = size.z; faceH = size.y; }
    else if (faceAxis === 'y') { faceW = size.x; faceH = size.z; }
    else { faceW = size.x; faceH = size.y; }

    const countH = Math.max(0, Math.floor((faceW - margin * 2) / spacing));
    const countV = Math.max(0, Math.floor((faceH - margin * 2) / spacing));

    const geometries: THREE.BufferGeometry[] = [];
    const faceNormal = new THREE.Vector3();
    if (faceAxis === 'x') faceNormal.set(isPeg ? 1 : -1, 0, 0);
    else if (faceAxis === 'y') faceNormal.set(0, isPeg ? 1 : -1, 0);
    else faceNormal.set(0, 0, isPeg ? 1 : -1);

    for (let dh = 0; dh <= countH; dh++) {
      for (let dv = 0; dv <= countV; dv++) {
        const hOff = (dh * spacing) - (countH * spacing) / 2;
        const vOff = (dv * spacing) - (countV * spacing) / 2;
        
        const worldPos = new THREE.Vector3();
        if (faceAxis === 'x') worldPos.set(isPeg ? box.max.x : box.min.x, center.y + vOff, center.z + hOff);
        else if (faceAxis === 'y') worldPos.set(center.x + hOff, isPeg ? box.max.y : box.min.y, center.z + vOff);
        else worldPos.set(center.x + hOff, center.y + vOff, isPeg ? box.max.z : box.min.z);

        if (isValidPlacement(tempMesh, worldPos, faceNormal, h * 0.7)) {
          const inst = cylGeo.clone();
          inst.translate(worldPos.x, worldPos.y, worldPos.z);
          geometries.push(inst);
        }
      }
    }

    if (geometries.length > 0) {
      const merged = BufferGeometryUtils.mergeGeometries(geometries);
      const opBrush = createBrush(merged);
      if (opBrush && resultBrush) {
        const op = isPeg ? ADDITION : SUBTRACTION;
        const res = evaluator.evaluate(resultBrush, opBrush, op);
        resultBrush = createBrush(res.geometry) || resultBrush;
        tempMesh.geometry = resultBrush.geometry;
      }
    }
  };

  if (ix < stepsX - 1) await addFeatures('x', true);
  if (ix > 0) await addFeatures('x', false);
  if (iy < stepsY - 1) await addFeatures('y', true);
  if (iy > 0) await addFeatures('y', false);
  if (iz < stepsZ - 1) await addFeatures('z', true);
  if (iz > 0) await addFeatures('z', false);

  return resultBrush.geometry;
}

/**
 * Adds a small raised plate to parts for physical identification.
 */
async function applyLabel(geo: THREE.BufferGeometry, ix: number, iy: number, iz: number, config: LabelConfig): Promise<THREE.BufferGeometry> {
  const thickness = config.thickness;
  const plateGeo = new THREE.BoxGeometry(config.plateSize, thickness, config.plateSize / 2);
  const bounds = new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position') as THREE.BufferAttribute);
  const center = bounds.getCenter(new THREE.Vector3());
  
  // Position label at bottom center of the part
  plateGeo.translate(center.x, bounds.min.y + thickness / 2, center.z);
  
  const baseBrush = createBrush(geo);
  const labelBrush = createBrush(plateGeo);
  if (!baseBrush || !labelBrush) return geo;
  
  try {
    const res = evaluator.evaluate(baseBrush, labelBrush, ADDITION);
    return res.geometry;
  } catch {
    return geo;
  }
}

/**
 * Standard grid slicing logic.
 */
export async function performGridSlice(
  geometry: THREE.BufferGeometry,
  bounds: THREE.Box3,
  config: SlicingConfig,
  connectors: ConnectorConfig,
  hollow: HollowConfig,
  labels: LabelConfig,
  baseName: string,
  onProgress: (msg: string) => void
): Promise<ModelPart[]> {
  const parts: ModelPart[] = [];
  const size = bounds.getSize(new THREE.Vector3());
  const min = bounds.min;

  const stepsX = Math.max(1, Math.ceil(size.x / config.printerX));
  const stepsY = Math.max(1, Math.ceil(size.y / config.printerY));
  const stepsZ = Math.max(1, Math.ceil(size.z / config.printerZ));

  const total = stepsX * stepsY * stepsZ;
  if (total > 500) throw new Error("Part count exceeds safety limit (500). Increase printer volume size.");

  let baseBrush = createBrush(geometry.clone());
  if (!baseBrush) throw new Error("Could not initialize geometry for CSG.");

  if (hollow.enabled) {
    onProgress("Hollowing Model...");
    await wait();
    baseBrush = await applyHollowing(baseBrush, bounds, hollow);
  }

  let current = 0;
  for (let ix = 0; ix < stepsX; ix++) {
    for (let iy = 0; iy < stepsY; iy++) {
      for (let iz = 0; iz < stepsZ; iz++) {
        current++;
        onProgress(`Slicing Fragment ${current}/${total}...`);
        await wait();

        const w = (ix === stepsX - 1) ? (size.x - ix * config.printerX) : config.printerX;
        const h = (iy === stepsY - 1) ? (size.y - iy * config.printerY) : config.printerY;
        const d = (iz === stepsZ - 1) ? (size.z - iz * config.printerZ) : config.printerZ;

        if (w < 0.1 || h < 0.1 || d < 0.1) continue;

        const boxGeo = new THREE.BoxGeometry(w, h, d);
        boxGeo.translate(
          min.x + ix * config.printerX + w / 2, 
          min.y + iy * config.printerY + h / 2, 
          min.z + iz * config.printerZ + d / 2
        );
        
        const boxBrush = createBrush(boxGeo);
        if (!boxBrush) continue;

        try {
          const res = evaluator.evaluate(baseBrush, boxBrush, INTERSECTION);
          if (res && res.geometry && res.geometry.attributes.position.count > 0) {
            let finalGeo = res.geometry;
            
            if (connectors.enabled) {
              finalGeo = await applyConnectors(finalGeo, ix, iy, iz, stepsX, stepsY, stepsZ, config, connectors, min);
            }

            if (labels.enabled) {
              finalGeo = await applyLabel(finalGeo, ix, iy, iz, labels);
            }

            parts.push({
              geometry: ensureValidForCSG(finalGeo),
              name: `${baseName}_P${ix}-${iy}-${iz}.stl`,
              index: [ix, iy, iz]
            });
          }
        } catch (err) {
          console.error(`Fragment ${current} processing failed:`, err);
        }
      }
    }
  }
  return parts;
}

/**
 * Custom manual slicing logic using defined split points.
 */
export async function performManualSlice(
  geometry: THREE.BufferGeometry,
  bounds: THREE.Box3,
  config: SlicingConfig,
  connectors: ConnectorConfig,
  hollow: HollowConfig,
  labels: LabelConfig,
  baseName: string,
  onProgress: (msg: string) => void
): Promise<ModelPart[]> {
    const size = bounds.getSize(new THREE.Vector3());
    const min = bounds.min;
    
    // Split distances
    const splitsX = config.showX ? [config.manualX, size.x - config.manualX] : [size.x];
    const splitsY = config.showY ? [config.manualY, size.y - config.manualY] : [size.y];
    const splitsZ = config.showZ ? [config.manualZ, size.z - config.manualZ] : [size.z];
    
    const parts: ModelPart[] = [];
    let baseBrush = createBrush(geometry.clone());
    if (!baseBrush) throw new Error("Geometry initialization failed.");

    if (hollow.enabled) {
        onProgress("Hollowing Model...");
        await wait();
        baseBrush = await applyHollowing(baseBrush, bounds, hollow);
    }

    let current = 0;
    let offsetX = 0;
    for (let ix = 0; ix < splitsX.length; ix++) {
        // FIX: Define w in correct scope
        const w = splitsX[ix];
        let offsetY = 0;
        for (let iy = 0; iy < splitsY.length; iy++) {
            // FIX: Define h in correct scope
            const h = splitsY[iy];
            let offsetZ = 0;
            for (let iz = 0; iz < splitsZ.length; iz++) {
                // FIX: Define d in correct scope
                const d = splitsZ[iz];
                current++;
                onProgress(`Cutting Fragment ${current}...`);
                await wait();

                if (w < 0.1 || h < 0.1 || d < 0.1) {
                    offsetZ += d;
                    continue;
                }

                const boxGeo = new THREE.BoxGeometry(w, h, d);
                boxGeo.translate(
                    min.x + offsetX + w / 2, 
                    min.y + offsetY + h / 2, 
                    min.z + offsetZ + d / 2
                );
                
                const boxBrush = createBrush(boxGeo);
                if (boxBrush) {
                    try {
                        const res = evaluator.evaluate(baseBrush, boxBrush, INTERSECTION);
                        if (res && res.geometry && res.geometry.attributes.position.count > 0) {
                            parts.push({
                                geometry: ensureValidForCSG(res.geometry),
                                name: `${baseName}_M${ix}-${iy}-${iz}.stl`,
                                index: [ix, iy, iz]
                            });
                        }
                    } catch (e) {
                        console.error("Manual cut failure:", e);
                    }
                }
                offsetZ += d;
            }
            offsetY += h;
        }
        offsetX += w;
    }
    return parts;
}
