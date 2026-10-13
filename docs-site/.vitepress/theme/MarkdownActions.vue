<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vitepress';

const route = useRoute();
const isOpen = ref(false);
const copiedState = ref<'idle' | 'markdown' | 'url'>('idle');
const dropdownRef = ref<HTMLElement | null>(null);

const mdPath = computed(() => {
  let p = route.path.replace(/\.html$/, '');
  if (p.endsWith('/')) p += 'index';
  return p.startsWith('/') ? `${p}.md` : `/${p}.md`;
});

const fullMdUrl = computed(() => {
  if (typeof window === 'undefined') return `https://docs.harness.agentkit.best${mdPath.value}`;
  return `${window.location.origin}${mdPath.value}`;
});

async function getRawMarkdown(): Promise<string> {
  try {
    const res = await fetch(mdPath.value);
    if (res.ok) {
      return await res.text();
    }
  } catch (err) {
    console.warn('Could not fetch markdown twin directly:', err);
  }
  return '';
}

async function copyMarkdown() {
  try {
    const text = await getRawMarkdown();
    if (text && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      copiedState.value = 'markdown';
      setTimeout(() => {
        copiedState.value = 'idle';
      }, 2000);
    }
  } catch (err) {
    console.error('Failed to copy markdown to clipboard:', err);
  } finally {
    isOpen.value = false;
  }
}

async function copyMarkdownUrl() {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(fullMdUrl.value);
      copiedState.value = 'url';
      setTimeout(() => {
        copiedState.value = 'idle';
      }, 2000);
    }
  } catch (err) {
    console.error('Failed to copy URL to clipboard:', err);
  } finally {
    isOpen.value = false;
  }
}

function openMarkdown() {
  window.open(mdPath.value, '_blank');
  isOpen.value = false;
}

function sendToChatGPT() {
  const prompt = `Please read this Cloud Harness MCP documentation page: ${fullMdUrl.value}`;
  const url = `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`;
  window.open(url, '_blank');
  isOpen.value = false;
}

function sendToClaude() {
  const prompt = `Please read this Cloud Harness MCP documentation page: ${fullMdUrl.value}`;
  const url = `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;
  window.open(url, '_blank');
  isOpen.value = false;
}

function toggleDropdown() {
  isOpen.value = !isOpen.value;
}

function handleClickOutside(e: MouseEvent) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    isOpen.value = false;
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    isOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
  document.addEventListener('keydown', handleKeyDown);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleKeyDown);
});
</script>

<template>
  <div class="md-actions-bar" ref="dropdownRef">
    <div class="md-actions-group">
      <button
        type="button"
        class="md-action-btn primary-btn"
        @click="copyMarkdown"
        :title="copiedState === 'markdown' ? 'Copied to clipboard!' : 'Copy raw Markdown to clipboard'"
        aria-label="Copy page as Markdown"
      >
        <svg v-if="copiedState === 'markdown'" class="action-icon check-icon" viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <svg v-else class="action-icon" viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span class="btn-label">{{ copiedState === 'markdown' ? 'Copied Markdown!' : 'Copy as Markdown' }}</span>
      </button>

      <button
        type="button"
        class="md-action-btn trigger-btn"
        @click="toggleDropdown"
        :aria-expanded="isOpen"
        aria-haspopup="true"
        aria-label="More Markdown actions"
        title="More actions"
      >
        <svg class="chevron-icon" :class="{ 'rotate': isOpen }" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
    </div>

    <!-- Dropdown Menu -->
    <transition name="dropdown-fade">
      <div v-if="isOpen" class="md-dropdown-menu" role="menu" aria-label="Markdown options">
        <button type="button" class="dropdown-item" role="menuitem" @click="copyMarkdown">
          <svg class="item-icon" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span class="item-text">Copy as Markdown</span>
        </button>

        <button type="button" class="dropdown-item" role="menuitem" @click="copyMarkdownUrl">
          <svg v-if="copiedState === 'url'" class="item-icon check-icon" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <svg v-else class="item-icon" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
          </svg>
          <span class="item-text">{{ copiedState === 'url' ? 'URL Copied!' : 'Copy Markdown URL' }}</span>
        </button>

        <button type="button" class="dropdown-item" role="menuitem" @click="openMarkdown">
          <svg class="item-icon" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
          <span class="item-text">Open as Markdown</span>
        </button>

        <div class="dropdown-divider" role="separator"></div>

        <button type="button" class="dropdown-item ai-item" role="menuitem" @click="sendToChatGPT">
          <svg class="item-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"></circle>
            <path d="M8 12h8M12 8v8" stroke="currentColor" stroke-width="2"></path>
          </svg>
          <span class="item-text">Send to ChatGPT</span>
        </button>

        <button type="button" class="dropdown-item ai-item" role="menuitem" @click="sendToClaude">
          <svg class="item-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="none" stroke="currentColor" stroke-width="2"></polygon>
          </svg>
          <span class="item-text">Send to Claude</span>
        </button>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.md-actions-bar {
  position: relative;
  display: flex;
  justify-content: flex-end;
  margin-bottom: 1.25rem;
  font-family: inherit;
  z-index: 10;
}

.md-actions-group {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background-color: var(--vp-c-bg-soft);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.md-actions-group:hover {
  border-color: var(--vp-c-brand-1);
}

.md-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.625rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--vp-c-text-2);
  background: transparent;
  border: none;
  cursor: pointer;
  line-height: 1;
  transition: color 0.15s ease, background-color 0.15s ease;
}

.md-action-btn:hover {
  color: var(--vp-c-text-1);
  background-color: var(--vp-c-bg-mute);
}

.primary-btn {
  border-top-left-radius: 5px;
  border-bottom-left-radius: 5px;
}

.trigger-btn {
  padding: 0.375rem 0.4rem;
  border-left: 1px solid var(--vp-c-divider);
  border-top-right-radius: 5px;
  border-bottom-right-radius: 5px;
}

.action-icon {
  flex-shrink: 0;
}

.check-icon {
  color: var(--vp-c-green-1, #10b981);
}

.chevron-icon {
  transition: transform 0.2s ease;
}

.chevron-icon.rotate {
  transform: rotate(180deg);
}

.btn-label {
  letter-spacing: -0.01em;
}

/* Dropdown Menu */
.md-dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 180px;
  padding: 0.25rem;
  background-color: var(--vp-c-bg-elv);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 50;
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.4rem 0.625rem;
  font-size: 0.8125rem;
  font-weight: 450;
  color: var(--vp-c-text-2);
  background: transparent;
  border: none;
  border-radius: 4px;
  text-align: left;
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
}

.dropdown-item:hover {
  color: var(--vp-c-text-1);
  background-color: var(--vp-c-bg-mute);
}

.dropdown-item:hover .item-icon {
  color: var(--vp-c-brand-1);
}

.item-icon {
  flex-shrink: 0;
  color: var(--vp-c-text-3);
}

.dropdown-divider {
  height: 1px;
  margin: 0.25rem 0;
  background-color: var(--vp-c-divider);
}

.dropdown-fade-enter-active,
.dropdown-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.dropdown-fade-enter-from,
.dropdown-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
