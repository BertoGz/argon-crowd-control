export type ScenarioMode = 'repel' | 'attract';

export interface Vec2 {
  x: number;
  z: number;
}

export interface TipPoint {
  x: number;
  z: number;
  mode: ScenarioMode;
  label: string;
  intensity: number; // 0.5 to 2.0
  radius: number;    // effective radius in meters
}

export interface BarrierIntervention {
  id: string;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  kind: 'wave_breaker' | 'funnel_wall' | 'chicane';
  reason?: string;
}

export interface BeaconIntervention {
  id: string;
  x: number;
  z: number;
  targetX: number;
  targetZ: number;
  radius: number;
  label: string;
  kind: 'exit_signage' | 'dispersion_attractor';
}

export interface VenueGate {
  id: 'north_main' | 'south_aux' | 'east_stage' | 'west_emergency';
  name: string;
  x: number;
  z: number;
  width: number;
  normalX: number;
  normalZ: number;
  isOpen: boolean;
}

export interface PhysicalInterventionPlan {
  barriers: BarrierIntervention[];
  beacons: BeaconIntervention[];
  openGates: ('north_main' | 'south_aux' | 'east_stage' | 'west_emergency')[];
}

export interface CrowdAgent {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  desiredSpeed: number;
  radius: number;
  panic: number;           // 0 (calm) to 1 (extreme panic/herding)
  crushPressure: number;   // kN/m physical compression force
  localDensity: number;    // people per m^2
  evacuated: boolean;
  satisfiedAttract: boolean;
  targetGateId: string | null;
  guidedByBeaconId: string | null;
}

export interface PassCriteriaConfig {
  maxCrushPressure: number; // kN/m threshold (e.g. 2.0 strict to 5.5 lenient, default 3.8)
  minSafetyScore: number;   // 0 - 100 minimum safety score to pass (default 80)
}

export interface SimulationMetrics {
  elapsedSeconds: number;
  totalAgents: number;
  activeAgents: number;
  evacuatedCount: number;
  reachedTargetCount: number;
  peakCrushPressure: number;     // kN/m (> 4.5 kN/m is lethal crowd crush threshold)
  currentMaxPressure: number;
  crushPocketEvents: number;     // cumulative frame-seconds where agents exceed critical pressure
  criticalAgentCount: number;    // agents currently experiencing > 3.8 kN/m
  avgPanic: number;
  flowEfficiency: number;        // 0 - 100%
  jammingDetected: boolean;
  hotspotCoords: Vec2 | null;
}

export interface CCTVFrameCapture {
  frameIndex: number;
  timestampSimSec: number;
  dataUrl: string; // Base64 PNG from CCTV virtual camera
  cameraLabel: string;
}

export interface ArgonVisualCritique {
  iteration: number;
  timestamp: string;
  modelUsed: string;
  isLiveApiCall: boolean;
  executionLog: string;
  latencyMs: number;
  scenarioSuccess: boolean;
  safetyScore: number; // 0 to 100
  observedCrowdBehavior: string;
  detectedBottlenecks: string[];
  rootCauseDiagnosis: string;
  interventionReasoning: string;
  proposedPlan: PhysicalInterventionPlan;
  cctvFramesSent: CCTVFrameCapture[];
  metricsAtEvaluation: SimulationMetrics;
}

export interface PresetScenario {
  id: string;
  title: string;
  subtitle: string;
  mode: ScenarioMode;
  description: string;
  tip: TipPoint;
  initialGates: ('north_main' | 'south_aux' | 'east_stage' | 'west_emergency')[];
  agentCount: number;
}
