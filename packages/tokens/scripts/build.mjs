#!/usr/bin/env node
/**
 * DS-33 shared token build. Plain Node, no dependencies.
 *
 * Reads packages/tokens/tokens.json (the single source of truth, itself transcribed from the live
 * LIT player CSS/TS — see that file's own `meta.sourceFiles`) and generates:
 *   - packages/tokens/dist/tokens.css   CSS custom properties (--ms-*). NOT wired into the site yet.
 *   - packages/tokens/dist/Theme.swift  A SwiftUI theme (Color, MSFont, MSMotion, MSShape, MSSpace,
 *                                       MSComponent, MSIcon, MSLCD, MSSpectrum).
 *
 * Nothing is silently dropped: every scalar leaf in tokens.json is emitted into BOTH outputs, unless
 * its own `value` is paired with a `cssOnly: "<reason>"` field (a genuine CSS-only mechanism — a
 * `calc()`/`env()`/grid-template/clip-path string with no portable SwiftUI literal), in which case it
 * is emitted into tokens.css only and the reason is carried as a Swift doc comment at the matching
 * spot so nothing just vanishes. A handful of clearly tabular/structural blocks (the LCD glyph table,
 * the tab bar's SVG icon paths, the boot terminal's line list, the EQ bar geometry + keyframes, the
 * spectrum's gradient stops) are emitted by dedicated functions instead of the generic per-leaf walker,
 * because a flat --ms-* variable per array entry would be unreadable; tokens.test.ts checks each of
 * those blocks explicitly rather than via the generic sweep.
 *
 * Deterministic: same tokens.json in, byte-identical files out (object key order in tokens.json is
 * fixed, and every code path below iterates in that same order).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const TOKENS_PATH = path.join(PKG_ROOT, 'tokens.json');
const DIST_DIR = path.join(PKG_ROOT, 'dist');

const tokens = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));

// ── Shared helpers ─────────────────────────────────────────────────────────

/** Keys that are documentation about a token, never a token themselves. */
const SKIP_KEYS = new Set([
  'source', '$note', 'note', 'meta', '$schema', 'rule', 'corners', 'order',
  'postscriptNames', 'weightsLoaded', 'colorNote', 'swiftNote', 'tableNote', 'segmentBitsNote',
  // Prose/keyword descriptions of a CSS animation-timing detail that the matching Swift Animation
  // constant already encodes structurally (a `steps()` count, an `infinite alternate` direction, a
  // written-out easing formula) — not a separate numeric/color value of its own.
  'timing', 'iteration', 'easing', 'swiftFallback', 'propertiesCss', 'propertyCss', 'shape',
  // Rendering-instruction descriptors realized differently in Swift (a font-function CHOICE, a
  // `.textCase(.uppercase)` view modifier, a design-rule comment), each proven by a dedicated,
  // stronger test in tokens.test.ts rather than a literal string match.
  'family', 'case', 'feature',
]);

/** Structural blocks handled by a dedicated emitter, skipped by the generic walker so they are not
 * double-processed (and so a raw path-data string or gradient-stop array never gets flattened into a
 * meaningless --ms-* var). Listed as dotted paths from the tokens root. */
const STRUCTURAL_PATHS = new Set([
  'component.tabBar.icons',
  'component.tabBar.tabs',
  'component.lcd.glyphs',
  'component.lcd.statusFormat.examples',
  'component.bootLoader.terminal.lines',
  'component.listRow.eq.barXOffsetsPx',
  'component.listRow.eq.restHeightsPct',
  'component.listRow.eq.keyframes',
  'component.listRow.current.backgroundGradient',
  'component.spectrum.bandColorStops',
]);

/** camelCase / PascalCase -> kebab-case, then sanitized to a legal CSS custom-property fragment. */
function kebab(word) {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16));
}

/** {hex, alpha} -> a CSS color literal. */
function colorCss({ hex, alpha = 1 }) {
  if (alpha >= 1) return hex.toUpperCase();
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function isColorPair(node) {
  return node && typeof node === 'object' && !Array.isArray(node) && 'hex' in node && 'alpha' in node;
}

/** Unit suffix for a numeric leaf, decided by scanning the path from the leaf outward for a
 * recognised suffix (Ms / S / Pt / Px / Pct / Deg / Ratio). `space` tokens are always px by convention. */
function unitFor(pathParts) {
  if (pathParts[0] === 'space') return 'px';
  const leaf = pathParts[pathParts.length - 1];
  if (leaf === 'tracking') return 'em';
  for (let i = pathParts.length - 1; i >= 0; i--) {
    const key = pathParts[i];
    if (/Ms$/.test(key)) return 'ms';
    if (/S$/.test(key)) return 's';
    if (/(Pt|Px)$/.test(key)) return 'px';
    if (/Pct$/.test(key)) return '%';
    if (/Deg$/.test(key)) return 'deg';
    if (/Ratio$/.test(key)) return '';
  }
  return '';
}

/** Look up a dotted path like "type.primaryButton" or "color.tokens.gold" against the root tree. */
function resolvePath(root, dotted) {
  const parts = dotted.split('.');
  let node = root;
  for (const part of parts) {
    if (node == null || typeof node !== 'object') return undefined;
    node = part in node ? node[part] : node.tokens && part in node.tokens ? node.tokens[part] : undefined;
  }
  return node;
}

/** Sentinel meaning "this reference points at a composite bundle (many fields), not a single CSS
 * value" — e.g. `hudPanel.title: "type.panelTitle"` is a pointer to a whole type role, whose OWN
 * fields are already fully emitted elsewhere under `--ms-type-panel-title-*`. Emitting the pointer
 * itself would just produce `[object Object]`, so the caller skips it instead. */
const COMPOSITE_REF = Symbol('composite-ref');

function resolveNodeToCss(node) {
  if (node == null) return String(node);
  if (isColorPair(node)) return colorCss(node);
  if (typeof node === 'object' && 'css' in node && typeof node.css === 'string') return node.css;
  if (typeof node === 'object' && 'value' in node && typeof node.value !== 'object') return resolveNodeToCss(node.value);
  if (typeof node === 'string') return resolveRef(node);
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object') return COMPOSITE_REF; // no single representable value
  return String(node);
}

/** A bare or dotted reference used as a leaf value elsewhere in tokens.json (e.g. "gold",
 * "goldReadout", "type.primaryButton", "shape.focusRing") is resolved to its real CSS value when
 * that's possible; otherwise the literal string is kept as-is (plenty of leaf strings are just
 * ordinary CSS keywords: "uppercase", "ease-in-out", "top-left", …). Returns COMPOSITE_REF when the
 * reference points at a multi-field bundle rather than a single value. */
function resolveRef(str) {
  if (str.includes('.')) {
    const head = str.split('.')[0];
    if (['color', 'glow', 'type', 'shape', 'space', 'motion', 'component'].includes(head)) {
      const found = resolvePath(tokens, str);
      if (found !== undefined) return resolveNodeToCss(found);
    }
    return str;
  }
  if (tokens.color?.tokens?.[str]) return colorCss(tokens.color.tokens[str]);
  return str;
}

// ── CSS generation (generic leaf walk over color, glow, type, shape, space, motion, component) ──

const cssLines = [];
/** Every leaf the walker actually emitted, dotted-path -> { css, swiftSkippedReason? }. Used by the
 * Swift generator below so both outputs are demonstrably built from the same walk, and by the test's
 * "nothing silently dropped" cross-check. */
const emitted = {};

function emitCssVar(pathParts, rawValue, cssOnlyReason) {
  let parts = pathParts;
  if (parts[parts.length - 1] === 'value') parts = parts.slice(0, -1);
  const dotted = pathParts.join('.');
  const name = `--ms-${parts.filter((p) => p !== 'tokens').map(kebab).join('-')}`;
  cssLines.push(`  ${name}: ${rawValue};`);
  emitted[dotted] = { cssVar: name, css: rawValue, cssOnlyReason: cssOnlyReason ?? null };
}

function pathIsStructural(pathParts) {
  const dotted = pathParts.join('.');
  return [...STRUCTURAL_PATHS].some((p) => dotted === p || dotted.startsWith(`${p}.`));
}

function walkForCss(node, pathParts) {
  if (node == null) return;
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const nextPath = [...pathParts, key];
    if (pathIsStructural(nextPath)) continue; // handled by a dedicated emitter, see below
    if (value === null) continue; // e.g. glow.spectrumBar.color: null (per-bar dynamic, no fixed value)

    if (Array.isArray(value)) {
      if (key === 'cubicBezier' && value.length === 4) {
        emitCssVar(nextPath, `cubic-bezier(${value.join(', ')})`);
      } else if (key === 'dashPt' && value.length === 2) {
        emitCssVar(nextPath, `${value[0]}px ${value[1]}px`);
      } else if (value.every((v) => typeof v === 'number')) {
        // A plain numeric array not named above (e.g. type.label.sizePt: [11, 12]) — comma-separated,
        // same unit rule as a scalar of the same key name.
        emitCssVar(nextPath, value.map((v) => `${v}${unitFor(nextPath)}`).join(', '));
      } else if (value.every((v) => typeof v === 'string')) {
        // A plain string array not named above and not already claimed by STRUCTURAL_PATHS — e.g.
        // motion.reducedMotion has none, but guard generically so nothing new silently vanishes.
        emitCssVar(nextPath, value.map((v) => `"${resolveRef(v)}"`).join(', '));
      }
      // arrays of objects are structural and must be listed in STRUCTURAL_PATHS
      continue;
    }

    if (isColorPair(value)) {
      emitCssVar(nextPath, colorCss(value));
      continue;
    }

    if (typeof value === 'object') {
      // A {value, cssOnly, ...} leaf: CSS gets the value, Swift is told why it's skipped.
      if ('value' in value && typeof value.value !== 'object') {
        const cssOnlyReason = typeof value.cssOnly === 'string' ? value.cssOnly : null;
        const rendered = typeof value.value === 'string' ? resolveRef(value.value) : `${value.value}${unitFor(nextPath)}`;
        if (rendered !== COMPOSITE_REF) emitCssVar(nextPath, rendered, cssOnlyReason);
        // fall through to also walk any OTHER sibling keys (e.g. shape.hairlineWidthPt.color)
        const rest = Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'value' && k !== 'cssOnly'));
        walkForCss(rest, pathParts); // siblings share the parent's own path, not path+'value'
        continue;
      }
      // A glow-style {css, offsetX, offsetY, blurPt, color, ...} bundle: emit the literal css string
      // AND recurse into its decomposed numeric/color siblings.
      if (typeof value.css === 'string') {
        emitCssVar(nextPath.concat('css'), value.css);
      }
      walkForCss(value, nextPath);
      continue;
    }

    if (typeof value === 'string') {
      const rendered = resolveRef(value);
      if (rendered !== COMPOSITE_REF) emitCssVar(nextPath, rendered);
    } else if (typeof value === 'number') {
      emitCssVar(nextPath, `${value}${unitFor(nextPath)}`);
    } else if (typeof value === 'boolean') {
      emitCssVar(nextPath, String(value));
    }
  }
}

for (const groupName of ['color', 'glow', 'shape', 'space', 'motion']) {
  const group = tokens[groupName];
  const root = group.tokens ?? group;
  walkForCss(root, [groupName]);
}
walkForCss(tokens.type, ['type']);
walkForCss(tokens.component, ['component']);

// ── Structural blocks: dedicated CSS + Swift emitters ──────────────────────

const structuralCss = [];
const structuralSwift = [];

// component.tabBar.icons — SVG path data, kept as literal strings in both outputs.
{
  const icons = tokens.component.tabBar.icons;
  const names = Object.keys(icons).filter((k) => !['viewBox', 'strokeWidth', 'fill', 'source'].includes(k));
  structuralCss.push('', '  /* Component: tab bar icons (src/ios.ts ICONS) */');
  structuralCss.push(`  --ms-component-tab-bar-icons-view-box: "${icons.viewBox}";`);
  structuralCss.push(`  --ms-component-tab-bar-icons-stroke-width: ${icons.strokeWidth};`);
  for (const name of names) {
    structuralCss.push(`  --ms-component-tab-bar-icons-${kebab(name)}: "${icons[name].replace(/"/g, '\\"')}";`);
  }
  structuralSwift.push(
    '/// Raw SVG path/shape data for the tab bar icons (src/ios.ts ICONS), one string per icon, pipe-separated',
    '/// per sub-element ("d" path data, or "rect x=.. y=.. w=.. h=.. rx=.."). SwiftUI has no SVG importer, so',
    '/// build a `Path` from the same points, or rasterize once via an equivalent icon set.',
    'enum MSIcon {',
    `    static let viewBox = "${icons.viewBox}"`,
    `    static let strokeWidth: CGFloat = ${icons.strokeWidth}`,
    ...names.map((name) => `    static let ${name} = "${icons[name].replace(/"/g, '\\"')}"`),
    '}',
    '',
  );
}

// component.tabBar.tabs — label/href/icon triples.
{
  const tabs = tokens.component.tabBar.tabs;
  structuralCss.push('', '  /* Component: tab bar tabs (src/ios.ts TABS) */');
  tabs.forEach((tab, i) => {
    structuralCss.push(`  --ms-component-tab-bar-tabs-${i}-label: "${tab.label}";`);
    structuralCss.push(`  --ms-component-tab-bar-tabs-${i}-href: "${tab.href}";`);
    structuralCss.push(`  --ms-component-tab-bar-tabs-${i}-icon: "${tab.icon}";`);
  });
  structuralSwift.push(
    'struct MSTab { let label: String; let href: String; let icon: String }',
    '',
    'let msTabs: [MSTab] = [',
    ...tabs.map((tab) => `    MSTab(label: "${tab.label}", href: "${tab.href}", icon: "${tab.icon}"),`),
    ']',
    '',
  );
}

// component.lcd.glyphs — the 14-segment bitmask table.
{
  const glyphs = tokens.component.lcd.glyphs;
  const bits = glyphs.segmentBits;
  const bitmask = (names) =>
    names
      .split(' ')
      .filter(Boolean)
      .reduce((mask, name) => mask | (1 << bits[name]), 0);

  structuralCss.push('', '  /* Component: LCD segment bits + glyph table (player3d/lcd-text.ts) */');
  for (const [name, bit] of Object.entries(bits)) {
    structuralCss.push(`  --ms-component-lcd-segment-bit-${kebab(name)}: ${bit};`);
  }
  for (const [char, names] of Object.entries(glyphs.table)) {
    const safeName = char === ' ' ? 'space' : char === '-' ? 'dash' : /[A-Z0-9]/.test(char) ? char.toLowerCase() : char.charCodeAt(0);
    structuralCss.push(`  --ms-component-lcd-glyph-${safeName}: ${bitmask(names)}; /* "${char}" = ${names || '(blank)'} */`);
  }

  structuralSwift.push(
    '/// 14-segment LCD font (player3d/lcd-text.ts SEGMENT + GLYPHS), transcribed bit-for-bit from the same',
    '/// segment-letter definitions the web canvas renderer uses, not hand-computed.',
    'enum MSLCDSegment {',
    ...Object.entries(bits).map(([name, bit]) => `    static let ${name} = 1 << ${bit}`),
    '}',
    '',
    'enum MSLCDGlyph {',
    `    /// Character -> OR'd MSLCDSegment bitmask, one entry per player3d/lcd-text.ts GLYPHS key.`,
    '    static let table: [Character: Int] = [',
    ...Object.entries(glyphs.table).map(([char, names]) => {
      const expr = names
        .split(' ')
        .filter(Boolean)
        .map((n) => `MSLCDSegment.${n}`)
        .join(' | ') || '0';
      const key = char === '"' ? '\\"' : char === '\\' ? '\\\\' : char;
      return `        "${key}": ${expr},`;
    }),
    '    ]',
    '}',
    '',
  );
}

// component.lcd.statusFormat.examples — concrete rendered readouts (right-justified track numbers etc).
{
  const examples = tokens.component.lcd.statusFormat.examples;
  structuralCss.push('', '  /* Component: LCD status format examples (player3d/lcd-text.ts lcdLine()) */');
  for (const [name, value] of Object.entries(examples)) {
    structuralCss.push(`  --ms-component-lcd-status-example-${kebab(name)}: "${value}";`);
  }
  structuralSwift.push(
    '/// Concrete rendered LCD strings (11 chars, see MSLCD.characterCount) proving the padding rule:',
    '/// left-justified for a bare status word, right-justified track numbers when lcdLine(left, right) is used.',
    'enum MSLCDStatusExample {',
    '    static let all: [String: String] = [',
    ...Object.entries(examples).map(([name, value]) => `        "${name}": "${value}",`),
    '    ]',
    '}',
    '',
  );
}

// component.bootLoader.terminal.lines — boot printout content + thresholds.
{
  const lines = tokens.component.bootLoader.terminal.lines;
  structuralCss.push('', '  /* Component: boot terminal lines (hud.ts BootTerminal content) */');
  lines.forEach((line, i) => {
    structuralCss.push(`  --ms-component-boot-loader-terminal-lines-${i}-text: "${line.text.replace(/"/g, '\\"')}";`);
    structuralCss.push(`  --ms-component-boot-loader-terminal-lines-${i}-at-ratio: ${line.atRatio};`);
  });
  structuralSwift.push(
    'struct MSBootLine { let text: String; let atRatio: Double }',
    '',
    'let msBootLines: [MSBootLine] = [',
    ...lines.map((line) => `    MSBootLine(text: "${line.text.replace(/"/g, '\\"')}", atRatio: ${line.atRatio}),`),
    ']',
    '',
  );
}

// component.listRow.eq — bar geometry + the full 0/50/100% keyframe set.
{
  const eq = tokens.component.listRow.eq;
  structuralCss.push('', '  /* Component: list row EQ bars (hud.css .p3d-track__eq, @keyframes p3d-eq) */');
  structuralCss.push(`  --ms-component-list-row-eq-bar-x-offsets: ${eq.barXOffsetsPx.map((v) => `${v}px`).join(', ')};`);
  structuralCss.push(`  --ms-component-list-row-eq-rest-heights: ${eq.restHeightsPct.map((v) => `${v}%`).join(', ')};`);
  for (const [key, frame] of Object.entries(eq.keyframes)) {
    structuralCss.push(`  --ms-component-list-row-eq-keyframe-${kebab(key)}: ${frame.heightsPct.map((v) => `${v}%`).join(', ')};`);
  }
  structuralSwift.push(
    '/// The three-bar EQ glyph next to the current track (hud.css .p3d-track__eq + @keyframes p3d-eq).',
    'enum MSEQ {',
    `    static let barXOffsets: [CGFloat] = [${eq.barXOffsetsPx.join(', ')}]`,
    `    static let restHeightsPct: [CGFloat] = [${eq.restHeightsPct.join(', ')}]`,
    '    /// Keyframe -> per-bar height percentages, in barXOffsets order.',
    '    static let keyframes: [(atPct: Double, heightsPct: [CGFloat])] = [',
    ...Object.entries(eq.keyframes).map(([key, frame]) => {
      const at = Number(key.replace('pct', ''));
      return `        (atPct: ${at}, heightsPct: [${frame.heightsPct.join(', ')}]),`;
    }),
    '    ]',
    '}',
    '',
  );
}

// component.listRow.current.backgroundGradient — the current-row gold gradient.
{
  const gradient = tokens.component.listRow.current.backgroundGradient;
  structuralCss.push('', '  /* Component: list row current-track gradient */');
  structuralCss.push(`  --ms-component-list-row-current-background-gradient: ${gradient.css};`);
  structuralSwift.push(
    '/// The current-track row background (hud.css .p3d-track[aria-current] linear-gradient(90deg, …)).',
    'enum MSGradient {',
    '    static let listRowCurrent = LinearGradient(',
    '        stops: [',
    ...gradient.stops.map(
      (stop) => `            .init(color: Color(msHex: "${stop.color.hex}", alpha: ${stop.color.alpha}), location: ${(stop.positionPct / 100).toFixed(2)}),`,
    ),
    '        ],',
    `        startPoint: .leading, endPoint: .trailing // angleDeg: ${gradient.angleDeg}`,
    '    )',
    '}',
    '',
  );
}

// component.spectrum.bandColorStops — the analyser's bass-to-treble ramp.
{
  const stops = tokens.component.spectrum.bandColorStops;
  structuralCss.push('', '  /* Component: spectrum analyser band colors (hud.ts BANDS) */');
  stops.forEach((stop, i) => {
    structuralCss.push(`  --ms-component-spectrum-band-${i}: ${colorCss(stop.color)};`);
  });
  structuralSwift.push(
    '/// The analyser bar ramp, bass to treble (hud.ts BANDS + bandColor()).',
    'extension MSComponent.Spectrum {',
    '    static let bandColorStops: [(positionPct: Double, color: Color)] = [',
    ...stops.map(
      (stop) => `        (positionPct: ${stop.positionPct}, color: Color(msHex: "${stop.color.hex}"${stop.color.alpha < 1 ? `, alpha: ${stop.color.alpha}` : ''})),`,
    ),
    '    ]',
    '}',
    '',
  );
}

// ── Type and component curated additions (scalar fields the generic walker already emitted from
//    tokens.json verbatim; this block only adds the two font-stack constants, which live under a key
//    the generic walker intentionally does not touch since `fontFamilies.*.css` strings are consumed
//    by the Swift font enum, not flattened 1:1). ──

const t = tokens.type;
const curatedCss = [
  '',
  '  /* Type: font stacks (consumed by MSFont in Theme.swift via PostScript name, not this var) */',
  `  --ms-font-inter: ${t.fontFamilies.inter.css};`,
  `  --ms-font-mono: ${t.fontFamilies.jetbrainsMono.css};`,
];

// ── Assemble tokens.css ─────────────────────────────────────────────────

const css = `/* GENERATED FILE — do not edit by hand. Regenerate with \`npm run tokens\`.
 * Source: packages/tokens/tokens.json (DS-33). NOT wired into the site yet — replacing the
 * hardcoded values in hud.css/theme.css with these is a later, separate step. */

:root {
${cssLines.join('\n')}
${curatedCss.join('\n')}
${structuralCss.join('\n')}
}
`;

// ── Swift generation ────────────────────────────────────────────────────

const colorLines = Object.entries(tokens.color.tokens)
  .map(([key, { hex, alpha }]) => `    static let ${key} = Color(msHex: "${hex}"${alpha < 1 ? `, alpha: ${alpha}` : ''})`)
  .join('\n');

const spaceLines = Object.entries(tokens.space.tokens)
  .map(([key, { value }]) => `    static let ${key}: CGFloat = ${value}`)
  .join('\n');

const shape = tokens.shape;
const motion = tokens.motion;
const c = tokens.component;

/** Resolve a color-ish reference (a bare color-token name, or an inline {hex,alpha}) to a Swift
 * `Color` expression. Falls back to `.clear` with a comment for anything unresolvable (should not
 * happen for real tokens; a fallback keeps the generator from crashing on a typo instead of silently
 * emitting bad Swift). */
function swiftColor(ref) {
  if (ref == null) return 'Color.clear /* dynamic, no fixed color */';
  if (isColorPair(ref)) return `Color(msHex: "${ref.hex}"${ref.alpha < 1 ? `, alpha: ${ref.alpha}` : ''})`;
  if (typeof ref === 'string') {
    if (tokens.color.tokens[ref]) return `MSColor.${ref}`;
    return `Color.clear /* unresolved color ref "${ref}" */`;
  }
  return 'Color.clear /* unresolved */';
}

function swiftGlow(name) {
  const g = tokens.glow.tokens[name];
  if (!g) return `MSGlow(color: .clear, radius: 0, x: 0, y: 0) /* unresolved glow "${name}" */`;
  return `MSGlow(color: ${swiftColor(g.color)}, radius: ${g.blurPt}, x: ${g.offsetX}, y: ${g.offsetY})`;
}

const swift = `// GENERATED FILE — do not edit by hand. Regenerate with \`npm run tokens\`.
// Source: packages/tokens/tokens.json (DS-33), itself transcribed from the live LIT player CSS/TS —
// including src/player3d/hud.ts and hud-fx.ts, which is where several type roles turned out to render
// in JetBrains Mono rather than Inter (hud.ts adds the \`p3d-mono\` class from JS; see
// tokens.json meta.criticRound2Note). See tokens.json's \`meta.disagreementsWithPrdTable\` for every
// place this differs from the PRD's §4A table (the CSS/TS is the source of truth, not the table).

import SwiftUI

// MARK: - Color

extension Color {
    /// Hex + alpha, no asset catalog needed. \`hex\` is "#RRGGBB"; \`alpha\` is 0...1.
    init(msHex hex: String, alpha: Double = 1) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        var rgbValue: UInt64 = 0
        Scanner(string: s).scanHexInt64(&rgbValue)
        let r = Double((rgbValue & 0xFF0000) >> 16) / 255
        let g = Double((rgbValue & 0x00FF00) >> 8) / 255
        let b = Double(rgbValue & 0x0000FF) / 255
        self.init(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }
}

enum MSColor {
${colorLines}
}

// MARK: - Glow (portable text-shadow / box-shadow / filter:drop-shadow equivalent)

/// A single-layer glow: pair with \`.shadow(color:radius:x:y:)\` (SwiftUI approximates CSS blur radius
/// 1:1 well enough for these small values) or, for text, \`.shadow\` on the Text view directly.
struct MSGlow {
    let color: Color
    let radius: CGFloat
    let x: CGFloat
    let y: CGFloat
}

enum MSGlowStyle {
    static let goldReadout = ${swiftGlow('goldReadout')}
    static let goldTrackTitle = ${swiftGlow('goldTrackTitle')}
    static let goldPrimaryPulse = ${swiftGlow('goldPrimaryPulse')}
    static let goldBootBar = ${swiftGlow('goldBootBar')}
    static let goldGauge = ${swiftGlow('goldGauge')}
    static let goldMiniPlayerBar = ${swiftGlow('goldMiniPlayerBar')}
    static let goldButtonHover = ${swiftGlow('goldButtonHover')}
    static let iceInspectHint = ${swiftGlow('iceInspectHint')}
    static let oscilloscope = ${swiftGlow('oscilloscope')}
    static let float = ${swiftGlow('float')}
    static let floatLift = ${swiftGlow('floatLift')}
    /// spectrumBar and lcdSegment have no fixed color/blur (per-bar / per-frame dynamic) — see
    /// component.spectrum.glow and component.lcd.layout.glowBlurRatio in tokens.json instead.
}

// MARK: - Fonts

/// Inter and JetBrains Mono, bundled as static TTFs (packages/tokens/fonts/), both OFL. Register them
/// at launch with \`CTFontManagerRegisterFontsForURL\` for each .ttf (or list them under the app/widget
/// target's Info.plist \`UIAppFonts\` key so the system registers them automatically); SwiftUI's
/// \`Font.custom\` then finds them by PostScript name. (\`UIFont.registerFont(from:)\` does not exist —
/// do not copy that from an older draft of this file.)
enum MSFont {
    enum InterWeight {
        case regular, medium, semibold, extrabold

        var postscriptName: String {
            switch self {
            case .regular: return "${t.fontFamilies.inter.postscriptNames['400']}"
            case .medium: return "${t.fontFamilies.inter.postscriptNames['500']}"
            case .semibold: return "${t.fontFamilies.inter.postscriptNames['600']}"
            case .extrabold: return "${t.fontFamilies.inter.postscriptNames['800']}"
            }
        }
    }

    enum MonoWeight {
        case medium, semibold, bold

        var postscriptName: String {
            switch self {
            case .medium: return "${t.fontFamilies.jetbrainsMono.postscriptNames['500']}"
            case .semibold: return "${t.fontFamilies.jetbrainsMono.postscriptNames['600']}"
            case .bold: return "${t.fontFamilies.jetbrainsMono.postscriptNames['700']}"
            }
        }
    }

    static func inter(_ size: CGFloat, weight: InterWeight = .regular) -> Font {
        .custom(weight.postscriptName, size: size)
    }

    static func mono(_ size: CGFloat, weight: MonoWeight = .medium) -> Font {
        .custom(weight.postscriptName, size: size)
    }

    /// Ready-made styles for the named type roles in tokens.json \`type\`, corrected in round 2 to match
    /// what the live DOM actually renders (hud.ts adds \`p3d-mono\` to several elements whose own CSS
    /// rule never sets font-family — see tokens.json meta.criticRound2Note). Only mono weights
    /// 500/600/700 are bundled: a declared 800 (primaryButton) has no matching face and renders as the
    /// heaviest loaded one (Bold/700, MonoWeight.bold below); a declared/default 400 (readoutValue,
    /// trackNumDur, panelMeta) renders as the lightest loaded one (Medium/500, MonoWeight.medium).
    enum Style {
        static let label = MSFont.mono(${t.label.sizePt[0]}, weight: .semibold) // DS-8
        static let panelTitle = MSFont.inter(${t.panelTitle.sizePt}, weight: .extrabold) // DS-9 — genuinely Inter, no p3d-mono class
        static let panelMeta = MSFont.mono(${t.panelMeta.sizePt}, weight: .medium) // declared 400, renders Medium (500)
        static let primaryButton = MSFont.mono(${t.primaryButton.sizePt}, weight: .bold) // DS-10 — declared 800, renders Bold (700)
        static let trackTitle = MSFont.inter(${t.trackTitle.sizePt}, weight: .medium) // genuinely Inter (explicit shorthand, no p3d-mono)
        static let trackNumDur = MSFont.mono(${t.trackNumDur.sizePt}, weight: .medium) // declared 400, renders Medium (500)
        static let readoutValue = MSFont.mono(${t.readoutValue.sizePt}, weight: .medium) // declared 400, renders Medium (500)
        static let keyButton = MSFont.mono(${t.keyButton.sizePt}, weight: .semibold) // DS-15
        static let repeatButton = MSFont.mono(${t.repeatButton.sizePt}, weight: .bold) // declared+rendered 700, exact match
        static let sheetToggleLabel = MSFont.mono(${t.sheetToggleLabel.sizePt}, weight: .bold) // declared+rendered 700, exact match
        static let readoutLabel = MSFont.mono(${t.label.sizePt[0]}, weight: .semibold) // DS-8, alias of Style.label
        static let largeTitle = MSFont.inter(${t.largeTitle.sizePt}, weight: .extrabold) // DS-12 — genuinely Inter (theme.css:63-71 var(--font-hud))
        static let iosNavTitle = MSFont.inter(${t.iosNavTitle.sizePt}, weight: .semibold)
        static let tabLabel = MSFont.mono(${t.tabLabel.sizePt}, weight: .semibold) // DS-26
    }

    enum LineHeight {
        static let trackTitle: CGFloat = ${t.trackTitle.lineHeight} // hud.css .p3d-track { font: 500 14px/1.25 'Inter' }
        static let largeTitle: CGFloat = ${t.largeTitle.lineHeight} // src/ios.css body.ios-app .dashboard-title
    }

    enum Tracking {
        static let label: CGFloat = ${t.label.sizePt[0]} * ${t.label.tracking} // ${(t.label.sizePt[0] * t.label.tracking).toFixed(2)}pt
        static let panelTitle: CGFloat = ${t.panelTitle.sizePt} * ${t.panelTitle.tracking} // ${(t.panelTitle.sizePt * t.panelTitle.tracking).toFixed(2)}pt
        static let primaryButton: CGFloat = ${t.primaryButton.sizePt} * ${t.primaryButton.tracking} // ${(t.primaryButton.sizePt * t.primaryButton.tracking).toFixed(2)}pt
        static let keyButton: CGFloat = ${t.keyButton.sizePt} * ${t.keyButton.tracking} // ${(t.keyButton.sizePt * t.keyButton.tracking).toFixed(2)}pt
        static let repeatButton: CGFloat = ${t.repeatButton.sizePt} * ${t.repeatButton.tracking} // ${(t.repeatButton.sizePt * t.repeatButton.tracking).toFixed(2)}pt
        static let sheetToggleLabel: CGFloat = ${t.sheetToggleLabel.sizePt} * ${t.sheetToggleLabel.tracking} // ${(t.sheetToggleLabel.sizePt * t.sheetToggleLabel.tracking).toFixed(2)}pt
        static let largeTitle: CGFloat = ${t.largeTitle.sizePt} * (${t.largeTitle.tracking}) // ${(t.largeTitle.sizePt * t.largeTitle.tracking).toFixed(2)}pt
        static let iosNavTitle: CGFloat = ${t.iosNavTitle.sizePt} * (${t.iosNavTitle.tracking}) // ${(t.iosNavTitle.sizePt * t.iosNavTitle.tracking).toFixed(2)}pt
        static let tabLabel: CGFloat = ${t.tabLabel.sizePt} * ${t.tabLabel.tracking} // ${(t.tabLabel.sizePt * t.tabLabel.tracking).toFixed(2)}pt
        static let sectionLabel: CGFloat = ${t.sectionLabel.sizePt} * ${t.sectionLabel.tracking} // ${(t.sectionLabel.sizePt * t.sectionLabel.tracking).toFixed(2)}pt
        /// \`.p3d-mono\`'s own base tracking (0.06em) is size-independent in the CSS; multiply by
        /// whatever size you apply it at: \`size * monoDefaultEm\`.
        static let monoDefaultEm: CGFloat = 0.06
    }
}

// MARK: - Motion (DS-28 to DS-30)

enum MSMotion {
    /// DS-28: the standard curve, 0.35s for moves. Canonical example: hud.css:649 .p3d-tracklist.
    static let standard = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: ${motion.standardCurve.durationMoveS})
    /// DS-28: the same curve, 0.5s for larger moves.
    static let standardLarge = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: ${motion.standardCurve.durationLargeS})
    /// DS-29: the BOOT LOADER's own fade-out only (hud.css .p3d-boot), CSS \`ease\`
    /// (cubic-bezier(0.25, 0.1, 0.25, 1.0)). Distinct from midSessionOverlayFade below.
    static let overlayFade = Animation.timingCurve(0.25, 0.1, 0.25, 1.0, duration: ${motion.overlayFadeS.value})
    /// Mid-session overlays (primary button / inspect hint / open hint) fade in/out on a SEPARATE,
    /// shorter 0.42s timing (hud.css:1384-1391), not the 0.6s boot fade above. Pair with a 10pt
    /// vertical offset (see MSComponent.OverlayShowHide) — CSS animates opacity AND translate together.
    static let midSessionOverlayFade = Animation.easeInOut(duration: ${motion.midSessionOverlayFadeS.value})
    /// DS-29: scene reveals. Literal CSS is a ${motion.sceneRevealS.durationS}s fade with a ${motion.sceneRevealS.delayS}s
    /// delay (~${motion.sceneRevealS.totalApproxS}s total) — the PRD's "about 3 s" rounds this.
    /// Citations: hud.css:1290-1294 (.p3d-hud/.p3d-insert/.p3d-inspect-hint) and hud.css:1162-1164
    /// (.stream-page .main-nav) — two separate rules, same value.
    static let sceneReveal = Animation.timingCurve(0.25, 0.1, 0.25, 1.0, duration: ${motion.sceneRevealS.durationS}).delay(${motion.sceneRevealS.delayS})
    /// DS-14: the primary button's idle glow pulse. CSS \`animation: p3d-pulse 1.8s ease-in-out
    /// infinite\` runs ONE 1.8s cycle per iteration; SwiftUI's \`repeatForever(autoreverses: true)\`
    /// instead plays the given duration forward THEN backward each cycle, so it must be given HALF
    /// the CSS duration (0.9s) to land on the same 1.8s total — NOT \`duration: 1.8\`.
    static let pulseCycle = Animation.easeInOut(duration: ${motion.pulseCycleS.swiftHalfDurationS}).repeatForever(autoreverses: true)
    /// Now-playing disc spin (theme.css \`mini-player-spin\`).
    static let discSpin = Animation.linear(duration: ${motion.discSpinS.value}).repeatForever(autoreverses: false)
    /// hud.css @keyframes p3d-label-open (the tracklist sheet toggle's title spring on open).
    static let labelOpen = Animation.timingCurve(${motion.labelOpenAnim.cubicBezier.join(', ')}, duration: ${motion.labelOpenAnim.durationS})
    /// hud.css @keyframes p3d-label-close (…on close).
    static let labelClose = Animation.timingCurve(${motion.labelCloseAnim.cubicBezier.join(', ')}, duration: ${motion.labelCloseAnim.durationS})
    /// theme.css @keyframes myind-rise-in / hud.css @keyframes p3d-rise-in — the shared "rise in" reveal.
    static let riseIn = Animation.timingCurve(${motion.riseInS.cubicBezier.join(', ')}, duration: ${motion.riseInS.value})
    /// theme.css @keyframes myind-page-in — CSS \`ease\`.
    static let pageIn = Animation.timingCurve(0.25, 0.1, 0.25, 1.0, duration: ${motion.pageInS.value})
    /// theme.css body.page-leaving — CSS \`ease\`.
    static let pageLeaving = Animation.timingCurve(0.25, 0.1, 0.25, 1.0, duration: ${motion.pageLeavingS.value})
    /// theme.css body .modal-overlay.is-closing — CSS \`ease\`.
    static let modalClosing = Animation.timingCurve(0.25, 0.1, 0.25, 1.0, duration: ${motion.modalClosingS.value})
    /// theme.css @keyframes mini-player-in.
    static let miniPlayerIn = Animation.timingCurve(${motion.miniPlayerInS.cubicBezier.join(', ')}, duration: ${motion.miniPlayerInS.value})
    /// theme.css .mini-player--leaving — CSS \`ease\`.
    static let miniPlayerLeaving = Animation.timingCurve(0.25, 0.1, 0.25, 1.0, duration: ${motion.miniPlayerLeavingS.value})
    /// theme.css @keyframes mini-player-ask — same single-midpoint shape as pulseCycle, halved for
    /// SwiftUI's autoreverse doubling (see pulseCycle's own note).
    static let askPulse = Animation.easeInOut(duration: ${motion.askPulseS.swiftHalfDurationS}).repeatForever(autoreverses: true)
    /// hud.css @keyframes p3d-open-pulse — same single-midpoint shape as pulseCycle, halved.
    static let openPulse = Animation.easeInOut(duration: ${motion.openPulseS.swiftHalfDurationS}).repeatForever(autoreverses: true)
    /// hud.css @keyframes nav-peek-bob is an ASYMMETRIC 4-stage keyframe (0%/68%/80%/100%), not a
    /// symmetric midpoint — there is no simple Animation curve for it. This is the raw duration only;
    /// drive the actual bob with a discrete keyframe/phase animation (e.g. PhaseAnimator), not
    /// Animation.easeInOut.repeatForever.
    static let navPeekBobDurationS: Double = ${motion.navPeekBobS.value}
    /// CSS \`steps()\` timing functions (glitch text, the EQ bars via MSEQ, the terminal caret) are
    /// discrete frame jumps with no native SwiftUI Animation equivalent — these are raw durations
    /// for a Timer-driven or explicit per-step state machine, not Animation curves.
    static let glitchJitterDurationS: Double = ${motion.glitchJitterAnim.durationS}
    static let glitchGhostDurationS: Double = ${motion.glitchGhostAnim.durationS}
    static let terminalCaretBlinkDurationS: Double = ${motion.terminalCaretBlinkAnim.durationS}
    /// DS-30: Reduce Motion. The CSS sets \`animation: none; transition: none\` outright — an instant
    /// state change, not a soft fallback crossfade — so the SwiftUI equivalent is \`nil\`, not a short
    /// Animation. Use \`withAnimation(reduceMotion ? MSMotion.reducedMotionFallback : MSMotion.standard)\`.
    static let reducedMotionFallback: Animation? = nil

    enum PressScale {
        /// DS-29's blanket rule; matches body.ios-app .product-card:active.
        static let tile: CGFloat = ${motion.pressScale.tile.value}
        /// body.ios-app .action-card:active — a lighter squish than DS-29 states.
        static let actionRow: CGFloat = ${motion.pressScale.actionRow.value}
        /// .ios-tab:active — a heavier squish than DS-29 states.
        static let tabIcon: CGFloat = ${motion.pressScale.tabIcon.value}
    }
}

// MARK: - Shape (DS-13, DS-14, DS-15, DS-21)

enum MSShape {
    static let chamfer: CGFloat = ${shape.chamferPt.value}
    static let cornerTickSize: CGFloat = ${shape.cornerTickPt.size}
    static let cornerTickStroke: CGFloat = ${shape.cornerTickPt.strokeWidth}
    static let primaryButtonSlant: CGFloat = ${shape.primaryButtonSlantPt.value}
    static let minTouchTarget: CGFloat = ${shape.minTouchTargetPt.default}
    static let primaryButtonMinHeight: CGFloat = ${shape.minTouchTargetPt.primaryButton}
    /// The DEFAULT focus ring (+2pt offset). NOT universal — see MSComponent.ListRow.focusRingOffset
    /// (-2, inset) and MSComponent.peripheralFocusRingOffset (+3, nav-peek / mini-player bar).
    static let focusRingWidth: CGFloat = ${shape.focusRing.widthPt}
    static let focusRingOffset: CGFloat = ${shape.focusRing.offsetPt}
    static let hairlineWidth: CGFloat = ${shape.hairlineWidthPt.value}
    /// Vite scaffold leftover (src/style.css:85-95 \`button { border-radius: 8px }\`) — DO NOT ADOPT.
    /// Recorded only so nobody mistakes it for a real DS-15 value. See tokens.json disagreements list.
    static let strayGlobalButtonRadius: CGFloat = ${shape.strayGlobalButtonRadiusPt.value}
    /// Legacy site chrome (theme.css/ios.css) — not yet unified with the HUD chamfer motif above.
    static let siteCardRadius: CGFloat = ${shape.siteCardRadiusPt.value}
    static let siteButtonRadius: CGFloat = ${shape.siteButtonRadiusPt.value}
    static let iosGroupedRadius: CGFloat = ${shape.iosGroupedRadiusPt.value}
    static let pillRadius: CGFloat = ${shape.pillRadiusPt.value} // ios.css:458 .order-status; hud.css:1196 .nav-peek
}

// MARK: - Space

/// The discrete pixel steps actually repeated across hud.css/theme.css — an inventory, not a
/// prescriptive scale (see tokens.json \`space.$note\`).
enum MSSpace {
${spaceLines}
}

// MARK: - Component

enum MSComponent {
    enum HUDPanel {
        static let paddingTop: CGFloat = ${c.hudPanel.paddingPt.top}
        static let paddingHorizontal: CGFloat = ${c.hudPanel.paddingPt.right}
        static let paddingBottom: CGFloat = ${c.hudPanel.paddingPt.bottom}
        static let headerPaddingBottom: CGFloat = ${c.hudPanel.header.paddingBottomPt}
        static let headerMarginBottom: CGFloat = ${c.hudPanel.header.marginBottomPt}
        static let scanlineAlpha: Double = ${c.hudPanel.background.scanline.lineAlpha}
        static let scanlineLineHeight: CGFloat = ${c.hudPanel.background.scanline.lineHeightPx}
        static let scanlinePeriod: CGFloat = ${c.hudPanel.background.scanline.periodPx}
        static let cornerTickColor = MSColor.gold
    }

    /// theme.css product/account/stats cards — a DIFFERENT, lighter corner tick than HUDPanel's.
    enum SiteCard {
        static let cornerTickSize: CGFloat = ${c.siteCard.cornerTick.sizePt}
        static let cornerTickStroke: CGFloat = ${c.siteCard.cornerTick.strokeWidthPt}
        /// gold at 60% alpha (\`--line\`), NOT full gold — see tokens.json disagreements list.
        static let cornerTickColor = MSColor.line
    }

    /// DS-18 grouped lists (ios.css). NOT a HUDPanel — plain rounded rect + cream fill/separators.
    enum GroupedList {
        static let fill = MSColor.creamFill
        static let borderWidth: CGFloat = 1
        static let radius = MSShape.iosGroupedRadius
        static let actionRowSeparatorInset: CGFloat = ${c.groupedList.separator.actionRow.insetPt}
        static let orderRowSeparatorInset: CGFloat = ${c.groupedList.separator.orderRow.insetPt}
        static let separatorColor = MSColor.creamSeparator
        static let iconTileSize: CGFloat = ${c.groupedList.iconTile.sizePt}
        static let iconTileRadius: CGFloat = ${c.groupedList.iconTile.radiusPt}
        static let iconSize: CGFloat = ${c.groupedList.iconTile.iconSizePt}
        static let chevronSize: CGFloat = ${c.groupedList.chevron.sizePt}
        static let chevronColor = MSColor.creamChevron
    }

    enum PrimaryButton {
        static let minHeight: CGFloat = ${c.primaryButton.minHeightPt}
        static let slant: CGFloat = ${c.primaryButton.slantPt}
        static let paddingHorizontal: CGFloat = ${c.primaryButton.paddingHorizontalPt}
        /// Differs from MSShape.focusRing (gold, 2pt) — the primary button's own ring is white, 3pt,
        /// 4pt offset. See tokens.json meta.disagreementsWithPrdTable.
        static let focusRingWidth: CGFloat = ${c.primaryButton.focusRing.widthPt}
        static let focusRingOffset: CGFloat = ${c.primaryButton.focusRing.offsetPt}
        static let focusRingColor = Color.white
        static let pulseDuration: Double = ${motion.pulseCycleS.totalS}
    }

    /// Shared show/hide motion for the primary button, inspect hint and open hint (hud.css:1384-1405).
    enum OverlayShowHide {
        static let shownOpacity: Double = ${c.overlayShowHide.shownOpacity}
        static let hiddenOpacity: Double = ${c.overlayShowHide.hiddenOpacity}
        static let hiddenTranslateY: CGFloat = ${c.overlayShowHide.hiddenTranslateYPx}
        static let animation = MSMotion.midSessionOverlayFade
    }

    enum KeyButton {
        static let minHeight: CGFloat = ${c.keyButton.minHeightPt}
        static let paddingHorizontal: CGFloat = ${c.keyButton.paddingHorizontalPt}
        static let textColor = MSColor.text
        static let latchedFill = MSColor.gold
        static let latchedTextColor = MSColor.ink
    }

    enum ListRow {
        static let minHeight: CGFloat = ${c.listRow.minHeightPt}
        static let gap: CGFloat = ${c.listRow.gapPt}
        static let currentLeadingBorderWidth: CGFloat = ${c.listRow.current.leadingBorderWidthPt}
        /// INSET, not the +2 MSShape.focusRing default — see tokens.json disagreements list.
        static let focusRingOffset: CGFloat = ${c.listRow.focusRingOffsetPt.value}
    }

    enum ReadoutRow {
        static let minHeight: CGFloat = ${c.readoutRow.minHeightPt}
        static let gap: CGFloat = ${c.readoutRow.gapPt}
        static let dividerWidth: CGFloat = ${c.readoutRow.divider.widthPt}
        static let dividerAlpha: Double = ${c.readoutRow.divider.color.alpha}
        static let dividerDashPattern: [CGFloat] = [${c.readoutRow.divider.widthPt}, ${c.readoutRow.divider.widthPt}] // "1px dashed"
    }

    enum Sheet {
        static let panelAlpha: Double = ${c.sheet.panelAlpha}
        static let toggleMinHeight: CGFloat = ${c.sheet.toggleMinHeightPt}
        static let focusRingOffset: CGFloat = ${c.sheet.focusRingOffsetPt}
    }

    /// nav-peek and the mini-player scrub bar both use +3pt, not the default +2pt (MSShape.focusRing).
    static let peripheralFocusRingOffset: CGFloat = ${c.peripheralFocusRingOffsetPt.value}

    enum TabBar {
        static let iconSize: CGFloat = ${c.tabBar.tab.iconSizePt}
        static let iconStrokeWidth: CGFloat = ${c.tabBar.tab.iconStrokeWidth}
        static let bottomPaddingTop: CGFloat = ${c.tabBar.bottomBar.paddingTopPt}
        static let blur: CGFloat = ${c.tabBar.topBar.blurPx}
        static let saturate: Double = ${c.tabBar.topBar.saturatePct}
        static let topBarHeightBase: CGFloat = ${c.tabBar.topBar.heightBasePt} // + safe area inset top
        static let handoverScroll: CGFloat = ${c.tabBar.topBar.handoverScrollPx}
    }

    enum NowPlaying {
        static let blur: CGFloat = ${c.nowPlaying.blurPt}
        static let radius: CGFloat = ${c.nowPlaying.radiusPt}
        static let paddingVertical: CGFloat = ${c.nowPlaying.paddingPt.vertical}
        static let paddingHorizontal: CGFloat = ${c.nowPlaying.paddingPt.horizontal}
        static let gap: CGFloat = ${c.nowPlaying.gapPt}
        static let artSizeDesktop: CGFloat = ${c.nowPlaying.art.sizePt.desktop}
        static let artSizePhone: CGFloat = ${c.nowPlaying.art.sizePt.phone}
        static let barHeight: CGFloat = ${c.nowPlaying.bar.heightPt}
        static let barBackgroundAlpha: Double = ${tokens.color.tokens.miniPlayerBarBg.alpha}
        static let playingBorderAlpha: Double = ${tokens.color.tokens.goldPlayingBorder.alpha}
        static let askRingWidth: CGFloat = ${c.nowPlaying.askRing.widthPt}
        static let askRingAlpha: Double = ${tokens.color.tokens.goldAskRing.alpha}
        /// Below MSShape.minTouchTarget (44) — pre-existing, flagged in tokens.json.
        static let keySizeDesktop: CGFloat = ${c.nowPlaying.key.sizePt.desktop}
        static let keySizePhone: CGFloat = ${c.nowPlaying.key.sizePt.phone}
        static let closeButtonSize: CGFloat = ${c.nowPlaying.closeButtonSizePt}
        /// gold at 60% alpha (\`--line\`), NOT full gold — see tokens.json disagreements list.
        static let cornerTickSize: CGFloat = ${c.nowPlaying.cornerTick.sizePt}
        static let cornerTickStroke: CGFloat = ${c.nowPlaying.cornerTick.strokeWidthPt}
        static let cornerTickColor = MSColor.line
        /// src/ios.css:518-522 — the docked-above-tab-bar phone position overrides theme.css's 10pt
        /// insets to 8pt left/right, bottom = 58 + safe area inset bottom.
        static let dockedBottomBase: CGFloat = ${c.nowPlaying.iosAppDocked.bottomExpr.value.match(/\\d+/)?.[0] ?? '58'}
        static let dockedLeft: CGFloat = ${c.nowPlaying.iosAppDocked.leftPt}
        static let dockedRight: CGFloat = ${c.nowPlaying.iosAppDocked.rightPt}
    }

    enum Spectrum {
        static let barGapRatio: CGFloat = ${c.spectrum.barGapRatio}
        static let barWidthRatio: CGFloat = ${c.spectrum.barWidthRatio}
        static let barMaxHeightRatio: CGFloat = ${c.spectrum.barMaxHeightRatio}
        static let silentBaselineHeightAtDpr1: CGFloat = ${c.spectrum.silentBaseline.heightPxAtDpr1}
        static let oscilloscopeLineWidthRatio: CGFloat = ${c.spectrum.oscilloscope.lineWidthRatio}
        static let oscilloscopeLineWidthMin: CGFloat = ${c.spectrum.oscilloscope.lineWidthMinPt}
        static let oscilloscopeMidlineRatio: CGFloat = ${c.spectrum.oscilloscope.midlineRatio}
        static let oscilloscopeEnvelopeBase: CGFloat = ${c.spectrum.oscilloscope.envelopeBase}
        static let oscilloscopeEnvelopeSwing: CGFloat = ${c.spectrum.oscilloscope.envelopeSwing}
        static let oscilloscopeAmplitudeRatio: CGFloat = ${c.spectrum.oscilloscope.amplitudeRatio}
        static let sparklineWindowSize: Int = ${c.spectrum.sparkline.windowSize}
        static let sparklineThreshold: CGFloat = ${c.spectrum.sparkline.threshold}
        static let sparklineDash: [CGFloat] = [${c.spectrum.sparkline.dashPt.join(', ')}]
        static let sparklineLineWidth: CGFloat = ${c.spectrum.sparkline.lineWidthPt}
        static let sparklinePeakRadius: CGFloat = ${c.spectrum.sparkline.peakRadiusPt}
        static let radialGaugeStartDeg: Double = ${c.spectrum.radialGauge.startDeg}
        static let radialGaugeSpanDeg: Double = ${c.spectrum.radialGauge.spanDeg}
        static let radialGaugeRadius: CGFloat = ${c.spectrum.radialGauge.radiusPt}
        static let radialGaugeTickCount: Int = ${c.spectrum.radialGauge.tickCount}
        static let radialGaugeTickInnerMajor: CGFloat = ${c.spectrum.radialGauge.tickInnerMajorPt}
        static let radialGaugeTickInnerMinor: CGFloat = ${c.spectrum.radialGauge.tickInnerMinorPt}
        static let radialGaugeTickOuter: CGFloat = ${c.spectrum.radialGauge.tickOuterPt}
        static let radialGaugeMajorTickEvery: Int = ${c.spectrum.radialGauge.majorTickEvery}
        static let radialGaugeEaseMs: Double = ${motion.radialGaugeEaseMs.value}
        static let sparklinePushThrottleMs: Double = ${motion.sparklinePushThrottleMs.value}
    }

    enum LCD {
        static let characterCount: Int = ${c.lcd.characterCount}
        static let characterAspect: CGFloat = ${c.lcd.characterAspect.widthToHeight} // width / height
        static let italicSlant: CGFloat = ${c.lcd.italicSlant}
        static let flashDurationMs: Double = ${motion.lcdFlashMs.value}

        enum Layout {
            static let padXRatio: CGFloat = ${c.lcd.layout.padXRatio}
            static let cellWidthRatio: CGFloat = ${c.lcd.layout.cellWidthRatio}
            static let segmentThicknessRatio: CGFloat = ${c.lcd.layout.segmentThicknessRatio}
            static let segmentGapRatio: CGFloat = ${c.lcd.layout.segmentGapRatio}
            static let insetRatio: CGFloat = ${c.lcd.layout.insetRatio}
            static let bezelCornerRadiusRatio: CGFloat = ${c.lcd.layout.bezelCornerRadiusRatio}
            static let baselineOffsetRatio: CGFloat = ${c.lcd.layout.baselineOffsetRatio}
            static let glowBlurRatio: CGFloat = ${c.lcd.layout.glowBlurRatio}
            static let diagonalNormalRatio: CGFloat = ${c.lcd.layout.diagonalNormalRatio}
            static let diagonalOffsetRatio: CGFloat = ${c.lcd.layout.diagonalOffsetRatio}
            static let flagMaxSizeRatio: CGFloat = ${c.lcd.layout.flagMaxSizeRatio}
            static let flagYOffsetRatio: CGFloat = ${c.lcd.layout.flagYOffsetRatio}
            static let flagSpacingRatio: CGFloat = ${c.lcd.layout.flagSpacingRatio}
        }

        enum Flags {
            static let playTipXRatio: CGFloat = ${c.lcd.flags.play.tipXRatio}
            static let playTipYRatio: CGFloat = ${c.lcd.flags.play.tipYRatio}
            static let pauseBarWidthRatio: CGFloat = ${c.lcd.flags.pause.barWidthRatio}
            static let pauseBarOffsetRatio: CGFloat = ${c.lcd.flags.pause.barOffsetRatio}
            static let stopWidthRatio: CGFloat = ${c.lcd.flags.stop.widthRatio}
            static let repeatOuterRadiusRatio: CGFloat = ${c.lcd.flags.repeat.outerRadiusRatio}
            static let repeatInnerRadiusRatio: CGFloat = ${c.lcd.flags.repeat.innerRadiusRatio}
            static let repeatArcStartDeg: Double = ${c.lcd.flags.repeat.arcStartDeg}
            static let repeatArcEndDeg: Double = ${c.lcd.flags.repeat.arcEndDeg}
        }
    }

    enum BootLoader {
        static let textTracking: CGFloat = ${c.bootLoader.tracking}
        static let textSize: CGFloat = ${c.bootLoader.sizePt}
        static let gap: CGFloat = ${c.bootLoader.gapPt}
        static let trackWidthMax: CGFloat = ${c.bootLoader.track.widthMaxPt}
        static let trackWidthMaxPct: CGFloat = ${c.bootLoader.track.widthMaxPct}
        static let trackHeight: CGFloat = ${c.bootLoader.track.heightPt}
        static let trackBackgroundAlpha: Double = ${c.bootLoader.track.background.alpha}
        static let barTransitionDuration: Double = ${c.bootLoader.bar.transitionDurationS}
        static let terminalWidthMax: CGFloat = ${c.bootLoader.terminal.widthMaxPt}
        static let terminalWidthMaxPct: CGFloat = ${c.bootLoader.terminal.widthMaxPct}
        static let terminalMinHeight: CGFloat = ${c.bootLoader.terminal.minHeightPt}
        static let terminalTextSize: CGFloat = ${c.bootLoader.terminal.sizePt}
        static let terminalLineHeight: CGFloat = ${c.bootLoader.terminal.lineHeight}
        static let terminalTracking: CGFloat = ${c.bootLoader.terminal.tracking}
        static let terminalPrefix: String = "${c.bootLoader.terminal.prefix.text}"
        static let terminalPrefixColor = MSColor.terminalPrefix
        static let terminalCharsPerTick: Int = ${c.bootLoader.terminal.typing.charsPerTick}
        static let terminalTickDelayMinMs: Double = ${motion.terminalTypingMinMs.value}
        static let terminalTickDelayMaxMs: Double = ${motion.terminalTypingMaxMs.value}
        static let caretWidth: CGFloat = ${c.bootLoader.caret.widthPt}
        static let caretHeight: CGFloat = ${c.bootLoader.caret.heightPt}
    }
}

${structuralSwift.join('\n')}
`;

// ── Write ────────────────────────────────────────────────────────────────

mkdirSync(DIST_DIR, { recursive: true });
writeFileSync(path.join(DIST_DIR, 'tokens.css'), css);
writeFileSync(path.join(DIST_DIR, 'Theme.swift'), swift);
writeFileSync(path.join(DIST_DIR, 'emitted.json'), JSON.stringify(emitted, null, 2));

console.log('Wrote packages/tokens/dist/tokens.css, Theme.swift and emitted.json');
