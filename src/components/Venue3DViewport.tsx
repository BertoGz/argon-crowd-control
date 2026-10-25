import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  CrowdSimulationEngine,
  VENUE_HALF_D,
  VENUE_HALF_W,
} from '../engine/crowdPhysics';
import type {
  SimulationMetrics,
  TipPoint,
} from '../types/simulation';
import { Camera, Crosshair, Eye, Flame, Magnet } from 'lucide-react';

interface Venue3DViewportProps {
  engineRef: React.MutableRefObject<CrowdSimulationEngine>;
  activeTip: TipPoint;
  crushThreshold: number;
  isRunning: boolean;
  simSpeed: number;
  cameraPreset: 'isometric' | 'topdown' | 'angled';
  onCameraPresetChange: (preset: 'isometric' | 'topdown' | 'angled') => void;
  onTipPlacedByUser: (newTip: TipPoint) => void;
  onMetricsUpdate: (metrics: SimulationMetrics) => void;
  onCCTVFrameTick: (simSec: number, captureFrameFn: () => string) => void;
  cctvPreviewCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  highlightedItemId?: string | null;
  onSelectIntervention?: (id: string | null) => void;
}

export const Venue3DViewport: React.FC<Venue3DViewportProps> = ({
  engineRef,
  activeTip,
  crushThreshold,
  isRunning,
  simSpeed,
  cameraPreset,
  onCameraPresetChange,
  onTipPlacedByUser,
  onMetricsUpdate,
  onCCTVFrameTick,
  cctvPreviewCanvasRef,
  highlightedItemId = null,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [hoverCoords, setHoverCoords] = useState<{ x: number; z: number } | null>(null);

  // Refs to keep latest props inside requestAnimationFrame loop
  const isRunningRef = useRef(isRunning);
  const simSpeedRef = useRef(simSpeed);
  const onMetricsUpdateRef = useRef(onMetricsUpdate);
  const onCCTVFrameTickRef = useRef(onCCTVFrameTick);
  const onTipPlacedRef = useRef(onTipPlacedByUser);
  const highlightedItemIdRef = useRef<string | null>(highlightedItemId);

  useEffect(() => {
    isRunningRef.current = isRunning;
    simSpeedRef.current = simSpeed;
    onMetricsUpdateRef.current = onMetricsUpdate;
    onCCTVFrameTickRef.current = onCCTVFrameTick;
    onTipPlacedRef.current = onTipPlacedByUser;
    highlightedItemIdRef.current = highlightedItemId;
  }, [isRunning, simSpeed, onMetricsUpdate, onCCTVFrameTick, onTipPlacedByUser, highlightedItemId]);

  // Orbit angle state for manual camera rotation
  const cameraOrbitRef = useRef({ theta: 0.0, phi: 0.85, distance: 38 });
  const isDraggingOrbitRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (cameraPreset === 'isometric') {
      cameraOrbitRef.current = { theta: 0.32, phi: 0.82, distance: 38 };
    } else if (cameraPreset === 'topdown') {
      cameraOrbitRef.current = { theta: 0.0, phi: 0.08, distance: 36 };
    } else {
      cameraOrbitRef.current = { theta: -0.45, phi: 1.05, distance: 33 };
    }
  }, [cameraPreset]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 540;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070a10);
    scene.fog = new THREE.FogExp2(0x070a10, 0.011);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.5, 160);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0x94a3b8, 0.85);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.35);
    dirLight.position.set(16, 32, 20);
    scene.add(dirLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.55);
    rimLight.position.set(-22, 18, -16);
    scene.add(rimLight);

    // Arena Floor (40m x 30m)
    const floorGeo = new THREE.PlaneGeometry(VENUE_HALF_W * 2, VENUE_HALF_D * 2);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x0d131f,
      roughness: 0.8,
      metalness: 0.15,
    });
    const floorMesh = new THREE.Mesh(floorGeo, floorMeshMaterialWithGrid(floorMat));
    floorMesh.name = 'arena_floor';
    scene.add(floorMesh);

    // Tactical Metric Grid Overlay on Floor
    const gridHelper = new THREE.GridHelper(VENUE_HALF_W * 2, 20, 0x1e293b, 0x111827);
    gridHelper.position.y = 0.02;
    gridHelper.scale.z = VENUE_HALF_D / VENUE_HALF_W;
    scene.add(gridHelper);

    // Dynamic groups for walls/gates, barriers, beacons, tip, and agents
    const wallsGroup = new THREE.Group();
    scene.add(wallsGroup);

    const interventionsGroup = new THREE.Group();
    scene.add(interventionsGroup);

    const tipGroup = new THREE.Group();
    scene.add(tipGroup);

    // InstancedMesh for up to 350 Crowd Agents (Body + Head + Crush Ring)
    const maxAgents = 350;
    const bodyGeo = new THREE.CapsuleGeometry(0.28, 0.65, 6, 12);
    bodyGeo.translate(0, 0.6, 0);
    const bodyMat = new THREE.MeshStandardMaterial({
      roughness: 0.35,
      metalness: 0.2,
    });
    const agentInstanced = new THREE.InstancedMesh(bodyGeo, bodyMat, maxAgents);
    agentInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(agentInstanced);

    // Crush shockwave rings on floor under critical agents
    const ringGeo = new THREE.RingGeometry(0.38, 0.68, 20);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xef4444,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.75,
    });
    const crushRingsInstanced = new THREE.InstancedMesh(ringGeo, ringMat, maxAgents);
    crushRingsInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(crushRingsInstanced);

    // Tip visual meshes (Pillar + 2 Expanding Pulse Rings)
    const tipCoreGeo = new THREE.CylinderGeometry(0.45, 0.65, 2.8, 24);
    tipCoreGeo.translate(0, 1.4, 0);
    const tipCoreMat = new THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0xef4444,
      emissiveIntensity: 0.9,
      transparent: true,
      opacity: 0.9,
    });
    const tipCoreMesh = new THREE.Mesh(tipCoreGeo, tipCoreMat);
    tipGroup.add(tipCoreMesh);

    const tipPulseGeo = new THREE.RingGeometry(0.85, 1.1, 64);
    tipPulseGeo.rotateX(-Math.PI / 2);
    const tipPulseMat1 = new THREE.MeshBasicMaterial({
      color: 0xef4444,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.7,
    });
    const tipPulseMesh1 = new THREE.Mesh(tipPulseGeo, tipPulseMat1);
    tipPulseMesh1.position.y = 0.05;
    tipGroup.add(tipPulseMesh1);

    const tipPulseMat2 = tipPulseMat1.clone();
    const tipPulseMesh2 = new THREE.Mesh(tipPulseGeo, tipPulseMat2);
    tipPulseMesh2.position.y = 0.05;
    tipGroup.add(tipPulseMesh2);

    // Rebuild perimeter walls & gates + barriers + beacons whenever plan or highlight changes
    let lastPlanSignature = '';
    const highlightAnimatedMeshes: THREE.Object3D[] = [];

    const syncStaticArchitecture = () => {
      const eng = engineRef.current;
      const hlId = highlightedItemIdRef.current;
      const sig = JSON.stringify({
        gates: eng.gates.map((g) => g.isOpen),
        barriers: eng.barriers,
        beacons: eng.beacons,
        hlId,
      });
      if (sig === lastPlanSignature) return;
      lastPlanSignature = sig;

      // Clear groups
      wallsGroup.clear();
      interventionsGroup.clear();
      highlightAnimatedMeshes.length = 0;

      const wallMat = new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        roughness: 0.6,
        metalness: 0.4,
      });

      const wallHeight = 1.8;
      const wallThickness = 0.45;

      // Build North & South walls with gate openings (G1 at x=0, z=-15; G2 at x=0, z=+15)
      for (const side of [-1, 1]) {
        const zPos = side * VENUE_HALF_D;
        const gate = eng.gates.find((g) =>
          side === -1 ? g.id === 'north_main' : g.id === 'south_aux'
        );
        const gateHalfW = (gate?.width || 3.2) / 2;

        // Left segment: -20 to -gateHalfW
        const segW = VENUE_HALF_W - gateHalfW;
        const leftWall = new THREE.Mesh(
          new THREE.BoxGeometry(segW, wallHeight, wallThickness),
          wallMat
        );
        leftWall.position.set(-VENUE_HALF_W + segW / 2, wallHeight / 2, zPos);
        wallsGroup.add(leftWall);

        // Right segment: +gateHalfW to +20
        const rightWall = new THREE.Mesh(
          new THREE.BoxGeometry(segW, wallHeight, wallThickness),
          wallMat
        );
        rightWall.position.set(VENUE_HALF_W - segW / 2, wallHeight / 2, zPos);
        wallsGroup.add(rightWall);

        // Gate status portal bar / barrier
        if (gate) {
          const gateColor = gate.isOpen ? 0x10b981 : 0xef4444;
          const archMat = new THREE.MeshStandardMaterial({
            color: gateColor,
            emissive: gateColor,
            emissiveIntensity: 0.7,
            transparent: true,
            opacity: gate.isOpen ? 0.35 : 0.85,
          });
          const gateHeight = gate.isOpen ? 0.25 : wallHeight * 0.9;
          const gateY = gate.isOpen ? wallHeight + 0.15 : gateHeight / 2;
          const gateMesh = new THREE.Mesh(
            new THREE.BoxGeometry(gate.width, gateHeight, 0.28),
            archMat
          );
          gateMesh.position.set(gate.x, gateY, zPos);
          wallsGroup.add(gateMesh);
        }
      }

      // Build West & East walls with gate openings (G3 at x=-20, z=0; G4 at x=+20, z=0)
      for (const side of [-1, 1]) {
        const xPos = side * VENUE_HALF_W;
        const gate = eng.gates.find((g) =>
          side === -1 ? g.id === 'west_emergency' : g.id === 'east_stage'
        );
        const gateHalfW = (gate?.width || 3.2) / 2;
        const segD = VENUE_HALF_D - gateHalfW;

        const topWall = new THREE.Mesh(
          new THREE.BoxGeometry(wallThickness, wallHeight, segD),
          wallMat
        );
        topWall.position.set(xPos, wallHeight / 2, -VENUE_HALF_D + segD / 2);
        wallsGroup.add(topWall);

        const botWall = new THREE.Mesh(
          new THREE.BoxGeometry(wallThickness, wallHeight, segD),
          wallMat
        );
        botWall.position.set(xPos, wallHeight / 2, VENUE_HALF_D - segD / 2);
        wallsGroup.add(botWall);

        if (gate) {
          const gateColor = gate.isOpen ? 0x10b981 : 0xef4444;
          const archMat = new THREE.MeshStandardMaterial({
            color: gateColor,
            emissive: gateColor,
            emissiveIntensity: 0.7,
            transparent: true,
            opacity: gate.isOpen ? 0.35 : 0.85,
          });
          const gateHeight = gate.isOpen ? 0.25 : wallHeight * 0.9;
          const gateY = gate.isOpen ? wallHeight + 0.15 : gateHeight / 2;
          const gateMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.28, gateHeight, gate.width),
            archMat
          );
          gateMesh.position.set(xPos, gateY, gate.z);
          wallsGroup.add(gateMesh);
        }
      }

      // Render Argon-deployed 3D Barriers (Wave-breakers, Funnel Walls, Chicanes)
      for (const bar of eng.barriers) {
        const dx = bar.x2 - bar.x1;
        const dz = bar.z2 - bar.z1;
        const len = Math.hypot(dx, dz) || 1;
        const midX = (bar.x1 + bar.x2) / 2;
        const midZ = (bar.z1 + bar.z2) / 2;
        const angle = Math.atan2(dz, dx);

        const isHighlighted = hlId === 'ALL' || hlId === bar.id;
        const isDimmed = hlId !== null && !isHighlighted;

        const barColor =
          bar.kind === 'funnel_wall'
            ? 0x38bdf8
            : bar.kind === 'chicane'
            ? 0xa855f7
            : 0xf59e0b;

        const barMat = new THREE.MeshStandardMaterial({
          color: isHighlighted ? barColor : 0x1e293b,
          emissive: barColor,
          emissiveIntensity: isHighlighted ? 1.15 : isDimmed ? 0.2 : 0.55,
          roughness: 0.3,
          metalness: 0.7,
          transparent: isDimmed,
          opacity: isDimmed ? 0.45 : 1,
        });

        const barMesh = new THREE.Mesh(
          new THREE.BoxGeometry(len, isHighlighted ? 1.65 : 1.35, isHighlighted ? 0.48 : 0.36),
          barMat
        );
        barMesh.position.set(midX, isHighlighted ? 0.82 : 0.68, midZ);
        barMesh.rotation.y = -angle;
        interventionsGroup.add(barMesh);

        // Glowing top rail
        const railMat = new THREE.MeshBasicMaterial({
          color: isHighlighted ? 0xffffff : barColor,
          transparent: isDimmed,
          opacity: isDimmed ? 0.4 : 1,
        });
        const railMesh = new THREE.Mesh(
          new THREE.BoxGeometry(len + 0.08, 0.16, isHighlighted ? 0.52 : 0.42),
          railMat
        );
        railMesh.position.set(midX, isHighlighted ? 1.68 : 1.38, midZ);
        railMesh.rotation.y = -angle;
        interventionsGroup.add(railMesh);

        if (isHighlighted) {
          // Floor spotlight ring + vertical locator beam
          const ringRadius = Math.max(2.2, len * 0.62);
          const hlRing = new THREE.Mesh(
            new THREE.RingGeometry(ringRadius - 0.28, ringRadius, 48),
            new THREE.MeshBasicMaterial({
              color: 0xfbbf24,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.85,
            })
          );
          hlRing.rotation.x = -Math.PI / 2;
          hlRing.position.set(midX, 0.08, midZ);
          interventionsGroup.add(hlRing);
          highlightAnimatedMeshes.push(hlRing);

          const beamMesh = new THREE.Mesh(
            new THREE.CylinderGeometry(0.12, 0.45, 5.5, 16),
            new THREE.MeshBasicMaterial({
              color: 0xfbbf24,
              transparent: true,
              opacity: 0.25,
            })
          );
          beamMesh.position.set(midX, 2.75, midZ);
          interventionsGroup.add(beamMesh);
        }
      }

      // Render Argon-deployed 3D Beacons (Exit Signage & Dispersion Attractors)
      for (const b of eng.beacons) {
        const isHighlighted = hlId === 'ALL' || hlId === b.id;
        const isDimmed = hlId !== null && !isHighlighted;

        const beaconColor =
          b.kind === 'dispersion_attractor' ? 0xc084fc : 0x22d3ee;

        // Holographic Pylon
        const pylonMesh = new THREE.Mesh(
          new THREE.CylinderGeometry(isHighlighted ? 0.42 : 0.28, isHighlighted ? 0.52 : 0.38, isHighlighted ? 3.2 : 2.5, 16),
          new THREE.MeshStandardMaterial({
            color: isHighlighted ? 0xffffff : beaconColor,
            emissive: beaconColor,
            emissiveIntensity: isHighlighted ? 1.35 : isDimmed ? 0.25 : 0.85,
            transparent: true,
            opacity: isDimmed ? 0.4 : 0.92,
          })
        );
        pylonMesh.position.set(b.x, isHighlighted ? 1.6 : 1.25, b.z);
        interventionsGroup.add(pylonMesh);

        // Coverage radius ring on floor
        const covRing = new THREE.Mesh(
          new THREE.RingGeometry(b.radius - (isHighlighted ? 0.32 : 0.16), b.radius, 48),
          new THREE.MeshBasicMaterial({
            color: beaconColor,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: isHighlighted ? 0.85 : isDimmed ? 0.12 : 0.35,
          })
        );
        covRing.rotation.x = -Math.PI / 2;
        covRing.position.set(b.x, 0.05, b.z);
        interventionsGroup.add(covRing);

        if (isHighlighted) {
          const innerRing = new THREE.Mesh(
            new THREE.RingGeometry(1.1, 1.45, 36),
            new THREE.MeshBasicMaterial({
              color: 0x38bdf8,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.9,
            })
          );
          innerRing.rotation.x = -Math.PI / 2;
          innerRing.position.set(b.x, 0.09, b.z);
          interventionsGroup.add(innerRing);
          highlightAnimatedMeshes.push(innerRing);
        }

        // Direction vector line pointing toward target exit if exit_signage
        if (b.kind === 'exit_signage') {
          const dirX = b.targetX - b.x;
          const dirZ = b.targetZ - b.z;
          const dLen = Math.hypot(dirX, dirZ) || 1;
          const arrowLen = Math.min(4.5, dLen * 0.45);
          const arrowHelper = new THREE.ArrowHelper(
            new THREE.Vector3(dirX / dLen, 0, dirZ / dLen),
            new THREE.Vector3(b.x, 0.35, b.z),
            arrowLen,
            beaconColor,
            1.1,
            0.7
          );
          interventionsGroup.add(arrowHelper);
        }
      }
    };

    // Raycaster for user clicking on floor to place Tip
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const getFloorIntersection = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObject(floorMesh);
      if (hits.length > 0) {
        const pt = hits[0].point;
        return {
          x: Number(Math.max(-VENUE_HALF_W + 1.5, Math.min(VENUE_HALF_W - 1.5, pt.x)).toFixed(1)),
          z: Number(Math.max(-VENUE_HALF_D + 1.5, Math.min(VENUE_HALF_D - 1.5, pt.z)).toFixed(1)),
        };
      }
      return null;
    };

    const handlePointerDown = (e: MouseEvent) => {
      if (e.button === 2 || e.shiftKey) {
        isDraggingOrbitRef.current = true;
        dragStartRef.current = { x: e.clientX, y: e.clientY };
        return;
      }
      dragStartRef.current = { x: e.clientX, y: e.clientY };
    };

    const handlePointerMove = (e: MouseEvent) => {
      if (isDraggingOrbitRef.current) {
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        dragStartRef.current = { x: e.clientX, y: e.clientY };
        cameraOrbitRef.current.theta -= dx * 0.007;
        cameraOrbitRef.current.phi = Math.max(
          0.08,
          Math.min(1.38, cameraOrbitRef.current.phi - dy * 0.006)
        );
        return;
      }
      const pt = getFloorIntersection(e.clientX, e.clientY);
      setHoverCoords(pt);
    };

    const handlePointerUp = (e: MouseEvent) => {
      if (isDraggingOrbitRef.current) {
        isDraggingOrbitRef.current = false;
        return;
      }
      const movedDist = Math.hypot(
        e.clientX - dragStartRef.current.x,
        e.clientY - dragStartRef.current.y
      );
      if (movedDist < 6 && e.button === 0) {
        const pt = getFloorIntersection(e.clientX, e.clientY);
        if (pt) {
          const currentTip = engineRef.current.tip;
          onTipPlacedRef.current({
            ...currentTip,
            x: pt.x,
            z: pt.z,
          });
        }
      }
    };

    const domElem = renderer.domElement;
    domElem.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
    const preventContext = (e: MouseEvent) => e.preventDefault();
    domElem.addEventListener('contextmenu', preventContext);

    // Helper to render the Zero-Cheat CCTV Security Camera Feed Canvas
    // STRICT NO-COLOR-CHEATING: All pedestrians are rendered with identical neutral monochrome
    // head-and-shoulder silhouettes. No pressure colors, no red halos, no velocity vector arrows.
    const renderCCTVSecurityCanvas = () => {
      const cctvCanvas = cctvPreviewCanvasRef.current;
      if (!cctvCanvas) return;
      const ctx = cctvCanvas.getContext('2d');
      if (!ctx) return;

      const cw = cctvCanvas.width;
      const ch = cctvCanvas.height;
      const eng = engineRef.current;

      // Crisp monochrome CCTV background (no artificial motion trails or color cheats)
      ctx.fillStyle = '#090d14';
      ctx.fillRect(0, 0, cw, ch);

      const padLeft = 38;
      const padRight = 38;
      const padTop = 36;
      const padBottom = 26;
      const plotW = cw - padLeft - padRight;
      const plotH = ch - padTop - padBottom;

      const toScreenX = (x: number) =>
        padLeft + ((x + VENUE_HALF_W) / (VENUE_HALF_W * 2)) * plotW;
      const toScreenY = (z: number) =>
        padTop + ((z + VENUE_HALF_D) / (VENUE_HALF_D * 2)) * plotH;

      // Subtle architectural floor reference grid (so Argon can reference spatial coordinates)
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.lineWidth = 1;
      ctx.font = '10px monospace';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';

      for (let gx = -20; gx <= 20; gx += 10) {
        const sx = toScreenX(gx);
        ctx.beginPath();
        ctx.moveTo(sx, padTop);
        ctx.lineTo(sx, ch - padBottom);
        ctx.stroke();
        ctx.fillText(`X:${gx}`, sx - 12, ch - 8);
      }

      for (let gz = -15; gz <= 15; gz += 5) {
        const sy = toScreenY(gz);
        ctx.beginPath();
        ctx.moveTo(padLeft, sy);
        ctx.lineTo(cw - padRight, sy);
        ctx.stroke();
        if (gz % 10 === 0 || gz === -15 || gz === 15) {
          ctx.fillText(`Z:${gz}`, 4, sy + 3);
        }
      }

      // Draw Arena Perimeter Walls
      ctx.strokeStyle = 'rgba(203, 213, 225, 0.65)';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(padLeft, padTop, plotW, plotH);

      // Draw Physical Gate Openings (G1..G4)
      for (const g of eng.gates) {
        const gx = toScreenX(g.x);
        const gy = toScreenY(g.z);
        if (g.id === 'north_main' || g.id === 'south_aux') {
          const gw = (g.width / (VENUE_HALF_W * 2)) * plotW;
          // Clear wall opening if open, draw solid shutter bar if locked
          ctx.fillStyle = g.isOpen ? '#090d14' : '#64748b';
          ctx.fillRect(gx - gw / 2, gy - 3, gw, 6);
          if (g.isOpen) {
            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = 1;
            ctx.strokeRect(gx - gw / 2, gy - 3, gw, 6);
          }
        } else {
          const gh = (g.width / (VENUE_HALF_D * 2)) * plotH;
          ctx.fillStyle = g.isOpen ? '#090d14' : '#64748b';
          ctx.fillRect(gx - 3, gy - gh / 2, 6, gh);
          if (g.isOpen) {
            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = 1;
            ctx.strokeRect(gx - 3, gy - gh / 2, 6, gh);
          }
        }
        ctx.fillStyle = 'rgba(203, 213, 225, 0.75)';
        ctx.font = 'bold 8px monospace';
        ctx.fillText(
          `${g.id.split('_')[0].toUpperCase()}[${g.isOpen ? 'OPEN' : 'SHUT'}]`,
          Math.max(28, Math.min(cw - 88, gx - 26)),
          g.z < 0 ? gy - 6 : g.z > 0 ? gy + 13 : gy - 8
        );
      }

      // Draw Physical Beacons / Pylons as structural markers
      for (const b of eng.beacons) {
        const bx = toScreenX(b.x);
        const by = toScreenY(b.z);
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(bx, by, 5, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Draw Physical Barriers (Steel Baffles)
      for (const bar of eng.barriers) {
        const x1 = toScreenX(bar.x1);
        const y1 = toScreenY(bar.z1);
        const x2 = toScreenX(bar.x2);
        const y2 = toScreenY(bar.z2);
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      // Draw User Tip Point Marker (Physical anomaly/stage marker on floor)
      const tx = toScreenX(eng.tip.x);
      const ty = toScreenY(eng.tip.z);
      ctx.strokeStyle = 'rgba(248, 250, 252, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.arc(tx, ty, 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(248, 250, 252, 0.85)';
      ctx.font = 'bold 8px monospace';
      ctx.fillText('TIP', tx - 9, ty - 12);

      // Draw Crowd Agents as UNIFORM MONOCHROME Overhead Human Silhouettes (Shoulders + Head)
      // ZERO color-coding of crush pressure, panic, or speed!
      for (const a of eng.agents) {
        if (a.evacuated) continue;
        const ax = toScreenX(a.x);
        const ay = toScreenY(a.z);

        // Shoulders silhouette (uniform neutral gray)
        ctx.fillStyle = 'rgba(148, 163, 184, 0.78)';
        ctx.beginPath();
        ctx.arc(ax, ay, 3.1, 0, Math.PI * 2);
        ctx.fill();

        // Head center (uniform light gray)
        ctx.fillStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.arc(ax, ay, 1.55, 0, Math.PI * 2);
        ctx.fill();
      }

      // CCTV HUD Watermark Header
      ctx.fillStyle = 'rgba(2, 6, 23, 0.82)';
      ctx.fillRect(0, 0, cw, 20);
      ctx.font = 'bold 10px monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('● REC  CAM-01 MONOCHROME CCTV (NO COLOR TELEMETRY)', 8, 13);
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(
        `T+${eng.elapsedSeconds.toFixed(1)}s`,
        cw - 58,
        13
      );
    };

    const dummy = new THREE.Object3D();
    const ringDummy = new THREE.Object3D();
    const color = new THREE.Color();

    let animId = 0;
    let lastTime = performance.now();
    let frameCounter = 0;

    const animate = (now: number) => {
      animId = requestAnimationFrame(animate);
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;
      frameCounter++;

      const eng = engineRef.current;

      if (isRunningRef.current) {
        const metrics = eng.step(dt * simSpeedRef.current);
        if (frameCounter % 3 === 0) {
          onMetricsUpdateRef.current(metrics);
        }
        onCCTVFrameTickRef.current(eng.elapsedSeconds, () => {
          renderCCTVSecurityCanvas();
          return cctvPreviewCanvasRef.current?.toDataURL('image/png') || '';
        });
      }

      syncStaticArchitecture();

      // Pulse highlighted intervention rings
      if (highlightAnimatedMeshes.length > 0) {
        const hlScale = 1 + Math.sin(now * 0.008) * 0.12;
        for (const m of highlightAnimatedMeshes) {
          m.scale.set(hlScale, hlScale, 1);
        }
      }

      // Update Tip 3D Marker & Expanding Pulse Rings
      const tip = eng.tip;
      tipGroup.position.set(tip.x, 0, tip.z);
      const tipColorHex = tip.mode === 'repel' ? 0xef4444 : 0xd946ef;
      tipCoreMat.color.setHex(tipColorHex);
      tipCoreMat.emissive.setHex(tipColorHex);
      tipPulseMat1.color.setHex(tipColorHex);
      tipPulseMat2.color.setHex(tipColorHex);

      const pulseSpeed = 0.00042;
      const pulsePhase1 = (now * pulseSpeed) % 1;
      const pulsePhase2 = ((now * pulseSpeed) + 0.5) % 1;

      // In repel mode, waves expand outward; in attract mode, waves contract inward!
      // Because tipPulseGeo vertices were rotated into the XZ plane, scale X and Z equally for a true circle.
      const s1 = tip.mode === 'repel' ? 1 + pulsePhase1 * 6.0 : 1 + (1 - pulsePhase1) * 6.0;
      const s2 = tip.mode === 'repel' ? 1 + pulsePhase2 * 6.0 : 1 + (1 - pulsePhase2) * 6.0;
      tipPulseMesh1.scale.set(s1, 1, s1);
      tipPulseMat1.opacity = (1 - pulsePhase1) * 0.55;
      tipPulseMesh2.scale.set(s2, 1, s2);
      tipPulseMat2.opacity = (1 - pulsePhase2) * 0.55;

      // Update Crowd Agent Instances
      for (let i = 0; i < maxAgents; i++) {
        const a = eng.agents[i];
        if (!a || a.evacuated) {
          dummy.position.set(0, -50, 0);
          dummy.scale.set(0.001, 0.001, 0.001);
          dummy.updateMatrix();
          agentInstanced.setMatrixAt(i, dummy.matrix);

          ringDummy.position.set(0, -50, 0);
          ringDummy.scale.set(0.001, 0.001, 0.001);
          ringDummy.updateMatrix();
          crushRingsInstanced.setMatrixAt(i, ringDummy.matrix);
          continue;
        }

        const bob = Math.sin(now * 0.014 + a.id) * 0.06;
        dummy.position.set(a.x, Math.max(0, bob), a.z);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        agentInstanced.setMatrixAt(i, dummy.matrix);

        // Dynamic color based on physical crush pressure
        const crushLimit = eng.crushThreshold;
        if (a.crushPressure > crushLimit) {
          color.setHex(0xef4444); // Critical Red Crush
        } else if (a.crushPressure > crushLimit * 0.58) {
          color.setHex(0xf59e0b); // Agitated Amber
        } else if (a.guidedByBeaconId) {
          color.setHex(0x38bdf8); // Guided by Argon Beacon (Sky Cyan)
        } else {
          color.setHex(0x10b981); // Calm Emerald Flow
        }
        agentInstanced.setColorAt(i, color);

        // Show floor crush shockwave ring if agent is in critical compression
        if (a.crushPressure > crushLimit) {
          const ringScale = 1.0 + Math.sin(now * 0.012 + a.id) * 0.2;
          ringDummy.position.set(a.x, 0.04, a.z);
          ringDummy.scale.set(ringScale, 1, ringScale);
          ringDummy.updateMatrix();
          crushRingsInstanced.setMatrixAt(i, ringDummy.matrix);
        } else {
          ringDummy.position.set(0, -50, 0);
          ringDummy.scale.set(0.001, 0.001, 0.001);
          ringDummy.updateMatrix();
          crushRingsInstanced.setMatrixAt(i, ringDummy.matrix);
        }
      }

      agentInstanced.instanceMatrix.needsUpdate = true;
      if (agentInstanced.instanceColor) {
        agentInstanced.instanceColor.needsUpdate = true;
      }
      crushRingsInstanced.instanceMatrix.needsUpdate = true;

      // Update Orbit Camera position smoothly
      const { theta, phi, distance } = cameraOrbitRef.current;
      const targetX = distance * Math.sin(phi) * Math.sin(theta);
      const targetY = distance * Math.cos(phi);
      const targetZ = distance * Math.sin(phi) * Math.cos(theta);
      camera.position.lerp(new THREE.Vector3(targetX, targetY, targetZ), 0.14);
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);

      // Update Live CCTV Feed Canvas every 2 frames
      if (frameCounter % 2 === 0) {
        renderCCTVSecurityCanvas();
      }
    };

    animId = requestAnimationFrame(animate);

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || 800;
      const h = container.clientHeight || 480;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      domElem.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', handlePointerUp);
      domElem.removeEventListener('contextmenu', preventContext);
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
    };
  }, [engineRef, cctvPreviewCanvasRef]);

  const currentTip = activeTip;

  return (
    <div className="relative w-full h-full bg-slate-950 rounded-xl overflow-hidden border border-slate-800/90 shadow-2xl select-none">
      {/* Main Three.js WebGL Viewport */}
      <div ref={mountRef} className="w-full h-full cursor-crosshair" />

      {/* Top-Left HUD Overlay: Compact Scenario Indicator & Color Legend */}
      <div className="absolute top-3 left-3 flex flex-col gap-1.5 pointer-events-none">
        <div className="flex items-center gap-2 bg-slate-950/85 backdrop-blur-md border border-slate-800 px-3 py-1.5 rounded-lg text-xs text-slate-200">
          {currentTip.mode === 'repel' ? (
            <Flame className="w-3.5 h-3.5 text-red-400 shrink-0" />
          ) : (
            <Magnet className="w-3.5 h-3.5 text-fuchsia-400 shrink-0" />
          )}
          <span className="font-medium">
            {currentTip.mode === 'repel' ? 'Hazard Egress (Repel)' : 'Focal Surge (Attract)'}
          </span>
          <span className="text-slate-500">•</span>
          <span className="font-mono text-[11px] text-slate-400 flex items-center gap-1">
            <Crosshair className="w-3 h-3 text-sky-400" />
            Tip ({currentTip.x}m, {currentTip.z}m)
          </span>
        </div>

        {/* Color Legend */}
        <div className="flex flex-wrap items-center gap-2.5 bg-slate-950/80 backdrop-blur-md border border-slate-800/80 px-2.5 py-1 rounded-md text-[11px] text-slate-400">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
            Calm
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-sky-400 inline-block" />
            Guided
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />
            High Pressure
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
            <span className="text-red-300">
              Crush Force (&gt;{crushThreshold.toFixed(1)} kN/m)
            </span>
          </span>
        </div>
      </div>

      {/* Top-Right Camera View Controls */}
      <div className="absolute top-3 right-3 flex items-center gap-1 bg-slate-950/85 backdrop-blur-md border border-slate-800 p-1 rounded-lg">
        <button
          onClick={() => onCameraPresetChange('isometric')}
          className={`px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1 transition cursor-pointer ${
            cameraPreset === 'isometric'
              ? 'bg-slate-800 text-white border border-slate-700'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Eye className="w-3.5 h-3.5" />
          3D Director
        </button>
        <button
          onClick={() => onCameraPresetChange('topdown')}
          className={`px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1 transition cursor-pointer ${
            cameraPreset === 'topdown'
              ? 'bg-slate-800 text-white border border-slate-700'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Camera className="w-3.5 h-3.5" />
          Top-Down
        </button>
        <button
          onClick={() => onCameraPresetChange('angled')}
          className={`px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1 transition cursor-pointer ${
            cameraPreset === 'angled'
              ? 'bg-slate-800 text-white border border-slate-700'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Stadium
        </button>
      </div>

      {/* Bottom-Left Live Cursor Coordinate Readout */}
      <div className="absolute bottom-3 left-3 bg-slate-950/80 backdrop-blur border border-slate-800/80 px-2.5 py-1 rounded text-[11px] font-mono text-slate-400 pointer-events-none">
        {hoverCoords
          ? `X=${hoverCoords.x.toFixed(1)}m, Z=${hoverCoords.z.toFixed(1)}m • Click floor to move Tip`
          : 'Click floor to place Tip • Right-drag to orbit'}
      </div>
    </div>
  );
};

function floorMeshMaterialWithGrid(mat: THREE.MeshStandardMaterial) {
  return mat;
}
