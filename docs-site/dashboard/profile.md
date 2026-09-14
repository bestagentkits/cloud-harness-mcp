---
title: Operator Profile & Appearance
description: Account details, an editable display name, session management, and server-persisted theme settings.
---

# Operator Profile & Appearance

## Display Name

The top-bar chip shows your **display name**; selecting it opens this page. Use
the **Display name** form to set the label you want to see there:

- Letters and numbers in any script, spaces, and `. _ - '` are accepted, up to 64
  characters.
- **Save display name** stores it; **Use sign-on name** clears it and returns the
  chip to your verified single sign-on name.
- The display name is cosmetic. It never replaces your verified identity, never
  grants access, and the read-only **Account** panel below always reports the
  authoritative sign-on name, email, subject, and identity provider.

Like the theme choice, it persists **server-side, not in the browser**: the
CSRF-guarded `PUT /api/v1/preferences` writes an HttpOnly
`ch-dashboard-display-name` cookie, and `GET /api/v1/profile` returns it as
`preferences.displayName`. A value that no longer matches the allowed pattern is
ignored on read, so a tampered cookie cannot inject content.

## Identity Details

The Profile panel displays your authenticated Cloudflare Access principal information:

- **Email:** Account email address.
- **Subject ID:** Unique Cloudflare Access subject identifier (`sub`).
- **Session Expiry:** Time remaining on your active dashboard login session.

## Theme & Appearance

Cloud Harness MCP supports three theme modes:

- **System:** Automatically tracks your operating system `prefers-color-scheme`.
- **Light:** The HUD's light companion, with light surfaces and darkened cyan and status accents.
- **Dark:** The HUD's default base — a near-black canvas with the cyan accent.

Dark is the base theme, so a machine whose OS expresses no preference renders
dark. `System` still follows your OS when it does express one.

### Server-Side Persistence

To comply with strict CSP rules forbidding browser storage (`localStorage`), your theme preference is persisted server-side via `PUT /api/v1/preferences` into a secure `ch-dashboard-theme` HttpOnly cookie. The dashboard shell injects `data-theme` directly on initial HTML delivery, preventing screen flicker on page load.
