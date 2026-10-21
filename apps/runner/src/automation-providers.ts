import type { AutomationProvider } from '@cloud-harness/contracts';
import type { ProviderAdapter } from './automation-adapter.js';
import { customAdapter } from './automation-custom.js';
import { githubAdapter } from './automation-github.js';
import { jiraAdapter } from './automation-jira.js';
import { linearAdapter } from './automation-linear.js';

// The adapter contract lives in its own module so adapters import it without importing this
// registry back (a cycle would leave an adapter uninitialized when its module loads first).
export type * from './automation-adapter.js';

export type AutomationProviderRegistry = Readonly<Partial<Record<AutomationProvider, ProviderAdapter>>>;

/**
 * Every automation provider this runner accepts, keyed by provider. Adding a provider is one
 * import and one entry here. A provider without an entry is refused: creating a connection or a
 * rule for it answers INVALID_INPUT, and its webhooks get the shared UNAUTHORIZED.
 */
export const AUTOMATION_PROVIDER_ADAPTERS: AutomationProviderRegistry = {
  github: githubAdapter,
  linear: linearAdapter,
  jira: jiraAdapter,
  custom: customAdapter
};
