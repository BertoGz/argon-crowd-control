import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  Camera,
  CheckCircle2,
  ChevronRight,
  Code2,
  DoorOpen,
  Flame,
  KeyRound,
  Layers,
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

  const [isAnalyzingCCTV, setIsAnalyzingCCTV] = useState<boolean>(false);
  const isAnalyzingRef = useRef<boolean>(false);

  const [loopIteration, setLoopIteration] = useState<number>(1);
  const loopIterationRef = useRef<number>(1);

  const [capturedFrames, setCapturedFrames] = useState<CCTVFrameCapture[]>([]);
  const capturedFramesRef = useRef<CCTVFrameCapture[]>([]);

  useEffect(() => {
    isAutoLoopActiveRef.current = isAutoLoopActive;
    isAnalyzingRef.current = isAnalyzingCCTV;
    loopIterationRef.current = loopIteration;
    capturedFramesRef.current = capturedFrames;
  }, [isAutoLoopActive, isAnalyzingCCTV, loopIteration, capturedFrames]);

  const [critiqueHistory, setCritiqueHistory] = useState<ArgonVisualCritique[]>([]);
  const [selectedCritiqueIndex, setSelectedCritiqueIndex] = useState<number>(0);
  const [showZeroCheatModal, setShowZeroCheatModal] = useState<boolean>(false);
  const [allowSecondaryAttractors, setAllowSecondaryAttractors] = useState<boolean>(false);
  const allowSecondaryRef = useRef<boolean>(false);

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

            // Once all 4 sequential CCTV frames are captured in Autonomous Loop mode, trigger Argon!
            if (
              nextList.length === CAPTURE_TIMESTAMPS.length &&
              isAutoLoopActiveRef.current &&
              !isAnalyzingRef.current
            ) {
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

  // Manually trigger Argon analysis right now on current frames
  const handleAnalyzeNow = () => {
    let frames = [...capturedFramesRef.current];
    if (frames.length === 0 && cctvPreviewCanvasRef.current) {
      frames = [
        {
          frameIndex: 1,
          timestampSimSec: engineRef.current.elapsedSeconds,
          dataUrl: cctvPreviewCanvasRef.current.toDataURL('image/png'),
          cameraLabel: `CAM-01 T+${engineRef.current.elapsedSeconds.toFixed(1)}s`,
        },
      ];
    }
    triggerArgonVerification(frames, loopIteration, currentPlan);
  };

  // Apply a proposed plan manually if user ran single-step
  const handleApplyProposedPlan = (plan: PhysicalInterventionPlan, nextIter: number) => {
    setCurrentPlan(plan);
    setLoopIteration(nextIter);
    setCapturedFrames([]);
    capturedFramesRef.current = [];
    engineRef.current.reset(
      activePreset.agentCount,
      engineRef.current.tip,
      plan
    );
    setMetrics(engineRef.current.getMetrics());
    setIsRunning(true);
  };

  // Manual Gate Toggle
  const handleToggleGate = (
    gateId: 'north_main' | 'south_aux' | 'east_stage' | 'west_emergency'
  ) => {
    const exists = currentPlan.openGates.includes(gateId);
    const nextGates = exists
      ? currentPlan.openGates.filter((id) => id !== gateId)
      : [...currentPlan.openGates, gateId];
    if (nextGates.length === 0) return; // keep at least 1 gate open
    const updatedPlan: PhysicalInterventionPlan = {
      ...currentPlan,
      openGates: nextGates,
    };
    setCurrentPlan(updatedPlan);
    engineRef.current.applyInterventionPlan(updatedPlan);
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

  return (
    <div className="min-h-screen bg-[#060911] text-slate-100 flex flex-col">
      {/* Top Navigation & Scenario Bar */}
      <header className="border-b border-slate-800/90 bg-slate-950/90 backdrop-blur-md px-5 py-3 flex flex-wrap items-center justify-between gap-3 z-20">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-sky-500/20">
            <Radio className="w-5 h-5 text-white" />
        </div>
        <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold tracking-tight text-white">
                ARGON CROWD CONTROL
              </h1>
              <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30">
                More Dimensions Track • Closed-Loop CCTV Architect
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Render 3D Crowd Physics → Watch CCTV Frames (Zero Game-Data Cheat) → Critique → Mutate 3D World in a Loop
            </p>
          </div>
        </div>

        {/* Two Core Demo Mode Switchers */}
        <div className="flex items-center gap-2 bg-slate-900/90 p-1 rounded-xl border border-slate-800">
          {PRESET_SCENARIOS.map((preset) => {
            const isSelected = activePreset.id === preset.id;
            const isRepel = preset.mode === 'repel';
            return (
              <button
                key={preset.id}
                onClick={() => handleSelectPreset(preset)}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition ${
                  isSelected
                    ? isRepel
                      ? 'bg-red-500/20 text-red-300 border border-red-500/40 shadow-sm'
                      : 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/40 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {isRepel ? (
                  <Flame className="w-3.5 h-3.5 text-red-400" />
                ) : (
                  <Magnet className="w-3.5 h-3.5 text-fuchsia-400" />
                )}
                <span>
                  {isRepel
                    ? 'Demo 1: Run AWAY from Tip (Repel)'
                    : 'Demo 2: Move TOWARDS Tip (Attract)'}
                </span>
              </button>
            );
          })}
        </div>

        {/* Right Action Controls: Closed-Loop Trigger + API Key */}
        <div className="flex items-center gap-2.5">
          <button
            onClick={
              isAutoLoopActive
                ? () => setIsAutoLoopActive(false)
                : handleStartAutonomousLoop
            }
            className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition shadow-lg cursor-pointer ${
              isAutoLoopActive
                ? 'bg-amber-500 text-slate-950 hover:bg-amber-400 shadow-amber-500/20'
                : 'bg-gradient-to-r from-sky-500 to-indigo-600 text-white hover:from-sky-400 hover:to-indigo-500 shadow-sky-500/25'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            {isAutoLoopActive
              ? `Stop Auto-Loop (Iter #${loopIteration})`
              : 'Start Autonomous Argon Loop'}
          </button>

        <button
            onClick={() => setShowZeroCheatModal(true)}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700/80 flex items-center gap-1.5 transition cursor-pointer"
            title="Inspect the exact CCTV images & zero-cheat prompt sent to Gemini 4 Argon"
          >
            <Code2 className="w-3.5 h-3.5 text-sky-400" />
            Zero-Cheat Proof
        </button>

          <button
            onClick={() => setShowApiConfig(!showApiConfig)}
            className={`p-2 rounded-lg border transition cursor-pointer ${
              apiKey
                ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-white'
            }`}
            title="Configure Gemini 4 Argon API Key"
          >
            <KeyRound className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Collapsible Gemini 4 Argon API Key & Model Bar */}
      {showApiConfig && (
        <div className="bg-slate-900/95 border-b border-slate-800 px-5 py-2.5 flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-3 flex-1 min-w-[280px]">
            <span className="font-semibold text-slate-300">Gemini API Key:</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => saveApiKey(e.target.value)}
              placeholder="Paste GEMINI_API_KEY for live @google/genai multimodal calls..."
              className="flex-1 max-w-md bg-slate-950 border border-slate-700 rounded-md px-3 py-1.5 text-slate-200 focus:outline-none focus:border-sky-500"
            />
            <span className="text-slate-400">Model:</span>
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-md px-2.5 py-1.5 text-slate-200"
            >
              <option value="gemini-4-argon">gemini-4-argon (Primary)</option>
              <option value="gemini-2.5-pro">gemini-2.5-pro</option>
              <option value="gemini-2.5-flash">gemini-2.5-flash</option>
            </select>
          </div>
          <div className="text-slate-400">
            {apiKey
              ? 'Live @google/genai multimodal vision enabled (sends 4 CCTV PNG frames per iteration).'
              : 'No key entered yet — using built-in Optical CCTV Frame Analyzer fallback so live demos never break.'}
          </div>
        </div>
      )}

      {/* Main Workspace Grid */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 p-4 max-w-[1800px] w-full mx-auto">
        {/* LEFT / CENTER COLUMN (7 cols): 3D Venue + Physical Controls */}
        <div className="lg:col-span-7 flex flex-col gap-3">
          {/* 3D Viewport Container */}
          <div className="h-[490px] w-full relative">
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
            />

            {/* Banner overlay when Argon is analyzing the CCTV frames */}
            {isAnalyzingCCTV && (
              <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center z-10">
                <div className="bg-slate-900 border border-sky-500/50 rounded-2xl p-6 max-w-md text-center shadow-2xl">
                  <div className="w-12 h-12 rounded-full bg-sky-500/20 border border-sky-500/40 flex items-center justify-center mx-auto mb-3 animate-pulse">
                    <Bot className="w-6 h-6 text-sky-400" />
                  </div>
                  <h3 className="text-sm font-bold text-white mb-1">
                    Gemini 4 Argon Watching CCTV Sequence (Iteration #{loopIteration})
                  </h3>
                  <p className="text-xs text-slate-300 mb-3">
                    Inspecting 4 optical CCTV frames (T+1.5s → T+7.5s) for compressive crowd arches, panic herding, and crush pockets...
                  </p>
                  <div className="grid grid-cols-4 gap-1.5">
                    {capturedFrames.map((f) => (
                      <img
                        key={f.frameIndex}
                        src={f.dataUrl}
                        alt={f.cameraLabel}
                        className="w-full h-14 object-cover rounded border border-sky-500/40"
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Simulation Transport & Manual Intervention Controls */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsRunning(!isRunning)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold flex items-center gap-1.5 text-white transition cursor-pointer"
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
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium flex items-center gap-1.5 text-slate-200 transition cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Replay Current Layout
              </button>

              <button
                onClick={handleClearInterventions}
                className="px-3 py-1.5 rounded-lg bg-slate-800/80 hover:bg-red-950/60 hover:text-red-300 text-xs font-medium flex items-center gap-1.5 text-slate-400 transition cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Reset to Unmitigated Baseline
              </button>
            </div>

            {/* Gate Status Toggles */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] text-slate-400 flex items-center gap-1 mr-1">
                <DoorOpen className="w-3.5 h-3.5 text-slate-400" />
                Perimeter Gates:
              </span>
              {(
                [
                  { id: 'north_main', label: 'G1 North' },
                  { id: 'south_aux', label: 'G2 South' },
                  { id: 'west_emergency', label: 'G3 West' },
                  { id: 'east_stage', label: 'G4 East' },
                ] as const
              ).map((g) => {
                const isOpen = currentPlan.openGates.includes(g.id);
                return (
                  <button
                    key={g.id}
                    onClick={() => handleToggleGate(g.id)}
                    className={`px-2.5 py-1 rounded text-[11px] font-mono font-semibold border transition cursor-pointer ${
                      isOpen
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        : 'bg-red-500/10 border-red-500/30 text-red-400'
                    }`}
                  >
                    {g.label}: {isOpen ? 'OPEN' : 'LOCKED'}
                  </button>
                );
              })}
            </div>

            {/* Speed Selector & Secondary Attractor Toggle */}
            <div className="flex items-center gap-2 text-xs flex-wrap">
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
                  className={`px-2.5 py-1 rounded text-[11px] font-mono font-semibold border transition cursor-pointer ${
                    allowSecondaryAttractors
                      ? 'bg-fuchsia-500/20 border-fuchsia-500/40 text-fuchsia-300'
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-600'
                  }`}
                  title="When OFF, 100% of the crowd moves toward your single Tip and Argon only uses physical wave-breaker barriers & chicanes."
                >
                  Satellite Decoy Tips: {allowSecondaryAttractors ? 'ON (Split Crowd)' : 'OFF (Single Tip Only)'}
                </button>
              )}

              <span className="text-slate-400">Sim Speed:</span>
              {[1, 1.5, 2].map((spd) => (
                <button
                  key={spd}
                  onClick={() => setSimSpeed(spd)}
                  className={`px-2 py-0.5 rounded font-mono text-[11px] ${
                    simSpeed === spd
                      ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                      : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {spd}x
                </button>
              ))}
            </div>
          </div>

          {/* Active Physical Interventions Summary Strip */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-3.5 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <Layers className="w-4 h-4 text-sky-400" />
                <span>
                  Active 3D Physical Interventions in Arena (Iteration #{loopIteration})
                </span>
              </div>
              <div className="text-[11px] text-slate-400 font-mono">
                {currentPlan.barriers.length} 3D Barriers • {currentPlan.beacons.length} Optical Beacons • {currentPlan.openGates.length}/4 Gates Open
              </div>
            </div>

            {currentPlan.barriers.length === 0 && currentPlan.beacons.length === 0 ? (
              <div className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 flex items-center justify-between">
                <span>
                  Unmitigated Baseline: No wave-breaker barriers or directional signage beacons deployed yet.
                </span>
                <button
                  onClick={handleStartAutonomousLoop}
                  className="text-xs font-bold text-amber-300 underline hover:text-white cursor-pointer"
                >
                  Let Argon Watch CCTV & Fix Flow →
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {currentPlan.barriers.map((bar) => (
                  <div
                    key={bar.id}
                    className="bg-slate-950/80 border border-slate-800 rounded-lg px-3 py-1.5 text-[11px] flex items-center justify-between"
                  >
                    <div>
                      <span className="font-mono text-amber-400 font-semibold uppercase mr-1.5">
                        [{bar.kind.replace('_', ' ')}]
                      </span>
                      <span className="text-slate-300">{bar.reason || bar.id}</span>
                    </div>
                    <span className="font-mono text-slate-500 ml-2 shrink-0">
                      ({bar.x1},{bar.z1})→({bar.x2},{bar.z2})
                    </span>
                  </div>
                ))}
                {currentPlan.beacons.map((b) => (
                  <div
                    key={b.id}
                    className="bg-slate-950/80 border border-slate-800 rounded-lg px-3 py-1.5 text-[11px] flex items-center justify-between"
                  >
                    <div>
                      <span className="font-mono text-sky-400 font-semibold uppercase mr-1.5">
                        [{b.kind === 'dispersion_attractor' ? 'SAT-POD' : 'SIGNAGE'}]
                      </span>
                      <span className="text-slate-300">{b.label}</span>
                    </div>
                    <span className="font-mono text-slate-500 ml-2 shrink-0">
                      @({b.x},{b.z}) R={b.radius}m
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN (5 cols): Live CCTV Optical Feed + Argon Verification Loop */}
        <div className="lg:col-span-5 flex flex-col gap-3">
          {/* Card 1: Live CCTV Camera Feed (What Argon Actually Sees) */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-3.5 flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
                <Video className="w-4 h-4 text-red-400" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                  Live CCTV Optical Feed (Argon Vision Input)
                </h2>
              </div>
              <button
                onClick={handleAnalyzeNow}
                disabled={isAnalyzingCCTV}
                className="px-2.5 py-1 rounded-md bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/40 text-[11px] font-semibold flex items-center gap-1 transition cursor-pointer disabled:opacity-50"
              >
                <Camera className="w-3 h-3" />
                Critique CCTV Now
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
              {/* Live CCTV Canvas */}
              <div className="sm:col-span-7 relative rounded-lg overflow-hidden border border-slate-700/80 bg-slate-950">
                <canvas
                  ref={cctvPreviewCanvasRef}
                  width={360}
                  height={250}
                  className="w-full h-[185px] object-cover block"
                />
                <div className="cctv-scanlines absolute inset-0 pointer-events-none" />
              </div>

              {/* Real-Time Crowd Quake Telemetry & Captured Keyframes */}
              <div className="sm:col-span-5 flex flex-col gap-2">
                <div
                  className={`p-2.5 rounded-lg border ${
                    metrics.peakCrushPressure > maxCrushThreshold
                      ? 'bg-red-950/40 border-red-500/50 text-red-200'
                      : 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                  }`}
                >
                  <div className="text-[10px] font-mono uppercase opacity-80 flex items-center justify-between">
                    <span>Peak Crush Force</span>
                    {metrics.peakCrushPressure > maxCrushThreshold ? (
                      <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
                    ) : (
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                    )}
                  </div>
                  <div className="text-lg font-mono font-bold">
                    {metrics.peakCrushPressure.toFixed(2)} kN/m
                  </div>
                  <div className="text-[10px] opacity-80">
                    {metrics.peakCrushPressure > maxCrushThreshold
                      ? `FAILING: Exceeds ${maxCrushThreshold.toFixed(1)} kN/m Limit`
                      : `PASSING: Below ${maxCrushThreshold.toFixed(1)} kN/m Limit`}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-1.5 text-xs">
                  <div className="bg-slate-950 border border-slate-800 rounded-lg p-2">
                    <div className="text-[10px] text-slate-400">
                      {activeTip.mode === 'repel'
                        ? 'Evacuated'
                        : 'Reached Surge Tip'}
                    </div>
                    <div className="font-mono font-bold text-slate-100">
                      {activeTip.mode === 'repel'
                        ? `${metrics.evacuatedCount}/${metrics.totalAgents}`
                        : `${metrics.reachedTargetCount}/${metrics.totalAgents}`}
                    </div>
                  </div>
                  <div className="bg-slate-950 border border-slate-800 rounded-lg p-2">
                    <div className="text-[10px] text-slate-400">Flow Score</div>
                    <div className="font-mono font-bold text-sky-400">
                      {metrics.flowEfficiency}%
                    </div>
                  </div>
                </div>

                {/* 4 Sequential Keyframe Slots */}
                <div>
                  <div className="text-[10px] font-mono text-slate-400 mb-1 flex items-center justify-between">
                    <span>CCTV Clip Buffer (4 Frames):</span>
                    <span>{capturedFrames.length}/4 Snapped</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1">
                    {[0, 1, 2, 3].map((idx) => {
                      const f = capturedFrames[idx];
                      return f ? (
                        <img
                          key={idx}
                          src={f.dataUrl}
                          alt={f.cameraLabel}
                          className="w-full h-9 object-cover rounded border border-sky-500/50"
                          title={f.cameraLabel}
                        />
                      ) : (
                        <div
                          key={idx}
                          className="w-full h-9 rounded border border-dashed border-slate-700 bg-slate-950/60 flex items-center justify-center text-[9px] font-mono text-slate-500"
                        >
                          T+{CAPTURE_TIMESTAMPS[idx]}s
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Pass / Fail Threshold Sliders */}
            <div className="bg-slate-950/90 border border-slate-800/90 rounded-lg p-2.5 flex flex-col gap-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-sky-400" />
                  Test Pass Criteria Sliders (Live CCTV & Argon Thresholds)
                </span>
                <span className="font-mono text-[10px] text-slate-400">
                  {maxCrushThreshold <= 2.8
                    ? 'Strict Safety Standard'
                    : maxCrushThreshold >= 4.4
                    ? 'Lenient Standard'
                    : 'Standard OSHA/FEMA Limit'}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Slider 1: Max Allowable Crush Force */}
                <div className="bg-slate-900/80 border border-slate-800 rounded px-2.5 py-1.5">
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span className="text-slate-300">Max Crush Force to Pass:</span>
                    <span className="font-mono font-bold text-red-300">
                      &le; {maxCrushThreshold.toFixed(1)} kN/m
                    </span>
                  </div>
                  <input
                    type="range"
                    min={2.0}
                    max={5.5}
                    step={0.1}
                    value={maxCrushThreshold}
                    onChange={(e) => setMaxCrushThreshold( parseFloat(e.target.value) )}
                    className="w-full accent-sky-400 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
                  />
                  <div className="flex justify-between text-[9px] font-mono text-slate-500 mt-0.5">
                    <span>2.0 kN/m (Strict)</span>
                    <span>3.8 (Default)</span>
                    <span>5.5 kN/m (Lenient)</span>
                  </div>
                </div>

                {/* Slider 2: Min Argon Safety Score */}
                <div className="bg-slate-900/80 border border-slate-800 rounded px-2.5 py-1.5">
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span className="text-slate-300">Min Safety Score to Pass:</span>
                    <span className="font-mono font-bold text-sky-300">
                      &ge; {minSafetyScore}/100
                    </span>
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={95}
                    step={5}
                    value={minSafetyScore}
                    onChange={(e) => setMinSafetyScore( parseInt(e.target.value, 10) )}
                    className="w-full accent-sky-400 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
                  />
                  <div className="flex justify-between text-[9px] font-mono text-slate-500 mt-0.5">
                    <span>50 (Easy Pass)</span>
                    <span>80 (Default)</span>
                    <span>95 (Zero-Crush)</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Card 2: Gemini 4 Argon Closed-Loop Critique & Verification Log */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex-1 flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-sky-400" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                  Gemini 4 Argon Visual Critique & Closed Loop
                </h2>
              </div>
              {critiqueHistory.length > 0 && (
                <div className="flex items-center gap-1">
                  {critiqueHistory.map((c, idx) => (
                    <button
                      key={c.iteration + '-' + idx}
                      onClick={() => setSelectedCritiqueIndex(idx)}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono font-semibold transition cursor-pointer ${
                        selectedCritiqueIndex === idx
                          ? c.scenarioSuccess
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      Iter #{c.iteration} {c.scenarioSuccess ? '✓' : '↻'}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {!activeCritique ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-8 px-4 border border-dashed border-slate-800 rounded-xl bg-slate-950/40">
                <Activity className="w-8 h-8 text-sky-400/70 mb-2" />
                <h3 className="text-sm font-semibold text-slate-200 mb-1">
                  Ready to Run the Visual Verification Loop
                </h3>
                <p className="text-xs text-slate-400 max-w-sm mb-4">
                  1. Click anywhere on the 3D arena floor to place the{' '}
                  <strong className="text-slate-200">
                    {activeTip.mode === 'repel'
                      ? 'Hazard Repulsion Tip'
                      : 'Attraction Surge Tip'}
                  </strong>
                  .<br />
                  2. Click <strong>Start Autonomous Argon Loop</strong>. Argon will watch the 4 CCTV frames, detect any crowd crush arch, place 3D barriers/beacons, and re-test until safe!
                </p>
                <button
                  onClick={handleStartAutonomousLoop}
                  className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs flex items-center gap-2 transition cursor-pointer"
                >
                  <Sparkles className="w-4 h-4" />
                  Launch Closed-Loop Verification
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-3 text-xs">
                {/* Status Banner */}
                <div
                  className={`p-3 rounded-lg border flex items-center justify-between ${
                    activeCritique.scenarioSuccess
                      ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200'
                      : 'bg-amber-500/10 border-amber-500/40 text-amber-200'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    {activeCritique.scenarioSuccess ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                    ) : (
                      <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0" />
                    )}
                    <div>
                      <div className="font-bold text-sm">
                        {activeCritique.scenarioSuccess
                          ? `Iteration #${activeCritique.iteration} PASSED — Safe Flow Verified`
                          : `Iteration #${activeCritique.iteration} FAILED — Crush Bottleneck Detected`}
                      </div>
                      <div className="text-[11px] opacity-80 font-mono">
                        Model: {activeCritique.modelUsed} • Safety Score: {activeCritique.safetyScore}/100 • Peak Force: {activeCritique.metricsAtEvaluation.peakCrushPressure} kN/m
                      </div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase ${
                            activeCritique.isLiveApiCall
                              ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                              : 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                          }`}
                        >
                          {activeCritique.isLiveApiCall ? 'LIVE GEMINI API' : 'LOCAL OPTICAL FALLBACK'}
                        </span>
                        <span className="text-[10px] font-mono text-slate-400 truncate max-w-[360px]" title={activeCritique.executionLog}>
                          {activeCritique.executionLog}
                        </span>
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
                      className="px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs flex items-center gap-1 shrink-0 cursor-pointer"
                    >
                      Apply Fix & Test Iter #{activeCritique.iteration + 1}
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* What Argon Saw in the CCTV Frames */}
                <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3 space-y-2">
                  <div>
                    <div className="text-[10px] font-mono uppercase text-sky-400 font-semibold">
                      1. Optical CCTV Observation (From 4 Sequential Frames)
                    </div>
                    <p className="text-slate-200 mt-0.5 leading-relaxed">
                      {activeCritique.observedCrowdBehavior}
                    </p>
                  </div>

                  <div>
                    <div className="text-[10px] font-mono uppercase text-red-400 font-semibold">
                      2. Root-Cause Crowd Physics Diagnosis
                    </div>
                    <p className="text-slate-300 mt-0.5 leading-relaxed">
                      {activeCritique.rootCauseDiagnosis}
                    </p>
                  </div>

                  <div>
                    <div className="text-[10px] font-mono uppercase text-emerald-400 font-semibold">
                      3. Argon Spatial Intervention Plan
                    </div>
                    <p className="text-slate-300 mt-0.5 leading-relaxed">
                      {activeCritique.interventionReasoning}
                    </p>
                  </div>
                </div>

                {/* CCTV Frames Inspected in This Iteration */}
                <div>
                  <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1.5">
                    <span>CCTV Frames Sent to Gemini 4 Argon (Iter #{activeCritique.iteration}):</span>
                    <button
                      onClick={() => setShowZeroCheatModal(true)}
                      className="text-sky-400 hover:underline font-mono cursor-pointer"
                    >
                      View Raw Prompt & Payload →
                    </button>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {activeCritique.cctvFramesSent.map((frame) => (
                      <div
                        key={frame.frameIndex}
                        className="bg-slate-950 border border-slate-800 rounded overflow-hidden"
                      >
                        <img
                          src={frame.dataUrl}
                          alt={frame.cameraLabel}
                          className="w-full h-16 object-cover"
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
