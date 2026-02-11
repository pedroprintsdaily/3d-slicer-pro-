
import * as THREE from 'three';
import React, { useEffect, useRef } from 'react';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SlicingConfig, ModelPart, ConnectorConfig, LabelConfig } from '../types';

interface ViewerProps {
  mesh: THREE.Mesh | null;
  parts: ModelPart[];
  slicingConfig: SlicingConfig;
  connectorConfig: ConnectorConfig;
  labelConfig: LabelConfig;
  modelBounds: THREE.Box3 | null;
  viewMode: 'original' | 'split';
  sectionView: boolean;
}

const Viewer: React.FC<ViewerProps> = ({ mesh, parts, slicingConfig, connectorConfig, labelConfig, modelBounds, viewMode, sectionView }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  
  const meshGroupRef = useRef<THREE.Group>(new THREE.Group());
  const guideGroupRef = useRef<THREE.Group>(new THREE.Group());
  const connectorPreviewRef = useRef<THREE.Group>(new THREE.Group());
  const labelGroupRef = useRef<THREE.Group>(new THREE.Group());

  useEffect(() => {
    if (!containerRef.current) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(40, containerRef.current.clientWidth / containerRef.current.clientHeight, 1, 100000);
    camera.position.set(500, 500, 500);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = true;
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controlsRef.current = controls;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x112233, 1.0);
    scene.add(hemi);

    const mainLight = new THREE.DirectionalLight(0xffffff, 1.2);
    mainLight.position.set(1000, 2000, 1000);
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 2048;
    mainLight.shadow.mapSize.height = 2048;
    scene.add(mainLight);

    const fillLight = new THREE.DirectionalLight(0x5B8CFF, 0.6);
    fillLight.position.set(-1000, 500, -1000);
    scene.add(fillLight);

    const grid = new THREE.GridHelper(5000, 50, 0x334155, 0x1e293b);
    grid.position.y = -1;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.1;
    scene.add(grid);

    scene.add(meshGroupRef.current);
    scene.add(guideGroupRef.current);
    scene.add(connectorPreviewRef.current);
    scene.add(labelGroupRef.current);

    const animate = () => {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!containerRef.current || !camera || !renderer) return;
      camera.aspect = containerRef.current.clientWidth / containerRef.current.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
      if (containerRef.current && renderer.domElement) {
        containerRef.current.removeChild(renderer.domElement);
      }
    };
  }, []);

  const createLabelSprite = (text: string) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return new THREE.Sprite();
    canvas.width = 512; canvas.height = 128;
    ctx.fillStyle = 'rgba(11, 15, 20, 0.95)';
    ctx.roundRect(0, 0, 512, 128, 16);
    ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = '#5B8CFF'; ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 64px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 64);
    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.scale.set(60, 15, 1);
    return sprite;
  };

  useEffect(() => {
    if (!meshGroupRef.current || !labelGroupRef.current || !connectorPreviewRef.current || !modelBounds) return;
    
    const clearGroup = (group: THREE.Group) => {
      group.children.forEach(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
      });
      group.clear();
    };

    clearGroup(meshGroupRef.current);
    clearGroup(labelGroupRef.current);
    clearGroup(connectorPreviewRef.current);

    const center = modelBounds.getCenter(new THREE.Vector3());
    const clippingPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), center.y);
    const planes = sectionView ? [clippingPlane] : [];

    if (viewMode === 'split' && parts.length > 0) {
      const maxIdx = parts.reduce((acc, pt) => [
        Math.max(acc[0], pt.index[0]),
        Math.max(acc[1], pt.index[1]),
        Math.max(acc[2], pt.index[2])
      ], [0,0,0]);
      
      const midX = maxIdx[0] / 2;
      const midY = maxIdx[1] / 2;
      const midZ = maxIdx[2] / 2;

      const modelSize = modelBounds.getSize(new THREE.Vector3());
      const explosionMultiplier = 1.0 * slicingConfig.explodeFactor;
      
      parts.forEach((p) => {
        const mat = new THREE.MeshStandardMaterial({ 
          color: 0x475569, roughness: 0.15, metalness: 0.85,
          clippingPlanes: planes,
          clipShadows: true,
          side: THREE.DoubleSide
        });
        const partMesh = new THREE.Mesh(p.geometry, mat);
        partMesh.castShadow = true;
        partMesh.receiveShadow = true;
        
        const [idxX, idxY, idxZ] = p.index;
        const offset = new THREE.Vector3(
          (idxX - midX) * modelSize.x * explosionMultiplier,
          (idxY - midY) * modelSize.y * explosionMultiplier,
          (idxZ - midZ) * modelSize.z * explosionMultiplier
        );

        partMesh.position.copy(offset);
        meshGroupRef.current?.add(partMesh);

        const pBounds = new THREE.Box3().setFromObject(partMesh);
        const pCenter = pBounds.getCenter(new THREE.Vector3());

        const labelSprite = createLabelSprite(`P ${idxX}-${idxY}-${idxZ}`);
        labelSprite.position.set(pCenter.x, pBounds.max.y + 15, pCenter.z);
        labelGroupRef.current?.add(labelSprite);

        if (labelConfig.enabled && labelConfig.showInPreview) {
          const tH = labelConfig.thickness;
          const plateGeo = new THREE.BoxGeometry(labelConfig.plateSize, tH, labelConfig.plateSize / 2);
          const plateMat = new THREE.MeshStandardMaterial({ color: 0x2DE2E6, emissive: 0x2DE2E6, emissiveIntensity: 0.3 });
          const plateMesh = new THREE.Mesh(plateGeo, plateMat);
          plateMesh.position.set(pCenter.x, pBounds.min.y + tH / 2, pCenter.z);
          labelGroupRef.current?.add(plateMesh);
        }

        if (connectorConfig.enabled && connectorConfig.showInPreview) {
          const spacing = Math.max(5, connectorConfig.spacing);
          const margin = connectorConfig.edgeMargin;
          const pVolX = slicingConfig.printerX, pVolY = slicingConfig.printerY, pVolZ = slicingConfig.printerZ;

          const drawConnector = (facePos: THREE.Vector3, axis: 'x'|'y'|'z', isPeg: boolean, faceW: number, faceH: number) => {
            const r = isPeg ? connectorConfig.diameter / 2 : (connectorConfig.diameter / 2) + connectorConfig.tolerance;
            const h = connectorConfig.length;
            const cylGeo = new THREE.CylinderGeometry(r, r, h, 16);
            if (axis === 'x') cylGeo.rotateZ(Math.PI / 2);
            else if (axis === 'z') cylGeo.rotateX(Math.PI / 2);

            const cylMat = isPeg 
              ? new THREE.MeshStandardMaterial({ color: 0x2DE2E6, emissive: 0x2DE2E6, emissiveIntensity: 0.5 }) 
              : new THREE.MeshStandardMaterial({ color: 0xFF4D6D, transparent: true, opacity: 0.3, wireframe: true });

            const countH = Math.max(0, Math.floor((faceW - margin * 2) / spacing));
            const countV = Math.max(0, Math.floor((faceH - margin * 2) / spacing));

            for (let dh = 0; dh <= countH; dh++) {
              for (let dv = 0; dv <= countV; dv++) {
                const hOff = (dh * spacing) - (countH * spacing) / 2;
                const vOff = (dv * spacing) - (countV * spacing) / 2;
                const cMesh = new THREE.Mesh(cylGeo, cylMat);
                cMesh.position.copy(facePos);
                if (axis === 'x') cMesh.position.add(new THREE.Vector3(0, vOff, hOff));
                else if (axis === 'y') cMesh.position.add(new THREE.Vector3(hOff, 0, vOff));
                else cMesh.position.add(new THREE.Vector3(hOff, vOff, 0));
                connectorPreviewRef.current?.add(cMesh);
              }
            }
          };

          const bMin = pBounds.min, bMax = pBounds.max;
          if (idxX < maxIdx[0]) drawConnector(new THREE.Vector3(bMax.x, pCenter.y, pCenter.z), 'x', true, pVolZ, pVolY);
          if (idxX > 0) drawConnector(new THREE.Vector3(bMin.x, pCenter.y, pCenter.z), 'x', false, pVolZ, pVolY);
          if (idxY < maxIdx[1]) drawConnector(new THREE.Vector3(pCenter.x, bMax.y, pCenter.z), 'y', true, pVolX, pVolZ);
          if (idxY > 0) drawConnector(new THREE.Vector3(pCenter.x, bMin.y, pCenter.z), 'y', false, pVolX, pVolZ);
          if (idxZ < maxIdx[2]) drawConnector(new THREE.Vector3(pCenter.x, pCenter.y, bMax.z), 'z', true, pVolX, pVolY);
          if (idxZ > 0) drawConnector(new THREE.Vector3(pCenter.x, pCenter.y, bMin.z), 'z', false, pVolX, pVolY);
        }
      });
    } else if (mesh) {
      const originalMat = new THREE.MeshStandardMaterial({ 
        color: 0x334155, roughness: 0.3, metalness: 0.8,
        clippingPlanes: planes,
        clipShadows: true,
        side: THREE.DoubleSide
      });
      const visualMesh = new THREE.Mesh(mesh.geometry, originalMat);
      meshGroupRef.current.add(visualMesh);
      if (modelBounds && controlsRef.current) {
        const centerPos = modelBounds.getCenter(new THREE.Vector3());
        controlsRef.current.target.lerp(centerPos, 0.1);
      }
    }
  }, [mesh, parts, viewMode, slicingConfig.explodeFactor, modelBounds, labelConfig, connectorConfig, slicingConfig.printerX, slicingConfig.printerY, slicingConfig.printerZ, sectionView]);

  return <div ref={containerRef} className="w-full h-full cursor-move" />;
};

export default Viewer;
