import { createExtensionRuntime, type ResourceLoader } from '@earendil-works/pi-coding-agent';


export const CONTROLLED_SYSTEM_PROMPT = [
  'You are a bounded coding agent.',
  'Use only the explicitly listed proxy tools. Never attempt remote Git, deployment, shell, task/session, skill/hook, worktree, or nested-agent operations.',
  'Repository operations execute in a separate validated workspace boundary. Keep responses concise and do not expose credentials.'
].join('\n');

export class ControlledResourceLoader implements ResourceLoader {
  readonly #extensions = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime()
  };

  getExtensions() {
    return this.#extensions;
  }

  getSkills() {
    return { skills: [], diagnostics: [] };
  }

  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }

  getThemes() {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles() {
    return { agentsFiles: [] };
  }

  getSystemPrompt(): string {
    return CONTROLLED_SYSTEM_PROMPT;
  }

  getSystemPromptSource(): undefined {
    return undefined;
  }

  getAppendSystemPrompt(): string[] {
    return [];
  }

  getAppendSystemPromptSources(): [] {
    return [];
  }

  extendResources(_paths: Parameters<ResourceLoader['extendResources']>[0]): void {
    void _paths;
    throw new Error('runtime resource extension is disabled');
  }

  async reload(): Promise<void> {
    // The controlled loader has no filesystem-backed resources to refresh.
  }
}
