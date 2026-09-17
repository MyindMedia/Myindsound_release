import { AdditiveBlending, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';
import { PALETTE } from './shaders';

/**
 * Start-up halo: hovers in front of the disc while it loads and spins up, lights its ticks
 * clockwise with the disc speed, then expands and dissipates when playback starts.
 * Radar sweep adapted from the React Bits Pro `404-7` radar block.
 */

const HALO = {
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform float uProgress;
    uniform float uSweep;
    uniform float uOpacity;
    uniform vec3 uGold;
    uniform vec3 uIce;
    varying vec2 vUv;

    float ringLine(float r, float radius, float width) {
      float aa = fwidth(r) * 1.5;
      return 1.0 - smoothstep(width, width + aa, abs(r - radius));
    }

    void main() {
      vec2 p = (vUv - 0.5) * 2.0;
      float r = length(p);
      float turn = fract(atan(p.x, p.y) / 6.2831853); // 0 at 12 o'clock, clockwise

      float outer = ringLine(r, 0.93, 0.004);
      float inner = ringLine(r, 0.66, 0.003) * step(0.5, fract((turn - uTime * 0.04) * 40.0));

      float tickBand = step(0.76, r) * step(r, 0.86);
      float tick = tickBand * step(abs(fract(turn * 72.0) - 0.5), 0.14);
      float majorBand = step(0.72, r) * step(r, 0.89);
      float major = majorBand * step(abs(fract(turn * 12.0) - 0.5), 0.022);
      float lit = step(turn, uProgress);

      float behind = fract(uSweep - turn);
      float sweep = (1.0 - smoothstep(0.0, 0.16, behind)) * step(0.62, r) * step(r, 0.95);
      float sweepEdge = (1.0 - smoothstep(0.0, 0.012, behind)) * step(0.6, r) * step(r, 0.97);

      float glow = exp(-pow((r - 0.86) / 0.11, 2.0));

      vec3 col = uIce * outer * 0.9
        + uIce * inner * 0.45
        + mix(uIce * 0.22, uGold * 1.8, lit) * (tick + major * 1.4)
        + uGold * sweep * 0.35
        + vec3(1.0, 0.95, 0.8) * sweepEdge * 1.6
        + uGold * glow * (0.12 + 0.35 * uProgress);
      gl_FragColor = vec4(col * uOpacity, 1.0);
    }
  `,
};

type Phase = 'hidden' | 'booting' | 'dissipating';

export class DiscHalo {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private phase: Phase = 'hidden';
  private opacity = 0;
  private scale = 0.7;
  private sweep = 0;
  private bootSeconds = 0;
  private bootElapsed = 0;
  private readonly reducedMotion: boolean;

  constructor(centre: Vector3, discRadius: number, options: { reducedMotion: boolean }) {
    this.reducedMotion = options.reducedMotion;
    this.material = new ShaderMaterial({
      vertexShader: HALO.vertexShader,
      fragmentShader: HALO.fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uProgress: { value: 0 },
        uSweep: { value: 0 },
        uOpacity: { value: 0 },
        uGold: { value: PALETTE.gold },
        uIce: { value: PALETTE.ice },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    const size = discRadius * 2 * 1.32;
    this.mesh = new Mesh(new PlaneGeometry(size, size), this.material);
    // Hovers well in front of the deck face, so it parallaxes over the disc when the deck tilts.
    this.mesh.position.set(centre.x, centre.y, 0.34);
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
  }

  /** With `seconds`, the ticks fill over that time (track calibration); without, they follow disc speed. */
  boot(seconds = 0): void {
    this.bootSeconds = seconds;
    this.bootElapsed = 0;
    this.phase = 'booting';
    this.opacity = this.reducedMotion ? 1 : 0;
    this.scale = this.reducedMotion ? 1 : 0.7;
    this.material.uniforms.uProgress.value = 0;
    this.mesh.visible = true;
  }

  dissipate(): void {
    if (this.phase === 'hidden') return;
    this.phase = 'dissipating';
    this.material.uniforms.uProgress.value = 1;
  }

  hide(): void {
    this.phase = 'hidden';
    this.opacity = 0;
    this.mesh.visible = false;
  }

  /** `spin` is the disc speed as a 0..1 fraction of play speed. */
  update(dt: number, elapsed: number, spin: number): void {
    if (this.phase === 'hidden') return;
    const uniforms = this.material.uniforms;
    uniforms.uTime.value = elapsed;

    if (this.phase === 'booting') {
      this.opacity += (1 - this.opacity) * (1 - Math.exp(-dt * 5));
      this.scale += (1 - this.scale) * (1 - Math.exp(-dt * 4));
      this.bootElapsed += dt;
      const target = this.bootSeconds > 0 ? this.bootElapsed / this.bootSeconds : spin;
      uniforms.uProgress.value = Math.max(uniforms.uProgress.value, Math.min(1, target));
    } else {
      const fade = this.reducedMotion ? 12 : 3.2;
      this.opacity -= this.opacity * (1 - Math.exp(-dt * fade)) + dt * 0.15;
      this.scale += dt * (this.reducedMotion ? 0 : 0.9);
      if (this.opacity <= 0.01) {
        this.hide();
        return;
      }
    }

    this.sweep = (this.sweep + dt * (0.35 + 2.2 * spin)) % 1;
    uniforms.uSweep.value = this.sweep;
    uniforms.uOpacity.value = this.opacity;
    this.mesh.scale.setScalar(this.scale);
  }
}
