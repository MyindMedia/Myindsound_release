/**
 * Shared GLSL: CRT post pass, rain, cartridge shell. The city lives in city-shaders.ts.
 * CRT_PASS adapts ThreeUI's `crt` shader (MIT, Meng To / Design+Code, github.com/MengTo/threeui):
 * scanlines, chromatic fringe, rolling bar, vignette and grain. The screen curvature is removed so
 * the 3D deck stays aligned with the HTML HUD.
 */
import { Color } from 'three';

export const PALETTE = {
  base: new Color('#07070C'),
  gold: new Color('#FDB913'),
  orange: new Color('#FF8C00'),
  pink: new Color('#FF3DA8'),
  ice: new Color('#9FD8FF'),
};

export const CRT_PASS = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uMotion: { value: 1 },
    uResolution: { value: [1, 1] },
    uIntensity: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uMotion;
    uniform vec2 uResolution;
    uniform float uIntensity;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 dir = vUv - 0.5;
      float d2 = dot(dir, dir);
      vec2 offset = dir * (0.0012 + 0.006 * d2) * uIntensity;
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 col = vec3(texture2D(tDiffuse, vUv + offset).r, base.g, texture2D(tDiffuse, vUv - offset).b);

      float lines = uResolution.y * 0.5;
      float scan = sin(vUv.y * 3.14159265 * lines + uTime * 3.0 * uMotion);
      col *= mix(1.0 - 0.14 * uIntensity, 1.0, scan * scan);

      float bar = fract(vUv.y * 0.5 - uTime * 0.06 * uMotion);
      bar = smoothstep(0.0, 0.05, bar) * smoothstep(0.18, 0.05, bar);
      col += bar * 0.025 * uMotion * uIntensity;

      float vig = smoothstep(1.05, 0.35, length(dir * vec2(1.1, 1.0)));
      col *= mix(0.55, 1.0, vig);

      col += (hash(vUv * uResolution + fract(uTime * 0.37)) - 0.5) * 0.018 * uIntensity;
      gl_FragColor = vec4(max(col, vec3(0.0)), base.a);
    }
  `,
};

export const RAIN = {
  vertexShader: /* glsl */ `
    attribute vec3 aSeed;
    uniform float uTime;
    uniform float uHeight;
    varying float vAlpha;
    void main() {
      float speed = 3.2 + aSeed.z * 2.6;
      float y = mod(aSeed.y * uHeight - uTime * speed, uHeight) - uHeight * 0.35;
      vec3 p = position;
      p.x += aSeed.x;
      p.y += y;
      p.z += -2.0 - aSeed.z * 9.0;
      p.x += p.y * 0.08;
      vAlpha = 0.18 + 0.4 * aSeed.z;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    varying float vAlpha;
    void main() {
      gl_FragColor = vec4(uColor * vAlpha, vAlpha);
    }
  `,
};

/**
 * Shell texture with the baked disc faded out so the real spinning disc shows through. Everywhere else the
 * shell is solid: the art is laid over dark plastic, so edges where the art's outline is smaller than the
 * 3D shape never open onto the scene behind.
 */
export const SHELL = {
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D uMap;
    uniform vec4 uDisc;
    uniform float uDim;
    varying vec2 vUv;
    const vec3 PLASTIC = vec3(0.012, 0.014, 0.022);
    void main() {
      vec4 tex = texture2D(uMap, vUv);
      float d = length((vUv - uDisc.xy) / uDisc.zw);
      float inside = 1.0 - smoothstep(0.93, 1.0, d);
      vec3 colour = mix(PLASTIC, tex.rgb, tex.a);
      float alpha = mix(1.0, 0.16, inside);
      gl_FragColor = vec4(colour * uDim, alpha);
      #include <colorspace_fragment>
    }
  `,
};
