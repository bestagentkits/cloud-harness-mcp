import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/features/settings/settings-page';
import { warmPageRead } from '@/lib/page-read';
import { noSearch } from '@/lib/search-params';

export const Route = createFileRoute('/settings')({
  staticData: { pageId: 'settings' },
  validateSearch: noSearch,
  loader: (match) => warmPageRead('settings', match),
  component: SettingsPage
});
