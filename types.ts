
import * as THREE from 'three';

export interface SlicingConfig {
  mode: 'grid' | 'manual';
  printerX: number;
  printerY: number;
  printerZ: number;
  manualX: number;
  manualY: number;
  manualZ: number;
  showX: boolean;
  showY: boolean;
  showZ: boolean;
  explodeFactor: number;
}

export interface ConnectorConfig {
  enabled: boolean;
  diameter: number;
  length: number;
  tolerance: number;
  spacing: number;
  edgeMargin: number;
  showInPreview: boolean;
}

export interface HollowConfig {
  enabled: boolean;
  wallThickness: number;
  drainHoleEnabled: boolean;
  drainHoleDiameter: number;
}

export interface LabelConfig {
  enabled: boolean;
  plateSize: number;
  thickness: number;
  showInPreview: boolean;
}

export interface ModelPart {
  geometry: THREE.BufferGeometry;
  name: string;
  index: [number, number, number];
}

export interface AppState {
  isLoaded: boolean;
  fileName: string;
  parts: ModelPart[];
  isProcessing: boolean;
  progressMessage: string;
  viewMode: 'original' | 'split';
  sectionView: boolean;
}
