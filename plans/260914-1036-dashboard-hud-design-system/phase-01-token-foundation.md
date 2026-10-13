---
phase: 1
title: "Token foundation and contrast gate"
status: completed
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: Token foundation and contrast gate

## Goal

`apps/api/dashboard/dashboard.css` declares the marketing HUD palette in OKLCH
for a dark base and a light companion, and a new test proves WCAG AA for every
text, pill, control, and focus pair in both themes.

## Files to Create / Modify

- Modify: `apps/api/dashboard/dashboard.css` (the `:root` token block at lines
  1-41 and the two theme blocks at lines 44-96)
- Create: `apps/api/test/dashboard-design-tokens.test.ts`
- Modify: `apps/api/test/dashboard-ui-contract.test.ts` (additive assertions only)

## Background the executor needs

The marketing source of truth is `site/index.html` and `site/haas.html`. Their
`:root` blocks declare the palette as **hex**, which
`apps/api/test/dashboard-ui-contract.test.ts` rejects with
`expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)`. That assertion scans the whole
file including comments, so **do not put a hex literal anywhere in
`dashboard.css`, not even in a comment**. Identify marketing tokens by their
custom-property name (`--bg-void`, `--cyan-glow`, ...) instead.

Read `site/index.html` lines 50-100 and `site/haas.html` lines 50-100 to confirm
the source values before you start. Do not read or copy `site/styles.css`; it is
a legacy stylesheet that the live pages do not link.

## Tasks & Steps

### Task 1.1 — Write the failing contrast test

- **Goal:** A test exists that fails against today's amber/gray tokens and will
  pass once the HUD palette lands.
- **Target files and symbols:** create
  `apps/api/test/dashboard-design-tokens.test.ts`.
- **Steps:**
  1. Read `dashboard.css` with `readFileSync`, the same way
     `dashboard-ui-contract.test.ts` does.
  2. Write a small local sRGB <-> OKLCH converter in the test file: implement
     `oklchToSrgb(l, c, h)`, `relativeLuminance(rgb)`, and
     `contrastRatio(rgbA, rgbB)`. Use the standard OKLab matrices and the WCAG
     relative-luminance formula. Do not add a dependency.
  3. Write `extractTokens(css, selector)` returning a `Map` of `--name` to raw
     value for one declaration block. It must **return an empty Map when the
     selector is absent and never throw**, so a missing block surfaces as a
     failed assertion instead of a crash.
  4. Resolve `var(--other)` chains against the same block, falling back to
     `:root`. Parse both `oklch(L C H)` and `oklch(L C H / A)`, and composite an
     alpha value over a given background.
  5. **Assert the preconditions as their own test case** named
     `'declares both light theme blocks'`:
     `expect(css).toContain(':root[data-theme="light"]')` and
     `expect(css).toContain('@media (prefers-color-scheme: light)')`. This is the
     assertion that fails in the red phase: today the light palette lives in
     `:root` itself and neither light block exists.
  6. Assert these text pairs at a minimum of **4.5**, once for the dark base
     (`:root`) and once for the light companion (`:root[data-theme="light"]`):
     `--ink` on `--canvas`, `--ink` on `--surface`, `--ink-muted` on `--canvas`,
     `--ink-muted` on `--surface`, `--on-accent` on `--accent`, `--success` on
     `--success-soft`, `--warning` on `--warning-soft`, `--danger` on
     `--danger-soft`, `--info` on `--info-soft`, and `--ink` on `--accent-soft`.
     Composite every translucent `-soft` value over `--surface` first.
  7. Assert the **accent-as-text** pairs at a minimum of **4.5**. This is not
     optional and it is where the current stylesheet is actually broken.
     `--accent-strong` is the dashboard's link and emphasis text colour
     (`a:hover`, `.env-tag`, `#context-nav a[aria-current]`, `.site-footer a`,
     `.avatar`, `button:hover`, `.copy:hover`, `.detail-actions a:hover`,
     `.relevance-badge.hybrid`, `.wikilink`). For each theme assert
     `--accent-strong` against `--surface`, `--surface-raised`, `--canvas`,
     `--accent-soft` composited over `--surface`, and `--accent-soft` composited
     over `--surface-raised`.
     Then assert the fill/text split mechanically:
     `expect(css).not.toContain('color: var(--accent);')`. The bare `--accent` is
     the **fill** token (button and tab backgrounds, brackets, borders, focus
     ring); `--accent-strong` is the **text** token. Today
     `dashboard.css:448` is `.wikilink:hover { color: var(--accent); }`, which
     renders amber text at **2.83-3.13:1**, and Task 1.2 removes it.
  8. Assert the **opaque non-text** tokens at a minimum of **3.0** against
     `--canvas`, `--surface`, and `--surface-raised`: `--accent-line` and
     `--focus`. `--accent-line` is what actually draws the corner brackets
     (`dashboard.css:212`), the detail-pane border (`:274`), `.page-note`
     (`:301`), and every link underline (`:103`, `:447`) — **not** `--accent`.
     Asserting `--accent` at 3.0 instead would be a vacuous gate, because the
     brackets never consume `--accent`.
  9. Assert the fill/border alpha split mechanically:
     `--accent-line`, `--line`, `--line-strong`, `--focus`, `--success-line`,
     `--warning-line`, `--danger-line`, and `--info-line` are **opaque** (their
     value contains no `/ <alpha>` component). `--accent-soft` and the four
     semantic `-soft` tokens are **translucent**. A translucent border over the
     near-black canvas collapses to under 1.5:1, which is the trap this assertion
     exists to catch. Do **not** assert the semantic `-line` tokens at 3.0; they
     only draw a status-pill border whose state is carried by the label and dot.
     See the "`-soft` is a translucent fill, `-line` is an opaque border" rule
     below for the measured justification.
  10. Assert the accent hue band: the `:root` `--accent` hue is between 195 and
      215, and the light `--accent` hue is between 235 and 250. This proves the
      palette is the cyan HUD and not the retired amber.
  11. Assert that the declarations inside `:root[data-theme="light"]` and inside
      `@media (prefers-color-scheme: light)` are **identical sets** (same keys,
      same values). First assert that **both blocks were found and are
      non-empty**, so the comparison cannot pass vacuously against two empty
      Maps. The CSS cannot share a token set across a media query, so this
      catches the classic bug where one light path is edited and the other is
      forgotten.
- **Success criteria:** the test file exists and
  `npx vitest run apps/api/test/dashboard-design-tokens.test.ts` fails for four
  measured reasons: (1) step 5 finds no light block; (2) `--info`,
  `--info-soft`, and `--info-line` do not exist; (3) step 7 catches
  `color: var(--accent);` in `.wikilink:hover` and the sub-4.5 accent text it
  produces; (4) step 9 finds the `:root` accent hue at 62 instead of the cyan
  band. Note that every plain `--ink` / `--ink-muted` / status-pill text pair in
  today's stylesheet already passes, so do **not** expect or engineer a failure
  there.
- **Verify:** `npx vitest run apps/api/test/dashboard-design-tokens.test.ts`
  exits **non-zero**, and the output names the missing light block, the missing
  `--info` token, `color: var(--accent);`, and the out-of-band accent hue. A
  passing run at this point is a failure of this task; do not proceed until you
  have seen it fail for those reasons. Do not "fix" a pair that already passes.

### Task 1.2 — Route accent-as-text onto `--accent-strong`

- **Goal:** The bare `--accent` is never used as a text colour, so the fill/text
  contrast split the test asserts is actually true of the stylesheet.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`, the
  `.wikilink:hover` rule at line 448.
- **Steps:**
  1. Change `.wikilink:hover { color: var(--accent); }` to
     `.wikilink:hover { color: var(--accent-strong); }`.
  2. Leave `.wikilink`'s own `color: var(--accent-strong)` unchanged.
  3. Confirm this was the only text consumer:
     `grep -n 'color: var(--accent);' apps/api/dashboard/dashboard.css` must
     return nothing. Do **not** touch `border-color: var(--accent)`,
     `background: var(--accent)`, `border: 1px solid var(--accent)`, or
     `accent-color: var(--accent)` — those are fills and borders, not text.
- **Success criteria:** the stylesheet contains no `color: var(--accent);`.
- **Verify:** `grep -c 'color: var(--accent);' apps/api/dashboard/dashboard.css`
  prints `0`. The contrast assertion that consumes this lives in Task 1.1 step 7
  and goes green once Tasks 1.3 and 1.4 have also landed.

### Task 1.3 — Replace the token block with the HUD ramp

- **Goal:** `:root` declares the dark HUD palette plus the marketing raw ramp,
  and the existing semantic names alias onto it.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`, the `:root`
  block (currently lines 1-41).
- **Steps:**
  1. Replace the `:root` block with the block given verbatim in the
     "Token block to write" section below. Keep every token name that the
     contract test asserts: `--canvas`, `--surface`, `--ink`, `--accent`,
     `--space-4`, `--motion-state`. Keep all other existing names too.
  2. Keep the existing `--text-*`, `--space-*`, `--radius-*`, `--motion-*`, and
     font-stack lines. Only `--radius-lg` changes to `.5rem`, and `--space-10`
     and `--space-12` are added.
  3. Do not touch any rule below the token blocks in this task.
- **Success criteria:** the file contains `--hud-cyan`, `--void`, `--panel`,
  `--card`, `--info`, and `--stroke`, and no rule below the tokens has changed.
- **Verify:** run one grep per token. BSD/macOS `grep` does not support `\|`
  alternation in basic regex — it matches the literal characters and prints `0`,
  which would be a spurious gate failure on this checkout — so loop instead:

  ```bash
  for t in --hud-cyan --void --panel --info: --stroke:; do grep -c -- "$t" apps/api/dashboard/dashboard.css; done
  ```

  Each of the five printed numbers is at least `1`. Then
  `grep -cE '#[0-9a-f]{3,8}' apps/api/dashboard/dashboard.css` prints `0`.

### Task 1.4 — Add the light companion blocks

- **Goal:** Both light paths render the light palette, declared identically.
- **Target files and symbols:** `apps/api/dashboard/dashboard.css`, the
  `@media (prefers-color-scheme: dark)` block at lines 44-71 and the
  `:root[data-theme="dark"]` block at lines 74-96.
- **Steps:**
  1. Delete the `@media (prefers-color-scheme: dark) { :root:not([data-theme]) {...} }`
     block and the `:root[data-theme="dark"] {...}` block entirely. Dark is now
     the `:root` base, so neither is needed.
  2. Add `:root[data-theme="light"] { ... }` containing the light block from the
     "Token block to write" section.
  3. Add `@media (prefers-color-scheme: light) { :root:not([data-theme]) { ... } }`
     containing the **same declarations**, copied byte for byte.
  4. Put the two light blocks next to each other and add a one-line comment above
     the first one stating that both must stay identical because the CSS cannot
     share a token set across a media query, and that
     `apps/api/test/dashboard-design-tokens.test.ts` asserts they match.
- **Success criteria:** no `prefers-color-scheme: dark` block remains; a
  `prefers-color-scheme: light` block exists; `:root[data-theme="light"]`
  exists; the two light declaration sets are identical.
- **Verify:** `grep -c 'prefers-color-scheme: dark' apps/api/dashboard/dashboard.css`
  prints `0`, and `npx vitest run apps/api/test/dashboard-design-tokens.test.ts`
  now exits **0** with all pairs passing. If you reach this point before Tasks 1.2
  and 1.5 are done, expect the accent-text and contract assertions to still fail;
  that is expected, so finish those tasks and re-run rather than weakening them.

### Task 1.5 — Extend the UI contract test

- **Goal:** The contract test pins the new token layer so a later edit cannot
  silently drop it.
- **Target files and symbols:** `apps/api/test/dashboard-ui-contract.test.ts`, the
  `'uses tokenized responsive styling with reduced-motion and narrow-screen rules'`
  test case.
- **Steps:**
  1. Extend the existing token loop from
     `['--canvas:', '--surface:', '--ink:', '--accent:', '--space-4:', '--motion-state:']`
     to also include `'--info:'`, `'--hud-cyan:'`, `'--void:'`, `'--panel:'`, and
     `'--stroke:'`.
  2. Add one assertion that `css` contains
     `'@media (prefers-color-scheme: light)'` and one that `css` contains
     `':root[data-theme="light"]'`.
  3. Do not remove or weaken any existing assertion.
- **Success criteria:** the new assertions are present and the whole file passes.
- **Verify:** `npx vitest run apps/api/test/dashboard-ui-contract.test.ts` exits 0.

### Task 1.6 — Assert the asset and inline-style safety the CSP depends on

- **Goal:** The acceptance item "no web font, no external asset, no inline
  `style=`" is actually enforced, instead of being assumed.
- **Target files and symbols:** `apps/api/test/dashboard-ui-contract.test.ts`
  only.
- **Steps:**
  1. In `dashboard-ui-contract.test.ts`, add a test case named
     `'keeps the dashboard free of external assets and inline styles'` asserting:

     ```js
     expect(css).not.toMatch(/@font-face|@import|url\(/i);
     expect(html).not.toMatch(/\sstyle=/i);
     expect(html).not.toMatch(/<link[^>]+href="https?:/i);
     expect(script).not.toMatch(/\.style\.|setAttribute\(['"]style['"]/);
     ```

     The existing contract test already reads `dashboard.css`, `index.html`, and
     the three JS assets, so no new file read is needed.
  2. Confirm the assertions pass on the current tree. `dashboard.css` contains no
     `@font-face`, no `@import`, and no `url(`; `index.html` has no `style=`
     attribute; the scripts do not touch `.style`. If any of these fails, STOP and
     report it — a real external asset or inline style is a finding, not something
     to assert around.
  3. **Do not add a document-header assertion.** An earlier draft asked for one.
     It is withdrawn because the CSP header is set by `dashboardSecurity` inside
     the router mounted at `/dashboard`, and that router sits after
     `accessAssertionAuth` in `apps/api/src/app.ts:76-78`. Reaching it in a test
     requires forging a Cloudflare Access JWT, which is out of proportion for a
     CSS reskin. Instead, record in your journal that an **unauthenticated** 401
     from `/dashboard/*` is emitted before `dashboardSecurity` runs and therefore
     carries no CSP, `X-Frame-Options`, or `X-Content-Type-Options`. That is a
     pre-existing hardening gap for a follow-up issue; do not fix it here, and do
     not claim the header is verified.
  4. Do not modify `apps/api/src/dashboard-security.ts` or
     `apps/api/src/dashboard-assets.ts` in this plan.
- **Success criteria:** the asset and inline-style case exists and passes, and the
  deferred header assertion is recorded rather than silently dropped.
- **Verify:** `npx vitest run dashboard-ui-contract` exits 0 and the output lists
  `keeps the dashboard free of external assets and inline styles`.

## Token block to write

Copy this verbatim into `:root`. Comments carry the marketing token name, never a
hex value.

```css
:root {
  color-scheme: dark;

  /* Marketing HUD ramp. Source: site/index.html and site/haas.html, whose
     :root blocks declare these as hex. The UI contract test rejects hex, so
     each value is the same colour expressed in OKLCH; the comment names the
     marketing custom property it came from. */
  --void: oklch(0.000 0.000 0);              /* --bg-void        */
  --panel: oklch(0.127 0.009 253.7);         /* --bg-panel       */
  --card: oklch(0.154 0.014 263.9);          /* --bg-card        */
  --card-hover: oklch(0.192 0.026 266.6);    /* --bg-card-hover  */
  --bright: oklch(0.984 0.003 247.9);        /* --text-bright    */
  --muted: oklch(0.711 0.035 256.8);         /* --text-muted     */
  --dim: oklch(0.554 0.041 257.4);           /* --text-dim       */
  --hud-cyan: oklch(0.870 0.148 202.9);      /* --cyan-glow      */
  --hud-green: oklch(0.696 0.149 162.5);     /* --green-neon     */
  --hud-amber: oklch(0.769 0.165 70.1);      /* --amber-warn     */
  --hud-purple: oklch(0.627 0.233 303.9);    /* --purple-laser   */
  --hud-violet: oklch(0.827 0.108 306.4);    /* violet code ink  */
  --hud-red: oklch(0.637 0.208 25.3);        /* terminal alert   */

  /* Semantic layer. These names are the contract: component rules and the UI
     contract test both depend on them, so the HUD ramp aliases onto them
     rather than replacing them. */
  --canvas: var(--void);
  --surface: var(--panel);
  --surface-raised: var(--card);
  --surface-muted: var(--card-hover);
  --ink: var(--bright);
  --ink-muted: var(--muted);
  --line: oklch(0.330 0.014 260);      /* opaque hairline, marketing blue      */
  --line-strong: oklch(0.440 0.018 262);/* opaque hairline, marketing blue     */

  --accent: var(--hud-cyan);
  --accent-hover: oklch(0.930 0.120 200.5);
  --accent-strong: oklch(0.905 0.130 201.5);
  --accent-soft: oklch(0.870 0.148 202.9 / .12);  /* --cyan-dim: fill only */
  --accent-line: oklch(0.550 0.130 202.9);        /* OPAQUE: brackets, borders, underlines */
  --on-accent: oklch(0.127 0.009 253.7);
  --focus: oklch(0.870 0.148 202.9);

  --success: var(--hud-green);
  --success-soft: oklch(0.696 0.149 162.5 / .12);
  --success-line: oklch(0.470 0.085 162.5);
  --warning: var(--hud-amber);
  --warning-soft: oklch(0.769 0.165 70.1 / .12);
  --warning-line: oklch(0.500 0.080 70.1);
  --danger: var(--hud-red);
  --danger-hover: oklch(0.700 0.190 25.3);
  --danger-soft: oklch(0.637 0.208 25.3 / .12);
  --danger-line: oklch(0.500 0.120 27.3);
  --info: var(--hud-purple);
  --info-soft: oklch(0.627 0.233 303.9 / .12);
  --info-line: oklch(0.500 0.120 303.9);

  --code-bg: oklch(0.154 0.014 263.9);
  --code-ink: var(--hud-violet);
  --shadow-overlay: 0 .25rem .75rem oklch(0 0 0 / .60), 0 1rem 2.5rem oklch(0 0 0 / .70);
  --shadow-raise: 0 .0625rem .1875rem oklch(0 0 0 / .50);

  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-display: var(--font-sans);
  --font-mono: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;

  --text-11: .6875rem; --text-12: .75rem; --text-13: .8125rem; --text-14: .875rem; --text-16: 1rem; --text-20: 1.25rem; --text-24: 1.5rem; --text-28: 1.75rem; --text-36: 2.25rem;
  --space-1: .25rem; --space-2: .5rem; --space-3: .75rem; --space-4: 1rem; --space-5: 1.25rem; --space-6: 1.5rem; --space-8: 2rem; --space-10: 2.5rem; --space-12: 3rem;
  --radius-sm: .25rem; --radius-md: .375rem; --radius-lg: .5rem; --radius-pill: 99rem;

  --stroke: 1px;
  --motion-fast: 150ms; --motion-state: 220ms; --ease-out: cubic-bezier(.16, 1, .3, 1);
}
```

Copy this into **both** light blocks (identical declarations):

```css
  color-scheme: light;

  --canvas: oklch(0.960 0.008 253.9);        /* --bg-void light      */
  --surface: oklch(1.000 0.000 0);           /* --bg-panel light     */
  --surface-raised: oklch(0.972 0.008 253.9);/* --bg-card-hover light */
  --surface-muted: oklch(0.945 0.010 253.9);
  --ink: oklch(0.208 0.040 265.8);           /* --text-bright light  */
  --ink-muted: oklch(0.446 0.037 257.3);     /* --text-muted light   */
  --line: oklch(0.888 0.009 253.9);          /* opaque hairline              */
  --line-strong: oklch(0.795 0.013 253.9);   /* opaque hairline              */

  --accent: oklch(0.539 0.128 242.0);
  --accent-hover: oklch(0.490 0.120 242.0);
  --accent-strong: oklch(0.500 0.122 242.0);
  --accent-soft: oklch(0.539 0.128 242.0 / .12);
  --accent-line: oklch(0.620 0.135 242.0);   /* OPAQUE, clears 3:1 on light surfaces */
  --on-accent: oklch(1 0 0);
  --focus: oklch(0.539 0.128 242.0);

  --success: oklch(0.513 0.129 154.1);
  --success-soft: oklch(0.513 0.129 154.1 / .12);
  --success-line: oklch(0.755 0.095 154.1);
  --warning: oklch(0.541 0.145 49.0);
  --warning-soft: oklch(0.541 0.145 49.0 / .12);
  --warning-line: oklch(0.800 0.105 49.0);
  --danger: oklch(0.542 0.221 27.3);
  --danger-hover: oklch(0.495 0.205 27.3);
  --danger-soft: oklch(0.542 0.221 27.3 / .12);
  --danger-line: oklch(0.795 0.115 27.3);
  --info: oklch(0.558 0.271 293.0);
  --info-soft: oklch(0.558 0.271 293.0 / .12);
  --info-line: oklch(0.795 0.115 293.0);

  --code-bg: oklch(0.945 0.010 253.9);
  --code-ink: oklch(0.400 0.140 300.0);
  --shadow-overlay: 0 .25rem .75rem oklch(0.35 0.03 260 / .16), 0 1rem 2.5rem oklch(0.30 0.04 260 / .22);
  --shadow-raise: 0 .0625rem .1875rem oklch(0.35 0.03 260 / .10);
```

### Rule: `-soft` is a translucent fill, `-line` is an opaque border

This is the single most important correction in this token block, and it is not
optional.

`-soft` tokens are **translucent** and used only as backgrounds, exactly like
the marketing `--cyan-dim` / `--green-dim` / `--purple-dim` tints. They are
always paired with an opaque text colour or an opaque border, so the tint is
reinforcement rather than the sole state indicator.

`-line` tokens are **opaque** and are used for borders, brackets, and link
underlines. Today's stylesheet already declares them opaque
(`dashboard.css:15` `--accent-line: oklch(0.720 0.140 66)`,
`:11` `--line: oklch(0.888 0.009 250)`), and the marketing alphas are a trap here:
compositing `oklch(0.870 0.148 202.9 / .20)` over `--canvas` yields only
**1.47:1**, so a 20%-alpha cyan would make the corner brackets, the detail-pane
border, the note borders, and every link underline effectively disappear. The
values above are opaque and were each measured:

| Token | Dark | Light | Dark vs canvas/surface/raised | Light vs canvas/surface/raised |
| --- | --- | --- | --- | --- |
| `--accent-line` | `oklch(0.550 0.130 202.9)` | `oklch(0.620 0.135 242.0)` | 4.58 / 4.40 / 4.27 | 3.20 / 3.59 / 3.31 |
| `--focus` | `oklch(0.870 0.148 202.9)` | `oklch(0.539 0.128 242.0)` | 14.90 / 14.32 / 13.89 | 4.47 / 5.02 / 4.63 |

Two consequences to accept deliberately:

1. The light `--accent-line` is deliberately **darker** than the light
   `--accent` fill. That is required: the light canvas is near-white, so a
   light-tinted cyan line cannot reach 3:1 on it. It also fixes a pre-existing
   defect. Today's light `--accent-line` is `oklch(0.720 0.140 66)`, which
   measures **2.28:1** against the light canvas and **2.56:1** against the light
   surface — already below the 3.0 floor before this work starts. The light
   `--accent-line` value above was chosen to clear it.
2. The semantic `--success-line`, `--warning-line`, `--danger-line`, and
   `--info-line` keep today's light/dark lightness with the marketing hue, so
   they are exactly as visible as they are now. In the light theme they measure
   roughly **1.7-2.1:1** against the light surfaces and do **not** reach 3.0.
   That is acceptable and intentional: these only ever draw the border of a
   status pill, and the pill conveys its state through its text label and its
   leading dot, so the border is not the information required to identify the
   state. Do not "fix" them by darkening the palette, and do not assert them at
   3.0 — assert `--accent-line` and `--focus` at 3.0, which is where the
   requirement actually bites.

The light `--accent` / `--success` / `--warning` / `--danger` / `--info` **text**
values also differ from the raw marketing light hexes on purpose. The marketing
light accents fail WCAG AA as pill and button text (measured: green 3.06:1, red
4.01:1, amber 4.27:1, white-on-cyan 4.09:1). The values above are the same hues,
darkened and chroma-clamped to the sRGB gamut, each verified at or above the
threshold its test asserts. Do not "restore" the marketing light values.

## Verification

- `npx vitest run dashboard` exits 0, and printed a pass for every pair in both
  themes. `dashboard` is the deliberate glob: it matches every test file whose
  path contains `dashboard` — ten files today, plus the new
  `dashboard-design-tokens.test.ts`. That includes `dashboard-ui-behavior.test.ts`,
  `knowledge-dashboard-ui.test.ts`, and `mcp-servers-dashboard-ui.test.ts`, which
  a `dashboard-*.test.ts` pattern silently misses.
- `grep -cE '#[0-9a-f]{3,8}' apps/api/dashboard/dashboard.css` prints `0`.
- `grep -c 'gradient(' apps/api/dashboard/dashboard.css` prints `0`.
- `npx tsc --noEmit -p apps/api/tsconfig.json` exits 0 (or
  `npm run typecheck` exits 0).

## Failure Protocol

If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:

- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.
