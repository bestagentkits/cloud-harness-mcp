---
title: Operator Profile & Appearance
description: Account details, session management, and server-persisted theme settings.
---

# Operator Profile & Appearance

## Identity Details

The Profile panel displays your authenticated Cloudflare Access principal information:
- **Email:** Account email address.
- **Subject ID:** Unique Cloudflare Access subject identifier (`sub`).
- **Session Expiry:** Time remaining on your active dashboard login session.

## Theme & Appearance

Cloud Harness MCP supports three theme modes:
- **System:** Automatically tracks your operating system `prefers-color-scheme`.
- **Light:** High-contrast cool concrete industrial theme.
- **Dark:** Tinted graphite console theme.

### Server-Side Persistence
To comply with strict CSP rules forbidding browser storage (`localStorage`), your theme preference is persisted server-side via `PUT /api/v1/preferences` into a secure `ch-dashboard-theme` HttpOnly cookie. The dashboard shell injects `data-theme` directly on initial HTML delivery, preventing screen flicker on page load.
