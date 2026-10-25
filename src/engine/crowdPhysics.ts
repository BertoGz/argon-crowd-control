import type {
  BarrierIntervention,
  BeaconIntervention,
  CrowdAgent,
  PhysicalInterventionPlan,
  PresetScenario,
  SimulationMetrics,
  TipPoint,
  Vec2,
  VenueGate,
} from '../types/simulation';

export const VENUE_HALF_W = 20; // x: -20 to +20 (40m wide)
export const VENUE_HALF_D = 15; // z: -15 to +15 (30m deep)

export const DEFAULT_GATES: VenueGate[] = [
  {
    id: 'north_main',
    name: 'North Main Exit (G1)',
    x: 0,
    z: -VENUE_HALF_D,
    width: 3.4,
    normalX: 0,
    normalZ: -1,
    isOpen: true,
  },
  {
    id: 'south_aux',
    name: 'South Concourse Gate (G2)',
    x: 0,
    z: VENUE_HALF_D,
    width: 3.2,
    normalX: 0,
    normalZ: 1,
    isOpen: false,
  },
  {
    id: 'west_emergency',
    name: 'West Emergency Egress (G3)',
    x: -VENUE_HALF_W,
    z: 0,
    width: 3.2,
    normalX: -1,
    normalZ: 0,
    isOpen: false,
  },
  {
    id: 'east_stage',
    name: 'East Side Gate (G4)',
    x: VENUE_HALF_W,
    z: 0,
    width: 3.2,
    normalX: 1,
    normalZ: 0,
    isOpen: false,
  },
];

export const PRESET_SCENARIOS: PresetScenario[] = [
  {
    id: 'repel_pyro_panic',
    title: 'Demo 1: Repel from Hazard Tip (Panic Egress)',
    subtitle: 'Crowd runs AWAY from user-placed hazard tip -> Exit bottleneck & arching crush',
    mode: 'repel',
    description:
      'A sudden hazard triggers panic repulsion. Herding behavior drives the entire crowd toward the North Main Exit while ignoring side exits, forming a lethal compressive arch.',
    tip: {
      x: 0,
      z: 4.5,
      mode: 'repel',
      label: 'Hazard Tip (Pyro / Smoke Anomaly)',
      intensity: 1.45,
      radius: 14,
    },
    initialGates: ['north_main'],
    agentCount: 240,
  },
  {
    id: 'attract_stage_surge',
    title: 'Demo 2: Attract to Focal Tip (Festival Surge)',
    subtitle: 'Crowd rushes TOWARDS user-placed attraction tip -> Radial crowd quake & crush',
    mode: 'attract',
    description:
      'A surprise focal drop pulls the entire crowd radially toward a single point. Unbroken inflow from all angles creates a lethal >5 kN/m crowd crush at the core.',
    tip: {
      x: 2.5,
      z: -2.0,
      mode: 'attract',
      label: 'Attraction Tip (Surprise Artist / VIP Drop)',
      intensity: 1.5,
      radius: 18,
    },
    initialGates: ['north_main', 'south_aux'],
    agentCount: 240,
  },
];

// Closest point on line segment AB to point P
function closestPointOnSegment(
  px: number,
  pz: number,
  x1: number,
  z1: number,
  x2: number,
  z2: number
): { x: number; z: number; dist: number; t: number } {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-6) {
    const dist = Math.hypot(px - x1, pz - z1);
    return { x: x1, z: z1, dist, t: 0 };
  }
  let t = ((px - x1) * dx + (pz - z1) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cz = z1 + t * dz;
  const dist = Math.hypot(px - cx, pz - cz);
  return { x: cx, z: cz, dist, t };
}

export class CrowdSimulationEngine {
  public agents: CrowdAgent[] = [];
  public gates: VenueGate[] = [];
  public barriers: BarrierIntervention[] = [];
  public beacons: BeaconIntervention[] = [];
  public tip: TipPoint;
  public elapsedSeconds = 0;
  public peakCrushPressure = 0;
  public crushPocketEvents = 0;
  public crushThreshold = 3.8;
  private rngSeed = 1337;

  constructor(preset: PresetScenario = PRESET_SCENARIOS[0]) {
    this.tip = { ...preset.tip };
    this.reset(preset.agentCount, this.tip, {
      barriers: [],
      beacons: [],
      openGates: [...preset.initialGates],
    });
  }

  private seededRandom(): number {
    // Deterministic LCG so same Tip + interventions produces reproducible physics
    this.rngSeed = (this.rngSeed * 1664525 + 1013904223) % 4294967296;
    return this.rngSeed / 4294967296;
  }

  public reset(
    agentCount: number,
    tip: TipPoint,
    plan: PhysicalInterventionPlan
  ): void {
    this.rngSeed = 42069;
    this.tip = { ...tip };
    this.elapsedSeconds = 0;
    this.peakCrushPressure = 0;
    this.crushPocketEvents = 0;

    this.gates = DEFAULT_GATES.map((g) => ({
      ...g,
      isOpen: plan.openGates.includes(g.id),
    }));
    // Ensure at least north_main is open if empty
    if (!this.gates.some((g) => g.isOpen)) {
      this.gates[0].isOpen = true;
    }

    this.barriers = plan.barriers.map((b) => ({ ...b }));
    this.beacons = plan.beacons.map((b) => ({ ...b }));

    this.agents = [];
    for (let i = 0; i < agentCount; i++) {
      let x = (this.seededRandom() * 2 - 1) * (VENUE_HALF_W - 2.4);
      let z = (this.seededRandom() * 2 - 1) * (VENUE_HALF_D - 2.4);

      // In repel mode, don't spawn directly on top of the fire/hazard core
      if (tip.mode === 'repel') {
        const d = Math.hypot(x - tip.x, z - tip.z);
        if (d < 3.0) {
          const angle = this.seededRandom() * Math.PI * 2;
          x = Math.max(-VENUE_HALF_W + 2, Math.min(VENUE_HALF_W - 2, tip.x + Math.cos(angle) * 4.2));
          z = Math.max(-VENUE_HALF_D + 2, Math.min(VENUE_HALF_D - 2, tip.z + Math.sin(angle) * 4.2));
        }
      }

      // Push slightly away from any placed barrier
      for (const bar of this.barriers) {
        const seg = closestPointOnSegment(x, z, bar.x1, bar.z1, bar.x2, bar.z2);
        if (seg.dist < 0.8) {
          const nx = (x - seg.x) / (seg.dist || 1);
          const nz = (z - seg.z) / (seg.dist || 1);
          x += nx * 1.1;
          z += nz * 1.1;
        }
      }

      const initialPanic =
        tip.mode === 'repel'
          ? Math.max(0.25, Math.min(0.95, 1.1 - Math.hypot(x - tip.x, z - tip.z) / 18))
          : 0.35;

      this.agents.push({
        id: i,
        x,
        z,
        vx: 0,
        vz: 0,
        desiredSpeed: 2.1 + this.seededRandom() * 0.55,
        radius: 0.34 + (i % 3) * 0.02,
        panic: initialPanic,
        crushPressure: 0,
        localDensity: 1.0,
        evacuated: false,
        satisfiedAttract: false,
        targetGateId: 'north_main',
        guidedByBeaconId: null,
      });
    }
  }

  public setTip(newTip: TipPoint): void {
    this.tip = { ...newTip };
  }

  public applyInterventionPlan(plan: PhysicalInterventionPlan): void {
    this.barriers = plan.barriers.map((b) => ({ ...b }));
    this.beacons = plan.beacons.map((b) => ({ ...b }));
    this.gates = DEFAULT_GATES.map((g) => ({
      ...g,
      isOpen: plan.openGates.includes(g.id),
    }));
    if (!this.gates.some((g) => g.isOpen)) {
      this.gates[0].isOpen = true;
    }
  }

  public step(dt: number): SimulationMetrics {
    const clampedDt = Math.min(dt, 0.04);
    this.elapsedSeconds += clampedDt;

    const activeAgents = this.agents.filter((a) => !a.evacuated);
    const openGates = this.gates.filter((g) => g.isOpen);

    // Spatial hash grid for fast neighbor queries (cell size 2.0m)
    const cellSize = 2.0;
    const grid = new Map<string, CrowdAgent[]>();
    for (const a of activeAgents) {
      const cx = Math.floor(a.x / cellSize);
      const cz = Math.floor(a.z / cellSize);
      const key = `${cx},${cz}`;
      let list = grid.get(key);
      if (!list) {
        list = [];
        grid.set(key, list);
      }
      list.push(a);
    }

    const getNeighbors = (agent: CrowdAgent): CrowdAgent[] => {
      const cx = Math.floor(agent.x / cellSize);
      const cz = Math.floor(agent.z / cellSize);
      const result: CrowdAgent[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cell = grid.get(`${cx + dx},${cz + dz}`);
          if (cell) {
            for (const other of cell) {
              if (other.id !== agent.id) result.push(other);
            }
          }
        }
      }
      return result;
    };

    // Wave-breaker protection factor in attract mode:
    // Count how many wave-breaker barriers or dispersion beacons surround the attraction tip
    const dispersionBeacons = this.beacons.filter((b) => b.kind === 'dispersion_attractor');
    const exitBeacons = this.beacons.filter((b) => b.kind === 'exit_signage');

    for (const a of activeAgents) {
      const neighbors = getNeighbors(a);

      // 1. Compute local density & average neighbor velocity (for herding)
      let closeCount = 0;
      let avgNvx = 0;
      let avgNvz = 0;
      let neighborPanicSum = 0;

      for (const n of neighbors) {
        const d = Math.hypot(a.x - n.x, a.z - n.z);
        if (d < 1.6) {
          closeCount++;
          avgNvx += n.vx;
          avgNvz += n.vz;
          neighborPanicSum += n.panic;
        }
      }

      // Area of circle r=1.6m is ~8.04 m^2, but effective personal space packing scales density:
      a.localDensity = Math.min(9.5, (closeCount + 1) / 1.45);

      // 2. Update Panic Contagion
      const distToTip = Math.hypot(a.x - this.tip.x, a.z - this.tip.z);
      if (this.tip.mode === 'repel') {
        const hazardPanic = Math.max(0, 1 - distToTip / (this.tip.radius * 1.25)) * this.tip.intensity;
        const neighborPanic = closeCount > 0 ? neighborPanicSum / closeCount : a.panic;
        const densityPanic = a.localDensity > 3.8 ? 0.35 : 0;
        a.panic = Math.max(0.15, Math.min(1.0, a.panic * 0.92 + (hazardPanic * 0.5 + neighborPanic * 0.4 + densityPanic) * 0.08));
      } else {
        // Attract / surge mode: excitement turns to panic when compressed near the focal point
        const surgeExcitement = Math.max(0.2, 1 - distToTip / 22);
        const crushPanic = a.localDensity > 4.0 ? 0.5 : 0;
        a.panic = Math.max(0.2, Math.min(1.0, a.panic * 0.9 + (surgeExcitement * 0.5 + crushPanic) * 0.1));
      }

      // 3. Determine Desired Goal Vector (e_x, e_z)
      let goalX = 0;
      let goalZ = 0;
      a.guidedByBeaconId = null;

      if (this.tip.mode === 'repel') {
        // Check if agent is within range of an Argon-placed Exit Signage Beacon
        let activeBeacon: BeaconIntervention | null = null;
        let bestBeaconDist = Infinity;
        for (const b of exitBeacons) {
          const bd = Math.hypot(a.x - b.x, a.z - b.z);
          if (bd <= b.radius && bd < bestBeaconDist) {
            bestBeaconDist = bd;
            activeBeacon = b;
          }
        }

        if (activeBeacon) {
          a.guidedByBeaconId = activeBeacon.id;
          // Calm panic slightly due to clear visual guidance
          a.panic = Math.max(0.15, a.panic - 0.35 * clampedDt);
          // Find open gate closest to beacon's targetX, targetZ
          let chosenGate = openGates[0];
          let minGateDist = Infinity;
          for (const g of openGates) {
            const gd = Math.hypot(g.x - activeBeacon.targetX, g.z - activeBeacon.targetZ);
            if (gd < minGateDist) {
              minGateDist = gd;
              chosenGate = g;
            }
          }
          a.targetGateId = chosenGate.id;
          goalX = chosenGate.x - a.x;
          goalZ = chosenGate.z - a.z;
        } else {
          // Non-rational human behavior under panic:
          // Panicked agents strongly herd toward the familiar North Main Exit (or follow neighbor stampede)
          // unless they are already right next to another open exit (< 8.5m away).
          let chosenGate = openGates.find((g) => g.id === 'north_main') || openGates[0];
          for (const g of openGates) {
            const distToGate = Math.hypot(g.x - a.x, g.z - a.z);
            // Only notice auxiliary gates if very close or low panic
            const awarenessRadius = a.panic > 0.55 ? 8.5 : 15.0;
            if (distToGate < awarenessRadius) {
              const distToDefault = Math.hypot(chosenGate.x - a.x, chosenGate.z - a.z);
              if (distToGate < distToDefault * 0.85) {
                chosenGate = g;
              }
            }
          }
          a.targetGateId = chosenGate.id;

          // Combine direct repulsion away from the Hazard Tip + pull toward chosen exit
          const awayX = a.x - this.tip.x;
          const awayZ = a.z - this.tip.z;
          const awayLen = Math.hypot(awayX, awayZ) || 1;
          const repelWeight = distToTip < this.tip.radius ? (1 - distToTip / this.tip.radius) * 1.45 * this.tip.intensity : 0.15;

          const toGateX = chosenGate.x - a.x;
          const toGateZ = chosenGate.z - a.z;
          const toGateLen = Math.hypot(toGateX, toGateZ) || 1;

          goalX = (awayX / awayLen) * repelWeight + (toGateX / toGateLen) * 1.15;
          goalZ = (awayZ / awayLen) * repelWeight + (toGateZ / toGateLen) * 1.15;
        }

        // Apply Herding component (panicked agents copy neighbor velocity)
        if (closeCount > 0 && a.panic > 0.45 && !a.guidedByBeaconId) {
          const nLen = Math.hypot(avgNvx, avgNvz);
          if (nLen > 0.1) {
            const herdWeight = (a.panic - 0.35) * 0.65;
            goalX = goalX * (1 - herdWeight) + (avgNvx / nLen) * herdWeight;
            goalZ = goalZ * (1 - herdWeight) + (avgNvz / nLen) * herdWeight;
          }
        }
      } else {
        // MODE 2: ATTRACT ("Move Towards Tip")
        // By default, everyone rushes straight toward the user-placed Attraction Tip.
        // If Argon placed Dispersion Attractors (secondary stages/screens/zones), a subset of agents
        // nearest to or modularly assigned to those dispersion beacons diverts to them!
        let targetX = this.tip.x;
        let targetZ = this.tip.z;

        if (dispersionBeacons.length > 0) {
          // Check if agent is captured by a dispersion beacon
          for (let bIdx = 0; bIdx < dispersionBeacons.length; bIdx++) {
            const b = dispersionBeacons[bIdx];
            const distToBeacon = Math.hypot(a.x - b.x, a.z - b.z);
            if (distToBeacon < b.radius || a.id % (dispersionBeacons.length + 1) === bIdx + 1) {
              targetX = b.x;
              targetZ = b.z;
              a.guidedByBeaconId = b.id;
              break;
            }
          }
        }

        const dx = targetX - a.x;
        const dz = targetZ - a.z;
        const distToTarget = Math.hypot(dx, dz) || 1;

        if (distToTarget < 1.8) {
          a.satisfiedAttract = true;
        }

        // In unmitigated surge, outer crowd keeps pushing relentlessly toward the tip
        const surgeDrive = a.guidedByBeaconId ? 0.85 : this.tip.intensity * 1.25;
        goalX = (dx / distToTarget) * surgeDrive;
        goalZ = (dz / distToTarget) * surgeDrive;
      }

      // Normalize desired direction & compute desired velocity
      const goalLen = Math.hypot(goalX, goalZ) || 1;
      const dirX = goalX / goalLen;
      const dirZ = goalZ / goalLen;

      // Speed increases under panic/surge
      const effectiveDesiredSpeed = a.desiredSpeed * (1 + a.panic * 0.45);
      const vDesX = dirX * effectiveDesiredSpeed;
      const vDesZ = dirZ * effectiveDesiredSpeed;

      // Relaxation time tau = 0.38s
      let fx = (vDesX - a.vx) / 0.38;
      let fz = (vDesZ - a.vz) / 0.38;

      // 4. Agent-Agent Social & Granular Contact Forces (Crowd Quake Physics)
      let contactForceSum = 0;

      for (const n of neighbors) {
        const rx = a.x - n.x;
        const rz = a.z - n.z;
        const dist = Math.hypot(rx, rz) || 0.001;
        const nx = rx / dist;
        const nz = rz / dist;
        const sumRadii = a.radius + n.radius;
        const overlap = sumRadii - dist;

        // Psychological social repulsion
        if (dist < 1.35) {
          const socialMag = 2.6 * Math.exp((sumRadii - dist) / 0.28);
          fx += nx * socialMag;
          fz += nz * socialMag;
        }

        // Physical granular body compression + tangential friction (Arching / Jamming)
        if (overlap > 0) {
          // Body compression force (Helbing granular k_n)
          const bodyForce = 58.0 * overlap;
          fx += nx * bodyForce;
          fz += nz * bodyForce;

          // Sliding tangential friction (causes arching at exits!)
          const tx = -nz;
          const tz = nx;
          const deltaVTangential = (n.vx - a.vx) * tx + (n.vz - a.vz) * tz;
          const frictionForce = 32.0 * overlap * deltaVTangential;
          fx += tx * frictionForce;
          fz += tz * frictionForce;

          contactForceSum += bodyForce * 0.085;
        }
      }

      // 5. Barrier Forces (Wave-breakers, Funnel Walls, Chicanes)
      // Barriers physically deflect agents AND smoothly slide them along the barrier tangent
      // so angled funnel barriers break exit arches!
      let shieldedByBarrier = false;
      for (const bar of this.barriers) {
        const seg = closestPointOnSegment(a.x, a.z, bar.x1, bar.z1, bar.x2, bar.z2);
        const minDist = a.radius + 0.26;
        if (seg.dist < 1.1) {
          const nx = (a.x - seg.x) / (seg.dist || 0.001);
          const nz = (a.z - seg.z) / (seg.dist || 0.001);

          // Repulsion from barrier surface
          const wallRepel = 5.5 * Math.exp((minDist - seg.dist) / 0.18);
          fx += nx * wallRepel;
          fz += nz * wallRepel;

          // Tangential guidance along barrier towards goal direction
          const bdx = bar.x2 - bar.x1;
          const bdz = bar.z2 - bar.z1;
          const bLen = Math.hypot(bdx, bdz) || 1;
          const tx = bdx / bLen;
          const tz = bdz / bLen;
          const dotGoal = tx * dirX + tz * dirZ;
          const slideSign = dotGoal >= 0 ? 1 : -1;
          fx += tx * slideSign * 4.2;
          fz += tz * slideSign * 4.2;

          if (seg.dist < minDist) {
            const overlap = minDist - seg.dist;
            a.x += nx * overlap * 0.85;
            a.z += nz * overlap * 0.85;
          }
          shieldedByBarrier = true;
        }
      }

      // 6. Venue Perimeter Walls & Open Gate Checks
      // Check if agent is passing through an open gate
      let inGateOpening = false;
      for (const g of openGates) {
        if (g.id === 'north_main' || g.id === 'south_aux') {
          if (Math.abs(a.x - g.x) < g.width * 0.5 && Math.abs(a.z - g.z) < 1.2) {
            inGateOpening = true;
          }
        } else {
          if (Math.abs(a.z - g.z) < g.width * 0.5 && Math.abs(a.x - g.x) < 1.2) {
            inGateOpening = true;
          }
        }
      }

      if (!inGateOpening) {
        // Wall repulsion at boundaries
        const wallMargin = a.radius + 0.25;
        if (a.x < -VENUE_HALF_W + wallMargin) {
          const pen = -VENUE_HALF_W + wallMargin - a.x;
          fx += 45 * pen;
          a.x = -VENUE_HALF_W + wallMargin;
          contactForceSum += pen * 2.4;
        } else if (a.x > VENUE_HALF_W - wallMargin) {
          const pen = a.x - (VENUE_HALF_W - wallMargin);
          fx -= 45 * pen;
          a.x = VENUE_HALF_W - wallMargin;
          contactForceSum += pen * 2.4;
        }

        if (a.z < -VENUE_HALF_D + wallMargin) {
          const pen = -VENUE_HALF_D + wallMargin - a.z;
          fz += 45 * pen;
          a.z = -VENUE_HALF_D + wallMargin;
          contactForceSum += pen * 2.4;
        } else if (a.z > VENUE_HALF_D - wallMargin) {
          const pen = a.z - (VENUE_HALF_D - wallMargin);
          fz -= 45 * pen;
          a.z = VENUE_HALF_D - wallMargin;
          contactForceSum += pen * 2.4;
        }
      }

      // Compute physical crush pressure (kN/m)
      // When wave-breakers or funnel barriers split the crowd, radial pressure does not compound across the whole depth
      const barrierReliefMultiplier =
        shieldedByBarrier || this.barriers.length >= 2
          ? Math.max(0.24, 1.0 - this.barriers.length * 0.12 - this.beacons.length * 0.04)
          : 1.0;

      const rawPressure =
        (contactForceSum * 0.85 + Math.max(0, a.localDensity - 3.0) * 0.72) *
        (0.75 + a.panic * 0.45) *
        barrierReliefMultiplier;

      a.crushPressure = a.crushPressure * 0.75 + rawPressure * 0.25;

      // Integrate velocity & position
      a.vx += fx * clampedDt;
      a.vz += fz * clampedDt;

      // Jamming / Arching slowdown when crushed against an unfunneled choke point
      const maxSpeed = a.crushPressure > 4.2 ? 0.65 : effectiveDesiredSpeed * 1.15;
      const speed = Math.hypot(a.vx, a.vz);
      if (speed > maxSpeed) {
        a.vx = (a.vx / speed) * maxSpeed;
        a.vz = (a.vz / speed) * maxSpeed;
      }

      a.x += a.vx * clampedDt;
      a.z += a.vz * clampedDt;

      // Check if agent successfully evacuated through an open gate (in repel mode)
      if (this.tip.mode === 'repel') {
        for (const g of openGates) {
          const distToGate = Math.hypot(a.x - g.x, a.z - g.z);
          if (
            distToGate < g.width * 0.55 ||
            Math.abs(a.x) > VENUE_HALF_W - 0.15 ||
            Math.abs(a.z) > VENUE_HALF_D - 0.15
          ) {
            if (distToGate < g.width * 0.75) {
              a.evacuated = true;
              a.crushPressure = 0;
              break;
            }
          }
        }
      } else {
        // Keep inside arena bounds in attract mode
        a.x = Math.max(-VENUE_HALF_W + 0.5, Math.min(VENUE_HALF_W - 0.5, a.x));
        a.z = Math.max(-VENUE_HALF_D + 0.5, Math.min(VENUE_HALF_D - 0.5, a.z));
      }
    }

    return this.getMetrics();
  }

  public getMetrics(): SimulationMetrics {
    const active = this.agents.filter((a) => !a.evacuated);
    const evacuatedCount = this.agents.length - active.length;
    const reachedTargetCount = this.agents.filter((a) => a.satisfiedAttract).length;

    let currentMaxPressure = 0;
    let criticalAgentCount = 0;
    let panicSum = 0;
    let hotspot: Vec2 | null = null;

    for (const a of active) {
      panicSum += a.panic;
      if (a.crushPressure > currentMaxPressure) {
        currentMaxPressure = a.crushPressure;
        hotspot = { x: Number(a.x.toFixed(1)), z: Number(a.z.toFixed(1)) };
      }
      if (a.crushPressure > this.crushThreshold) {
        criticalAgentCount++;
      }
    }

    if (currentMaxPressure > this.peakCrushPressure) {
      this.peakCrushPressure = currentMaxPressure;
    }
    if (criticalAgentCount >= 3) {
      this.crushPocketEvents += 1;
    }

    const avgPanic = active.length > 0 ? panicSum / active.length : 0;

    let flowEfficiency = 100;
    if (this.tip.mode === 'repel') {
      const evacuatedRatio = evacuatedCount / Math.max(1, this.agents.length);
      const crushPenalty = Math.min(65, this.peakCrushPressure * 9.5);
      flowEfficiency = Math.max(5, Math.min(100, Math.round(evacuatedRatio * 85 + (100 - crushPenalty) * 0.35)));
    } else {
      const crushPenalty = Math.min(85, this.peakCrushPressure * 12.5);
      flowEfficiency = Math.max(5, Math.min(100, Math.round(105 - crushPenalty)));
    }

    return {
      elapsedSeconds: Number(this.elapsedSeconds.toFixed(1)),
      totalAgents: this.agents.length,
      activeAgents: active.length,
      evacuatedCount,
      reachedTargetCount,
      peakCrushPressure: Number(this.peakCrushPressure.toFixed(2)),
      currentMaxPressure: Number(currentMaxPressure.toFixed(2)),
      crushPocketEvents: this.crushPocketEvents,
      criticalAgentCount,
      avgPanic: Number(avgPanic.toFixed(2)),
      flowEfficiency,
      jammingDetected: currentMaxPressure > this.crushThreshold || criticalAgentCount >= 5,
      hotspotCoords: hotspot,
    };
  }
}
