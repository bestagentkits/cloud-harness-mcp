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

Gemini may report that automatic registration with the server failed and ask for an OAuth client ID and secret, even after step 1. Cloudflare accepts standard registrations for Gemini's callback, so the cause is on Gemini's side and has not been identified. Register a client yourself and paste its credentials into Gemini:

1. In the Gemini dialog, click **Copy redirect URI**. Use this exact value; it is specific to your Google account.
2. Register a client. The registration endpoint is public and needs no Zero Trust access; anyone who registers still has to pass the Access policy to get a token.

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

3. Under **Advanced settings** in the Gemini dialog, paste `client_id` and `client_secret`, then click **Next**, accept the Google permissions, sign in through Cloudflare Access, and click **Allow**.

Keep these two details exactly as shown:

- **`client_secret_post`.** Gemini sends the secret in the request body, and Cloudflare enforces the method a client registered with. A `client_secret_basic` client completes the sign-in but fails the token exchange, and Gemini then reports that you must link the account.
- **The secret is shown once.** Cloudflare returns it only in the registration response. If you lose it, register a new client.

Each Google account has its own callback, so each Gemini user registers their own client. Cloudflare shows the client name on its **Authorize Client** page.

### What Gemini can do once connected

Gemini can call every Cloud Harness tool as you: open workspaces, read and write files, run commands with `exec_run`, use git, and run agents. It acts with your principal's permissions; privileged commands still need approval on the Dashboard. To disconnect, remove the app from Gemini's connected apps or unlink it from your Google account. Removing the Gemini callback from the allowlist, or removing you from the Access policy, stops new sign-ins and takes effect for existing connections at the next token refresh.

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
