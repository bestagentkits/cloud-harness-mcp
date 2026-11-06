// Imported by the visual spec before any fixture, so fixtures that build timestamps from
// "now" evaluate against one fixed instant and every screenshot renders the same dates.
// `thaw-time.ts` restores the real clock right after the fixtures load. The visual project
// runs in its own worker, so no other spec sees a fixture module evaluated under this clock.

export const VISUAL_NOW = Date.parse('2026-10-20T10:30:00.000Z');

const RealDate = Date;

class FixedDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date> | []) {
    if (args.length === 0) super(VISUAL_NOW);
    else super(...(args as ConstructorParameters<typeof Date>));
  }

  static override now(): number {
    return VISUAL_NOW;
  }
}

(globalThis as { __realDate?: DateConstructor }).__realDate = RealDate;
globalThis.Date = FixedDate as DateConstructor;
