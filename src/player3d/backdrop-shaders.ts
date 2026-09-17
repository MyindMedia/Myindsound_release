/**
 * GLSL for the comic-book city backdrop: a 90s-anime restyle of the LIT street scene with
 * depth-map parallax, pulsing neon (mask R), beam shimmer (mask G) and flying craft in the far sky.
 */

export const MAX_CRAFT = 6;

export const COMIC_CITY = {
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D uMap;
    uniform sampler2D uDepth;
    uniform sampler2D uMask;
    uniform vec2 uParallax;
    uniform float uTime;
    uniform float uMotion;
    uniform float uBass;
    uniform float uAspect;
    uniform vec4 uCraft[${MAX_CRAFT}];
    uniform vec3 uCraftColor[${MAX_CRAFT}];
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      // Two-step depth parallax: near (white) shifts one way, far (black) the other.
      float focus = 0.35;
      float d0 = texture2D(uDepth, vUv).r;
      vec2 uv = vUv + uParallax * (d0 - focus);
      float depth = texture2D(uDepth, uv).r;
      uv = clamp(vUv + uParallax * (depth - focus), 0.001, 0.999);

      vec3 col = texture2D(uMap, uv).rgb;
      vec4 mask = texture2D(uMask, uv);

      // Neon signs pulse on their own rhythm, with rare flicker dropouts, and swell with the bass.
      vec2 cell = floor(uv * vec2(16.0, 9.0));
      float rate = 1.2 + hash12(cell + 3.7) * 2.4;
      float pulse = 0.72 + 0.28 * sin(uTime * rate + hash12(cell) * 6.2831);
      float dropout = step(0.975, hash12(cell + floor(uTime * 11.0)));
      float neon = mix(1.0, pulse * (1.0 - 0.65 * dropout), uMotion) * (1.05 + 0.45 * uBass);
      col *= mix(1.0, neon * 1.2, mask.r);

      // Light shaft shimmer travelling upward.
      float shimmer = 0.9 + 0.1 * sin(uv.y * 46.0 - uTime * 5.0 * uMotion) + 0.06 * uBass;
      col *= mix(1.0, shimmer, mask.g);

      // Flying craft, only visible against the far sky / distant haze.
      float farMask = 1.0 - smoothstep(0.16, 0.3, depth);
      for (int i = 0; i < ${MAX_CRAFT}; i++) {
        vec4 craft = uCraft[i];
        if (craft.z <= 0.0) continue;
        vec2 p = (vUv - craft.xy) * vec2(uAspect, 1.0) / craft.z;
        float body = 1.0 - smoothstep(0.75, 1.0, length(p * vec2(1.0 / 0.02, 1.0 / 0.0055)));
        col = mix(col, vec3(0.015, 0.016, 0.03), body * farMask);
        vec2 frontOffset = p - vec2(0.021 * craft.w, 0.0);
        vec2 rearOffset = p + vec2(0.021 * craft.w, 0.0);
        float front = exp(-dot(frontOffset, frontOffset) / 0.000004);
        float rear = exp(-dot(rearOffset, rearOffset) / 0.0000035);
        float strobe = step(0.55, fract(uTime * 1.3 + float(i) * 0.37));
        float behind = -p.x * craft.w - 0.02;
        float trail = step(0.0, behind) * exp(-behind / 0.045) * exp(-(p.y * p.y) / 0.0000012);
        col += (vec3(0.92, 0.98, 1.0) * front * 1.6 + vec3(1.0, 0.22, 0.38) * rear * strobe * 1.3 + uCraftColor[i] * trail * 0.4) * farMask;
      }

      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }
  `,
};

/** Floating embers and dust in front of the backdrop. Additive points. */
export const EMBERS = {
  vertexShader: /* glsl */ `
    attribute vec3 aSeed;
    attribute vec3 aColor;
    uniform float uTime;
    uniform float uMotion;
    uniform float uPixelRatio;
    varying vec3 vColor;
    varying float vTwinkle;
    void main() {
      vec3 p = position;
      float t = uTime * uMotion;
      p.y = mod(p.y + t * (0.06 + aSeed.x * 0.2) + 2.5, 8.0) - 2.5;
      p.x += sin(t * (0.3 + aSeed.y) + aSeed.z * 6.28) * 0.3;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = (1.2 + aSeed.z * 2.4) * uPixelRatio * (10.0 / max(1.0, -mv.z));
      vColor = aColor;
      vTwinkle = 0.55 + 0.45 * sin(t * (2.0 + aSeed.x * 4.0) + aSeed.y * 30.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 vColor;
    varying float vTwinkle;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.0, d);
      gl_FragColor = vec4(vColor * a * vTwinkle, 1.0);
    }
  `,
};
