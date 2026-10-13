# Plan: Light theme & icon toggle (system / light / dark) for the landing page

- **Branch:** `feat/landing-light-theme-toggle`
- **Route:** feature via `/ak:cook`
- **Ship mode:** official (`--ship`)
- **Source:** natural-language request — "landing page [harness.agentkit.best]: add a
  light theme and an icon theme toggle (system-light-dark)."

## Outcome

Visitors to the public landing page (`site/index.html`, deployed at
`harness.agentkit.best` via Cloudflare Pages) can choose a light theme, a dark
theme, or follow their OS preference. A single icon toggle in the site header
cycles through **system → light → dark**, persists the choice in
`localStorage`, and applies it consistently to the companion `site/haas.html`
page so the choice survives navigation between the site's pages. The dark theme
remains the visual default.

## How it works

1. A tiny inline script in `<head>` (before first paint, avoiding FOUC) resolves
   the theme: value of `localStorage['harness-theme']` (`light`/`dark`/`system`),
   falling back to `system`. `system` resolves to `prefers-color-scheme`. It
   toggles a `theme-light` class on `<html>` and updates the `theme-color` meta.
2. An icon button in the header nav CDUs (`nav-actions`) and the mobile drawer
   cycles `light → dark → system → …`, stores the choice, re-evaluates, and swaps
   the icon (sun / moon / sun-partial). A `prefers-color-scheme` listener keeps
   `system` mode live when the OS theme changes.
3. The `theme-light` class overrides the HUD token set (backgrounds, text,
   borders, accent tints) so the whole page — hero, worker-grid diagram,
   terminals, invariant cards — renders in light mode without changing markup.

## Acceptance criteria

- [ ] A toggle icon appears in the desktop header and mobile drawer on
      `site/index.html` and `site/haas.html`.
- [ ] Toggle cycles through three modes: system, light, dark (icon reflects the
      active mode).
- [ ] The page renders in light mode with readable text and visible borders on
      every major section (verified against intentionally-broken markup none).
- [ ] Dark theme stays visually identical to today's default (no regression for
      existing dark visitors).
- [ ] Choice persists across reloads and across pages (`index.html` ⇄
      `haas.html`).
- [ ] System mode tracks OS preference changes without a reload.
- [ ] No flash of the wrong theme on load (boot script runs before paint).
- [ ] Toggle button is accessible: `aria-label`, `aria-pressed`, keyboard
      focusable, preserves site focus-visible styles.
- [ ] Repo gates pass; landing-page smoke test (open locally, toggle, reload).

## Non-goals

- Theming `site/styles.css` token set (not linked by the live pages) and the
  `site/variants/*` experiment pages.
- MCP/api server behavior, docs site, or dashboard. `vite` client-plugin checks
  are out of scope for this static page.
- A light-specific `og-image`/favicon variant.

## Phase 1 — Implement landing-page theme

1. Add `<head>` boot script (theme resolution, FOUC-avoidance, meta sync) to
   `site/index.html`; replace hardcoded `class="dark"` default wiring.
2. Add `html.theme-light { ... }` token overrides to the inline `<style>`;
   convert the handful of hardcoded dark surfaces (`html` bg, header bg,
   `.code-box`, `.invariant-card`) to CSS vars so they follow the theme.
3. Add the toggle button to `.main-nav .nav-actions` and the mobile drawer
   header; add toggle logic + icon swap + system listener to the page's main
   script; hide on non-JS gracefully.
4. Mirror the same changes onto `site/haas.html` (shared `:root` + header) so
   the choice is consistent across pages.

### Definition of done (Phase 1)

All acceptance criteria above meet; dark theme unchanged; light theme legible
across all main sections; repo gates pass.

## Status

- [x] Phase 1 implemented on `site/index.html` and `site/haas.html`.
- [x] Theme toggle verified: cycles system → light → dark, persists in
      `localStorage['harness-theme']`, tracks OS scheme, updates `theme-color`,
      FOUC-free via head boot script. Computed styles confirm a high-contrast
      light theme and an unchanged dark theme.
- [x] `npm run pages:check` and `npm run pages:links` pass.
- **status:** completed
