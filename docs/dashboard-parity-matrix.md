# Dashboard 2.0 parity matrix

Tài liệu này là danh mục đối chiếu (parity) giữa Dashboard legacy
(`apps/api/dashboard/`, vanilla JS) và Dashboard 2.0 React
(`apps/dashboard/`, theo [ADR 0005](adr/0005-dashboard-react-rewrite.md)) cho
epic [#458](https://github.com/bestagentkits/cloud-harness-mcp/issues/458).
Mỗi PR của phase P3/P4 phải đánh dấu các dòng mình đóng lại và giữ nguyên các
hàng bảo mật.

Nguồn: audit tĩnh (đọc code, chưa chạy trình duyệt) ngày 2026-10-20 trên `main`
tại `e8bd0aa6`. Số dòng chỉ là điểm neo để tìm nhanh. Khi code đổi thì tin
code, không tin số dòng ở đây. Code, schema và test vẫn là authority cho
hành vi (WHAT/HOW). Tài liệu này chỉ ghi WHERE và mục tiêu migration.

## Quy ước

Viết tắt file nguồn:

| Viết tắt | File |
| --- | --- |
| DJ | `apps/api/dashboard/dashboard.js` |
| DR | `apps/api/dashboard/dashboard-render.js` |
| DM | `apps/api/dashboard/dashboard-models.js` |
| DP | `apps/api/dashboard/dashboard-pages.js` |
| DA | `apps/api/dashboard/dashboard-api.js` |
| DT | `apps/api/dashboard/dashboard-terminal.js` |
| HTML | `apps/api/dashboard/index.html` |
| R-BFF | `apps/api/src/dashboard-router.ts` |
| C-BFF | `apps/api/src/dashboard-control-router.ts` |
| G-BFF | `apps/api/src/dashboard-gateway-router.ts` |
| T-BFF | `apps/api/src/dashboard-terminal-router.ts` |
| ASSETS | `apps/api/src/dashboard-assets.ts` |
| SEC | `apps/api/src/dashboard-security.ts` |
| SESS | `apps/api/src/dashboard-session.ts` |
| RESP | `apps/api/src/dashboard-response.ts` |

Phase: P3 là trang lõi, P4 là luồng nhạy cảm hoặc phức tạp (xem
[child issues](../plans/261020-1224-dashboard-2-react-dewee/child-issues/)).
P2 là router shell và primitive dùng chung. P1 là scaffold, build và canary.

Lớp test: **(a)** contract BFF/bảo mật, giữ nguyên; **(b)** hành vi frontend
qua DOM giả, port sang Playwright; **(c)** gắn vào markup, thay bằng test hành
vi (xem [mục 9](#9-test-gắn-markup-cần-thay-bằng-test-hành-vi)).

Folder feature mới có dạng `apps/dashboard/src/features/<x>`. Cột "Feature"
chỉ ghi `<x>`.

## 1. Bất biến không thương lượng

Các dòng sau áp dụng cho mọi phase. Một PR làm yếu bất kỳ dòng nào là chặn
merge.

| Bất biến | Owner hiện tại | Ghi chú cho React |
| --- | --- | --- |
| CSP chặt: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` | SEC (~29-32) | ADR chỉ thêm `font-src 'self'`. Không inline script, không `<style>` tiêm lúc runtime (Radix `react-remove-scroll`, toast lib). CSSOM/React `style` prop được phép. Thêm directive nào khác phải có ADR và test. |
| Session `__Host-ch-dashboard` (HttpOnly, Secure, SameSite=Strict, Path=/) và `x-csrf-token` lấy từ `GET /dashboard/api/v1/session`, chỉ giữ trong bộ nhớ | SESS (39-68), DA (8-28) | Token không vào storage, query cache dump hay log. 401 thì xoá token và bootstrap lại. |
| Mutation phải có Origin khớp Host và nằm trong allowlist, body JSON (415 nếu sai), body tối đa `min(MAX_BODY_BYTES, 1 MiB)` | SEC (11-35), R-BFF (103-121) | Ngoại lệ duy nhất: `POST /skill-archives` (zip raw, 8 MiB). |
| Thứ tự mount: requestSecurity → preAuth (1000/phút, 32 đồng thời) → Access JWT → principal limit `/api/v1` (120/phút, 8 đồng thời) → dashboard router → assets router | `apps/api/src/app.ts` (132-141) | Client phải ngân sách request: long-poll terminal và route fan-out cùng chiếm 8 slot đồng thời của một subject. |
| Không secret trong trình duyệt: value của secret, provider key và integration credential chỉ đi vào (write-only). Chỉ `POST /api-keys` trả plaintext một lần. | RESP (262-313), C-BFF (~387) | Reveal một lần phải xoá khi dismiss, khi bấm link, khi `pagehide`, khi session kết thúc. |
| Asset cùng origin, có version, cache `immutable`; shell `no-store` | ASSETS (125-165) | Allowlist sinh từ `.vite/manifest.json` lúc khởi động. Manifest không được phục vụ như asset. |
| Theme và display name đi qua cookie server (`ch-dashboard-theme`, `ch-dashboard-display-name`), shell tiêm `data-theme` lúc first paint | R-BFF (166-176), ASSETS (48-65) | Thay chuỗi `<html lang="en">` trong shell thì phải cập nhật `forcedTheme`. |
| Callback OAuth `/dashboard/mcp-oauth/callback` do server xử lý, nginx tắt access log | G-BFF (129-148), `deploy/nginx/cloud-harness-mcp.conf` (87-92) | Router React không được bắt path này. Nó vẫn là redirect 303 server-side. |
| `/cdn-cgi/access/logout` thuộc Cloudflare Access | HTML (24) | Link native, nằm ngoài router. |

## 2. Route và trang

Registry legacy nằm ở DP (35-266), loader ở DJ (`PAGE_LOADERS` 1194-1213),
danh sách shell path phía server là `DASHBOARD_SHELL_PATHS` trong ASSETS
(74-110). Hai danh sách này đang được `apps/api/test/dashboard-pages.test.ts`
ép phải khớp nhau. React cần thay bằng một nguồn route duy nhất (ADR: "one
route identity"): fallback `GET /dashboard/*` trả shell, trừ `/dashboard/api/`,
`/dashboard/assets/` và `/dashboard/mcp-oauth/`.

| Route cũ | Page key / loader | Feature | Phase | Deep-link params (giữ là search params) | BFF đọc chính | Ghi chú bảo mật | Test phải port |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/dashboard` | overview / `loadOverview` DJ:1823 | `overview` | P3 | không có | `GET /overview`, `/metrics?window=`, `/reliability`, `/privilege-grants` | Fan-out: 1 + N runner call (F5) | `dashboard-overview` (a), `dashboard-analytics` (b), `dashboard-agent-series` (b) |
| `/dashboard/workspaces` | workspaces / `loadIndex` DJ:1849 | `workspaces` | P3 | `q`, `status`, `expiring` | `GET /workspaces` | Sửa R1: filter phải ở lại trang này | `dashboard-ui-behavior` (b) |
| `/dashboard/workspaces/:ws_id[/tab]` | cockpit / `loadWorkspace` DJ:3357 | `workspace-cockpit` | P3 (summary, agents, runtime, automation, deploy, artifacts, activity), P4 (terminal, files, git) | `path`, `file` (files), `staged` (git) | `GET /workspaces/:id`, `/context`, `/runtime`, `/skills`, `/hooks`, `/deployments`, `/artifacts`, `/activity` | Tab: summary, agents, runtime, terminal, files, git, automation, deploy, artifacts, activity. Regex `ws_[A-Za-z0-9_-]{20,80}` | `dashboard-cockpit` (a/b), `dashboard-runtime` (b), `dashboard-automation` (b), `dashboard-git` (a+b) |
| `/dashboard/agents[/:agent_id]` | agents / `loadAgents` DJ:3752 | `agents` | P3 | `status`, `workspaceId`, `profileId`, `parentAgentId`, `attention` | `GET /agents`, `/agents/:id`, `/agents/:id/logs` | Fan-out khi không có `workspaceId` (F5) | `dashboard-agents` (b) |
| `/dashboard/activity` | activity / `loadActivity` DJ:3628 | `activity` | P3 | `filter` (mặc định `all`) | `GET /activity`, `/audit` | Fan-out | `dashboard-activity` (b) |
| `/dashboard/approvals` | approvals / `loadApprovals` DJ:3652 | `approvals` | P4 (approve/reject), P3 (đọc) | không có | `GET /privilege-grants`, `/package-plans` | Badge nav chỉ cập nhật khi tải trang (R13). React dùng Query invalidation. | `dashboard-activity` (b), `dashboard-privilege-grants` (a) |
| `/dashboard/packages` | packages / `loadPackages` DJ:3696 | `packages` | P4 | không có | `GET /packages`, `/package-plans` | Approve gửi đúng `planDigest` đang hiển thị | `dashboard-packages` (a) |
| `/dashboard/terminals` | terminals / `loadTerminals` DJ:3434 | `terminals` | P4 | không có | `GET /terminals` | Không có trên nav (navParent workspaces) | `dashboard-terminal` (b), `dashboard-terminal-router` (a) |
| `/dashboard/audit` | audit / `loadAudit` DJ:2228 | `audit` | P3 | `cursor` | `GET /audit` | Không có trên nav (đã gộp vào Activity) | `dashboard-audit-gaps` (a) |
| `/dashboard/projects[/:prj_id]` | projects / `loadProjects` DJ:1885 | `projects` | P3 (project/env), P4 (secret theo env) | không có | `GET /projects`, `/projects/:id/environments`, `/environments/:id/secrets` | Secret chỉ ghi | `dashboard-ui-behavior` (b) |
| `/dashboard/secrets` | secrets / `loadGlobalSecrets` DJ:1956 | `secrets` | P4 | không có | `GET /secrets` | Write-only. Bulk import `.env` được xoá khi đóng dialog | `dashboard-ui-behavior` (b) |
| `/dashboard/models` | models / `loadModels` DJ:2048 | `models` | P4 | không có | `GET /provider-credentials`, `/agent-model-profiles`, `/agent-model-config-status`, `/model-providers`, `/model-catalog`, `/model-spend[/policies]`, `/decision-plane/status` | Provider key write-only (input password, xoá khi đóng). Response model_* đang passthrough raw (F7) | `dashboard-models-wizard` (b+c), `dashboard-models-spend` (b), `dashboard-models-router` (a) |
| `/dashboard/skills` | skills / `loadSkills` DJ:1267 | `skills` | P3 | tab Skills không nằm trong URL (R16). React nên đưa vào URL. | `GET /skills`, `/skills/search`, `/skills/:id[/revisions|/diff|/usage]`, `/skill-sets[/:id]`, `/toolkit-registry`, `/skill-imports/:job` | Upload zip có parser riêng (8 MiB) | `dashboard-skills-ui` (b), `dashboard-skills-mapper` (a) |
| `/dashboard/integrations[/github]` | integrations / `loadGitHub` DJ:2270 | `integrations` | P4 | `state`, `installation_id` (callback GitHub App) | `GET /github`, `/integration-credentials`, `/typesafe/status` | `state` là state setup dùng một lần. Sau POST `/github/complete` thì `replaceState` để xoá query | `dashboard-github-error-message` (a), `dashboard-typesafe` (a+b) |
| `/dashboard/mcp-servers[/:mcps_id]` | mcp-servers / `loadMcpServers` DJ:2987 | `mcp-servers` | P4 | `oauth`, `reason` (kết quả callback, announce một lần rồi xoá). Tab chi tiết chưa nằm trong URL (R16). | `GET /mcp-servers[/:id]`, `/mcp-servers/:id/logs`, `/mcp-servers/:id/oauth`, `/mcp-gateway` | Không bao giờ hiển thị value header dạng secretRef. Endpoint qua SSRF guard ở server | `mcp-servers-dashboard-ui` (c), `dashboard-mcp-gateway-api` (a), `mcp-oauth` (a) |
| `/dashboard/knowledge[/:kn_id]` | knowledge / `loadKnowledge` DJ:2645 | `knowledge` | P3 | `kind`, `scope`, `projectId`, `q`, `cursor` | `GET /knowledge[/:id]`, `/knowledge-graph`, `POST /knowledge/search` | Markdown phải escape. Không `style=`, không `<style>` | `knowledge-dashboard-ui` (c), `knowledge-api` (a) |
| `/dashboard/artifacts` | artifacts / `loadArtifacts` DJ:2215 | `artifacts` | P4 | `cursor` | `GET /artifacts`, `/artifacts/:id`, `/artifacts/:id/download` | Download là link native (`Content-Disposition: attachment`) dưới prefix `/dashboard/api/v1/artifacts/` | `dashboard-ui-contract` (c, dòng 175-176) |
| `/dashboard/api-keys` | api-keys / `loadApiKeys` DJ:2234 | `api-keys` | P4 | không có | `GET /api-keys`, `/event-subscriptions`, `/server` | Reveal một lần (D3) | `dashboard-ui-behavior` (b) |
| `/dashboard/settings` | settings / `loadSettings` DJ:2384 | `settings` | P3 | không có | `GET /settings`, `/settings/oauth`, `/toolkits` | Response settings_* passthrough raw (F7) | `dashboard-lifecycle-settings` (b), `dashboard-oauth-settings` (b), `dashboard-router` (a) |
| `/dashboard/profile` | profile / `loadProfile` DJ:2342 | `profile` | P3 | không có | `GET /profile`, `/server` | Display name qua cookie server | `dashboard-ui-behavior` (b) |

### 2.1 Redirect legacy (server, 302, giữ nguyên)

| Từ | Đến | Owner |
| --- | --- | --- |
| `/dashboard/overview` | `/dashboard` | ASSETS (119-123, 157-159) |
| `/dashboard/github` | `/dashboard/integrations/github` | như trên |
| `/dashboard/integrations/mcp-servers` | `/dashboard/mcp-servers` | như trên |

Bảng `DASHBOARD_COMPAT_REDIRECTS` phía client (DP:281-285) không được import ở
đâu, chỉ để test parity. Trong React có thể bỏ, nhưng redirect phía server phải
giữ.

### 2.2 Cơ chế điều hướng cần tái tạo

| Hành vi legacy | Owner | Tương đương React |
| --- | --- | --- |
| `navigateTo` chỉ nhận path `/dashboard*`, ngoài ra rơi về `/dashboard` | DJ:539-562 | Router `basepath: /dashboard`. Link ngoài là native. |
| Bộ bắt link toàn cục bỏ qua modifier, `download`, `target` khác `_self`, hash | DJ:4121-4133 | `<Link>` của TanStack Router. Link asset, logout, download là `<a>` thường. |
| Mỗi lần điều hướng huỷ GET đang chạy (`setNavigationSignal`) và tải tuần tự | DJ:1215-1266, DA:4-18 | Query `signal` theo route. Mutation không bị huỷ khi điều hướng (giữ như legacy). |
| Lỗi tải trang hiện "This page could not load." kèm Retry | DJ:1257-1264 | Error boundary theo route có nút retry. |
| Drawer workspace trên desktop (`pushState({drawer})`), modal khi màn hình hẹp | DJ:2944-2967 | Route con hoặc search param; Back đóng drawer. |
| `document.title` = `${title} \| Cloud Harness` | DP:340-342 | `head` theo route. |

## 3. Dialog

| # | Dialog cũ | Mở từ | Feature | Phase | Đóng / draft | Secret | Ghi chú cho React |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | `confirm-dialog` (HTML 56-60) | `confirmAction` DJ:3919 (~25 nơi gọi, xem 3.1) | `shared/confirm` | P2 | Cancel autofocus; Esc = cancel | không | AlertDialog Radix. Nút action có trạng thái pending. Lỗi đóng dialog và hiện ở alert trang. |
| D2 | `file-conflict-dialog` (HTML 61-66) | 409 từ file PUT/PATCH/DELETE (DJ:3883-3895) | `workspace-files` | P4 | Giữ text editor chưa lưu. Có Review latest và Copy changes | không | Sửa R11 (listener `once` bị chồng). |
| D3 | `api-key-reveal-dialog` (HTML 67-74) | sau `POST /api-keys` (DJ:239-270, 2257) | `api-keys` | P4 | Chỉ đóng bằng Acknowledge hoặc Esc. Xoá key khi dismiss, khi bấm link, khi `pagehide`, khi copy lỗi | **Reveal một lần** | Key chỉ nằm trong state của component, không vào Query cache, không log. Có E2E chứng minh key bị xoá. |
| D4 | `bulk-import-dialog` (HTML 75-86) | `.open-bulk-import`, `#open-global-bulk-import` | `secrets` | P4 | Mọi cách đóng đều xoá textarea, preview, status | Text `.env` chỉ ghi | Không lưu draft. Không prompt dirty. |
| D5 | `open-workspace-dialog` (HTML 87-113) | `#open-workspace-btn` | `workspaces` | P4 | **Chết (R4)**: không handler submit, không handler cancel | không | Viết thật trên `POST /workspaces` (bắt buộc `idempotencyKey`, giữ key qua các lần retry). |
| D6 | `model-credential-dialog` (HTML 114-145) | thêm credential, rotate (DJ:2085-2142) | `models` | P4 | Đóng thì reset form và xoá key | Provider key write-only (`type=password`) | Xoá giá trị key khỏi form state trước khi gửi request. |
| D7 | `model-profile-dialog` / wizard (DM:1273-1730) | thêm/sửa/nhân bản/review giá | `models` | P4 | Chặn đóng khi đang busy. Đóng thì huỷ combobox và xoá key | Key có thể nhập trong wizard | Bước wizard được khôi phục (chỉ phần không secret). Combobox giữ ngữ nghĩa ARIA. |
| D8 | `knowledge-conflict-dialog` (HTML 160-183) | 409 khi lưu (DJ:2797-2844) | `knowledge` | P3 | Ba pane base / server / bản của bạn | không | "Load server version" phải hỏi xác nhận trước khi bỏ draft (R10). |
| D9 | `create-knowledge-dialog` (HTML 184-229) | `#open-create-knowledge-btn` | `knowledge` | P3 | Reset khi mở và khi huỷ | không | Scope `project` thì tải `/projects`. |
| D10 | `mcp-server-dialog` (HTML 230-272) | thêm/sửa (DJ:3103-3131) | `mcp-servers` | P4 | Đóng không xoá giá trị (R6) | Header literal là input thường | Đóng thì reset. Header value dùng ô che (masked). |
| D11 | `command-palette` (HTML 273-279) | `#open-palette`, Ctrl/Cmd+K | `shell/palette` | P2 | Esc, backdrop, chọn item | không | Cache index 60 s, invalidate khi có announce và khi `pagehide`. |
| — | `create-project-dialog` (DR:1066) | `#open-create-project` | `projects` | P3 | dialog form | không | |
| — | `create-global-secret-dialog` (DR:1098) | `#open-create-global-secret` | `secrets` | P4 | dialog form | value write-only | |
| — | `snapshot-dialog` (DR:1111) | `#open-create-snapshot` | `artifacts` | P4 | dialog form | không | |
| — | `create-api-key-dialog` (DR:1138) | `#open-create-api-key` | `api-keys` | P4 | dialog form, sau đó mở D3 | dẫn tới reveal | |
| — | `finalize-workspace-dialog` (DR:234) | `#finalize-workspace` | `workspace-cockpit` | P4 | dialog form | không | Push lên remote (tác động ra ngoài). |
| — | `open-session-dialog` (DR:469) | `#open-session` | `workspace-runtime` | P4 | dialog form | không | `idempotencyKey` bắt buộc (sửa R5). |
| — | `skill-upload-dialog` (DR:1579) | `#open-skill-upload` | `skills` | P3 | dialog form | không | Zip tối đa 8 MiB, media type riêng. |
| — | `skill-editor-dialog` (DR:1554) | `#open-skill-editor` | `skills` | P3 | dialog form | không | |
| — | `skill-import-dialog` (DR:1494) | **không có opener** | — | — | markup chết (R15) | — | Không port. |

Dialog dùng chung (P2): `createModalController` DJ:91-113, `trapModalFocus`
DJ:82-89, `dismissOnBackdrop` DJ:125-134. Trong React, Radix Dialog đảm nhận
focus trap, `inert` và restore focus về invoker.

### 3.1 Bước xác nhận

Hành động có confirm (D1) ở legacy, React phải giữ: xoá global secret, secret
reference, environment, project; xoá artifact; revoke API key; ngắt kết nối
GitHub; gỡ TypeSafe; approve/reject privilege grant; approve/reject package
plan; rollback và remove package; đóng terminal; xoá worktree; chạy deploy;
cancel agent, task, session; đóng workspace; xoá file; xoá knowledge; xoá model
profile và credential; xoá spend limit; xoá MCP server. Danh sách nơi gọi ở
DJ:1952-3917 và DM:1236-1242.

Hành động chưa có confirm ở legacy, cần quyết định ở phase tương ứng: lease
renew, recover, MCP enable toggle, MCP OAuth disconnect, refresh tool, các thao
tác git nâng cao (checkout, merge, rebase: R12), "New session" khi PTY đang
chạy, cancel skill import, archive/disable skill hàng loạt, restore skill. Đề
xuất: git checkout/merge/rebase và "New session" khi đang chạy cần confirm ở P4.

## 4. Ma trận API (BFF) theo feature

Mọi endpoint nằm dưới `/dashboard/api/v1`. React **không viết lại API**: dùng
đúng các endpoint này, đúng body, fence và idempotency. Cột "#" trỏ tới bảng
endpoint đầy đủ của bản audit BFF (số thứ tự route trong router). Mặc định: GET
không cần CSRF; mọi POST/PUT/PATCH/DELETE cần `x-csrf-token`, cookie session và
Origin hợp lệ.

Ký hiệu fence: **gen** = `expectedGeneration` nguyên > 0, khớp chặt (strict);
**gen0** = tạo mới với `expectedGeneration: 0`; **sha** =
`expectedSha256`/`expectedContentSha256`/`expectedManifestSha256`; **idem** =
`idempotencyKey` bắt buộc; **digest** = `planDigest`.

Cột "Override" đánh dấu route mà handler spread `request.body` **sau** các key
lấy từ path, nên một body key trùng tên sẽ thắng (finding F1). React chỉ được
gửi body đúng schema, không gửi lại path id trong body. Việc sửa thứ tự spread
ở server là issue riêng.

### 4.1 Session, profile, server

| Method | Path | Owner | Fence | Feature | Phase | Ghi chú |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/session` | R-BFF:113, SESS:39-54 | — | `shell/session` | P2 | Mỗi lần gọi mint session mới (F10). Chỉ bootstrap một lần mỗi tab, rồi bootstrap lại khi 401. |
| GET | `/profile` | R-BFF:126 | — | `profile` | P3 | |
| GET | `/server` | R-BFF:144 | — | `shell`, `api-keys` | P2 | `managedOAuthUrl`, limits, version |
| PUT | `/preferences` | R-BFF:166 | schema strict | `shell/theme`, `profile` | P2 | Đặt cookie theme và display name |

### 4.2 Workspace, file, git, runtime, automation

| Method | Path | Owner | Fence / idem | Override | UI caller legacy | Feature | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/workspaces` | R-BFF:283 | cursor, limit ≤100 | — | có | `workspaces` | P3 |
| POST | `/workspaces` | R-BFF:287 | **idem** | — | **không (R4)** | `workspaces` | P4 |
| GET | `/workspaces/:id` | R-BFF:290 | — | — | có | `workspace-cockpit` | P3 |
| GET | `/workspaces/:id/context` | R-BFF:646 | — | — | có | `workspace-cockpit` | P3 |
| POST | `/workspaces/:id/close` | R-BFF:330 | **gen** | — | có, confirm | `workspace-cockpit` | P4 |
| POST | `/workspaces/:id/lease-renew` | R-BFF:655 | extensionSeconds 60..86400 | có | có, không confirm | `workspace-cockpit` | P3 |
| POST | `/workspaces/:id/recover` | R-BFF:662 | mode enum | có | có, không confirm | `workspace-cockpit` | P4 |
| POST | `/workspaces/:id/finalize` | R-BFF:669 | idem tuỳ chọn | có | có, dialog | `workspace-cockpit` | P4 |
| GET | `/workspaces/:id/files`, `/files/content` | R-BFF:301-304 | path, offset, limit | — | có | `workspace-files` | P4 |
| PUT/PATCH/DELETE | `/workspaces/:id/files/content` | R-BFF:307-309 | **sha** tuỳ chọn, 409 → D2 | có | có (delete có confirm) | `workspace-files` | P4 |
| POST | `/workspaces/:id/files/move`, `/files/directory` | R-BFF:310-311 | — | có | có | `workspace-files` | P4 |
| GET | `/workspaces/:id/git/status`, `/git/diff`, `/git/log`, `/worktrees` | R-BFF:379-398 | `staged`, limit ≤500 | — | có | `workspace-git` | P4 |
| POST | `/workspaces/:id/git/{fetch,pull,checkout,branch,merge,rebase}` | R-BFF:402-416 | — | có | có, **không confirm (R12)** | `workspace-git` | P4 |
| POST / DELETE | `/workspaces/:id/worktrees[/:name]` | R-BFF:417-418 | name regex | có (cả id và name) | có (remove có confirm) | `workspace-git` | P4 |
| GET | `/workspaces/:id/runtime` | R-BFF:313 | pageQuery | — | có | `workspace-runtime` | P3 |
| GET | `/workspaces/:id/tasks/graph`, `/tasks/:taskId` | R-BFF:531-535 | cursor | — | có | `workspace-runtime` | P3 |
| POST | `/workspaces/:id/tasks/:taskId/cancel` | R-BFF:543 | — | — | có, confirm | `workspace-runtime` | P4 |
| POST | `/workspaces/:id/sessions` | R-BFF:550 | **idem** | có | có (key sinh lại mỗi lần submit: R5) | `workspace-runtime` | P4 |
| GET | `/workspaces/:id/sessions/:sid/io` | R-BFF:559 | cursor, waitMs 0 | — | có | `workspace-runtime` | P4 |
| POST | `/workspaces/:id/sessions/:sid/close` | R-BFF:568 | — | — | có, confirm | `workspace-runtime` | P4 |
| GET | `/workspaces/:id/skills`, `/hooks`, `/deployments` | R-BFF:346-357 | — | — | có | `workspace-automation` | P3 |
| POST | `/workspaces/:id/skills/:name/run` | R-BFF:371 | **sha** + privilege grant | có | có | `workspace-automation` | P4 |
| POST | `/workspaces/:id/hooks/run` | R-BFF:372 | **sha** | có | có | `workspace-automation` | P4 |
| POST | `/workspaces/:id/hooks/{activate,deactivate}` | R-BFF:373-374 | `manifestSha256` | có | **không** | `workspace-automation` | P4 (quyết định có thêm UI không) |
| POST | `/workspaces/:id/deployments/run` | R-BFF:375 | timeoutMs ≤300000 | có | có, confirm | `workspace-deploy` | P4 |
| GET | `/workspaces/:id/artifacts`, `/activity` | R-BFF:470-485 | — | — | có | `workspace-cockpit` | P3 |

Lưu ý F3: `/workspaces/:id/artifacts` và `/activity` lấy 100 bản ghi toàn cục
rồi mới lọc theo workspace, nên có thể cắt bớt mà không báo. UI React không
được ghi "không có dữ liệu" một cách tuyệt đối.

### 4.3 Agent

| Method | Path | Owner | Fence / idem | Override | Feature | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/agents`, `/workspaces/:id/agents` | R-BFF:429, 460 | status enum, limit ≤100 | — | `agents` | P3 |
| GET | `/agents/:agentId`, `/agents/:agentId/logs` | R-BFF:500-507 | cursor | — | `agents` | P3 |
| POST | `/agents/:agentId/messages` | R-BFF:515 | **idem** (R5), message ≤65536 byte | có | `agents` | P3 |
| POST | `/agents/:agentId/cancel` | R-BFF:522 | reason ≤2000, có confirm | có | `agents` | P3 |

Idempotency (R5): React phải tạo key **một lần cho mỗi ý định** (lúc mở form
hoặc lúc nhập lần đầu) và giữ nguyên key khi retry sau lỗi mạng. Chỉ sinh key
mới sau khi request thành công.

### 4.4 Overview, metrics, activity

| Method | Path | Owner | Feature | Phase | Ghi chú |
| --- | --- | --- | --- | --- | --- |
| GET | `/overview` | R-BFF:579 | `overview` | P3 | Fan-out |
| GET | `/metrics?window=1h\|24h\|7d` | R-BFF:595 | `overview` | P3 | Giá trị khác trả 400 |
| GET | `/reliability` | R-BFF:610 | `overview` | P3 | Tối đa 6 runner call |
| GET | `/activity` | R-BFF:629 | `activity` | P3 | Fan-out |
| GET | `/audit` | C-BFF:145 | `audit`, `activity` | P3 | cursor, limit |

### 4.5 Project, environment, secret

| Method | Path | Owner | Fence | Override | Confirm | Feature | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET/POST | `/projects` | C-BFF:26-27 | POST: **gen0**, strict | — | — | `projects` | P3 |
| PATCH/DELETE | `/projects/:projectId` | C-BFF:28-29 | **gen** | — | delete | `projects` | P3 |
| GET/POST | `/projects/:id/environments` | C-BFF:30-31 | POST strict | — | — | `projects` | P3 |
| PATCH/DELETE | `/environments/:environmentId` | C-BFF:32-33 | **gen** | — | delete | `projects` | P3 |
| GET | `/environments/:id/secrets` | C-BFF:34 | — | — | — | `secrets` | P4 |
| POST | `/environments/:id/secrets[/bulk]` | C-BFF:35-36 | **gen0**; bulk 1..200 item | có | bulk xem trước trong D4 | `secrets` | P4 |
| PUT/PATCH/DELETE | `/environments/:id/secrets/:name` | C-BFF:37-39 | **gen** | có (id và name) | delete | `secrets` | P4 |
| GET/POST | `/secrets`, `/secrets/bulk` | C-BFF:40-42 | **gen0** | — | — | `secrets` | P4 |
| PUT/PATCH/DELETE | `/secrets/:name` | C-BFF:43-45 | **gen** | có | delete | `secrets` | P4 |

Value secret chỉ đi vào. Response chỉ có `secretKeys` cộng readiness
(RESP:269). Nút tải `.env.example` chỉ tạo tên và mô tả, value để trống, object
URL bị revoke ngay (DJ:1933-1949, 2007-2026).

### 4.6 Model, credential, spend

| Method | Path | Owner | Fence | Override | Feature | Phase | Ghi chú |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET/POST | `/provider-credentials` | C-BFF:46-47 | POST strict, có `apiKey` gửi vào | — | `models` | P4 | Response chỉ metadata |
| PUT | `/provider-credentials/:id/rotate` | C-BFF:48 | **gen** | path thắng | `models` | P4 | |
| DELETE | `/provider-credentials/:id` | C-BFF:49 | **gen**, confirm | — | `models` | P4 | |
| GET/POST | `/agent-model-profiles` | C-BFF:57, 120 | — | — | `models` | P4 | passthrough raw (F7) |
| POST | `/agent-model-profiles/validate` | C-BFF:122 | dry run | — | `models` | P4 | **chưa có UI caller** |
| PATCH | `/agent-model-profiles/:id` | C-BFF:123 | — | có | `models` | P4 | |
| POST | `/agent-model-profiles/:id/{activate,disable}` | C-BFF:124-125 | **gen**, không confirm | — | `models` | P4 | |
| DELETE | `/agent-model-profiles/:id` | C-BFF:126 | **gen**, confirm | — | `models` | P4 | |
| GET | `/agent-model-config-status`, `/model-providers`, `/model-catalog` | C-BFF:127-129 | — | — | `models` | P4 | combobox debounce 250 ms |
| POST | `/model-catalog/refresh`, `/model-connection/verify` | C-BFF:137, 143 | — | — | `models` | P4 | |
| GET/PUT | `/model-spend`, `/model-spend/policies` | C-BFF:139-141 | upsert theo scope + period | — | `models` | P4 | |
| DELETE | `/model-spend/policies/:id` | C-BFF:142 | **gen**, confirm | — | `models` | P4 | |
| GET | `/decision-plane/status` | C-BFF:144 | — | — | `models` | P4 | |

### 4.7 Skill

| Method | Path | Owner | Fence | Override | UI caller | Feature | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/skills`, `/skills/search`, `/skills/:id`, `/skills/:id/revisions[/:rev]`, `/skills/:id/diff`, `/skills/:id/usage` | C-BFF:60-75 | — | — | có | `skills` | P3 |
| GET | `/skill-sets[/:id]`, `/toolkit-registry`, `/toolkits` | C-BFF:76-81, R-BFF:199 | — | — | có | `skills`, `workspaces` | P3 |
| POST | `/skill-sets/preview`, `/toolkits/preview` | C-BFF:77, R-BFF:211 | — | — | preview có; **toolkits/preview không** | `skills` | P3 |
| POST | `/skill-imports` | C-BFF:85 | **gen0** | — | có | `skills` | P3 |
| GET | `/skill-imports/:jobId` | C-BFF:82 | — | — | poll T1 | `skills` | P3 |
| POST | `/skill-imports/:jobId/cancel` | C-BFF:86 | **gen** (legacy gửi cứng `1`: R9) | có | có | `skills` | P3 |
| POST | `/skill-archives` | C-BFF:95, SEC:50 | **gen0** cứng ở server; zip ≤8 MiB | — | có | `skills` | P3 |
| POST | `/skills`, `/skills/bulk`, `/skill-sets` | C-BFF:102-104 | **gen0** / gen | — | có | `skills` | P3 |
| PATCH | `/skills/:id` | C-BFF:99 | **gen** | có | **không** | `skills` | P3 (quyết định) |
| POST | `/skills/:id/archive` | C-BFF:100 | **gen** | có | **không** | `skills` | P3 (quyết định) |
| POST | `/skills/:id/restore`, `/skills/:id/revisions`, `/revisions/:rev/fork` | C-BFF:101-113 | gen / ≥0 / gen0 | có | có | `skills` | P3 |
| PATCH/DELETE | `/skill-sets/:id` | C-BFF:118-119 | **gen** | có | có | `skills` | P3 |

### 4.8 Artifact, knowledge

| Method | Path | Owner | Fence | Override | UI caller | Feature | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET/POST | `/artifacts` | C-BFF:146-147 | POST **gen0** strict | — | có | `artifacts` | P4 |
| GET | `/artifacts/:id`, `/artifacts/:id/download` | C-BFF:148, 157-199 | — | — | có | `artifacts` | P4 |
| POST | `/artifacts/:id/restore` | C-BFF:153 | path thắng | — | **không** | `artifacts` | P4 (quyết định) |
| DELETE | `/artifacts/:id` | C-BFF:200 | **gen**, confirm | — | có | `artifacts` | P4 |
| GET/POST | `/knowledge` | C-BFF:231, 242 | POST **gen0** | — | có | `knowledge` | P3 |
| GET/PUT/DELETE | `/knowledge/:id` | C-BFF:241-244 | PUT: revision, 409 → D8; DELETE **gen** | PUT có | có | `knowledge` | P3 |
| POST | `/knowledge/search` | C-BFF:245 | — (POST không side effect, vẫn cần CSRF) | — | có | `knowledge` | P3 |
| GET | `/knowledge-graph` | C-BFF:246 | — | — | có | `knowledge` | P3 |
| POST/DELETE | `/knowledge/links` | C-BFF:253-254 | gen0 / gen tuỳ chọn | — | **không** (R15) | `knowledge` | P3 (quyết định) |

### 4.9 GitHub, integration credential, approval, package

| Method | Path | Owner | Fence | UI caller | Feature | Phase | Ghi chú |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/github` | C-BFF:201 | — | có | `integrations` | P4 | |
| POST | `/github/setup` | C-BFF:202 | strict | có | `integrations` | P4 | Trả `url`, `state` một lần. Điều hướng native tới GitHub. |
| POST | `/github/complete` | C-BFF:203 | strict `state`, `installationId` | có (callback) | `integrations` | P4 | Xoá query bằng `replaceState` sau khi xong |
| POST | `/github/reconcile` | C-BFF:204 | — | có | `integrations` | P4 | |
| POST | `/github/disconnect` | C-BFF:206 | body `{installationId}`, confirm | có | `integrations` | P4 | |
| DELETE | `/github/installations/:id` | C-BFF:205 | — | **không** (trùng với dòng trên) | — | — | Không port; chọn một dạng |
| GET/POST | `/integration-credentials` | C-BFF:52-53 | **gen0**, value gửi vào | có | `integrations` | P4 | write-only |
| PUT/DELETE | `/integration-credentials/:id[/rotate]` | C-BFF:54-55 | **gen** | có | `integrations` | P4 | |
| GET | `/typesafe/status` | C-BFF:56 | — | có | `settings`, `integrations` | P4 | |
| GET | `/privilege-grants` | C-BFF:207 | — | có | `approvals`, `overview` | P3 | |
| POST | `/privilege-grants/:id/{approve,reject}` | C-BFF:208-209 | confirm | có | `approvals` | P4 | |
| GET | `/packages`, `/package-plans` | C-BFF:211-212 | — | có | `packages`, `approvals` | P4 | |
| POST | `/package-plans/:id/approve` | C-BFF:213 | **digest** khớp giá trị đang hiển thị, confirm | có | `packages` | P4 | |
| POST | `/package-plans/:id/reject` | C-BFF:216 | confirm | có | `packages` | P4 | |
| POST | `/packages/rollback`, `/packages/remove` | C-BFF:217-218 | schema parse, confirm | có | `packages` | P4 | |

### 4.10 API key, event subscription, settings

| Method | Path | Owner | Fence | UI caller | Feature | Phase | Ghi chú |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api-keys` | C-BFF:219 | — | có | `api-keys` | P4 | |
| POST | `/api-keys` | C-BFF:220 | strict name, expiresInDays; 503 khi tắt | có | `api-keys` | P4 | **`data.apiKey` plaintext một lần** → D3 |
| DELETE | `/api-keys/:keyId` | C-BFF:223 | **gen**, confirm | có | `api-keys` | P4 | |
| GET | `/event-subscriptions` | C-BFF:227 | — | có | `api-keys` | P4 | 503 khi tắt events |
| POST | `/event-subscriptions/:id/revoke` | C-BFF:228 | — | **không** | `api-keys` | P4 (quyết định) | |
| GET/POST | `/settings` | R-BFF:223-235 | schema parse | có | `settings` | P3 | passthrough raw (F7) |
| GET/POST | `/settings/oauth` | R-BFF:247-259 | schema parse | có | `settings` | P3 | |
| POST | `/settings/network-check` | R-BFF:271 | — | có | `settings` | P3 | |

### 4.11 MCP server, gateway, OAuth hạ nguồn

| Method | Path | Owner | Fence | Override | Feature | Phase | Ghi chú |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET/POST | `/mcp-servers` | C-BFF:255-256 | POST: SSRF guard ở server | — | `mcp-servers` | P4 | Từ chối SSE kèm header secretRef |
| GET/PATCH/DELETE | `/mcp-servers/:id` | C-BFF:257-259 | DELETE **gen**, confirm | PATCH có | `mcp-servers` | P4 | |
| POST | `/mcp-servers/:id/enabled` | C-BFF:260 | không confirm | có | `mcp-servers` | P4 | |
| PUT | `/mcp-servers/:id/permissions` | C-BFF:262 | chỉ nhận permissionDefault, tools, gen | — | `mcp-servers` | P4 | |
| GET | `/mcp-servers/:id/logs` | C-BFF:271 | cursor | — | `mcp-servers` | P4 | |
| POST | `/mcp-servers/:id/{test,refresh}` | G-BFF:68-69 | — | — | `mcp-servers` | P4 | Gọi MCP hạ nguồn |
| GET | `/mcp-gateway` | G-BFF:71 | — | — | `mcp-servers` | P4 | URL công khai lấy từ Host trong allowlist |
| GET | `/mcp-servers/:id/oauth` | G-BFF:94 | — | — | `mcp-servers` | P4 | |
| POST | `/mcp-servers/:id/oauth/start` | G-BFF:103 | — | — | `mcp-servers` | P4 | Trả `authorizationUrl` (có state và PKCE challenge, không có verifier). Điều hướng native. |
| POST | `/mcp-servers/:id/oauth/disconnect` | G-BFF:114 | không confirm | — | `mcp-servers` | P4 | |
| GET | `/dashboard/mcp-oauth/callback` (ngoài `/api/v1`) | G-BFF:129 | `state` một lần | — | server | giữ nguyên | 303 về `/dashboard/mcp-servers/<id>?oauth=connected\|error&reason=`. HEAD cũng chạy handler này (F11). |

### 4.12 Terminal

| Method | Path | Owner | Body | Feature | Phase |
| --- | --- | --- | --- | --- | --- |
| GET | `/terminals`, `/workspaces/:id/terminals` | T-BFF:68-69 | — | `terminal` | P4 |
| POST | `/workspaces/:id/terminals` | T-BFF:72 | strict `{cwd?, cols?, rows?}` | `terminal` | P4 |
| POST | `/workspaces/:id/terminals/:tid/input` | T-BFF:75 | strict `{data}` (base64, chunk ≤16 KiB) | `terminal` | P4 |
| POST | `/workspaces/:id/terminals/:tid/resize` | T-BFF:78 | strict `{cols, rows}` | `terminal` | P4 |
| POST | `/workspaces/:id/terminals/:tid/close` | T-BFF:81 | strict `{}` | `terminal` | P4 |
| GET | `/workspaces/:id/terminals/:tid/output` | T-BFF:88 | cursor, waitMs ≤ min(25000, REQUEST_TIMEOUT_MS-5000) | `terminal` | P4 |

Body terminal là strict nên không thể ghi đè path id (T-BFF:29-33).

### 4.13 Route BFF chưa có UI caller

`POST /workspaces` (R4), `POST /toolkits/preview`,
`POST /agent-model-profiles/validate`, `POST /artifacts/:id/restore`,
`DELETE /github/installations/:id`, `POST /event-subscriptions/:id/revoke`,
`POST /workspaces/:id/hooks/{activate,deactivate}`,
`POST|DELETE /knowledge/links`, `PATCH /skills/:id`,
`POST /skills/:id/archive`. Mỗi phase quyết định cho route thuộc phạm vi của
mình: thêm UI (phải có test), hoặc ghi lý do không thêm. Không xoá route BFF
trong epic này.

## 5. Phím tắt

| Phím | Phạm vi | Hành động | Owner legacy | Phase |
| --- | --- | --- | --- | --- |
| Ctrl/Cmd+K | toàn trang, **bỏ qua khi focus trong terminal** | Mở/đóng palette | DJ:4022-4029, 790-796 | P2 |
| ↑ ↓ Home End Enter Esc | input palette | di chuyển, chọn, đóng | DJ:3997-4008 | P2 |
| Esc | modal, drawer, `<details>` cockpit | đóng, trả focus | DJ:94, 4033-4038 | P2 |
| Tab / Shift+Tab | modal | focus trap | DJ:82-89 | P2 (Radix) |
| Ctrl/Cmd+S | editor knowledge | lưu, chặn save của trình duyệt | DJ:2861-2865 | P3 |
| Enter / Space | node đồ thị knowledge | mở node | DJ:2933-2937 | P3 |
| Ctrl+Shift+F6 | trong terminal | nhả focus khỏi xterm, phím không gửi vào shell | DT:438-447 | P4 |
| ↑ ↓ Enter Esc Tab | combobox model trong wizard | điều hướng, chọn, đóng | DM:564-576 | P4 |

Thuộc tính `aria-keyshortcuts="Meta+K Control+K"` trên nút palette (HTML:19)
phải giữ. Khi focus nằm trong terminal, không phím tắt toàn cục nào được chạy.

## 6. Polling và timer

Legacy không có `setInterval`. Tất cả là chuỗi `setTimeout` hoặc long-poll.
React gán mỗi poller cho đúng một owner (Query `refetchInterval` hoặc một
controller duy nhất) và dừng nó khi route unmount.

| # | Owner legacy | Cơ chế | Giới hạn | Lỗi legacy | Tương đương React | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Skill import (DJ:578-607) | `setTimeout` 1500 ms | tối đa 40 lần | không bao giờ stop khi điều hướng (R7) | Query `refetchInterval`, dừng ở trạng thái kết thúc, dừng khi unmount | P3 |
| T2 | Đọc output terminal (DT:126-171) | long-poll `waitMs` 25 s; trả rỗng nhanh thì chờ 1 s; backoff `min(15 s, 500 ms·2^(n-1))`, tối đa 8 lần | 1 slot đồng thời | — | Controller terminal riêng, sống ngoài route | P4 |
| T3 | Bơm input terminal (DT:173-202) | queue có thứ tự, retry 6 lần `min(4 s, 250 ms·2^(n-1))`, 429 thì bỏ queue | — | — | như legacy | P4 |
| T4 | Resize terminal (DT:450-458) | ResizeObserver, debounce 150 ms | bỏ qua kích thước không đổi | — | như legacy | P4 |
| T5 | Theme terminal (DT:460-465) | MutationObserver trên `data-theme` | — | — | đọc token theme | P4 |
| T7 | Cache index palette (DJ:896-947) | 60 s | invalidate khi announce và `pagehide` | — | Query `staleTime` 60 s | P2 |
| T8-T10 | Debounce: combobox 250 ms, preview knowledge 200 ms, tìm skill 300 ms | — | — | — | giữ giá trị | P3/P4 |
| T11-T13 | Toast 4200 ms, cue cập nhật 900 ms, chip copy 2000 ms | — | — | — | giữ giá trị (Motion chỉ cho dialog và toast) | P2 |
| T15 | Badge approvals | chỉ cập nhật khi tải Overview, Activity, Approvals | — | badge cũ (R13) | invalidate sau approve/reject và khi focus cửa sổ | P3 |

Ngân sách: mỗi Access subject có 120 request/phút và 8 request đồng thời trên
`/api/v1` (F6). Một tab có terminal đang mở dùng 1 slot liên tục. Route fan-out
(`/agents` không có `workspaceId`, `/overview`, `/activity`) có thể tốn tới
khoảng 100 runner call. P3 phải đo số request khi chuyển trang và không được
vượt baseline legacy.

## 7. Vòng đời terminal

Owner: DT (`createTerminalSession` 101-267, `mountTerminalPane` 391-527). Phase
P4, feature `terminal`.

| Hạng mục | Legacy | Yêu cầu React |
| --- | --- | --- |
| PTY runner khi điều hướng / Refresh / popstate | Sống tiếp (không gọi close) | Sống tiếp. Không có route change nào gọi close. |
| View xterm | Bị dispose mỗi lần `load()` (DJ:1217-1220); Refresh xoá view (R2) | Controller terminal sống ở cấp app; view gắn lại khi quay lại route mà không phải reattach thủ công. |
| Reattach | Phát lại từ cursor `0` theo buffer runner (DT:225-231) | Giữ `nextCursor` theo terminal để không phát lại khi view còn sống; vẫn hỗ trợ phát lại từ `0`. |
| Race dispose khi open đang chạy | Trả về sớm, PTY mồ côi tới khi hết idle (R8) | Nếu đã dispose sau khi open thành công thì gọi close ngay. |
| Trạng thái | `idle, connecting, running, exited, closed, timed_out, failed, error, lost` (DT:27); `lost` = 404/410 | Giữ nguyên tập trạng thái và copy (`TERMINAL_WORKSPACE_ENDED_MESSAGE` DT:22). |
| Mở terminal | Vào tab không tự mở shell (DJ:3410-3413) | Giữ nguyên. |
| "New session" | Đóng PTY đang chạy mà không hỏi | Hỏi xác nhận khi đang chạy. |
| Asset | `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0 qua vendor map của ASSETS (32-37), `accessSync` khi khởi động | Bundle bằng Vite dưới dạng chunk lazy (≤150 KB gzip theo ADR). Có thể bỏ vendor map sau cutover. |
| CSP adapter | Monkey-patch `document.createElement` và `Element.prototype.setAttribute` (DT:278-312, R14) | Không monkey-patch toàn cục. Dùng constructed stylesheet có phạm vi hẹp, hoặc chứng minh xterm 6 không tiêm `<style>`. Phải có test CSP. |

## 8. Reveal một lần và dữ liệu nhạy cảm trên client

| Dữ liệu | Nơi xuất hiện | Quy tắc xoá ở legacy | Yêu cầu React (E2E ở P4) |
| --- | --- | --- | --- |
| API key plaintext (`data.apiKey`) | D3, `#api-key-secret` readonly; biến JS `apiKey` | dismiss, Esc, mọi lần bấm link (capture), `pagehide`, copy lỗi (DJ:239-270, 4060, 4066) | Chỉ trong state component. Không vào Query cache, devtools dump, console, screenshot. Xoá khi điều hướng, dismiss, hết session. |
| Provider key, value secret, integration credential | input password hoặc textarea trong form | xoá khi đóng; xoá khỏi DOM trước request (DJ:2114) | RHF state reset khi đóng; không lưu draft; không localStorage. |
| `.env` bulk import | D4 textarea | mọi cách đóng đều xoá | như legacy |
| CSRF token | biến module (DA:1-2) | xoá khi 401 | chỉ bộ nhớ |
| GitHub setup `state`, OAuth `authorizationUrl` | response JSON → điều hướng | không lưu | không lưu; điều hướng native |
| Query `?oauth=`, `?state=&installation_id=` | URL | `replaceState` sau khi xử lý | xoá search param sau khi xử lý |
| Clipboard | copy API key, copy draft knowledge, copy conflict file, chip `data-copy` | — | giữ hành vi, có thông báo cho screen reader |

localStorage (cho phép theo ADR) chỉ chứa tuỳ chọn không bí mật và trạng thái
khôi phục UI. Không bao giờ chứa token, key, value secret, nội dung file hay
draft secret.

## 9. Test gắn markup cần thay bằng test hành vi

Lớp (c) sẽ gãy ngay khi markup đổi. Các test này **không được xoá trước khi
test thay thế đã land** trong cùng phase. Các assertion đang là guard CSP/XSS
duy nhất (`not.toContain('<script>')`, `not.toMatch(/\sstyle=/)`, payload
`<img src=x`) phải chuyển thành kiểm tra runtime, không được bỏ.

| Vị trí | Assertion hiện tại | Hành vi mà nó đại diện | Test thay thế | Phase |
| --- | --- | --- | --- | --- |
| `apps/api/test/dashboard-ui-contract.test.ts:106-182` | CSS/HTML chứa selector, token, `@media`, landmark id | Landmark, focus vào `main`, reduced motion, breakpoint | Playwright: `getByRole` landmark, tab vào `main`, emulate `prefers-reduced-motion` rồi kiểm computed `transition-duration` | P2 |
| `dashboard-ui-contract.test.ts:160` | không có hex trong CSS | Chỉ dùng design token | Lint token (stylelint hoặc test trên `tokens.css`) | P1/P2 |
| `dashboard-ui-contract.test.ts:170, 172` | không `style=`, không `setAttribute('style')` | CSP: không inline style | Playwright: sau khi render mọi route, không phần tử nào có attribute `style` từ markup; lắng nghe `securitypolicyviolation` = 0 | P2 |
| `dashboard-ui-contract.test.ts:175-176` | link artifact nằm dưới `/dashboard/api/v1/artifacts/` | Download giữ prefix dashboard | Playwright: bấm download, kiểm URL request | P4 |
| `dashboard-ui-contract.test.ts:182` | chỉ có ba `.style.transform` | Chỉ transform qua CSSOM | Bỏ (React `style` prop là CSSOM); giữ kiểm tra CSP violation | P2 |
| `dashboard-ui-contract.test.ts:145-148` | `dataset.saveState = 'saved'` | Feedback lưu: saving → saved | Playwright: submit, kiểm `data-save-state` hoặc trạng thái theo role | P3 |
| `apps/api/test/dashboard-design-tokens.test.ts:18-19, 47, 163-177` | parse `dashboard.css`, hai block light giống hệt | Token light/dark nhất quán | So sánh computed custom property dưới `data-theme=light` và system light | P2 |
| `dashboard-design-tokens.test.ts:237-323` | WCAG AA tính từ text CSS | Chữ đọc được ở cả hai theme | axe-core trong Playwright cho mỗi theme | P2 |
| `apps/api/test/dashboard-pages.test.ts:123-135` | HTML không chứa `<p class="nav-group">`, có `<div id="sidebar-nav">`, `<title>` | Nav sinh từ registry | Playwright: nhãn nav bằng route registry; `document.title` sau điều hướng | P2 |
| `dashboard-pages.test.ts:140-151` | script chứa `PALETTE_PAGE_COMMANDS`, `PAGE_LOADERS[page.id]` | Route đi qua registry | Điều hướng từng route, kiểm trang đúng được render; test unit route tree = shell paths | P2 |
| `apps/api/test/dashboard-resource-page.test.ts:14-24` | có `id="open-add-profile-btn"`, `accent-btn`, `data-dialog` | Mỗi trang một primary action | Playwright: đếm button primary theo trang | P3 |
| `dashboard-resource-page.test.ts:35-61` | `<dialog>` có `aria-labelledby`, `aria-describedby`, `data-copy` được escape | Dialog có nhãn và mô tả; chip copy escape id | `getByRole('dialog', {name})`; chip copy ghi đúng giá trị vào clipboard; payload id độc hại không thực thi | P2 |
| `dashboard-resource-page.test.ts:84-104` | source chứa `pushState`, `popstate`, `setNavigationSignal` | Điều hướng trong cùng document, không reload | Playwright: đặt `window.__marker`, bấm nav, marker vẫn còn | P2 |
| `apps/api/test/dashboard-models-wizard.test.ts:430, 439, 529, 569-622` | `innerHTML` chứa `role="option" aria-selected="true"`, `<span class="status stale">` | Ngữ nghĩa combobox, text trạng thái | `getByRole('option', {selected: true})`, trạng thái theo role hoặc label | P4 |
| `dashboard-models-wizard.test.ts:648-692` | regex cắt `index.html` lấy `<dialog id="model-profile-dialog">` | Wizard tồn tại và được nối | Playwright: mở dialog, đi hết wizard | P4 |
| `apps/api/test/dashboard-models-spend.test.ts:110-236` | `data-price-provenance`, `<th>Settled</th>`, `<label for>` | Nguồn giá và nhãn spend | Text hiển thị "Catalog price", "Custom price (override)" theo role/text | P4 |
| `apps/api/test/dashboard-skills-ui.test.ts:74-111` | skeleton chứa `id="skills-library-table"` | Mỗi vùng tồn tại | `getByRole('table', {name})`, text empty state | P3 |
| `dashboard-skills-ui.test.ts:163, 297` | không `<script>` trong output | XSS: escape dữ liệu skill | Giữ dưới dạng test render React với payload độc hại + kiểm không có CSP violation | P3 |
| `apps/api/test/dashboard-ui-behavior.test.ts:297-309, 363-365, 768-770` | `data-href`, `id="save-display-name"`, class form rotate | Form tồn tại và link đúng | Playwright: bấm link settings kiểm URL; nhập display name rồi lưu | P3/P4 |
| `apps/api/test/dashboard-activity.test.ts:64-65, 88, 94` | class `accent-btn approve-grant`, `status ${tone}` | Nút approve/reject có tone | `getByRole('button', {name: 'Approve'})` | P4 |
| `apps/api/test/dashboard-agents.test.ts:82-102` | id filter, `<option selected>`, id form message, id cancel | Filter và hành động chi tiết | Đổi filter thì URL và danh sách đổi; bấm cancel có confirm | P3 |
| `apps/api/test/dashboard-analytics.test.ts:10-18` | `<svg class="chart chart-bars">`, `<caption>`, không `style=` | Chart có bảng thay thế truy cập được | `getByRole('table')` theo caption; không CSP violation | P3 |
| `apps/api/test/dashboard-agent-series.test.ts:76-86` | class chart, `<th>Failed / limit</th>` | Dữ liệu thể hiện bằng chữ, không chỉ bằng màu | Text "Failed / limit" hiển thị | P3 |
| `apps/api/test/dashboard-terminal.test.ts:330-371` | `id="terminal-close" disabled`, `<kbd>Ctrl+Shift+F6</kbd>` | Nút close bị disable khi chưa có terminal; có gợi ý phím | Close disabled khi trống; Ctrl+Shift+F6 chuyển focus ra ngoài | P4 |
| `dashboard-terminal.test.ts:423-440` | chuỗi CSS trên stylesheet giả | CSP adapter hoạt động | Playwright: mở terminal, `securitypolicyviolation` = 0, xterm render | P4 |
| `apps/api/test/dashboard-typesafe.test.ts:194-223` | `id="typesafe-remove"` có/không, `<dt>Egress</dt><dd>Off</dd>` | Nút gỡ chỉ hiện khi đã cấu hình | Hiển thị theo trạng thái | P4 |
| `apps/api/test/dashboard-oauth-settings.test.ts:38-91` | checkbox `checked`, `<option value="604800" selected>` | Giá trị mặc định và trạng thái disable của form | Chọn preset, kiểm giá trị phản ánh | P3 |
| `apps/api/test/dashboard-router.test.ts:874-878` | id control trong markup settings | Trang settings có nút save/reset/check | Giữ assertion payload (a); thay check id bằng smoke Playwright | P3 |
| `apps/api/test/dashboard-app-mount.test.ts:153-154` | HTML chứa `/dashboard/assets/${v}/dashboard.css` | URL asset có version | Test HTTP: lấy URL asset từ shell theo manifest, GET trả 200 và `immutable` | P1 |
| `dashboard-app-mount.test.ts:172-175` | source `app.ts` khớp chuỗi thứ tự middleware | Ngân sách request dành cho API, không cho pre-auth | Test HTTP: vượt ngân sách trên `/dashboard/api/v1` thì 429, đường pre-auth không bị ảnh hưởng | P1 |
| `apps/api/test/knowledge-dashboard-ui.test.ts:26-57` | output markdown bằng chuỗi tag chính xác | Markdown render an toàn | Giữ một assertion escape và kiểm không `style` (chuyển sang test bảo mật); thay so khớp chuỗi bằng parse DOM và kiểm text/role | P3 |
| `apps/api/test/mcp-servers-dashboard-ui.test.ts:108-139` | `<code class="mono">`, `data-copy="https://…"` | Card gateway và chip copy | Nút copy ghi endpoint; text hiển thị. Giữ `expectCspSafe` (89-91) | P4 |

### 9.1 Test lớp (b) cần port sang Playwright

| Suite | Số test | Phase | Ghi chú |
| --- | --- | --- | --- |
| `dashboard-activity` | 8 | P3/P4 | |
| `dashboard-agents` | 8 | P3 | |
| `dashboard-agent-series` | 8 | P3 | |
| `dashboard-analytics` | 9 | P3 | |
| `dashboard-automation` | 6 | P4 | |
| `dashboard-runtime` | 7 | P3 | |
| `dashboard-lifecycle-settings` | 7 | P3 | Logic parse input có thể giữ làm unit test thuần |
| `dashboard-oauth-settings` | 6 | P3 | |
| `dashboard-models-spend` | 27 | P4 | Phép tính USD giữ làm unit test |
| `dashboard-models-wizard` | 46 | P4 | Luật wizard giữ làm unit test; phần combobox chuyển sang Playwright |
| `dashboard-resource-page` | 10 | P2/P3 | |
| `dashboard-ui-behavior` | 42 | P2-P4 | Modal, palette, theme, backdrop, callback GitHub, escape |
| `dashboard-skills-ui` | 51 | P3 | |
| `dashboard-terminal` | 29 | P4 | Helper byte và protocol controller giữ làm unit test |
| `dashboard-typesafe` | 13 | P4 | phần (a) giữ nguyên |
| `dashboard-git` | 9 | P4 | parser git (a) giữ nguyên |
| `dashboard-cockpit` | 9 | P3 | |

Harness `apps/api/test/dashboard-test-dom.ts` được bốn suite dùng. Harness
`apps/api/test/dashboard-tree-dom.ts` hiện không có file nào import (cần xác
nhận trước khi xoá). Cả hai bị xoá cùng các suite legacy ở P6, không xoá sớm
hơn.

### 9.2 Test lớp (a) giữ nguyên, không sửa trong P1-P5

`dashboard-router`, `dashboard-session`, `dashboard-mcp-gateway-api`,
`dashboard-models-router`, `dashboard-terminal-router`, `dashboard-packages`,
`dashboard-privilege-grants`, `dashboard-response-totality`,
`dashboard-github-error-message`, `dashboard-audit-gaps`,
`dashboard-skills-mapper`, `dashboard-overview` (phần projection),
`access-auth`, `mcp-oauth`, `knowledge-api`, `runner-client-internal`,
`apps/api-key-gateway/test/gateway.test.ts`,
`test/upgrade-nginx-routes.test.ts`, các suite integration dashboard trong
`test/integration/`, `apps/runner/test/dashboard-control-service.test.ts` và
các test contract trong `packages/contracts/test/`.
`dashboard-app-mount` (phần HTTP và version) cũng giữ; chỉ các dòng (c) ở mục 9
được thay.

Hiện chưa có test trình duyệt nào cho dashboard (`test/e2e/` chỉ có test
Docker). P1 dựng Playwright + axe; mọi test thay thế ở trên chạy trên đó.

## 10. Lỗi legacy đã biết

Đây là lỗi tìm được khi đọc code, chưa xác nhận trên trình duyệt. React không
được sao chép các lỗi này. Lỗi cần sửa trên legacy trước cutover phải tách
thành issue riêng (không mở rộng PR của epic).

| ID | Mức | Lỗi | Owner | Xử lý trong React | Đề xuất issue riêng cho legacy |
| --- | --- | --- | --- | --- | --- |
| R4 | cao | Dialog launch workspace là UI chết: không handler submit và cancel; form không có `method`/`action` nên submit có thể thành GET kèm field trên query string | HTML:87-113, DJ:4068-4118 | Viết thật trên `POST /workspaces` (idem) | Có: sửa hoặc ẩn nút, cần xác nhận trên trình duyệt |
| R1 | trung bình-cao | Filter workspace điều hướng tới `/dashboard?q=` (Overview) và bỏ qua `q`/`status`; `#clear-filters` cũng vậy | DJ:3922, 1855 | Filter là search param của `/dashboard/workspaces` | Có |
| R5 | trung bình | Idempotency key sinh lại mỗi lần submit (agent message, session) | DJ:3795-3800, 3870-3874 | Key theo ý định, giữ qua retry | Tuỳ chọn |
| R7 | trung bình | Poller import skill không dừng khi điều hướng; rejection không được xử lý | DJ:1608-1618, 64 | Poller do Query sở hữu | Tuỳ chọn |
| R8 | trung bình | PTY mồ côi khi dispose trong lúc open | DT:211-212 | Close ngay nếu đã dispose | Tuỳ chọn |
| R2 | thấp-trung bình | Refresh xoá view terminal | DJ:3923, 1217-1220 | Terminal sống ở cấp app | Không |
| R9 | thấp-trung bình | Cancel import gửi cứng `expectedGeneration: 1` | DJ:1635 | Đọc generation từ job | Tuỳ chọn |
| R10 | thấp-trung bình | Không có guard form bẩn; "Load server version" bỏ draft knowledge chỉ với một cú bấm | DJ:2821-2833, 2846-2911 | Chặn điều hướng khi form bẩn (không áp dụng cho form secret: secret không giữ draft) | Không |
| R6 | thấp | Dialog MCP giữ giá trị đã nhập sau khi đóng; header value không được che | DJ:3179-3181, 3060-3066 | Reset khi đóng; ô che | Tuỳ chọn |
| R11 | thấp | Listener `once` bị chồng trên dialog conflict file | DJ:3891 | Radix Dialog | Không |
| R12 | thấp | Git checkout/merge/rebase và action `start` không confirm | DJ:3579-3580 | Thêm confirm | Không |
| R13 | thấp | Badge approvals cũ | DJ:3735-3751 | Invalidate Query | Không |
| R14 | info | Monkey-patch DOM toàn cục cho CSP adapter terminal | DT:278-312 | Không monkey-patch | Không |
| R15 | info | Code chết: `skill-import-dialog`, `createKnowledgeLink`/`deleteKnowledgeLink`, bảng redirect phía client | DR:1494, DA:91-92, DP:281-285 | Không port | Không |
| R16 | info | Tab chi tiết MCP, sub-view Runtime và tab Skills không nằm trong URL | DJ:3002-3024 | Đưa vào search param | Không |

Finding phía BFF (không thuộc phạm vi UI; tách issue nếu cần):

| ID | Mức | Finding | Owner |
| --- | --- | --- | --- |
| F1 | trung bình | Khoảng 40 route spread body sau path param, nên body thắng path id (vẫn trong phạm vi principal) | R-BFF, C-BFF (xem cột Override ở mục 4) |
| F2 | thấp-trung bình | JSON lỗi trả 500 thay vì 400 và không log | R-BFF:676-686 |
| F3 | thấp | Projection artifact/activity theo workspace bị cắt ở 100 bản ghi mà không báo | R-BFF:470-498 |
| F4 | thấp | Download artifact giữ toàn bộ file trong bộ nhớ | C-BFF:157-199 |
| F7 | info | Response chưa map đi thẳng ra trình duyệt (settings, oauth settings, `model_*`, `toolkits_*`); comment ở C-BFF:311-313 mô tả sai hành vi | RESP:651 |
| F10 | info | `GET /session` mint session mới mỗi lần và không revoke session cũ; LRU 1000 dùng chung | SESS |
| F11 | info | HEAD chạy handler callback OAuth và tiêu thụ `state` một lần | G-BFF:129 |

## 11. Thay đổi phía server mà React cần (P1)

Chi tiết nằm trong [P1](../plans/261020-1224-dashboard-2-react-dewee/child-issues/p1-scaffold-build-canary.md).
Phần này chỉ liệt kê điểm chạm:

- `ASSETS`: allowlist 7 tên cố định (11-19) và route `/assets/:version/:asset`
  một segment (133-139) phải đọc từ manifest Vite; chặn `..` và dotfile; shell
  phải sinh ra trước khi API khởi động (đọc bằng `readFileSync` lúc load
  module, dòng 9).
- `ASSETS`: thêm fallback shell sau route API và asset, giữ `no-store`.
- `SEC`: chỉ thêm `font-src 'self'`.
- `docker/api.Dockerfile` (9, 22-24): copy output build thay vì
  `apps/api/dashboard`.
- Cờ `CLOUD_HARNESS_DASHBOARD_UI=legacy|react` và cookie canary `?ui=react`
  (HttpOnly) chọn shell. Rollback bằng cách đặt `legacy` rồi restart `api`.
- Nginx (`deploy/nginx/cloud-harness-mcp.conf` 87-105) và
  `deploy/scripts/upgrade-nginx-dashboard.sh` không cần đổi nếu giữ nguyên
  prefix `/dashboard/`.

## 12. Theo dõi

| Phase | Mục trong ma trận | Người duyệt |
| --- | --- | --- |
| P1 | mục 1, 11; dòng P1 ở mục 9 | owner |
| P2 | D1, D11; mục 2.2, 5 (toàn cục), 6 (T7, T11-T13); dòng P2 ở mục 9 | owner |
| P3 | dòng P3 ở mục 2, 3, 4, 6, 9 | owner |
| P4 | dòng P4 ở mục 2, 3, 4, 6, 7, 8, 9 | owner + review bảo mật |
| P5 | Dewee (xem ADR); không đổi dòng nào trong ma trận | owner + review bảo mật |
| P6 | xoá legacy, harness DOM giả và các suite (b)/(c) đã có bản thay thế | owner |
