import { CylinderGeometry, Group, LatheGeometry, Mesh, MeshStandardMaterial, Vector2, type Texture } from 'three';

/**
 * The deck's spindle motor, under the seated disc. Once the cartridge is seated the rotor rises through the
 * cartridge's back opening: the chuck meets the underside of the hub plate and the shaft enters its centre
 * hole. It turns with the disc, and drops clear before the cartridge is ejected.
 * Built in deck space at the disc centre; heights are deck-space z.
 */

export interface SpindleOptions {
  x: number;
  y: number;
  /** Where the motor stands (the tray behind the window). */
  floorZ: number;
  /** Underside of the seated hub plate: the chuck's top face meets it when engaged. */
  hubBaseZ: number;
  /** Top of the seated hub: the shaft stops just below it. */
  hubTopZ: number;
  /** Radius of the hub's centre hole. */
  holeRadius: number;
  /** Radius of the hub plate. */
  plateRadius: number;
  /** How far the rotor drops when disengaged, clearing the cartridge's back face. */
  travel: number;
  environment: Texture | null;
}

const CHUCK_HEIGHT = 0.006;

function turned(profile: [number, number][]): LatheGeometry {
  const geometry = new LatheGeometry(
    profile.map(([r, h]) => new Vector2(r, h)),
    48,
  );
  return geometry.rotateX(Math.PI / 2);
}

export class Spindle {
  readonly group = new Group();
  private readonly rotor = new Group();
  private readonly travel: number;
  private engaged = 0;
  private target = 0;

  constructor(options: SpindleOptions) {
    const envMap = options.environment;
    const metal = (color: string, roughness: number) =>
      new MeshStandardMaterial({ color, metalness: 1, roughness, envMap, envMapIntensity: 0.4 });
    this.travel = options.travel;
    this.group.position.set(options.x, options.y, 0);

    // Stator: the motor can, fixed to the tray.
    const statorTop = options.hubBaseZ - CHUCK_HEIGHT - options.travel - 0.01;
    const statorHeight = statorTop - options.floorZ;
    const stator = new Mesh(
      new CylinderGeometry(options.plateRadius * 0.62, options.plateRadius * 0.66, statorHeight, 40).rotateX(Math.PI / 2),
      new MeshStandardMaterial({ color: '#2a2d33', metalness: 0.6, roughness: 0.5, envMap, envMapIntensity: 0.3 }),
    );
    stator.position.z = options.floorZ + statorHeight / 2;

    // Rotor: column, chuck (meets the hub plate), magnet pads and the shaft that enters the hub.
    const chuckRadius = options.plateRadius * 0.82;
    const chuckBase = options.hubBaseZ - CHUCK_HEIGHT;
    const chuck = new Mesh(
      turned([
        [0, 0],
        [chuckRadius, 0],
        [chuckRadius, CHUCK_HEIGHT - 0.001],
        [chuckRadius - 0.001, CHUCK_HEIGHT],
        [0, CHUCK_HEIGHT],
      ]),
      metal('#b9bdc4', 0.32),
    );
    // Chuck face sits just under the hub; the magnet pads on it touch the hub plate.
    chuck.position.z = chuckBase - 0.0008;

    // Long enough to reach into the stator when engaged, hidden behind the tray when dropped.
    const columnHeight = chuckBase - statorTop + 0.002;
    const column = new Mesh(
      new CylinderGeometry(options.holeRadius * 1.4, options.holeRadius * 1.4, columnHeight, 24).rotateX(Math.PI / 2),
      metal('#8c9097', 0.35),
    );
    column.position.z = chuckBase - columnHeight / 2;

    const pads = new Group();
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2;
      const pad = new Mesh(
        new CylinderGeometry(chuckRadius * 0.14, chuckRadius * 0.14, 0.0008, 20).rotateX(Math.PI / 2),
        new MeshStandardMaterial({ color: '#15161a', roughness: 0.6 }),
      );
      pad.position.set(Math.cos(angle) * chuckRadius * 0.62, Math.sin(angle) * chuckRadius * 0.62, options.hubBaseZ - 0.0004);
      pads.add(pad);
    }

    const shaftRadius = options.holeRadius * 0.82;
    const shaftLength = options.hubTopZ - 0.002 - options.hubBaseZ;
    const shaft = new Mesh(
      turned([
        [shaftRadius, 0],
        [shaftRadius, shaftLength - 0.0015],
        [shaftRadius * 0.55, shaftLength],
        [0, shaftLength],
      ]),
      metal('#e4e6ea', 0.12),
    );
    shaft.position.z = options.hubBaseZ;

    this.rotor.add(column, chuck, pads, shaft);
    this.group.add(stator, this.rotor);
    this.apply();
  }

  /** Engage under a seated disc, or drop clear. `immediate` skips the travel (reduced motion). */
  setEngaged(engaged: boolean, immediate = false): void {
    this.target = engaged ? 1 : 0;
    if (immediate) {
      this.engaged = this.target;
      this.apply();
    }
  }

  /** `angle`: how far the disc turned this frame (radians). */
  update(dt: number, angle: number): void {
    if (this.engaged !== this.target) {
      const next = this.engaged + (this.target - this.engaged) * (1 - Math.exp(-dt * 9));
      this.engaged = Math.abs(next - this.target) < 0.002 ? this.target : next;
      this.apply();
    }
    this.rotor.rotation.z -= angle;
  }

  private apply(): void {
    this.rotor.position.z = -this.travel * (1 - this.engaged);
  }
}
