
import React, { useState, useRef, useEffect } from 'react';
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import JSZip from 'jszip';
import Viewer from './components/Viewer';
import Sidebar from './components/Sidebar';
import { SlicingConfig, ConnectorConfig, HollowConfig, LabelConfig, AppState, ModelPart } from './types';
import { performGridSlice, performManualSlice } from './services/csgService';

const App: React.FC = () => {
  const [state, setState] = useState<AppState>({
    isLoaded: true,
    fileName: 'Industrial_Housing_V2.stl',
    parts: [],
    isProcessing: false,
    progressMessage: '',
    viewMode: 'original',
    sectionView: false
  });

  const [slicingConfig, setSlicingConfig] = useState<SlicingConfig>({
    mode: 'grid',
    printerX: 120,
    printerY: 120,
    printerZ: 120,
    manualX: 60,
    manualY: 60,
    manualZ: 60,
    showX: false,
    showY: false,
    showZ: false,
    explodeFactor: 0.5
  });

  const [connectorConfig, setConnectorConfig] = useState<ConnectorConfig>({
    enabled: true,
    diameter: 6,
    length: 12,
    tolerance: 0.3,
    spacing: 50,
    edgeMargin: 15,
    showInPreview: true
  });

  const [hollowConfig, setHollowConfig] = useState<HollowConfig>({
    enabled: false,
    wallThickness: 2.5,
    drainHoleEnabled: true,
    drainHoleDiameter: 8
  });

  const [labelConfig, setLabelConfig] = useState<LabelConfig>({
    enabled: true,
    plateSize: 15,
    thickness: 2,
    showInPreview: true
  });

  const meshRef = useRef<THREE.Mesh | null>(null);
  const [modelBounds, setModelBounds] = useState<THREE.Box3 | null>(new THREE.Box3(
    new THREE.Vector3(-100, 0, -100),
    new THREE.Vector3(100, 200, 100)
  ));

  useEffect(() => {
    const generateDemo = () => {
      const demoParts: ModelPart[] = [];
      const partSize = 100;
      for (let x = 0; x < 2; x++) {
        for (let y = 0; y < 2; y++) {
          for (let z = 0; z < 2; z++) {
            const geo = new THREE.BoxGeometry(partSize, partSize, partSize);
            geo.translate(-50 + x * partSize, 50 + y * partSize, -50 + z * partSize);
            demoParts.push({ geometry: geo, name: `Demo_P${x}-${y}-${z}.stl`, index: [x, y, z] });
          }
        }
      }
      const mainGeo = new THREE.BoxGeometry(200, 200, 200);
      mainGeo.translate(0, 100, 0);
      meshRef.current = new THREE.Mesh(mainGeo, new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.3, metalness: 0.8 }));
      setState(prev => ({ ...prev, parts: demoParts, isLoaded: true, viewMode: 'split' }));
    };
    generateDemo();
  }, []);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setState(prev => ({ ...prev, isProcessing: true, progressMessage: 'Parsing Geometry...' }));
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        const loader = new STLLoader();
        const rawGeometry = loader.parse(arrayBuffer);
        const geometry = BufferGeometryUtils.mergeVertices(rawGeometry);
        geometry.computeVertexNormals();
        geometry.center();
        geometry.computeBoundingBox();
        const bounds = geometry.boundingBox!;
        geometry.translate(0, -bounds.min.y, 0); 
        geometry.computeBoundingBox();
        meshRef.current = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.3, metalness: 0.8 }));
        setModelBounds(geometry.boundingBox!.clone());
        setState(prev => ({ ...prev, isLoaded: true, fileName: file.name, isProcessing: false, parts: [], viewMode: 'original' }));
      } catch (err: any) {
        alert(`Failed to parse STL file: ${err.message || String(err)}`);
        setState(prev => ({ ...prev, isProcessing: false }));
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleSlicing = async () => {
    if (!meshRef.current || !modelBounds) return;
    setState(prev => ({ ...prev, isProcessing: true, progressMessage: 'Industrial CSG Engine Online...' }));
    try {
      let resultParts: ModelPart[] = [];
      const baseName = state.fileName.replace('.stl', '');
      if (slicingConfig.mode === 'grid') {
        resultParts = await performGridSlice(meshRef.current.geometry, modelBounds, slicingConfig, connectorConfig, hollowConfig, labelConfig, baseName, (msg) => setState(prev => ({ ...prev, progressMessage: msg })));
      } else {
        resultParts = await performManualSlice(meshRef.current.geometry, modelBounds, slicingConfig, connectorConfig, hollowConfig, labelConfig, baseName, (msg) => setState(prev => ({ ...prev, progressMessage: msg })));
      }
      setState(prev => ({ ...prev, parts: resultParts, isProcessing: false, viewMode: 'split' }));
    } catch (err: any) {
      alert(`Slicing encountered an error: ${err.message || String(err)}`);
      setState(prev => ({ ...prev, isProcessing: false }));
    }
  };

  const exportZip = async () => {
    if (state.parts.length === 0) return;
    setState(prev => ({ ...prev, isProcessing: true, progressMessage: 'Packaging Production Files...' }));
    try {
      const zip = new JSZip();
      const exporter = new STLExporter();
      state.parts.forEach(p => {
        const stl = exporter.parse(new THREE.Mesh(p.geometry), { binary: true });
        zip.file(p.name, stl);
      });
      const content = await zip.generateAsync({ type: 'blob' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(content);
      link.download = `${state.fileName.replace('.stl', '')}_package.zip`;
      link.click();
    } catch (err: any) {
      alert(`Failed to export ZIP: ${err.message || String(err)}`);
    } finally {
      setState(prev => ({ ...prev, isProcessing: false }));
    }
  };

  return (
    <div className="flex h-screen w-full bg-[#0a0c10] text-slate-100 overflow-hidden font-inter">
      <div className="w-[340px] border-r border-white/5 z-20 flex flex-col glass-panel shadow-2xl relative overflow-hidden">
        <Sidebar 
          state={state} 
          slicingConfig={slicingConfig} 
          connectorConfig={connectorConfig} 
          hollowConfig={hollowConfig}
          labelConfig={labelConfig} 
          modelBounds={modelBounds}
          onFileUpload={handleFileUpload} 
          onSlicingConfigChange={setSlicingConfig} 
          onConnectorConfigChange={setConnectorConfig} 
          onHollowConfigChange={setHollowConfig}
          onLabelConfigChange={setLabelConfig}
          onSlice={handleSlicing} 
          onExportZip={exportZip} 
          onDownloadPart={(p) => {
            const exporter = new STLExporter();
            const stl = exporter.parse(new THREE.Mesh(p.geometry), { binary: true });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(new Blob([stl], { type: 'application/octet-stream' }));
            link.download = p.name;
            link.click();
          }}
          onReset={() => setState(prev => ({ ...prev, parts: [], isLoaded: false, viewMode: 'original' }))}
          onScale={(factor) => {
            if (meshRef.current) {
              meshRef.current.geometry.scale(factor, factor, factor);
              meshRef.current.geometry.computeBoundingBox();
              setModelBounds(meshRef.current.geometry.boundingBox!.clone());
              setState(prev => ({ ...prev, parts: [], viewMode: 'original' }));
            }
          }}
          onViewModeChange={(mode) => setState(prev => ({ ...prev, viewMode: mode }))}
          onSectionViewToggle={() => setState(prev => ({ ...prev, sectionView: !prev.sectionView }))}
        />
      </div>
      <div className="flex-1 relative cad-viewport">
        <Viewer 
          mesh={meshRef.current} 
          parts={state.parts} 
          slicingConfig={slicingConfig} 
          connectorConfig={connectorConfig} 
          labelConfig={labelConfig}
          modelBounds={modelBounds} 
          viewMode={state.viewMode} 
          sectionView={state.sectionView}
        />
        {state.isProcessing && (
          <div className="absolute inset-0 z-50 bg-[#0a0c10]/80 backdrop-blur-lg flex flex-col items-center justify-center">
            <div className="w-16 h-16 border-2 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin mb-8"></div>
            <p className="text-sm font-medium tracking-[0.2em] text-white uppercase">{state.progressMessage}</p>
          </div>
        )}
        <div className="absolute bottom-6 right-6 flex flex-col items-end gap-2 pointer-events-none">
          <div className="glass-panel px-4 py-2 rounded-lg border border-white/5 flex items-center gap-3">
            <span className="text-[9px] uppercase tracking-[0.2em] text-slate-500 font-bold">Engine Status</span>
            <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]"></div>
            <span className="text-[10px] font-mono text-slate-300 uppercase">Production Ready</span>
          </div>
          <div className="glass-panel px-4 py-2 rounded-lg border border-white/5">
             <span className="text-[9px] uppercase tracking-[0.2em] text-slate-500 font-bold mr-3">Active Slices</span>
             <span className="text-xs font-mono text-indigo-400 font-bold">{state.parts.length}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
