import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  Camera,
  CheckCircle2,
  ChevronRight,
  Code2,
  DoorOpen,
  Flame,
  KeyRound,
  Layers,
  Loader2,
  Magnet,
  Pause,
  Play,
  Radio,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Video,
} from 'lucide-react';
import {
  CrowdSimulationEngine,
  PRESET_SCENARIOS,
} from './engine/crowdPhysics';
import { Venue3DViewport } from './components/Venue3DViewport';
import {
  analyzeCCTVFramesWithArgon,
  buildZeroCheatVisualPrompt,
} from './services/argonVisionLoop';
import type {
  ArgonVisualCritique,
  CCTVFrameCapture,
  PhysicalInterventionPlan,
  PresetScenario,
  SimulationMetrics,
  TipPoint,
} from './types/simulation';

const CAPTURE_TIMESTAMPS = [1.5, 3.5, 5.5, 7.5];

export function App() {
  const [activePreset, setActivePreset] = useState<PresetScenario>(PRESET_SCENARIOS[0]);
  const [activeTip, setActiveTip] = useState<TipPoint>(() => ({ ...PRESET_SCENARIOS[0].tip }));
  const engineRef = useRef<CrowdSimulationEngine>(new CrowdSimulationEngine(PRESET_SCENARIOS[0]));
  const cctvPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [isRunning, setIsRunning] = useState<boolean>(true);
  const [simSpeed, setSimSpeed] = useState<number>(1.25);
  const [cameraPreset, setCameraPreset] = useState<'isometric' | 'topdown' | 'angled'>('isometric');

  const [metrics, setMetrics] = useState<SimulationMetrics>({
    elapsedSeconds: 0,
    totalAgents: PRESET_SCENARIOS[0].agentCount,
    activeAgents: PRESET_SCENARIOS[0].agentCount,
    evacuatedCount: 0,
    reachedTargetCount: 0,
    peakCrushPressure: 0,
    currentMaxPressure: 0,
    peakLocalDensity: 0,
    crushPocketEvents: 0,
    criticalAgentCount: 0,
    avgPanic: 0.4,
    flowEfficiency: 100,
    jammingDetected: false,
    hotspotCoords: null,
  });
  const [currentPlan, setCurrentPlan] = useState<PhysicalInterventionPlan>({
    barriers: [],
    beacons: [],
    openGates: [...PRESET_SCENARIOS[0].initialGates],
  });

  // Closed-Loop Verification State
  const [isAutoLoopActive, setIsAutoLoopActive] = useState<boolean>(false);
  const isAutoLoopActiveRef = useRef<boolean>(false);

  // Single-step queued review state (waits for 4 CCTV frames after "Critique Now" or "Apply Fix")
  const [isAwaiting4Frames, setIsAwaiting4Frames] = useState<boolean>(false);
  const isAwaiting4FramesRef = useRef<boolean>(false);

  const [isAnalyzingCCTV, setIsAnalyzingCCTV] = useState<boolean>(false);
  const isAnalyzingRef = useRef<boolean>(false);

  const [loopIteration, setLoopIteration] = useState<number>(1);
  const loopIterationRef = useRef<number>(1);

  const [capturedFrames, setCapturedFrames] = useState<CCTVFrameCapture[]>([]);
  const capturedFramesRef = useRef<CCTVFrameCapture[]>([]);

  useEffect(() => {
    isAutoLoopActiveRef.current = isAutoLoopActive;
    isAwaiting4FramesRef.current = isAwaiting4Frames;
    isAnalyzingRef.current = isAnalyzingCCTV;
    loopIterationRef.current = loopIteration;
    capturedFramesRef.current = capturedFrames;
  }, [isAutoLoopActive, isAwaiting4Frames, isAnalyzingCCTV, loopIteration, capturedFrames]);

  const [critiqueHistory, setCritiqueHistory] = useState<ArgonVisualCritique[]>([]);
  const [selectedCritiqueIndex, setSelectedCritiqueIndex] = useState<number>(0);
  const [showZeroCheatModal, setShowZeroCheatModal] = useState<boolean>(false);
  const [allowSecondaryAttractors, setAllowSecondaryAttractors] = useState<boolean>(false);
  const allowSecondaryRef = useRef<boolean>(false);

  // Right Inspector Tab & 3D Spatial Highlight State
  const [activeRightTab, setActiveRightTab] = useState<'interventions' | 'cctv' | 'critique'>('interventions');
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);

  // User-adjustable Pass/Fail Threshold Sliders
  const [maxCrushThreshold, setMaxCrushThreshold] = useState<number>(3.8);
  const maxCrushThresholdRef = useRef<number>(3.8);
  const [minSafetyScore, setMinSafetyScore] = useState<number>(80);
  const minSafetyScoreRef = useRef<number>(80);

  useEffect(() => {
    allowSecondaryRef.current = allowSecondaryAttractors;
    maxCrushThresholdRef.current = maxCrushThreshold;
    minSafetyScoreRef.current = minSafetyScore;
    engineRef.current.crushThreshold = maxCrushThreshold;
  }, [allowSecondaryAttractors, maxCrushThreshold, minSafetyScore]);

  // API Key & Model Config
  const [apiKey, setApiKey] = useState<string>(
    () => (import.meta.env.VITE_GEMINI_API_KEY as string) || localStorage.getItem('ARGON_API_KEY') || ''
  );
  const [modelId, setModelId] = useState<string>('gemini-4-argon');
  const [showApiConfig, setShowApiConfig] = useState<boolean>(false);

  const saveApiKey = (val: string) => {
    setApiKey(val);
    localStorage.setItem('ARGON_API_KEY', val);
  };

  // Switch between Demo 1 (Repel / Hazard) and Demo 2 (Attract / Surge)
  const handleSelectPreset = (preset: PresetScenario) => {
    setIsAutoLoopActive(false);
    setIsAwaiting4Frames(false);
    isAwaiting4FramesRef.current = false;
    setIsAnalyzingCCTV(false);
    setActivePreset(preset);
    setActiveTip({ ...preset.tip });
    const initialPlan: PhysicalInterventionPlan = {
      barriers: [],
      beacons: [],
      openGates: [...preset.initialGates],
    };
    setCurrentPlan(initialPlan);
    setLoopIteration(1);
    setCapturedFrames([]);
    capturedFramesRef.current = [];
    setCritiqueHistory([]);
    setSelectedCritiqueIndex(0);
    engineRef.current.reset(preset.agentCount, preset.tip, initialPlan);
    setMetrics(engineRef.current.getMetrics());
    setIsRunning(true);
  };

  // When user clicks on the 3D floor to place the Tip anywhere
  const handleTipPlacedByUser = useCallback(
    (newTip: TipPoint) => {
      setActiveTip({ ...newTip });
      engineRef.current.setTip(newTip);
      // Reset current run from T=0 with the new Tip so CCTV captures the fresh trajectory
      engineRef.current.reset(activePreset.agentCount, newTip, currentPlan);
      setCapturedFrames([]);
      capturedFramesRef.current = [];
      setMetrics(engineRef.current.getMetrics());
      setIsRunning(true);
    },
    [activePreset.agentCount, currentPlan]
  );

  // Trigger Argon Visual Verification on the 4 captured CCTV frames
  const triggerArgonVerification = useCallback(
    async (framesToAnalyze: CCTVFrameCapture[], iterNum: number, planUsed: PhysicalInterventionPlan) => {
      if (isAnalyzingRef.current) return;
      setIsAnalyzingCCTV(true);
      setIsRunning(false); // Pause physics while Argon critiques the CCTV recording

      try {
        const currentMetrics = engineRef.current.getMetrics();
        const critique = await analyzeCCTVFramesWithArgon({
          apiKey,
          modelId,
          iteration: iterNum,
          mode: engineRef.current.tip.mode,
          tip: { ...engineRef.current.tip },
          currentPlan: planUsed,
          cctvFrames: framesToAnalyze,
          allowSecondaryAttractors: allowSecondaryRef.current,
          passCriteria: {
            maxCrushPressure: maxCrushThresholdRef.current,
            minSafetyScore: minSafetyScoreRef.current,
          },
          groundTruthMetricsForUIOnly: currentMetrics,
        });

        setCritiqueHistory((prev) => {
          const updated = [critique, ...prev];
          return updated;
        });
        setSelectedCritiqueIndex(0);

        // If Autonomous Loop is active and scenario did NOT succeed yet (up to 25 iterations),
        // apply Argon's proposed 3D interventions and re-run!
        if (isAutoLoopActiveRef.current) {
          if (!critique.scenarioSuccess && iterNum < 25) {
            const nextIter = iterNum + 1;
            loopIterationRef.current = nextIter;
            setCurrentPlan(critique.proposedPlan);
            setLoopIteration(nextIter);
            setCapturedFrames([]);
            capturedFramesRef.current = [];
            engineRef.current.reset(
              activePreset.agentCount,
              engineRef.current.tip,
              critique.proposedPlan
            );
            setMetrics(engineRef.current.getMetrics());
            setIsAnalyzingCCTV(false);
            setIsRunning(true);
            return;
          } else {
            // Goal achieved! Keep running with verified safe layout
            setIsAutoLoopActive(false);
          }
        }
      } finally {
        setIsAnalyzingCCTV(false);
        setIsRunning(true);
      }
    },
    [apiKey, modelId, activePreset.agentCount]
  );

  // Called on every simulation frame tick from Venue3DViewport
  const handleCCTVFrameTick = useCallback(
    (simSec: number, captureFrameFn: () => string) => {
      const existingCount = capturedFramesRef.current.length;
      if (existingCount < CAPTURE_TIMESTAMPS.length) {
        const nextTargetSec = CAPTURE_TIMESTAMPS[existingCount];
        if (simSec >= nextTargetSec) {
          const dataUrl = captureFrameFn();
          if (dataUrl) {
            const newFrame: CCTVFrameCapture = {
              frameIndex: existingCount + 1,
              timestampSimSec: Number(simSec.toFixed(1)),
              dataUrl,
              cameraLabel: `CAM-01 T+${nextTargetSec.toFixed(1)}s`,
            };
            const nextList = [...capturedFramesRef.current, newFrame];
            capturedFramesRef.current = nextList;
            setCapturedFrames(nextList);

            // Once all 4 sequential CCTV frames are captured in Autonomous Loop mode OR single-step queued review, trigger Argon!
            if (
              nextList.length === CAPTURE_TIMESTAMPS.length &&
              (isAutoLoopActiveRef.current || isAwaiting4FramesRef.current) &&
              !isAnalyzingRef.current
            ) {
              if (isAwaiting4FramesRef.current) {
                setIsAwaiting4Frames(false);
                isAwaiting4FramesRef.current = false;
                setActiveRightTab('critique');
              }
              triggerArgonVerification(
                nextList,
                loopIterationRef.current,
                {
                  barriers: [...engineRef.current.barriers],
                  beacons: [...engineRef.current.beacons],
                  openGates: engineRef.current.gates
                    .filter((g) => g.isOpen)
                    .map((g) => g.id),
                }
              );
            }
          }
        }
      }
    },
    [triggerArgonVerification]
  );

  // Start full autonomous closed-loop verification from Iteration 1
  const handleStartAutonomousLoop = () => {
    const baselinePlan: PhysicalInterventionPlan = {
      barriers: [],
      beacons: [],
      openGates: [...activePreset.initialGates],
    };
    setCurrentPlan(baselinePlan);
    setLoopIteration(1);
    setCapturedFrames([]);
    capturedFramesRef.current = [];
    setCritiqueHistory([]);
    engineRef.current.reset(
      activePreset.agentCount,
      engineRef.current.tip,
      baselinePlan
    );
    setMetrics(engineRef.current.getMetrics());
    setIsAutoLoopActive(true);
    setIsRunning(true);
  };

  // Manually trigger Argon analysis: if 4 frames are already captured, critique immediately;
  // otherwise queue review to fire automatically as soon as the 4th CCTV frame is snapped.
  const handleAnalyzeNow = () => {
    const frames = [...capturedFramesRef.current];
    if (frames.length >= CAPTURE_TIMESTAMPS.length) {
      setActiveRightTab('critique');
      triggerArgonVerification(frames, loopIteration, currentPlan);
    } else {
      setIsAwaiting4Frames(true);
      isAwaiting4FramesRef.current = true;
      setIsRunning(true);
    }
  };

  // Apply a proposed plan from "Apply Fix" and automatically review once the 4 new CCTV frames are captured
  const handleApplyProposedPlan = (plan: PhysicalInterventionPlan, nextIter: number) => {
    setCurrentPlan(plan);
    setLoopIteration(nextIter);
    loopIterationRef.current = nextIter;
    setCapturedFrames([]);
    capturedFramesRef.current = [];
    setIsAwaiting4Frames(true);
    isAwaiting4FramesRef.current = true;
    engineRef.current.reset(
      activePreset.agentCount,
      engineRef.current.tip,
      plan
    );
    setMetrics(engineRef.current.getMetrics());
    setIsRunning(true);
  };

  const handleClearInterventions = () => {
    const cleanPlan: PhysicalInterventionPlan = {
      barriers: [],
      beacons: [],
      openGates: [...activePreset.initialGates],
    };
    setCurrentPlan(cleanPlan);
    setLoopIteration(1);
    setCapturedFrames([]);
    capturedFramesRef.current = [];
    engineRef.current.reset(
      activePreset.agentCount,
      engineRef.current.tip,
      cleanPlan
    );
    setMetrics(engineRef.current.getMetrics());
  };

  const activeCritique = critiqueHistory[selectedCritiqueIndex] || null;
  const totalInterventionsCount = currentPlan.barriers.length + currentPlan.beacons.length;

  const selectedInterventionMeta = (() => {
    if (!highlightedItemId) return null;
    if (highlightedItemId === 'ALL') {
      return {
        label: `Highlighting all ${totalInterventionsCount} active 3D interventions`,
        detail: `${currentPlan.barriers.length} barriers • ${currentPlan.beacons.length} optical beacons`,
        coords: `Iteration #${loopIteration}`,
      };
    }
    const bar = currentPlan.barriers.find((b) => b.id === highlightedItemId);
    if (bar) {
      return {
        label: `[${bar.kind.replace('_', ' ').toUpperCase()}] ${bar.id}`,
        detail: bar.reason || 'Physical crowd flow baffle',
        coords: `(${bar.x1},${bar.z1}) → (${bar.x2},${bar.z2})`,
      };
    }
    const beacon = currentPlan.beacons.find((b) => b.id === highlightedItemId);
    if (beacon) {
      return {
        label: `[${beacon.kind === 'dispersion_attractor' ? 'SAT-POD' : 'BEACON'}] ${beacon.label}`,
        detail: `Guides pedestrians within ${beacon.radius}m radius`,
        coords: `@(${beacon.x},${beacon.z}) R=${beacon.radius}m`,
      };
    }
    return null;
  })();

  return (
    <div className="h-screen overflow-hidden bg-[#070a12] text-slate-100 flex flex-col">
      {/* Compact Top Navigation Bar */}
      <header className="shrink-0 border-b border-slate-800/90 bg-slate-950 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 z-20">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-sky-500/15 border border-sky-500/40 flex items-center justify-center">
            <Radio className="w-4 h-4 text-sky-400" />
          </div>
          <h1 className="text-sm font-semibold tracking-tight text-white">
            Argon Crowd Control
          </h1>
          <span
            className={`text-[11px] font-mono px-2 py-0.5 rounded border ${
              activeCritique
                ? activeCritique.scenarioSuccess
                  ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                  : 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            Iter #{loopIteration}{' '}
            {activeCritique
              ? activeCritique.scenarioSuccess
                ? '• Passed'
                : '• Mitigating'
              : '• Baseline'}
          </span>
        </div>

        {/* Two Core Demo Mode Switchers */}
        <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
          {PRESET_SCENARIOS.map((preset) => {
            const isSelected = activePreset.id === preset.id;
            const isRepel = preset.mode === 'repel';
            return (
              <button
                key={preset.id}
                onClick={() => handleSelectPreset(preset)}
                className={`px-3 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
                  isSelected
                    ? 'bg-slate-800 text-white border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200 border border-transparent'
                }`}
              >
                {isRepel ? (
                  <Flame className="w-3.5 h-3.5 text-red-400" />
                ) : (
                  <Magnet className="w-3.5 h-3.5 text-fuchsia-400" />
                )}
                <span>
                  {isRepel
                    ? 'Demo 1: Run Away (Repel)'
                    : 'Demo 2: Move Towards (Attract)'}
                </span>
              </button>
            );
          })}
        </div>

        {/* Right Action Controls: Closed-Loop Trigger + API Key */}
        <div className="flex items-center gap-2">
          <button
            onClick={
              isAutoLoopActive
                ? () => setIsAutoLoopActive(false)
                : handleStartAutonomousLoop
            }
            disabled={isAnalyzingCCTV && !isAutoLoopActive}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50 ${
              isAutoLoopActive
                ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                : 'bg-sky-500 text-slate-950 hover:bg-sky-400'
            }`}
          >
            {isAutoLoopActive || isAnalyzingCCTV ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            {isAutoLoopActive
              ? `Stop Loop (Iter #${loopIteration})`
              : isAnalyzingCCTV
              ? `Analyzing Iter #${loopIteration}...`
              : 'Run Argon Loop'}
          </button>

        <button
            onClick={() => setShowZeroCheatModal(true)}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 flex items-center gap-1.5 transition cursor-pointer"
            title="Inspect the exact CCTV images & zero-cheat prompt sent to Gemini 4 Argon"
          >
            <Code2 className="w-3.5 h-3.5 text-sky-400" />
            Zero-Cheat Proof
        </button>

          <button
            onClick={() => setShowApiConfig(!showApiConfig)}
            className={`p-1.5 rounded-lg border transition cursor-pointer ${
              apiKey
                ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
            }`}
            title="Configure Gemini 4 Argon API Key"
          >
            <KeyRound className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Collapsible Gemini 4 Argon API Key & Model Bar */}
      {showApiConfig && (
        <div className="shrink-0 bg-slate-900 border-b border-slate-800 px-4 py-2 flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-3 flex-1 min-w-[280px]">
            <span className="font-medium text-slate-300">Gemini API Key:</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => saveApiKey(e.target.value)}
              placeholder="Paste GEMINI_API_KEY for live @google/genai multimodal calls..."
              className="flex-1 max-w-md bg-slate-950 border border-slate-700 rounded-md px-3 py-1 text-slate-200 focus:outline-none focus:border-sky-500"
            />
            <span className="text-slate-400">Model:</span>
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-md px-2.5 py-1 text-slate-200"
            >
              <option value="gemini-4-argon">gemini-4-argon (Primary)</option>
              <option value="gemini-2.5-pro">gemini-2.5-pro</option>
              <option value="gemini-2.5-flash">gemini-2.5-flash</option>
            </select>
          </div>
          <div className="text-slate-400">
            {apiKey
              ? 'Live @google/genai multimodal vision enabled (4 CCTV PNG frames/iter).'
              : 'Using built-in Optical CCTV Frame Analyzer fallback.'}
          </div>
        </div>
      )}

      {/* Persistent Offscreen/Dock Canvas Holder so CCTV rendering always stays active */}
      <div className={activeRightTab === 'cctv' ? 'hidden' : 'sr-only pointer-events-none'}>
        {/* When CCTV tab is not active, we still keep the canvas mounted via a portal/shared ref */}
      </div>

      {/* Main Two-Column Workspace (Locked to viewport height, no page scroll) */}
      <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-3 p-3 max-w-[1800px] w-full mx-auto overflow-hidden">
        {/* LEFT COLUMN (7 cols): Dominant 3D Arena Stage + Compact Transport Footer */}
        <div className="lg:col-span-7 flex flex-col min-h-0 h-full bg-slate-950 border border-slate-800/90 rounded-xl overflow-hidden">
          {/* Stage Telemetry Strip */}
          <div className="shrink-0 px-3.5 py-2 bg-slate-900/90 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-4 font-mono">
              <span className="flex items-center gap-1.5">
                <span className="text-slate-400">Physics Crush Force:</span>
                <strong
                  className={
                    metrics.peakCrushPressure > maxCrushThreshold
                      ? 'text-red-400'
                      : 'text-emerald-400'
                  }
                >
                  {metrics.peakCrushPressure.toFixed(2)} kN/m
                </strong>
                <span className="text-[10px] text-slate-500">
                  (limit {maxCrushThreshold.toFixed(1)} kN/m)
                </span>
              </span>

              <span className="text-slate-700">|</span>

              <span className="flex items-center gap-1.5">
                <span className="text-slate-400">Density:</span>
                <strong className="text-slate-200">
                  {metrics.peakLocalDensity.toFixed(1)} p/m²
                </strong>
              </span>

              <span className="text-slate-700">|</span>

              <span>
                <span className="text-slate-400">
                  {activeTip.mode === 'repel' ? 'Evacuated: ' : 'Reached Tip: '}
                </span>
                <strong className="text-slate-200">
                  {activeTip.mode === 'repel'
                    ? `${metrics.evacuatedCount}/${metrics.totalAgents}`
                    : `${metrics.reachedTargetCount}/${metrics.totalAgents}`}
                </strong>
              </span>

              <span className="text-slate-700">|</span>

              <span>
                <span className="text-slate-400">Flow: </span>
                <strong className="text-sky-400">{metrics.flowEfficiency}%</strong>
              </span>
            </div>

            <div className="text-[11px] font-mono text-slate-400">
              T+{metrics.elapsedSeconds.toFixed(1)}s • {capturedFrames.length}/4 CCTV frames
            </div>
          </div>

          {/* 3D Viewport Container */}
          <div className="flex-1 min-h-0 w-full relative">
            <Venue3DViewport
              engineRef={engineRef}
              activeTip={activeTip}
              crushThreshold={maxCrushThreshold}
              isRunning={isRunning}
              simSpeed={simSpeed}
              cameraPreset={cameraPreset}
              onCameraPresetChange={setCameraPreset}
              onTipPlacedByUser={handleTipPlacedByUser}
              onMetricsUpdate={setMetrics}
              onCCTVFrameTick={handleCCTVFrameTick}
              cctvPreviewCanvasRef={cctvPreviewCanvasRef}
              highlightedItemId={highlightedItemId}
            />

            {/* Floating Spatial Callout when an Intervention is Highlighted */}
            {selectedInterventionMeta && (
              <div className="absolute bottom-11 left-3 right-3 bg-slate-950/90 backdrop-blur-md border border-amber-400/50 rounded-lg px-3.5 py-2 flex items-center justify-between gap-3 z-10">
                <div className="text-xs truncate">
                  <span className="font-mono font-semibold text-amber-300 mr-2">
                    {selectedInterventionMeta.label}
                  </span>
                  <span className="text-slate-300">
                    {selectedInterventionMeta.detail}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono text-[11px] text-sky-300">
                    {selectedInterventionMeta.coords}
                  </span>
                  <button
                    onClick={() => setHighlightedItemId(null)}
                    className="text-[11px] text-slate-400 hover:text-white px-1.5 py-0.5 rounded bg-slate-800 cursor-pointer"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}

            {/* Banner overlay when Argon is analyzing the CCTV frames */}
            {isAnalyzingCCTV && (
              <div className="absolute inset-0 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center z-10">
                <div className="bg-slate-900 border border-slate-700/90 rounded-xl px-6 py-5 max-w-sm text-center flex flex-col items-center">
                  <Loader2 className="w-7 h-7 text-sky-400 animate-spin mb-3" />
                  <h3 className="text-sm font-semibold text-white mb-1">
                    Gemini 4 Argon Watching CCTV Sequence (Iteration #{loopIteration})
                  </h3>
                  <p className="text-xs text-slate-400">
                    Analyzing crowd flow and computing 3D spatial interventions...
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Slim Transport & Perimeter Gates Bar */}
          <div className="shrink-0 bg-slate-900 border-t border-slate-800 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setIsRunning(!isRunning)}
                className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-xs font-medium flex items-center gap-1.5 text-white transition cursor-pointer"
              >
                {isRunning ? (
                  <>
                    <Pause className="w-3.5 h-3.5 text-amber-400" />
                    Pause
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 text-emerald-400" />
                    Resume
                  </>
                )}
              </button>

              <button
                onClick={() => {
                  setCapturedFrames([]);
                  capturedFramesRef.current = [];
                  engineRef.current.reset(
                    activePreset.agentCount,
                    engineRef.current.tip,
                    currentPlan
                  );
                  setMetrics(engineRef.current.getMetrics());
                  setIsRunning(true);
                }}
                className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-xs font-medium flex items-center gap-1 text-slate-300 transition cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                Replay
              </button>

              <button
                onClick={() => {
                  setHighlightedItemId(null);
                  handleClearInterventions();
                }}
                className="px-2.5 py-1 rounded-md bg-slate-800/70 hover:bg-red-950/50 hover:text-red-300 text-xs font-medium flex items-center gap-1 text-slate-400 transition cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
                Reset Baseline
              </button>
            </div>

            {/* Read-Only Gate Status Telemetry */}
            <div className="flex items-center gap-3 flex-wrap text-[11px] font-mono select-none">
              <span className="text-slate-400 flex items-center gap-1">
                <DoorOpen className="w-3.5 h-3.5 text-slate-500" />
                Gates:
              </span>
              {(
                [
                  { id: 'north_main', label: 'G1 N' },
                  { id: 'south_aux', label: 'G2 S' },
                  { id: 'west_emergency', label: 'G3 W' },
                  { id: 'east_stage', label: 'G4 E' },
                ] as const
              ).map((g) => {
                const isOpen = currentPlan.openGates.includes(g.id);
                return (
                  <span
                    key={g.id}
                    className={`flex items-center gap-1 ${
                      isOpen ? 'text-emerald-400' : 'text-slate-500'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        isOpen ? 'bg-emerald-400' : 'bg-red-500/70'
                      }`}
                    />
                    <span>{g.label}</span>
                  </span>
                );
              })}
            </div>

            {/* Speed Selector */}
            <div className="flex items-center gap-1 text-xs">
              {activeTip.mode === 'attract' && (
                <button
                  onClick={() => {
                    const nextVal = !allowSecondaryAttractors;
                    setAllowSecondaryAttractors(nextVal);
                    if (!nextVal && currentPlan.beacons.some((b) => b.kind === 'dispersion_attractor')) {
                      const filteredPlan: PhysicalInterventionPlan = {
                        ...currentPlan,
                        beacons: currentPlan.beacons.filter((b) => b.kind !== 'dispersion_attractor'),
                      };
                      setCurrentPlan(filteredPlan);
                      engineRef.current.applyInterventionPlan(filteredPlan);
                    }
                  }}
                  className={`px-2 py-0.5 mr-1 rounded text-[11px] font-mono border transition cursor-pointer ${
                    allowSecondaryAttractors
                      ? 'bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  Decoys: {allowSecondaryAttractors ? 'ON' : 'OFF'}
                </button>
              )}
              {[1, 1.5, 2].map((spd) => (
                <button
                  key={spd}
                  onClick={() => setSimSpeed(spd)}
                  className={`px-2 py-0.5 rounded font-mono text-[11px] cursor-pointer ${
                    simSpeed === spd
                      ? 'bg-slate-800 text-sky-300 border border-slate-700'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {spd}x
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN (5 cols): Unified 3-Tab Inspector Dock (Scrolls internally per tab) */}
        <div className="lg:col-span-5 flex flex-col min-h-0 h-full bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden">
          {/* Tab Header Strip */}
          <div className="shrink-0 grid grid-cols-3 bg-slate-950 border-b border-slate-800">
            <button
              onClick={() => setActiveRightTab('interventions')}
              className={`py-3 px-3 text-xs font-medium flex items-center justify-center gap-2 border-b-2 transition cursor-pointer ${
                activeRightTab === 'interventions'
                  ? 'border-sky-400 text-white bg-slate-900/90'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Layers className="w-3.5 h-3.5 text-sky-400" />
              <span>3D Interventions</span>
              <span className="px-1.5 py-0.2 rounded bg-slate-800 text-[11px] font-mono text-slate-300">
                {totalInterventionsCount}
              </span>
            </button>

            <button
              onClick={() => setActiveRightTab('cctv')}
              className={`py-3 px-3 text-xs font-medium flex items-center justify-center gap-2 border-b-2 transition cursor-pointer ${
                activeRightTab === 'cctv'
                  ? 'border-sky-400 text-white bg-slate-900/90'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Video className="w-3.5 h-3.5 text-red-400" />
              <span>Live CCTV Feed</span>
              <span className="px-1.5 py-0.2 rounded bg-slate-800 text-[11px] font-mono text-slate-300">
                {capturedFrames.length}/4
              </span>
            </button>

            <button
              onClick={() => setActiveRightTab('critique')}
              className={`py-3 px-3 text-xs font-medium flex items-center justify-center gap-2 border-b-2 transition cursor-pointer ${
                activeRightTab === 'critique'
                  ? 'border-sky-400 text-white bg-slate-900/90'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Bot className="w-3.5 h-3.5 text-emerald-400" />
              <span>Argon Critique</span>
              {critiqueHistory.length > 0 && (
                <span
                  className={`px-1.5 py-0.2 rounded text-[11px] font-mono ${
                    activeCritique?.scenarioSuccess
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-amber-500/20 text-amber-300'
                  }`}
                >
                  #{activeCritique?.iteration}
                </span>
              )}
            </button>
          </div>

          {/* TAB 1: Active 3D Physical Interventions in Arena (with 3D Spatial Highlight) */}
          {activeRightTab === 'interventions' && (
            <div className="p-4 flex-1 min-h-0 overflow-y-auto flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-xs font-semibold text-white">
                    Active 3D Physical Interventions (Iteration #{loopIteration})
                  </h2>
                  <p className="text-[11px] text-slate-400">
                    Hover or click any barrier or beacon below to spotlight its exact location in the 3D arena.
                  </p>
                </div>

                {totalInterventionsCount > 0 && (
                  <button
                    onClick={() =>
                      setHighlightedItemId(
                        highlightedItemId === 'ALL' ? null : 'ALL'
                      )
                    }
                    className={`px-2.5 py-1 rounded-md text-xs font-medium border transition shrink-0 cursor-pointer ${
                      highlightedItemId === 'ALL'
                        ? 'bg-amber-500/20 border-amber-400/50 text-amber-200'
                        : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'
                    }`}
                  >
                    {highlightedItemId === 'ALL' ? 'Clear Spotlight' : 'Highlight All in 3D'}
                  </button>
                )}
              </div>

              {totalInterventionsCount === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-6 border border-dashed border-slate-800 rounded-xl bg-slate-950/40">
                  <Layers className="w-7 h-7 text-slate-500 mb-2" />
                  <div className="text-xs font-semibold text-slate-200 mb-1">
                    Unmitigated Baseline (0 Interventions Deployed)
                  </div>
                  <p className="text-xs text-slate-400 max-w-xs mb-4">
                    No wave-breaker barriers or optical signage beacons are placed in the arena yet. Run the autonomous Argon loop so Gemini can watch the CCTV feed and deploy 3D structures.
                  </p>
                  <button
                    onClick={handleStartAutonomousLoop}
                    disabled={isAutoLoopActive || isAnalyzingCCTV}
                    className={`px-3.5 py-2 rounded-lg font-semibold text-xs flex items-center gap-2 transition ${
                      isAutoLoopActive || isAnalyzingCCTV
                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 cursor-not-allowed'
                        : 'bg-sky-500 hover:bg-sky-400 text-slate-950 cursor-pointer'
                    }`}
                  >
                    {isAutoLoopActive || isAnalyzingCCTV ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        {isAnalyzingCCTV
                          ? `Argon Analyzing CCTV (Iter #${loopIteration})...`
                          : `Capturing CCTV Sequence (${capturedFrames.length}/4)...`}
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        Let Argon Watch CCTV & Deploy 3D Fixes
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <div className="shrink-0 flex flex-col divide-y divide-slate-800/80 border border-slate-800 rounded-xl overflow-hidden bg-slate-950/60">
                  {currentPlan.barriers.map((bar) => {
                    const isSelected =
                      highlightedItemId === bar.id || highlightedItemId === 'ALL';
                    return (
                      <button
                        key={bar.id}
                        type="button"
                        onMouseEnter={() => setHighlightedItemId(bar.id)}
                        onClick={() =>
                          setHighlightedItemId(
                            highlightedItemId === bar.id ? null : bar.id
                          )
                        }
                        className={`w-full text-left px-3.5 py-2.5 flex items-start justify-between gap-3 transition cursor-pointer ${
                          isSelected
                            ? 'bg-amber-500/10'
                            : 'hover:bg-slate-900/90'
                        }`}
                      >
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold uppercase bg-amber-500/15 text-amber-300 border border-amber-500/30">
                              {bar.kind.replace('_', ' ')}
                            </span>
                            <span className="text-xs font-medium text-slate-100">
                              {bar.id}
                            </span>
                            {isSelected && (
                              <span className="text-[10px] font-mono text-amber-300">
                                ● Spotlighted in 3D
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-400 leading-snug">
                            {bar.reason || 'Diverts high-pressure crowd stream'}
                          </p>
                        </div>
                        <span className="font-mono text-[11px] text-slate-400 shrink-0">
                          ({bar.x1},{bar.z1})→({bar.x2},{bar.z2})
                        </span>
                      </button>
                    );
                  })}

                  {currentPlan.beacons.map((b) => {
                    const isSelected =
                      highlightedItemId === b.id || highlightedItemId === 'ALL';
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onMouseEnter={() => setHighlightedItemId(b.id)}
                        onClick={() =>
                          setHighlightedItemId(
                            highlightedItemId === b.id ? null : b.id
                          )
                        }
                        className={`w-full text-left px-3.5 py-2.5 flex items-start justify-between gap-3 transition cursor-pointer ${
                          isSelected
                            ? 'bg-sky-500/10'
                            : 'hover:bg-slate-900/90'
                        }`}
                      >
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold uppercase bg-sky-500/15 text-sky-300 border border-sky-500/30">
                              {b.kind === 'dispersion_attractor'
                                ? 'SAT-POD'
                                : 'BEACON'}
                            </span>
                            <span className="text-xs font-medium text-slate-100">
                              {b.label}
                            </span>
                            {isSelected && (
                              <span className="text-[10px] font-mono text-sky-300">
                                ● Spotlighted in 3D
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-400 leading-snug">
                            Optical guidance radius {b.radius}m → target ({b.targetX},{b.targetZ})
                          </p>
                        </div>
                        <span className="font-mono text-[11px] text-slate-400 shrink-0">
                          @({b.x},{b.z}) R={b.radius}m
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Perimeter Gate Summary Footer inside Interventions Tab */}
              <div className="mt-auto pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
                <span>Active Perimeter Gates:</span>
                <span className="font-mono text-slate-300">
                  {currentPlan.openGates.length}/4 Open ({currentPlan.openGates.map((g) => g.split('_')[0].toUpperCase()).join(', ')})
                </span>
              </div>
            </div>
          )}

          {/* TAB 2: Live CCTV Optical Feed & Pass Criteria Sliders */}
          <div
            className={
              activeRightTab === 'cctv'
                ? 'p-4 flex-1 min-h-0 overflow-y-auto flex flex-col gap-3.5'
                : 'hidden'
            }
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xs font-semibold text-white flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                  Monochrome Overhead CCTV (Zero-Cheat Input)
                </h2>
                <p className="text-[11px] text-slate-400">
                  Uncolored overhead silhouette feed sent to Gemini 4 Argon at T+1.5s, 3.5s, 5.5s, and 7.5s.
                </p>
              </div>
              <button
                onClick={handleAnalyzeNow}
                disabled={isAnalyzingCCTV || isAutoLoopActive || isAwaiting4Frames}
                className="px-2.5 py-1.5 rounded-md bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/40 text-xs font-medium flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                {isAnalyzingCCTV ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Analyzing...
                  </>
                ) : isAwaiting4Frames ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Capturing ({capturedFrames.length}/4)...
                  </>
                ) : (
                  <>
                    <Camera className="w-3.5 h-3.5" />
                    Critique Now
                  </>
                )}
              </button>
            </div>

            {/* Live CCTV Canvas */}
            <div className="shrink-0 relative rounded-lg overflow-hidden border border-slate-800 bg-[#090d14]">
              <canvas
                ref={cctvPreviewCanvasRef}
                width={480}
                height={330}
                className="w-full aspect-[480/330] object-contain block"
              />
              <div className="cctv-scanlines absolute inset-0 pointer-events-none" />
            </div>

            {/* 4 Sequential Keyframe Slots */}
            <div className="shrink-0">
              <div className="text-[11px] font-mono text-slate-400 mb-1.5 flex items-center justify-between">
                <span>Captured Keyframe Buffer (4 Frames):</span>
                <span>{capturedFrames.length}/4 Snapped</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[0, 1, 2, 3].map((idx) => {
                  const f = capturedFrames[idx];
                  return f ? (
                    <div
                      key={idx}
                      className="rounded border border-slate-700 bg-[#090d14] overflow-hidden"
                    >
                      <img
                        src={f.dataUrl}
                        alt={f.cameraLabel}
                        className="w-full aspect-[480/330] object-contain block"
                      />
                      <div className="text-[9px] font-mono text-center py-0.5 text-slate-400">
                        T+{CAPTURE_TIMESTAMPS[idx]}s
                      </div>
                    </div>
                  ) : (
                    <div
                      key={idx}
                      className="aspect-[480/330] rounded border border-dashed border-slate-800 bg-slate-950/50 flex items-center justify-center text-[10px] font-mono text-slate-500"
                    >
                      T+{CAPTURE_TIMESTAMPS[idx]}s
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Pass / Fail Threshold Sliders */}
            <div className="shrink-0 mt-auto pt-3 border-t border-slate-800 flex flex-col gap-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-200 flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-sky-400" />
                  Verification Pass Thresholds
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  {maxCrushThreshold <= 2.8
                    ? 'Strict Safety Standard'
                    : maxCrushThreshold >= 4.4
                    ? 'Lenient Standard'
                    : 'OSHA/FEMA Limit'}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-slate-400">Max Crush Force:</span>
                    <span className="font-mono font-semibold text-slate-200">
                      &le; {maxCrushThreshold.toFixed(1)} kN/m
                    </span>
                  </div>
                  <input
                    type="range"
                    min={2.0}
                    max={5.5}
                    step={0.1}
                    value={maxCrushThreshold}
                    onChange={(e) => setMaxCrushThreshold(parseFloat(e.target.value))}
                    className="w-full accent-sky-400 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
                  />
                </div>

                <div className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-slate-400">Min Score:</span>
                    <span className="font-mono font-semibold text-slate-200">
                      &ge; {minSafetyScore}/100
                    </span>
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={95}
                    step={5}
                    value={minSafetyScore}
                    onChange={(e) => setMinSafetyScore(parseInt(e.target.value, 10))}
                    className="w-full accent-sky-400 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* TAB 3: Gemini 4 Argon Visual Critique & Closed Loop */}
          {activeRightTab === 'critique' && (
            <div className="p-4 flex-1 min-h-0 overflow-y-auto flex flex-col gap-3">
              {critiqueHistory.length > 0 && (
                <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-800">
                  <span className="text-xs text-slate-400">Iteration History:</span>
                  <div className="flex items-center gap-1 flex-wrap">
                    {critiqueHistory.map((c, idx) => (
                      <button
                        key={c.iteration + '-' + idx}
                        onClick={() => setSelectedCritiqueIndex(idx)}
                        className={`px-2 py-0.5 rounded text-[11px] font-mono font-medium transition cursor-pointer ${
                          selectedCritiqueIndex === idx
                            ? c.scenarioSuccess
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                              : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Iter #{c.iteration} {c.scenarioSuccess ? '✓' : '↻'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {!activeCritique ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-6 border border-dashed border-slate-800 rounded-xl bg-slate-950/40">
                  <Activity className="w-7 h-7 text-sky-400/70 mb-2" />
                  <h3 className="text-xs font-semibold text-slate-200 mb-1">
                    No Visual Critique Recorded Yet
                  </h3>
                  <p className="text-xs text-slate-400 max-w-xs mb-4">
                    Start the autonomous Argon loop or click Critique Now to evaluate the 4 monochrome CCTV frames.
                  </p>
                  <button
                    onClick={handleStartAutonomousLoop}
                    disabled={isAutoLoopActive || isAnalyzingCCTV}
                    className={`px-3.5 py-2 rounded-lg font-semibold text-xs flex items-center gap-2 transition ${
                      isAutoLoopActive || isAnalyzingCCTV
                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 cursor-not-allowed'
                        : 'bg-sky-500 hover:bg-sky-400 text-slate-950 cursor-pointer'
                    }`}
                  >
                    {isAutoLoopActive || isAnalyzingCCTV ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        {isAnalyzingCCTV
                          ? `Argon Analyzing CCTV (Iter #${loopIteration})...`
                          : `Capturing CCTV Sequence (${capturedFrames.length}/4)...`}
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        Run Closed-Loop Verification
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-3 text-xs">
                  {/* Status Banner */}
                  <div
                    className={`p-3 rounded-lg border flex items-center justify-between gap-2 ${
                      activeCritique.scenarioSuccess
                        ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200'
                        : 'bg-amber-500/10 border-amber-500/40 text-amber-200'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      {activeCritique.scenarioSuccess ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
                      )}
                      <div>
                        <div className="font-semibold text-xs">
                          {activeCritique.scenarioSuccess
                            ? `Iteration #${activeCritique.iteration} PASSED — Safe Flow Verified`
                            : `Iteration #${activeCritique.iteration} FAILED — Crush Bottleneck Detected`}
                        </div>
                        <div className="text-[11px] opacity-80 font-mono">
                          Score: {activeCritique.safetyScore}/100 • Inferred Force: {activeCritique.inferredCrushForceKnm} kN/m (CCTV Density: {activeCritique.opticalDensityPpm2} p/m²) • Physics Force: {activeCritique.groundTruthCrushForceKnm} kN/m
                        </div>
                      </div>
                    </div>

                    {!activeCritique.scenarioSuccess && !isAutoLoopActive && (
                      <button
                        onClick={() =>
                          handleApplyProposedPlan(
                            activeCritique.proposedPlan,
                            activeCritique.iteration + 1
                          )
                        }
                        disabled={isAwaiting4Frames || isAnalyzingCCTV}
                        className={`px-2.5 py-1.5 rounded-md font-semibold text-xs flex items-center gap-1.5 shrink-0 transition ${
                          isAwaiting4Frames || isAnalyzingCCTV
                            ? 'bg-amber-500/20 text-amber-200 border border-amber-500/40 cursor-not-allowed'
                            : 'bg-amber-400 hover:bg-amber-300 text-slate-950 cursor-pointer'
                        }`}
                      >
                        {isAwaiting4Frames || isAnalyzingCCTV ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            {isAnalyzingCCTV
                              ? `Reviewing Iter #${loopIteration}...`
                              : `Capturing CCTV (${capturedFrames.length}/4)...`}
                          </>
                        ) : (
                          <>
                            Apply Fix & Review #{activeCritique.iteration + 1}
                            <ChevronRight className="w-3.5 h-3.5" />
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {/* Structured Critique Sections */}
                  <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3 space-y-2.5">
                    <div>
                      <div className="text-[10px] font-mono uppercase text-sky-400 font-semibold">
                        1. Optical CCTV Observation
                      </div>
                      <p className="text-slate-200 mt-0.5 leading-relaxed">
                        {activeCritique.observedCrowdBehavior}
                      </p>
                    </div>

                    <div className="pt-2 border-t border-slate-800/80">
                      <div className="text-[10px] font-mono uppercase text-red-400 font-semibold">
                        2. Root-Cause Crowd Physics Diagnosis
                      </div>
                      <p className="text-slate-300 mt-0.5 leading-relaxed">
                        {activeCritique.rootCauseDiagnosis}
                      </p>
                    </div>

                    <div className="pt-2 border-t border-slate-800/80">
                      <div className="text-[10px] font-mono uppercase text-emerald-400 font-semibold">
                        3. Argon Spatial Intervention Plan
                      </div>
                      <p className="text-slate-300 mt-0.5 leading-relaxed">
                        {activeCritique.interventionReasoning}
                      </p>
                    </div>
                  </div>

                  {/* CCTV Frames Inspected in This Iteration */}
                  <div className="mt-auto">
                    <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1.5">
                      <span>Frames Inspected (Iter #{activeCritique.iteration}):</span>
                      <button
                        onClick={() => setShowZeroCheatModal(true)}
                        className="text-sky-400 hover:underline font-mono cursor-pointer"
                      >
                        Inspect Raw Payload →
                      </button>
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      {activeCritique.cctvFramesSent.map((frame) => (
                        <div
                          key={frame.frameIndex}
                          className="bg-[#090d14] border border-slate-800 rounded overflow-hidden"
                        >
                          <img
                            src={frame.dataUrl}
                            alt={frame.cameraLabel}
                            className="w-full aspect-[480/330] object-contain block"
                          />
                          <div className="text-[9px] font-mono text-center py-0.5 text-slate-400">
                            {frame.cameraLabel}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Zero-Cheat Proof Modal (Shows exact CCTV frames + prompt with zero game-data leakage) */}
      {showZeroCheatModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Code2 className="w-4 h-4 text-sky-400" />
                <h3 className="text-sm font-bold text-white">
                  Zero-Cheat Visual CCTV Verification Payload Inspector
                </h3>
              </div>
              <button
                onClick={() => setShowZeroCheatModal(false)}
                className="text-xs text-slate-400 hover:text-white px-2.5 py-1 rounded bg-slate-800 cursor-pointer"
              >
                Close
              </button>
            </div>
            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              <div className="bg-sky-500/10 border border-sky-500/30 rounded-lg p-3 text-sky-200">
                <strong>How Zero-Cheat CCTV Mode Works:</strong> Instead of passing ground-truth agent arrays (<code>agents[i].x, agents[i].vx</code>) to Gemini 4 Argon, the simulator renders overhead CCTV optical frames with a printed metric grid (<code>X:-20..+20, Z:-15..+15</code>) and sends only the <strong>4 PNG images</strong> + current barrier JSON. Argon must visually perceive crowd motion and bottlenecks from the pixels alone.
              </div>

              <div>
                <div className="font-mono text-[11px] uppercase text-slate-400 mb-1.5">
                  1. Multimodal Image Attachments (4 Base64 PNG Frames from CCTV Canvas)
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {(activeCritique?.cctvFramesSent || capturedFrames).map((f) => (
                    <div key={f.frameIndex} className="border border-slate-700 rounded p-1 bg-slate-950">
                      <img src={f.dataUrl} alt={f.cameraLabel} className="w-full h-24 object-cover rounded" />
                      <div className="text-[10px] font-mono text-center mt-1 text-slate-300">
                        {f.cameraLabel}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="font-mono text-[11px] uppercase text-slate-400 mb-1.5">
                  2. Exact Text Prompt Sent Alongside the 4 CCTV Images
                </div>
                <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-[11px] font-mono text-slate-300 whitespace-pre-wrap overflow-x-auto">
                  {buildZeroCheatVisualPrompt(
                    activeCritique?.iteration || loopIteration,
                    activeTip.mode,
                    currentPlan,
                    allowSecondaryAttractors,
                    { maxCrushPressure: maxCrushThreshold, minSafetyScore }
                  )}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
