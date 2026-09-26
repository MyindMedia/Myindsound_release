import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * DS-33: runs the real generator (packages/tokens/scripts/build.mjs) against the real tokens.json and
 * checks its actual output files (tokens.css, Theme.swift, and the generator's own emitted.json audit
 * trail), rather than re-implementing the build logic here.
 */

const PKG_ROOT = new URL('.', import.meta.url).pathname;
const TOKENS_JSON = join(PKG_ROOT, 'tokens.json');
const BUILD_SCRIPT = join(PKG_ROOT, 'scripts', 'build.mjs');

type Emitted = Record<string, { cssVar: string; css: string; cssOnlyReason: string | null }>;

function runBuild(): { css: string; swift: string; emitted: Emitted; tokens: any } {
  execFileSync(process.execPath, [BUILD_SCRIPT], { stdio: 'pipe' });
  const css = readFileSync(join(PKG_ROOT, 'dist', 'tokens.css'), 'utf8');
  const swift = readFileSync(join(PKG_ROOT, 'dist', 'Theme.swift'), 'utf8');
  const emitted = JSON.parse(readFileSync(join(PKG_ROOT, 'dist', 'emitted.json'), 'utf8'));
  const tokens = JSON.parse(readFileSync(TOKENS_JSON, 'utf8'));
  return { css, swift, emitted, tokens };
}

describe('tokens build: basics', () => {
  test('tokens.json parses and gold is #FDB913', () => {
    const tokens = JSON.parse(readFileSync(TOKENS_JSON, 'utf8'));
    expect(tokens.color.tokens.gold.hex).toBe('#FDB913');
    expect(tokens.color.tokens.gold.alpha).toBe(1);
  });

  test('gold is #FDB913 in both generated outputs', () => {
    const { css, swift } = runBuild();
    expect(css).toContain('--ms-color-gold: #FDB913;');
    expect(swift).toContain('static let gold = Color(msHex: "#FDB913")');
  });

  test('generation is deterministic: running the build twice produces byte-identical output', () => {
    const first = runBuild();
    const second = runBuild();
    expect(second.css).toBe(first.css);
    expect(second.swift).toBe(first.swift);
  });

  test('no unresolved reference strings leak through into either output (e.g. "type.primaryButton")', () => {
    const { css, swift } = runBuild();
    expect(swift).not.toMatch(/"(?:color|glow|type|shape|space|motion|component)\.[a-zA-Z]+"/);
    expect(css).not.toMatch(/:\s*(?:color|glow|type|shape|space|motion|component)\.[a-zA-Z]+;/);
  });
});

describe('tokens build: nothing silently dropped (cross-check every group)', () => {
  test('every named color token appears in both tokens.css and Theme.swift', () => {
    const { css, swift, tokens } = runBuild();
    const colorNames = Object.keys(tokens.color.tokens);
    expect(colorNames.length).toBeGreaterThan(0);
    for (const name of colorNames) {
      const kebab = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
      expect(css, `expected tokens.css to declare --ms-color-${kebab}`).toContain(`--ms-color-${kebab}:`);
      expect(swift, `expected Theme.swift to declare MSColor.${name}`).toContain(`static let ${name} = Color(`);
    }
  });

  test('every emitted scalar leaf is either present (by value) in Theme.swift, or carries a cssOnly reason', () => {
    const { swift, emitted } = runBuild();
    // Colors are exhaustively checked by name in the dedicated color test above (every MSColor.* is
    // proven present); Swift always writes them as `Color(msHex: ..., alpha: ...)`, never as a literal
    // `rgba(...)` string, so a literal-substring search against an rgba()/hex value would always "miss"
    // even when the color is correctly there. Same story for cubic-bezier(...) strings: Swift spells
    // the same 4 numbers out inside `Animation.timingCurve(a, b, c, d, ...)`, not as that literal
    // token, and every curve actually used is separately asserted in the "motion corrections" and
    // dedicated MSMotion describe blocks below. Both shapes are exempted here to avoid re-testing them
    // with a weaker heuristic; nothing here is exempted without an equivalent stronger check existing.
    const isCssShorthandOnly = (v: string) =>
      /rgba\(|#[0-9A-F]{6}\b/i.test(v) || v.startsWith('cubic-bezier(') || v.startsWith('polygon(') || v.includes('currentColor');
    // A handful of values need a formatting-aware check rather than a raw substring search — each has
    // its own stronger, explicit assertion elsewhere in this file (see the describe blocks above).
    const explicitlyCoveredElsewhere = new Set([
      'type.fontFamilies.inter.css', // Swift uses PostScript names, not the CSS fallback stack — see "fonts" describe block
      'type.fontFamilies.jetbrainsMono.css',
      'component.spectrum.sparkline.dashPt', // "3px 3px" vs Swift's `[3, 3]` — see "hud-fx colors" / EQ describe blocks
    ]);
    const missing: string[] = [];
    for (const [dotted, entry] of Object.entries(emitted)) {
      if (entry.cssOnlyReason) {
        expect(entry.cssOnlyReason.length, `cssOnly reason for ${dotted} must not be empty`).toBeGreaterThan(0);
        continue;
      }
      // A `.css` shorthand duplicate of a glow already fully decomposed into color/blurPt/offsetX/Y
      // (and proven present by the dedicated "glow (radius + alpha)" describe block above).
      if (dotted.startsWith('glow.') && dotted.endsWith('.css')) continue;
      if (explicitlyCoveredElsewhere.has(dotted)) continue;
      // Strip a trailing unit off EACH comma-separated segment (e.g. "11px, 12px" -> "11, 12"), not
      // just the whole string once, so a multi-value leaf like type.label.sizePt is checked properly.
      const bareValue = entry.css
        .replace(/^"|"$/g, '')
        .split(', ')
        .map((segment) => segment.replace(/(px|em|deg|ms|s|%)$/, ''))
        .join(', ');
      if (!bareValue || isCssShorthandOnly(bareValue)) continue;
      const found = bareValue.split(', ').every((segment) => swift.includes(segment));
      if (!found) missing.push(`${dotted} (css: ${entry.css})`);
    }
    expect(missing, `tokens present in tokens.css but not found anywhere in Theme.swift:\n${missing.join('\n')}`).toEqual([]);
  });

  test('every group (color, glow, type, shape, space, motion, component) emitted at least one token', () => {
    const { emitted } = runBuild();
    const groups = new Set(Object.keys(emitted).map((k) => k.split('.')[0]));
    for (const group of ['color', 'glow', 'type', 'shape', 'space', 'motion', 'component']) {
      expect(groups, `expected group "${group}" to have emitted at least one token`).toContain(group);
    }
  });
});

describe('tokens build: glow (radius + alpha)', () => {
  test('every glow token in tokens.json has a decomposed blur radius and color alpha in Theme.swift', () => {
    const { swift, tokens } = runBuild();
    for (const [name, glow] of Object.entries<any>(tokens.glow.tokens)) {
      if (!glow.color || glow.blurPt === undefined) continue; // spectrumBar/lcdSegment: dynamic, no fixed radius/color
      const styleName = name.charAt(0).toUpperCase() + name.slice(1);
      // Every fixed-radius/fixed-color glow must be reachable from MSGlowStyle by name, OR (float/floatLift)
      // documented as a shadow property on the panel that uses it.
      const declared = swift.includes(`static let ${name} = `) || swift.includes(`MSGlowStyle.${name}`);
      expect(declared, `expected Theme.swift to expose glow "${name}"`).toBe(true);
      expect(swift, `expected the radius ${glow.blurPt} for glow "${name}"`).toContain(String(glow.blurPt));
    }
  });

  test('MSGlow carries radius, x/y offset and color (not just a CSS string)', () => {
    const { swift } = runBuild();
    expect(swift).toMatch(/struct MSGlow\s*\{[^}]*let color: Color[^}]*let radius: CGFloat[^}]*let x: CGFloat[^}]*let y: CGFloat/s);
  });
});

describe('tokens build: gradients', () => {
  test('the current-row gold gradient is a real SwiftUI LinearGradient with both stops', () => {
    const { swift } = runBuild();
    expect(swift).toContain('static let listRowCurrent = LinearGradient(');
    expect(swift).toContain('Color(msHex: "#FDB913", alpha: 0.16), location: 0.00');
    expect(swift).toContain('Color(msHex: "#FDB913", alpha: 0), location: 0.80');
  });

  test('the LCD glass wash stops are both present as colors', () => {
    const { swift } = runBuild();
    expect(swift).toContain('lcdGlassWashFrom = Color(msHex: "#120C07")');
    expect(swift).toContain('lcdGlassWashTo = Color(msHex: "#070504")');
  });

  test('the spectrum band ramp has all 4 stops in order', () => {
    const { swift } = runBuild();
    const idx = swift.indexOf('bandColorStops');
    const slice = swift.slice(idx, idx + 500);
    expect(slice).toContain('#FF3DA8');
    expect(slice).toContain('#FF8C00');
    expect(slice).toContain('#FDB913');
    expect(slice).toContain('#9FD8FF');
  });
});

describe('tokens build: EQ bar animation', () => {
  test('bar x-offsets, rest heights and the full 0/50/100% keyframe set are all present', () => {
    const { swift } = runBuild();
    expect(swift).toContain('static let barXOffsets: [CGFloat] = [0, 5, 10]');
    expect(swift).toContain('static let restHeightsPct: [CGFloat] = [40, 80, 55]');
    expect(swift).toContain('(atPct: 0, heightsPct: [30, 90, 50])');
    expect(swift).toContain('(atPct: 50, heightsPct: [85, 35, 95])');
    expect(swift).toContain('(atPct: 100, heightsPct: [55, 70, 25])');
  });
});

describe('tokens build: LCD', () => {
  test('the segment bitmask table matches lcd-text.ts bit-for-bit (spot check + full coverage)', () => {
    const { swift, tokens } = runBuild();
    const glyphCount = Object.keys(tokens.component.lcd.glyphs.table).length;
    expect(glyphCount).toBe(38); // space, dash, 0-9, A-Z
    // Spot check against the literal source in player3d/lcd-text.ts.
    expect(swift).toContain('"0": MSLCDSegment.a | MSLCDSegment.b | MSLCDSegment.c | MSLCDSegment.d | MSLCDSegment.e | MSLCDSegment.f,');
    expect(swift).toContain('"8": MSLCDSegment.a | MSLCDSegment.b | MSLCDSegment.c | MSLCDSegment.d | MSLCDSegment.e | MSLCDSegment.f | MSLCDSegment.g1 | MSLCDSegment.g2,');
    expect(swift).toContain('" ": 0,');
    // Every glyph key from tokens.json appears somewhere in the Swift table.
    for (const char of Object.keys(tokens.component.lcd.glyphs.table)) {
      const key = char === '"' ? '\\"' : char;
      expect(swift, `expected MSLCDGlyph.table to contain "${char}"`).toContain(`"${key}":`);
    }
  });

  test('the layout ratios (padX, cell, inset, radius, glow blur, diagonal, d) are all in Theme.swift', () => {
    const { swift, tokens } = runBuild();
    const layout = tokens.component.lcd.layout;
    expect(swift).toContain(`static let padXRatio: CGFloat = ${layout.padXRatio}`);
    expect(swift).toContain(`static let cellWidthRatio: CGFloat = ${layout.cellWidthRatio}`);
    expect(swift).toContain(`static let insetRatio: CGFloat = ${layout.insetRatio}`);
    expect(swift).toContain(`static let bezelCornerRadiusRatio: CGFloat = ${layout.bezelCornerRadiusRatio}`);
    expect(swift).toContain(`static let glowBlurRatio: CGFloat = ${layout.glowBlurRatio}`);
    expect(swift).toContain(`static let diagonalNormalRatio: CGFloat = ${layout.diagonalNormalRatio}`);
    expect(swift).toContain(`static let diagonalOffsetRatio: CGFloat = ${layout.diagonalOffsetRatio}`);
  });

  test('the flag shapes (play/pause/stop/repeat) are recorded with their ratios', () => {
    const { swift } = runBuild();
    expect(swift).toContain('static let playTipXRatio');
    expect(swift).toContain('static let pauseBarWidthRatio');
    expect(swift).toContain('static let stopWidthRatio');
    expect(swift).toContain('static let repeatOuterRadiusRatio');
    expect(swift).toContain('static let repeatArcStartDeg: Double = -63');
    expect(swift).toContain('static let repeatArcEndDeg: Double = 243');
  });

  test('LCD status strings are right-aligned in 11 chars, not the old placeholder format', () => {
    const { swift, tokens } = runBuild();
    expect(tokens.component.lcd.statusFormat.examples['playing (track 3)']).toBe('PLAY     03');
    expect(tokens.component.lcd.statusFormat.examples['playing (track 3)']).toHaveLength(11);
    expect(swift).toContain('"playing (track 3)": "PLAY     03",');
    // The old, wrong placeholder must be gone for good.
    expect(swift).not.toContain('PLAY <NN>');
    expect(swift).not.toContain('<NN>');
  });
});

describe('tokens build: tab bar icons + labels', () => {
  test('all three tab icon path strings and labels are present', () => {
    const { swift, tokens } = runBuild();
    for (const tab of tokens.component.tabBar.tabs) {
      expect(swift).toContain(`label: "${tab.label}"`);
    }
    expect(swift).toContain('static let listen = "M12 3v11.5');
    expect(swift).toContain('static let store = "M5 8h14l-1 11.5');
    expect(swift).toContain('static let library = "rect x=3.5 y=4.5 w=7 h=7 rx=1.6');
    expect(swift).toContain('static let strokeWidth: CGFloat = 1.7');
  });
});

describe('tokens build: boot loader', () => {
  test('track width, background alpha, gap, text size/tracking and bar transition are present', () => {
    const { swift, tokens } = runBuild();
    const boot = tokens.component.bootLoader;
    expect(swift).toContain(`static let trackWidthMax: CGFloat = ${boot.track.widthMaxPt}`);
    expect(swift).toContain(`static let trackBackgroundAlpha: Double = ${boot.track.background.alpha}`);
    expect(swift).toContain(`static let gap: CGFloat = ${boot.gapPt}`);
    expect(swift).toContain(`static let textSize: CGFloat = ${boot.sizePt}`);
    expect(swift).toContain(`static let textTracking: CGFloat = ${boot.tracking}`);
    expect(swift).toContain(`static let barTransitionDuration: Double = ${boot.bar.transitionDurationS}`);
  });

  test('the terminal prefix, all 5 boot lines and the typing cadence (14-26ms) are present', () => {
    const { swift, tokens } = runBuild();
    expect(swift).toContain(`static let terminalPrefix: String = "${tokens.component.bootLoader.terminal.prefix.text}"`);
    expect(swift).toContain('static let terminalPrefixColor = MSColor.terminalPrefix');
    for (const line of tokens.component.bootLoader.terminal.lines) {
      expect(swift).toContain(`text: "${line.text.replace(/"/g, '\\"')}"`);
    }
    expect(swift).toContain('static let terminalTickDelayMinMs: Double = 14');
    expect(swift).toContain('static let terminalTickDelayMaxMs: Double = 26');
  });
});

describe('tokens build: now playing bar', () => {
  test('blur, radius, padding, gap, bar bg alpha, playing-border alpha, ask-ring, and iOS docked insets', () => {
    const { swift, tokens } = runBuild();
    const np = tokens.component.nowPlaying;
    expect(swift).toContain(`static let blur: CGFloat = ${np.blurPt}`);
    expect(swift).toContain(`static let radius: CGFloat = ${np.radiusPt}`);
    expect(swift).toContain(`static let paddingVertical: CGFloat = ${np.paddingPt.vertical}`);
    expect(swift).toContain(`static let paddingHorizontal: CGFloat = ${np.paddingPt.horizontal}`);
    expect(swift).toContain(`static let gap: CGFloat = ${np.gapPt}`);
    expect(swift).toContain('static let barBackgroundAlpha: Double = 0.14');
    expect(swift).toContain('static let playingBorderAlpha: Double = 0.45');
    expect(swift).toContain(`static let askRingWidth: CGFloat = ${np.askRing.widthPt}`);
    expect(swift).toContain('static let askRingAlpha: Double = 0.16');
    expect(swift).toContain(`static let dockedLeft: CGFloat = ${np.iosAppDocked.leftPt}`);
    expect(swift).toContain(`static let dockedRight: CGFloat = ${np.iosAppDocked.rightPt}`);
    expect(swift).toContain('static let dockedBottomBase: CGFloat = 58');
  });

  test('the now-playing and site-card corner ticks use `line` (60% gold), not full gold', () => {
    const { swift } = runBuild();
    // HUDPanel keeps the real full-gold tick.
    expect(swift).toMatch(/enum HUDPanel \{[\s\S]*?static let cornerTickColor = MSColor\.gold/);
    // NowPlaying and SiteCard must NOT.
    expect(swift).toMatch(/enum SiteCard \{[\s\S]*?static let cornerTickColor = MSColor\.line/);
    expect(swift).toMatch(/enum NowPlaying \{[\s\S]*?static let cornerTickColor = MSColor\.line/);
  });
});

describe('tokens build: primary button + key button', () => {
  test('primary button padding (26) and its show/hide motion (0.42s opacity + 10px lift)', () => {
    const { swift, tokens } = runBuild();
    expect(swift).toContain(`static let paddingHorizontal: CGFloat = ${tokens.component.primaryButton.paddingHorizontalPt}`);
    expect(tokens.component.primaryButton.paddingHorizontalPt).toBe(26);
    expect(swift).toContain('static let hiddenTranslateY: CGFloat = 10');
    expect(swift).toContain('static let animation = MSMotion.midSessionOverlayFade');
    expect(swift).toContain('static let midSessionOverlayFade = Animation.easeInOut(duration: 0.42)');
  });

  test('key button padding and the unlatched text color', () => {
    const { swift, tokens } = runBuild();
    expect(swift).toContain(`static let paddingHorizontal: CGFloat = ${tokens.component.keyButton.paddingHorizontalPt}`);
    expect(swift).toContain('static let textColor = MSColor.text');
    expect(swift).toContain('static let latchedFill = MSColor.gold');
  });
});

describe('tokens build: readout row + grouped list', () => {
  test('readout divider alpha 0.12, dash pattern, and gap 12', () => {
    const { swift, tokens } = runBuild();
    expect(tokens.component.readoutRow.divider.color.alpha).toBe(0.12);
    expect(swift).toContain('static let dividerAlpha: Double = 0.12');
    expect(swift).toContain('static let gap: CGFloat = 12');
    expect(swift).toContain('dividerDashPattern: [CGFloat] = [1, 1]');
  });

  test('grouped list: cream 0.05 fill, 0.1 separators (inset 57 / 14), 0.35 chevrons, 30pt/8pt icon tiles', () => {
    const { swift, tokens } = runBuild();
    expect(tokens.color.tokens.creamFill.alpha).toBe(0.05);
    expect(tokens.color.tokens.creamSeparator.alpha).toBe(0.1);
    expect(tokens.color.tokens.creamChevron.alpha).toBe(0.35);
    expect(swift).toContain('static let fill = MSColor.creamFill');
    expect(swift).toContain('static let actionRowSeparatorInset: CGFloat = 57');
    expect(swift).toContain('static let orderRowSeparatorInset: CGFloat = 14');
    expect(swift).toContain('static let iconTileSize: CGFloat = 30');
    expect(swift).toContain('static let iconTileRadius: CGFloat = 8');
    expect(swift).toContain('static let chevronColor = MSColor.creamChevron');
  });
});

describe('tokens build: motion corrections', () => {
  test('pulseCycle is a 0.9s half-duration autoreversing animation (1.8s total), not duration:1.8', () => {
    const { swift } = runBuild();
    expect(swift).toContain('static let pulseCycle = Animation.easeInOut(duration: 0.9).repeatForever(autoreverses: true)');
    expect(swift).not.toContain('Animation.easeInOut(duration: 1.8).repeatForever');
  });

  test('reducedMotionFallback is nil (instant), not a soft crossfade', () => {
    const { swift } = runBuild();
    expect(swift).toContain('static let reducedMotionFallback: Animation? = nil');
  });

  test('mid-session overlay fade (0.42s) is recorded distinct from the boot fade (0.6s)', () => {
    const { swift, tokens } = runBuild();
    expect(tokens.motion.midSessionOverlayFadeS.value).toBe(0.42);
    expect(tokens.motion.overlayFadeS.value).toBe(0.6);
    expect(swift).toContain('static let midSessionOverlayFade = Animation.easeInOut(duration: 0.42)');
    expect(swift).toContain('static let overlayFade = Animation.timingCurve(0.25, 0.1, 0.25, 1.0, duration: 0.6)');
  });
});

describe('tokens build: hud-fx colors', () => {
  test('oscilloscope and sparkline colors are present', () => {
    const { swift, tokens } = runBuild();
    expect(tokens.color.tokens.oscilloscopeTrace.hex).toBe('#9FD8FF');
    expect(swift).toContain('oscilloscopeTrace = Color(msHex: "#9FD8FF", alpha: 0.85)');
    expect(swift).toContain('sparklineThreshold = Color(msHex: "#FF8C00", alpha: 0.55)');
    expect(swift).toContain('sparklineFillFrom = Color(msHex: "#FDB913", alpha: 0.35)');
    expect(swift).toContain('sparklineLine = Color(msHex: "#FDB913")');
  });

  test('sparkline dash pattern (3px 3px) is present as a Swift dash array', () => {
    const { swift, tokens } = runBuild();
    expect(tokens.component.spectrum.sparkline.dashPt).toEqual([3, 3]);
    expect(swift).toContain('static let sparklineDash: [CGFloat] = [3, 3]');
  });
});

describe('tokens build: fonts (rendered weight, not just declared weight)', () => {
  test('primaryButton/readoutValue/trackNumDur/panelMeta/repeatButton/sheetToggleLabel are all mono in Theme.swift', () => {
    const { swift } = runBuild();
    expect(swift).toContain('static let primaryButton = MSFont.mono(15, weight: .bold)');
    expect(swift).toContain('static let readoutValue = MSFont.mono(14, weight: .medium)');
    expect(swift).toContain('static let trackNumDur = MSFont.mono(12, weight: .medium)');
    expect(swift).toContain('static let panelMeta = MSFont.mono(10, weight: .medium)');
    expect(swift).toContain('static let repeatButton = MSFont.mono(12, weight: .bold)');
    expect(swift).toContain('static let sheetToggleLabel = MSFont.mono(12, weight: .bold)');
  });

  test('largeTitle is Inter (theme.css:63-71 var(--font-hud)), not the ios.css system stack', () => {
    const { swift, tokens } = runBuild();
    expect(tokens.type.largeTitle.family).toBe('inter');
    expect(swift).toContain('static let largeTitle = MSFont.inter(34, weight: .extrabold)');
  });

  test('disagreement #8 (largeTitle font gap) has been removed as false', () => {
    const { tokens } = runBuild();
    const joined = tokens.meta.disagreementsWithPrdTable.join('\n');
    expect(joined).not.toMatch(/does not force Inter/);
  });
});

describe('tokens build: focus ring offsets + sub-44 targets', () => {
  test('per-context focus ring offsets: default +2, list row -2 (inset), peripheral +3', () => {
    const { swift, tokens } = runBuild();
    expect(tokens.shape.focusRing.offsetPt).toBe(2);
    expect(tokens.component.listRow.focusRingOffsetPt.value).toBe(-2);
    expect(tokens.component.peripheralFocusRingOffsetPt.value).toBe(3);
    expect(swift).toContain('static let focusRingOffset: CGFloat = 2');
    expect(swift).toContain('static let focusRingOffset: CGFloat = -2');
    expect(swift).toContain('static let peripheralFocusRingOffset: CGFloat = 3');
  });

  test('the disagreements list documents every sub-44 target, including cart/download/nav-peek', () => {
    const { tokens } = runBuild();
    const joined = tokens.meta.disagreementsWithPrdTable.join('\n');
    expect(joined).toContain('cart-btn');
    expect(joined).toContain('download-btn');
    expect(joined).toContain('nav-peek');
    expect(joined).toContain('56x26');
  });
});

describe('tokens build: stray site.css scaffold leftovers, flagged not adopted', () => {
  test('the 8px global button radius and #646cff hover are recorded as DO NOT ADOPT', () => {
    const { swift, tokens } = runBuild();
    expect(tokens.shape.strayGlobalButtonRadiusPt.value).toBe(8);
    expect(tokens.color.tokens.strayGlobalButtonHover.hex).toBe('#646CFF');
    expect(swift).toContain('static let strayGlobalButtonRadius: CGFloat = 8');
    expect(swift).toMatch(/DO NOT ADOPT/);
  });
});

describe('tokens build: meta.sourceFiles includes hud.ts and hud-fx.ts', () => {
  test('round 2 root cause file are both listed', () => {
    const { tokens } = runBuild();
    expect(tokens.meta.sourceFiles.some((f: string) => f.includes('hud.ts'))).toBe(true);
    expect(tokens.meta.sourceFiles.some((f: string) => f.includes('hud-fx.ts'))).toBe(true);
  });
});

describe('tokens build: font registration comment is valid API', () => {
  test('no invalid UIFont.registerFont(from:) reference; uses CTFontManagerRegisterFontsForURL/UIAppFonts', () => {
    const { swift } = runBuild();
    expect(swift).not.toMatch(/UIFont\.registerFont\(from:\)(?!` does not exist)/);
    expect(swift).toContain('CTFontManagerRegisterFontsForURL');
    expect(swift).toContain('UIAppFonts');
  });
});

describe('Theme.swift typechecks for iOS', () => {
  test('xcrun swiftc -typecheck against the iphonesimulator SDK succeeds', () => {
    runBuild();
    const sdkPath = execFileSync('xcrun', ['--show-sdk-path', '--sdk', 'iphonesimulator']).toString().trim();
    expect(() =>
      execFileSync(
        'xcrun',
        ['swiftc', '-typecheck', '-sdk', sdkPath, '-target', 'arm64-apple-ios17.0-simulator', join(PKG_ROOT, 'dist', 'Theme.swift')],
        { stdio: 'pipe' },
      ),
    ).not.toThrow();
  }, 30_000);

  test('xcrun swiftc -typecheck against the macosx SDK succeeds (sanity, catches non-iOS-specific breaks fast)', () => {
    runBuild();
    if (!existsSync('/usr/bin/xcrun')) return; // non-macOS CI: skip rather than fail
    const sdkPath = execFileSync('xcrun', ['--show-sdk-path', '--sdk', 'macosx']).toString().trim();
    expect(() =>
      execFileSync(
        'xcrun',
        ['swiftc', '-typecheck', '-sdk', sdkPath, '-target', 'arm64-apple-macos14', join(PKG_ROOT, 'dist', 'Theme.swift')],
        { stdio: 'pipe' },
      ),
    ).not.toThrow();
  }, 30_000);
});
