// Restores the real clock after the visual spec's fixtures were evaluated (see freeze-time.ts).
const holder = globalThis as { __realDate?: DateConstructor };
if (holder.__realDate) {
  globalThis.Date = holder.__realDate;
  delete holder.__realDate;
}
