---
title: Knowledge
description: Browse, search and edit memories and journals in the operator dashboard.
---

# Knowledge

`/dashboard/knowledge` lists the memories and journals that agents and operators record, with filters for kind, scope and project, a full-text search, and a graph view of how entries link. Each entry opens at `/dashboard/knowledge/<id>` with its content rendered as escaped Markdown.

## Filters and links

- **Kind, scope and project** narrow the list. Search runs over the same filters.
- **Graph** (`?view=graph`) shows the entries of the selected project and the links between them.
- Every filter, the search term and the page cursor are part of the address, so a copied link opens the same view and reload keeps it.

## Editing an entry

- **Save** sends the entry's generation. If someone else changed the entry since you opened it, the save is refused and a conflict view shows the version you started from, the current server version and your draft side by side. You choose whether to keep your draft or discard it and load the server version; nothing is overwritten silently.
- **Unsaved drafts survive a reload.** In the new dashboard, the text of an unsaved edit is kept in this browser tab's session storage, together with the generation it was based on, and restored when you reload the page; a banner says so and offers **Discard draft**. The draft is removed when you save or discard it, and session storage ends when the tab closes. Knowledge content is operator notes, never secrets, so it is allowed in browser storage; no IDs, tokens or other page data are stored with it.
- **Leaving asks first.** Navigating to another dashboard page while a draft is unsaved asks whether to discard it, and closing the tab shows the browser's own leave prompt. A reload does not ask, because the draft is restored.

## Links between entries

Links come from `[[kn_…]]` wikilinks in an entry's content. The entry page lists its outgoing links and backlinks read-only, and the graph draws them; there is no separate screen for adding or removing links.

## Classic dashboard

The classic dashboard keeps the same list, search, graph and editor, but it does not keep drafts across a reload.
