
import React from 'react';
import { Layers, Scissors, Move, Box, Upload, Download, Trash2, Monitor, Database, Eye, Tag, Droplet, Layout } from 'lucide-react';
import { AppState, SlicingConfig, ConnectorConfig, HollowConfig, LabelConfig, ModelPart } from '../types';
import * as THREE from 'three';

interface SidebarProps {
  state: AppState;
  slicingConfig: SlicingConfig;
  connectorConfig: ConnectorConfig;
  hollowConfig: HollowConfig;
  labelConfig: LabelConfig;
  modelBounds: THREE.Box3 | null;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSlicingConfigChange: (c: SlicingConfig) => void;
  onConnectorConfigChange: (c: ConnectorConfig) => void;
  onHollowConfigChange: (c: HollowConfig) => void;
  onLabelConfigChange: (c: LabelConfig) => void;
  onSlice: () => void;
  onExportZip: () => void;
  onDownloadPart: (part: ModelPart) => void;
  onReset: () => void;
  onScale: (factor: number) => void;
  onViewModeChange: (mode: 'original' | 'split') => void;
  onSectionViewToggle: () => void;
}

type Unit = 'mm' | 'in' | 'ft';

const Sidebar: React.FC<SidebarProps> = ({
  state, slicingConfig, connectorConfig, hollowConfig, labelConfig, modelBounds,
  onFileUpload, onSlicingConfigChange, onConnectorConfigChange, onHollowConfigChange, onLabelConfigChange,
  onSlice, onExportZip, onDownloadPart, onReset, onScale, onViewModeChange, onSectionViewToggle
}) => {
  const [scaleVal, setScaleVal] = React.useState('');
  const [unit, setUnit] = React.useState<Unit>('mm');
  
  const applyScale = () => {
    if (!modelBounds || !scaleVal) return;
    
    let targetHeightMm = parseFloat(scaleVal);
    if (unit === 'in') targetHeightMm *= 25.4;
    else if (unit === 'ft') targetHeightMm *= 304.8;

    const currentHeight = modelBounds.max.y - modelBounds.min.y;
    if (currentHeight > 0) {
      onScale(targetHeightMm / currentHeight);
    }
  };

  const SectionHeader = ({ icon: Icon, title, color = "text-[#5B8CFF]" }: any) => (
    <div className="flex items-center gap-2 mb-4">
      <div className={`bg-[#5B8CFF]/10 p-1.5 rounded-lg border border-[#5B8CFF]/20`}>
        <Icon className={`w-3.5 h-3.5 ${color}`} />
      </div>
      <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">{title}</h3>
    </div>
  );

  const hasSlices = state.parts.length > 0;

  return (
    <div className="flex flex-col h-full custom-scroll overflow-y-auto p-6 gap-8">
      {/* Brand Header */}
      <div className="flex items-center gap-3 mb-2">
        <div className="bg-[#5B8CFF] w-9 h-9 rounded-xl flex items-center justify-center shadow-[0_0_20px_rgba(91,140,255,0.3)]">
          <Layers className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-sm font-bold tracking-tight text-white uppercase">Slice3D PRO</h1>
          <p className="text-[8px] text-[#2DE2E6] font-bold uppercase tracking-[0.3em]">Precision Core v2.5</p>
        </div>
      </div>

      {!state.isLoaded ? (
        <label className="group flex flex-col items-center justify-center h-48 border border-white/5 rounded-2xl cursor-pointer hover:bg-white/5 transition-all bg-white/[0.02]">
          <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
            <Upload className="w-5 h-5 text-slate-400" />
          </div>
          <span className="text-xs font-medium text-slate-300">Initialize STL Asset</span>
          <span className="text-[9px] text-slate-500 mt-1 uppercase tracking-widest">Local Processing Only</span>
          <input type="file" className="hidden" accept=".stl" onChange={onFileUpload} />
        </label>
      ) : (
        <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
          {/* File Asset Card */}
          <div className="cad-panel--soft p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 overflow-hidden">
                <Database className="w-3.5 h-3.5 text-[#5B8CFF] shrink-0" />
                <span className="text-[11px] font-medium truncate text-slate-200">{state.fileName}</span>
              </div>
              <button onClick={onReset} className="text-slate-500 hover:text-red-400 transition-colors p-1">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            {modelBounds && (
              <div className="grid grid-cols-3 gap-2 pt-2 border-t border-white/5">
                {[
                  { l: 'X', v: (modelBounds.max.x - modelBounds.min.x).toFixed(1) },
                  { l: 'Y', v: (modelBounds.max.y - modelBounds.min.y).toFixed(1) },
                  { l: 'Z', v: (modelBounds.max.z - modelBounds.min.z).toFixed(1) }
                ].map(d => (
                  <div key={d.l} className="flex flex-col">
                    <span className="text-[9px] text-slate-500 font-bold">{d.l} DIM</span>
                    <span className="text-[11px] font-mono text-slate-200">{d.v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Scaling Section */}
          <section>
            <SectionHeader icon={Move} title="Scaling & Geometry" />
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <input 
                  type="number" 
                  placeholder={`Height (${unit})`}
                  className="cad-input text-xs"
                  value={scaleVal}
                  onChange={(e) => setScaleVal(e.target.value)}
                />
                <select 
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as Unit)}
                  className="bg-slate-900 border border-white/10 rounded-xl px-2 text-[10px] font-bold text-slate-300 uppercase focus:outline-none"
                >
                  <option value="mm">mm</option>
                  <option value="in">in</option>
                  <option value="ft">ft</option>
                </select>
              </div>
              <button onClick={applyScale} className="bg-white/5 hover:bg-white/10 border border-white/10 py-2.5 rounded-xl text-[9px] uppercase tracking-widest font-bold text-slate-200 transition-all active:scale-95">
                Rescale Asset
              </button>
            </div>
          </section>

          {/* Hollowing & Walls */}
          <section className="space-y-4 pt-4 border-t border-white/5">
            <div className="flex items-center justify-between">
              <SectionHeader icon={Droplet} title="Hollowing & Walls" color="text-[#A5B4FC]" />
              <input type="checkbox" className="accent-[#A5B4FC]" checked={hollowConfig.enabled} onChange={(e) => onHollowConfigChange({ ...hollowConfig, enabled: e.target.checked })} />
            </div>
            {hollowConfig.enabled && (
              <div className="flex flex-col gap-4 bg-white/[0.03] p-3 rounded-xl border border-white/5">
                <div className="flex flex-col gap-1">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-[9px] text-slate-500 font-bold uppercase">Wall Thickness</span>
                    <span className="text-[10px] text-indigo-300 font-mono">{hollowConfig.wallThickness}mm</span>
                  </div>
                  <input 
                    type="range" min="0.5" max="10" step="0.5" 
                    value={hollowConfig.wallThickness} 
                    onChange={(e) => onHollowConfigChange({ ...hollowConfig, wallThickness: parseFloat(e.target.value) })}
                    className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-indigo-400"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-slate-500 font-bold uppercase">Drain Holes</span>
                    <input type="checkbox" className="accent-indigo-400 w-3 h-3" checked={hollowConfig.drainHoleEnabled} onChange={(e) => onHollowConfigChange({ ...hollowConfig, drainHoleEnabled: e.target.checked })} />
                  </div>
                  {hollowConfig.drainHoleEnabled && (
                    <input 
                      type="number" 
                      className="bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-[10px] text-white focus:outline-none w-14 text-right"
                      value={hollowConfig.drainHoleDiameter}
                      onChange={(e) => onHollowConfigChange({ ...hollowConfig, drainHoleDiameter: Math.max(1, parseFloat(e.target.value) || 1) })}
                    />
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Slicing Logic */}
          <section>
            <SectionHeader icon={Scissors} title="Slicing Parameters" />
            <div className="flex bg-black/40 rounded-xl p-1 mb-4 border border-white/5">
              <button 
                onClick={() => onSlicingConfigChange({ ...slicingConfig, mode: 'grid' })}
                className={`flex-1 py-2 text-[9px] uppercase font-bold tracking-widest rounded-lg transition-all ${slicingConfig.mode === 'grid' ? 'bg-[#5B8CFF] text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
              >Grid</button>
              <button 
                onClick={() => onSlicingConfigChange({ ...slicingConfig, mode: 'manual' })}
                className={`flex-1 py-2 text-[9px] uppercase font-bold tracking-widest rounded-lg transition-all ${slicingConfig.mode === 'manual' ? 'bg-[#5B8CFF] text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
              >Manual</button>
            </div>

            <div className="space-y-4">
              {slicingConfig.mode === 'grid' ? (
                <div className="grid grid-cols-1 gap-3">
                  {['printerX', 'printerY', 'printerZ'].map((k) => (
                    <div key={k} className="flex items-center justify-between gap-4">
                      <label className="text-[10px] uppercase font-bold text-slate-500 tracking-tighter">{k.replace('printer', 'Volume ')}</label>
                      <input 
                        type="number" 
                        className="bg-black/20 border border-white/5 rounded-lg px-2 py-1.5 text-[11px] w-20 text-right focus:outline-none text-white font-mono"
                        value={(slicingConfig as any)[k]}
                        onChange={(e) => onSlicingConfigChange({ ...slicingConfig, [k]: Math.max(1, parseFloat(e.target.value) || 1) })}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-4">
                  {['X', 'Y', 'Z'].map(axis => {
                    const showKey = `show${axis}` as keyof SlicingConfig;
                    const valKey = `manual${axis}` as keyof SlicingConfig;
                    const max = modelBounds ? (modelBounds.max as any)[axis.toLowerCase()] - (modelBounds.min as any)[axis.toLowerCase()] : 100;
                    return (
                      <div key={axis} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="text-[10px] uppercase font-bold text-slate-500">{axis}-Axis Split</label>
                          <input 
                            type="checkbox" 
                            className="w-3.5 h-3.5 rounded border-white/10 bg-white/5"
                            checked={!!slicingConfig[showKey]} 
                            onChange={(e) => onSlicingConfigChange({ ...slicingConfig, [showKey]: e.target.checked })} 
                          />
                        </div>
                        <input 
                          type="range" min="0" max={max} step="0.5" 
                          disabled={!slicingConfig[showKey]}
                          value={(slicingConfig as any)[valKey]} 
                          onChange={(e) => onSlicingConfigChange({ ...slicingConfig, [valKey]: parseFloat(e.target.value) })}
                          className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#5B8CFF]"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          {/* Connectors Section */}
          <section className="space-y-4 pt-4 border-t border-white/5">
            <div className="flex items-center justify-between">
              <SectionHeader icon={Box} title="Connectors" color="text-[#2DE2E6]" />
              <input type="checkbox" className="accent-[#2DE2E6]" checked={connectorConfig.enabled} onChange={(e) => onConnectorConfigChange({ ...connectorConfig, enabled: e.target.checked })} />
            </div>
            {connectorConfig.enabled && (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { l: 'Diameter', k: 'diameter' },
                    { l: 'Length', k: 'length' },
                    { l: 'Gap Tol', k: 'tolerance' },
                    { l: 'Spacing', k: 'spacing' }
                  ].map(i => (
                    <div key={i.k} className="flex flex-col gap-1">
                      <span className="text-[9px] text-slate-500 font-bold uppercase">{i.l}</span>
                      <input 
                        type="number" 
                        className="bg-black/20 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] text-white focus:outline-none font-mono"
                        value={(connectorConfig as any)[i.k]}
                        onChange={(e) => onConnectorConfigChange({ ...connectorConfig, [i.k]: Math.max(0.1, parseFloat(e.target.value) || 0.1) })}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Labels Section */}
          <section className="space-y-4 pt-4 border-t border-white/5">
            <div className="flex items-center justify-between">
              <SectionHeader icon={Tag} title="Physical Labels" color="text-[#FF4D6D]" />
              <input type="checkbox" className="accent-[#FF4D6D]" checked={labelConfig.enabled} onChange={(e) => onLabelConfigChange({ ...labelConfig, enabled: e.target.checked })} />
            </div>
            {labelConfig.enabled && (
              <div className="grid grid-cols-2 gap-3">
                   <div className="flex flex-col gap-1">
                      <span className="text-[9px] text-slate-500 font-bold uppercase">Plate Size</span>
                      <input 
                        type="number" 
                        className="bg-black/20 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] text-white focus:outline-none"
                        value={labelConfig.plateSize}
                        onChange={(e) => onLabelConfigChange({ ...labelConfig, plateSize: parseFloat(e.target.value) || 1 })}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[9px] text-slate-500 font-bold uppercase">Thick</span>
                      <input 
                        type="number" 
                        className="bg-black/20 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] text-white focus:outline-none"
                        value={labelConfig.thickness}
                        onChange={(e) => onLabelConfigChange({ ...labelConfig, thickness: parseFloat(e.target.value) || 0.1 })}
                      />
                    </div>
              </div>
            )}
          </section>

          {/* Visualization Controls */}
          <section className="pt-4 border-t border-white/5">
            <SectionHeader icon={Monitor} title="View Options" color="text-amber-400" />
            <div className="space-y-4">
              <div className="flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase tracking-tighter">
                <span>Explode Factor</span>
                <span className="text-[#5B8CFF] font-mono">{slicingConfig.explodeFactor.toFixed(1)}x</span>
              </div>
              <input 
                type="range" min="0" max="2" step="0.1" 
                value={slicingConfig.explodeFactor} 
                onChange={(e) => onSlicingConfigChange({ ...slicingConfig, explodeFactor: parseFloat(e.target.value) })}
                className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#5B8CFF]"
              />
              <div className="grid grid-cols-2 gap-2">
                <button 
                  onClick={() => onViewModeChange('original')}
                  className={`py-2 text-[9px] font-bold uppercase tracking-widest rounded-xl border border-white/5 ${state.viewMode === 'original' ? 'bg-white/10 text-white shadow-inner' : 'text-slate-500 hover:text-slate-400'}`}
                >Asset</button>
                <button 
                  onClick={() => {
                    if (hasSlices) onViewModeChange('split');
                  }}
                  disabled={!hasSlices}
                  className={`py-2 text-[9px] font-bold uppercase tracking-widest rounded-xl border border-white/5 transition-all ${state.viewMode === 'split' ? 'bg-[#5B8CFF] text-white shadow-lg' : hasSlices ? 'text-slate-500 hover:text-slate-400' : 'text-slate-700 cursor-not-allowed opacity-50'}`}
                >Split</button>
                <button 
                  onClick={onSectionViewToggle}
                  className={`col-span-2 py-2.5 text-[9px] font-bold uppercase tracking-widest rounded-xl border border-white/5 flex items-center justify-center gap-2 transition-all ${state.sectionView ? 'bg-amber-500/20 text-amber-400 border-amber-500/30' : 'text-slate-500 hover:text-slate-400'}`}
                >
                  <Layout className="w-3.5 h-3.5" />
                  {state.sectionView ? 'Close Section' : 'Inspect Interior'}
                </button>
              </div>
            </div>
          </section>

          {/* Primary Actions */}
          <div className="mt-8 flex flex-col gap-3 pb-8">
            <button 
              onClick={onSlice}
              className="cad-btn"
            >
              <Scissors className="w-4 h-4" /> 
              <span className="text-[11px] uppercase tracking-[0.2em]">Generate Slices</span>
            </button>
            
            {state.parts.length > 0 && (
              <button 
                onClick={onExportZip}
                className="bg-white/5 hover:bg-white/10 text-slate-300 font-bold py-4 rounded-2xl transition-all flex items-center justify-center gap-3 border border-white/10"
              >
                <Download className="w-4 h-4" />
                <span className="text-[11px] uppercase tracking-[0.2em]">Export ZIP Package</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default Sidebar;
