import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Contrast gate for the dashboard HUD design system.
 *
 * The palette source of truth is `site/index.html` and `site/haas.html`, which
 * declare their tokens as hex. `dashboard.css` may not use hex (the UI contract
 * test rejects it), so the same colours are expressed in OKLCH. This test proves
 * the resulting surface, text, status, and control pairs stay legible, which is
 * the property a hue swap can silently break.
 *
 * Everything here is dependency-free: a local OKLCH -> sRGB conversion, the WCAG
 * relative-luminance formula, and brace-balanced block extraction. Alpha is
 * composited in encoded sRGB, because that is what CSS alpha compositing does.
 */

const css = readFileSync(
  new URL("../dashboard/dashboard.css", import.meta.url),
  "utf8",
);

// Selectors are matched WITHOUT the opening brace, and include the trailing
// space, so `:root ` cannot match `:root[data-theme="light"]` or
// `:root:not([data-theme])`.
const ROOT = ":root ";
const LIGHT_FORCED = ':root[data-theme="light"] ';
const LIGHT_SYSTEM = ":root:not([data-theme]) ";

/** Return the declaration body of the first block for `selector`, or null. */
function blockAfter(source: string, selector: string): string | null {
  const at = source.indexOf(selector);
  if (at === -1) return null;
  const open = source.indexOf("{", at + selector.length - 1);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/** Parse `--name: value;` pairs, ignoring anything that is not a custom property. */
function declarations(body: string | null): Map<string, string> {
  const found = new Map<string, string>();
  if (!body) return found;
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/g)) {
    // Collapse internal whitespace: a formatter may reflow a long value across
    // lines, and the two light blocks sit at different nesting depths, so their
    // indentation differs for the same declaration. Formatting is not semantics.
    found.set(match[1]!, match[2]!.trim().replace(/\s+/g, " "));
  }
  return found;
}

const rootTokens = declarations(blockAfter(css, ROOT));
const lightForced = declarations(blockAfter(css, LIGHT_FORCED));
const lightSystem = declarations(blockAfter(css, LIGHT_SYSTEM));

/** Resolve `var(--x)` chains against the active theme, then `:root`. */
function resolve(value: string, theme: Map<string, string>, depth = 0): string {
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim());
  if (!reference) return value.trim();
  if (depth > 8) throw new Error(`var() chain too deep at ${value}`);
  const name = reference[1]!;
  const next = theme.get(name) ?? rootTokens.get(name);
  if (next === undefined) throw new Error(`unresolved token ${name}`);
  return resolve(next, theme, depth + 1);
}

type Rgb = [number, number, number];

const toLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const toEncoded = (channel: number): number =>
  channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;

interface Colour {
  rgb: Rgb;
  alpha: number;
  hue: number;
}

function parseOklch(raw: string, theme: Map<string, string>): Colour {
  const value = resolve(raw, theme);
  const match =
    /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(
      value,
    );
  if (!match) throw new Error(`not a plain oklch() value: ${raw} -> ${value}`);
  const l = Number(match[1]);
  const chroma = Number(match[2]);
  const hue = Number(match[3]);
  const alpha = match[4] === undefined ? 1 : Number(match[4]);

  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = l - 0.0894841775 * a - 1.291485548 * b;
  const lCube = lPrime ** 3;
  const mCube = mPrime ** 3;
  const sCube = sPrime ** 3;
  const linear: Rgb = [
    4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
  ];
  return { rgb: linear.map(toEncoded) as Rgb, alpha, hue };
}

/** CSS composites alpha on the encoded channel values, not on linear light. */
function composite(foreground: Colour, background: Colour): Colour {
  if (foreground.alpha >= 1) return foreground;
  const mixed = foreground.rgb.map(
    (channel, index) =>
      channel * foreground.alpha +
      background.rgb[index]! * (1 - foreground.alpha),
  ) as Rgb;
  return { rgb: mixed, alpha: 1, hue: foreground.hue };
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(toLinear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: Colour, background: Colour): number {
  const solid = composite(foreground, background);
  const one = luminance(solid.rgb);
  const two = luminance(background.rgb);
  const lighter = Math.max(one, two);
  const darker = Math.min(one, two);
  return (lighter + 0.05) / (darker + 0.05);
}

function token(name: string, theme: Map<string, string>): Colour {
  const raw = theme.get(name) ?? rootTokens.get(name);
  if (raw === undefined) throw new Error(`missing token ${name}`);
  return parseOklch(raw, theme);
}

function alphaOf(name: string, theme: Map<string, string>): number {
  const raw = theme.get(name) ?? rootTokens.get(name);
  if (raw === undefined) throw new Error(`missing token ${name}`);
  return parseOklch(raw, theme).alpha;
}

const TEXT_FLOOR = 4.5;
const NON_TEXT_FLOOR = 3;

const themes: Array<[string, Map<string, string>]> = [
  ["dark (:root)", rootTokens],
  ['light (:root[data-theme="light"])', lightForced],
];

/** Every background a text or border token can land on. */
const SURFACES = ["--canvas", "--surface", "--surface-raised"] as const;

describe("dashboard design tokens", () => {
  it("declares both light theme blocks", () => {
    expect(css).toContain(LIGHT_FORCED.trim());
    expect(css).toContain("@media (prefers-color-scheme: light)");
    expect(lightForced.size, "forced light block is non-empty").toBeGreaterThan(
      0,
    );
    expect(lightSystem.size, "system light block is non-empty").toBeGreaterThan(
      0,
    );
  });

  it("keeps both light blocks byte-identical", () => {
    // The CSS cannot share one token set across a media query, so the two light
    // paths are duplicated and must be edited together.
    expect([...lightForced.entries()].sort()).toEqual(
      [...lightSystem.entries()].sort(),
    );
  });

  it("renders the cyan HUD accent rather than the retired amber", () => {
    const darkHue = token("--accent", rootTokens).hue;
    const lightHue = token("--accent", lightForced).hue;
    expect(darkHue).toBeGreaterThanOrEqual(195);
    expect(darkHue).toBeLessThanOrEqual(215);
    expect(lightHue).toBeGreaterThanOrEqual(235);
    expect(lightHue).toBeLessThanOrEqual(250);
  });

  it("never uses the fill accent as a text colour", () => {
    // `--accent` is the fill (buttons, tabs, brackets). `--accent-strong` is the
    // text token. Reintroducing a bare `color: var(--accent)` is what made
    // `.wikilink:hover` render at 2.83:1. The lookbehind keeps the border-*,
    // background-*, and accent-color: shorthands out of the match.
    const bareAccentText = [
      ...css.matchAll(/(?<![\w-])color:\s*var\(--accent\)/g),
    ];
    expect(
      bareAccentText,
      "no `color: var(--accent)` outside a fill or border",
    ).toHaveLength(0);
  });

  it("keeps the -line family opaque and the -soft family translucent", () => {
    const opaque = [
      "--accent-line",
      "--line",
      "--line-strong",
      "--focus",
      "--success-line",
      "--warning-line",
      "--danger-line",
      "--info-line",
    ];
    const translucent = [
      "--accent-soft",
      "--success-soft",
      "--warning-soft",
      "--danger-soft",
      "--info-soft",
    ];
    for (const [label, theme] of themes) {
      for (const name of opaque)
        expect(alphaOf(name, theme), `${label} ${name} opaque`).toBe(1);
      for (const name of translucent)
        expect(
          alphaOf(name, theme),
          `${label} ${name} translucent`,
        ).toBeLessThan(1);
    }
  });

  it("meets AA for every text pair in both themes", () => {
    const pairs: Array<[string, string, string]> = [
      ["--ink", "--canvas", "body text on canvas"],
      ["--ink", "--surface", "body text on surface"],
      ["--ink", "--surface-raised", "body text on raised surface"],
      ["--ink-muted", "--canvas", "muted text on canvas"],
      ["--ink-muted", "--surface", "muted text on surface"],
      ["--ink-muted", "--surface-raised", "muted text on raised surface"],
      ["--on-accent", "--accent", "primary control label"],
      ["--success", "--success-soft", "success pill"],
      ["--warning", "--warning-soft", "warning pill"],
      ["--danger", "--danger-soft", "danger pill"],
      ["--info", "--info-soft", "info pill"],
      ["--code-ink", "--code-bg", "code block"],
    ];
    for (const [label, theme] of themes) {
      for (const [foreground, background, what] of pairs) {
        const surface = token(background, theme);
        const behind =
          background.endsWith("-soft") || background === "--code-bg"
            ? token("--surface", theme)
            : surface;
        const ratio = contrast(
          token(foreground, theme),
          composite(surface, behind),
        );
        expect(
          ratio,
          `${label}: ${what} ${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(TEXT_FLOOR);
      }
      const onSoft = contrast(
        token("--ink", theme),
        composite(token("--accent-soft", theme), token("--surface", theme)),
      );
      expect(
        onSoft,
        `${label}: body text on accent-soft`,
      ).toBeGreaterThanOrEqual(TEXT_FLOOR);
    }
  });

  it("meets AA for accent emphasis text on every surface it lands on", () => {
    // `--accent-strong` is the link and emphasis colour: `a:hover`, `.env-tag`,
    // `#context-nav a[aria-current]`, `.site-footer a`, `.avatar`,
    // `button:hover`, `.copy:hover`, `.detail-actions a:hover`,
    // `.relevance-badge.hybrid`, and `.wikilink`.
    for (const [label, theme] of themes) {
      const emphasis = token("--accent-strong", theme);
      for (const surface of SURFACES) {
        const ratio = contrast(emphasis, token(surface, theme));
        expect(
          ratio,
          `${label}: accent-strong on ${surface}`,
        ).toBeGreaterThanOrEqual(TEXT_FLOOR);
      }
      for (const surface of ["--surface", "--surface-raised"] as const) {
        const ratio = contrast(
          emphasis,
          composite(token("--accent-soft", theme), token(surface, theme)),
        );
        expect(
          ratio,
          `${label}: accent-strong on accent-soft over ${surface}`,
        ).toBeGreaterThanOrEqual(TEXT_FLOOR);
      }
    }
  });

  it("keeps the accent-line and focus ring visible on every surface", () => {
    // `--accent-line` draws the corner brackets, the detail-pane border, the note
    // borders, and every link underline. It is opaque precisely so this holds: a
    // translucent tint measures about 1.5:1 over the HUD canvas.
    for (const [label, theme] of themes) {
      for (const name of ["--accent-line", "--focus"]) {
        for (const surface of SURFACES) {
          const ratio = contrast(token(name, theme), token(surface, theme));
          expect(
            ratio,
            `${label}: ${name} on ${surface}`,
          ).toBeGreaterThanOrEqual(NON_TEXT_FLOOR);
        }
      }
    }
  });

  it("keeps the dark spine readable in both themes", () => {
    // The top bar and rail stay dark in the light theme too, so their tokens are
    // declared once on `:root` and must never be redefined by a light block, where
    // a light value would put light ink on a light spine.
    for (const name of [...rootTokens.keys()].filter((key) => key.startsWith("--rail-"))) {
      expect(lightForced.has(name), `${name} redefined in the light theme`).toBe(false);
    }
    for (const [label, theme] of themes) {
      for (const background of ["--rail-bg", "--rail-raised", "--rail-hover"]) {
        for (const ink of ["--rail-ink", "--rail-ink-muted"]) {
          expect(
            contrast(token(ink, theme), token(background, theme)),
            `${label}: ${ink} on ${background}`,
          ).toBeGreaterThanOrEqual(TEXT_FLOOR);
        }
        expect(
          contrast(token("--rail-accent", theme), token(background, theme)),
          `${label}: --rail-accent (focus ring, current marker) on ${background}`,
        ).toBeGreaterThanOrEqual(NON_TEXT_FLOOR);
      }
      // Group labels and the version line sit directly on the rail background.
      expect(
        contrast(token("--rail-ink-faint", theme), token("--rail-bg", theme)),
        `${label}: --rail-ink-faint on --rail-bg`,
      ).toBeGreaterThanOrEqual(TEXT_FLOOR);
    }
  });
});
