---
title: Connect Google Gemini to Cloud Harness MCP
description: Connect the Gemini web app through Managed OAuth, or Gemini CLI with a static API key.
---

# Google Gemini

| Client | Connection mode | Endpoint |
|---|---|---|
| Gemini web app (custom connected app) | Managed OAuth | `https://harness.zuey.me/mcp` |
| Gemini CLI | Static API key | `https://api.harness.zuey.me/mcp` |

## Gemini web app

The Gemini web app connects to `https://harness.zuey.me/mcp` as a custom MCP app and signs in through Cloudflare Access, like ChatGPT and Claude.

### 1. Allow Gemini's callback

Gemini's OAuth callback has the form `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<id>`, with an `<id>` per Google account. Cloudflare refuses a client whose callback is not on the Access application's allowlist.

- With the Cloudflare API integration in read-write mode, open **Dashboard → [Settings](/dashboard/settings#allowed-redirect-uris) → MCP OAuth sessions → Allowed redirect URIs**, tick **Gemini custom apps**, and click **Save redirect URIs**. Wait for *Redirect URIs saved and confirmed by the provider*.
- Without the integration, an operator adds `https://oauth-redirect.googleusercontent.com/r/*` in Cloudflare Zero Trust under **Advanced settings → Managed OAuth → Allowed redirect URIs**.

The allowlist covers `/r/*` only, not the whole `oauth-redirect.googleusercontent.com` host.

### 2. Add the app in Gemini

1. In Gemini, open the custom connected apps settings and add an app.
2. Enter `https://harness.zuey.me/mcp` as the MCP server URL and click **Next**.
3. If Gemini connects, accept the Google permissions, sign in through Cloudflare Access, and click **Allow**.

### 3. If Gemini asks for a client ID and secret

Gemini may report that automatic registration with the server failed and ask for an OAuth client ID and secret, even after step 1. Cloudflare accepts standard registrations for Gemini's callback; why Gemini's own registration fails is not yet identified. Create a client for your Google account and paste its credentials into Gemini:

1. In the Gemini dialog, click **Copy redirect URI**. Use this exact value; it is specific to your Google account.
2. Open **Dashboard → [Settings](/dashboard/settings#connect-gemini) → MCP OAuth sessions → Connect Gemini**, paste the URI, and click **Create Gemini client**. A dialog shows the client ID and secret once; copy each into Gemini before closing it.
3. Under **Advanced settings** in the Gemini dialog, paste the client ID and secret, then click **Next**, accept the Google permissions, sign in through Cloudflare Access, and click **Allow**.

Without the Dashboard, register the client yourself. The registration endpoint is public and needs no Zero Trust access; anyone who registers still has to pass the Access policy to get a token.

```bash
REDIRECT_URI='<paste the URI from step 1>'
REGISTRATION=$(curl -s https://harness.zuey.me/.well-known/oauth-authorization-server | jq -r .registration_endpoint)
curl -s -X POST "$REGISTRATION" -H 'content-type: application/json' -d "{
  \"client_name\": \"Gemini custom app\",
  \"redirect_uris\": [\"$REDIRECT_URI\"],
  \"grant_types\": [\"authorization_code\", \"refresh_token\"],
  \"response_types\": [\"code\"],
  \"token_endpoint_auth_method\": \"client_secret_post\"
}" | jq '{client_id, client_secret}'
```

Either way, two details matter:

- **`client_secret_post`.** Gemini sends the secret in the request body, and Cloudflare enforces the method a client registered with. A `client_secret_basic` client completes the sign-in but fails the token exchange, and Gemini then reports that you must link the account. The Dashboard always registers `client_secret_post`.
- **The secret is shown once.** Cloudflare returns it only in the registration response, and Cloud Harness does not keep it. If you lose it, create another client.

Each Google account has its own callback, so each Gemini user creates their own client. Cloudflare shows the client name on its **Authorize Client** page. Cloud Harness cannot list or delete these clients; remove unused ones in Cloudflare Zero Trust.

### What Gemini can do once connected

Gemini can call every Cloud Harness tool as you: open workspaces, read and write files, run commands with `exec_run`, use git, and run agents. It acts with your principal's permissions; privileged commands still need approval on the Dashboard. To disconnect, remove the app from Gemini's connected apps or unlink it from your Google account. To cut off access from the harness side, remove the person from the Access policy: their existing connection stops at its next token refresh, because every refresh re-checks the policy. Removing the Gemini callback from the allowlist only blocks new registrations and sign-ins; it does not revoke a connection that already holds a grant.

## Gemini CLI

Set your authorization token in your shell environment:

```bash
export CLOUD_HARNESS_MCP_TOKEN="<YOUR_DASHBOARD_API_KEY>"
```

Add the server to Gemini CLI settings or pass it via command-line flags:

```bash
gemini mcp add cloud-harness \
  --url https://api.harness.zuey.me/mcp \
  --header "Authorization: Bearer $CLOUD_HARNESS_MCP_TOKEN"
```
