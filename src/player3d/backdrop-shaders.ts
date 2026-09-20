/**
 * GLSL for the city backdrop: depth-map parallax, pulsing neon (mask R), beam shimmer (mask G), flying
 * craft in the far sky, people shifting along the pavements, and a smoky haze over all of it so the
 * painting sits behind the deck.
 */

export const MAX_CRAFT = 6;
export const MAX_WALKER = 8;

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
    uniform vec4 uWalker[${MAX_WALKER}];
    uniform float uHaze;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash12(i);
      float b = hash12(i + vec2(1.0, 0.0));
      float c = hash12(i + vec2(0.0, 1.0));
      float d = hash12(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
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

      // Smoke drifting through the street: two layers of slow noise, thickest through the middle of the
      // frame, so the painting reads as atmosphere behind the deck rather than a picture beside it.
      // It is a veil, not a wash: keep it under the painting's own tone or it flattens the whole city
      // to one grey and the linework underneath stops reading.
      float drift = uTime * 0.018 * uMotion;
      float smoke = valueNoise(uv * vec2(3.2, 1.7) + vec2(drift, drift * 0.32)) * 0.62
                  + valueNoise(uv * vec2(7.5, 3.6) - vec2(drift * 1.7, drift * 0.5)) * 0.38;
      float band = smoothstep(0.02, 0.5, uv.y) * (1.0 - 0.4 * smoothstep(0.78, 1.0, uv.y));
      float haze = clamp(smoke * band * uHaze, 0.0, 1.0);
      col = mix(col, mix(vec3(0.05, 0.045, 0.085), vec3(0.15, 0.13, 0.21), smoke), haze * 0.16);
      // Lights still punch through it, just not all the way.
      float through = 1.0 - haze * 0.22;

      // The roadway: the bottom half of the frame, up to where the street meets the vanishing point.
      // (uv.y is 0 at the bottom of the painting, so this is the ground, not the sky.)
      float street = (1.0 - smoothstep(0.30, 0.50, uv.y)) * smoothstep(0.0, 0.06, uv.y);

      // People on the pavements: dark against the signs, with a little of the neon caught on them.
      for (int i = 0; i < ${MAX_WALKER}; i++) {
        vec4 walker = uWalker[i];
        if (walker.z <= 0.0) continue;
        // Their feet stand on walker.xy, so the body is drawn above it and the reflection below.
        vec2 p = (vUv - walker.xy) * vec2(uAspect, 1.0) / walker.z;
        float body = 1.0 - smoothstep(0.7, 1.0, length((p - vec2(0.0, 0.016)) * vec2(1.0 / 0.005, 1.0 / 0.015)));
        float head = 1.0 - smoothstep(0.7, 1.0, length((p - vec2(0.0, 0.034)) / 0.0042));
        float figure = clamp(body + head, 0.0, 1.0) * street;
        col = mix(col, vec3(0.015, 0.014, 0.026), figure * 0.85);
        // A rim of whatever sign is behind them, and their smear on the wet ground.
        col += vec3(0.75, 0.45, 0.95) * figure * 0.12 * (0.6 + 0.4 * sin(uTime * 1.7 + walker.w));
        vec2 r = (vUv - vec2(walker.x, walker.y - 0.02 * walker.z)) * vec2(uAspect, 1.0) / walker.z;
        float smear = exp(-dot(r * vec2(1.0 / 0.005, 1.0 / 0.014), r * vec2(1.0 / 0.005, 1.0 / 0.014)));
        col = mix(col, col * 0.68, smear * street * 0.55);
      }

      // Flying craft, only visible against the far sky / distant haze.
      float farMask = (1.0 - smoothstep(0.16, 0.3, depth)) * through;
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
