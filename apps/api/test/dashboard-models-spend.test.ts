import { describe, expect, it, vi } from 'vitest';
import { ModelSpendPolicyInputSchema, ModelSpendSummarySchema } from '@cloud-harness/contracts';
import './dashboard-test-dom.js';
import {
  SPEND_HELP_TEXT, UNKNOWN_SAVED_PRICE, createSpendPanel, formatSavedPrice, parseSpendLimit, parseWarnPercent, pricingReviewNotice,
  renderModelsPage, renderSavedPricing, renderSpendPanel, savedPriceProvenance
} from '../dashboard/dashboard-models.js';
import { TreeElement } from './dashboard-tree-dom.js';

const credentialId = `cred_${'a'.repeat(24)}`;
const revisionId = `mrev_${'r'.repeat(24)}`;
const policyId = `msp_${'p'.repeat(24)}`;
const profilePolicyId = `msp_${'q'.repeat(24)}`;

const catalogProvenance = { source: 'openrouter', sourceModelId: 'openai/gpt-5', retrievedAt: 1_760_000_000_000, confidence: 'exact', isOverride: false };
const overrideProvenance = { source: 'user', sourceModelId: null, retrievedAt: null, confidence: 'unknown', isOverride: true };

function profile(overrides: Record<string, unknown> = {}, revision: Record<string, unknown> = {}) {
  return {
    id: 'gpt-5', displayName: 'GPT 5', credentialId, generation: 3, status: 'ACTIVE', activeRevisionId: revisionId, desiredRevisionId: revisionId,
    activeRevision: {
      id: revisionId, profileId: 'gpt-5', credentialId, model: 'gpt-5', apiMode: 'responses', upstreamUrl: 'https://api.openai.com/v1/responses',
      pricing: { inputMicrosPerMillionTokens: 1_250_000, outputMicrosPerMillionTokens: 10_000_000, cacheReadMicrosPerMillionTokens: 125_000, cacheWriteMicrosPerMillionTokens: null },
      priceProvenance: catalogProvenance,
      limits: { maxInputTokens: 150_000, maxOutputTokens: 20_000, maxCostMicros: 2_500_000 },
      maxProxyOperations: ['files_read'], digest: 'd', createdAt: 1,
      ...revision
    },
    ...overrides
  };
}

const review = (overrides: Record<string, unknown> = {}) => ({
  state: 'repriced',
  changes: [
    { field: 'input', minPromptTokens: null, pinned: 1_250_000, catalog: 1_500_000, percent: 20 },
    { field: 'output', minPromptTokens: null, pinned: 10_000_000, catalog: 7_500_000, percent: -25 }
  ],
  catalogRetrievedAt: 1_760_000_000_000, isOverride: false, catalogHasConditionalPricing: false,
  ...overrides
});

function policy(overrides: Record<string, unknown> = {}) {
  return { id: policyId, profileId: null, period: 'day', limitMicros: 10_000_000, warnPercent: 80, generation: 2, createdAt: 1, updatedAt: 1, ...overrides };
}

function spendWindow(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'principal', profileId: null, period: 'day', windowStartsAt: '2026-10-17T00:00:00.000Z', windowEndsAt: '2026-10-18T00:00:00.000Z',
    estimatedSettledMicros: 1_500_000, estimatedReservedMicros: 2_500_000, estimatedUnreconciledMicros: 0,
    policy: null, thresholdState: null,
    ...overrides
  };
}

function summary(windows = [
  spendWindow({ policy: policy(), thresholdState: 'ok' }),
  spendWindow({ period: 'month', windowStartsAt: '2026-10-01T00:00:00.000Z', windowEndsAt: '2026-11-01T00:00:00.000Z', estimatedSettledMicros: 42_000_000 }),
  spendWindow({ scope: 'profile', profileId: 'gpt-5', policy: policy({ id: profilePolicyId, profileId: 'gpt-5', limitMicros: 4_000_000 }), thresholdState: 'exceeded' }),
  spendWindow({ scope: 'profile', profileId: 'gpt-5', period: 'month', windowStartsAt: '2026-10-01T00:00:00.000Z', windowEndsAt: '2026-11-01T00:00:00.000Z', thresholdState: null }),
  spendWindow({ scope: 'profile', profileId: 'retired', policy: policy({ id: `msp_${'r'.repeat(24)}`, profileId: 'retired', period: 'month', warnPercent: 50 }), period: 'month', windowStartsAt: '2026-10-01T00:00:00.000Z', windowEndsAt: '2026-11-01T00:00:00.000Z', thresholdState: 'warning' })
]) {
  return ModelSpendSummarySchema.parse({ isEstimate: true, windows });
}

describe('spend amounts typed in US dollars', () => {
  it('converts to micros with integer maths at six decimal places', () => {
    expect(parseSpendLimit('0.000001')).toEqual({ micros: 1 });
    expect(parseSpendLimit('12.345678')).toEqual({ micros: 12_345_678 });
    // 0.1 + 0.2 style binary fractions never enter the conversion.
    expect(parseSpendLimit('0.3')).toEqual({ micros: 300_000 });
    expect(parseSpendLimit('$25')).toEqual({ micros: 25_000_000 });
    expect(parseSpendLimit('1000000')).toEqual({ micros: 1_000_000_000_000 });
    expect(parseSpendLimit('10.')).toEqual({ micros: 10_000_000 });
  });

  it('rejects more than six decimals, negative, zero, oversized, and garbled amounts', () => {
    expect(parseSpendLimit('1.0000001')).toEqual({ error: 'Use at most six decimal places.' });
    expect(parseSpendLimit('-5')).toEqual({ error: 'Enter an amount above $0.' });
    expect(parseSpendLimit('0.000000')).toEqual({ error: 'Enter an amount above $0.' });
    expect(parseSpendLimit('1000000.000001')).toEqual({ error: 'Keep the limit at or below $1,000,000.' });
    expect(parseSpendLimit('1e3').error).toBeDefined();
    expect(parseSpendLimit('12,50').error).toBeDefined();
    expect(parseSpendLimit('').error).toBe('Enter a limit in US dollars.');
    expect(parseWarnPercent('80')).toEqual({ percent: 80 });
    expect(parseWarnPercent('0').error).toBeDefined();
    expect(parseWarnPercent('101').error).toBeDefined();
    expect(parseWarnPercent('50.5').error).toBeDefined();
  });
});

describe('saved price provenance and repricing', () => {
  it('shows the source, confidence, retrieval date, and a catalog or override badge', () => {
    const catalog = renderSavedPricing(profile());
    expect(catalog).toContain('data-price-provenance="catalog">Catalog price</span>');
    expect(catalog).toContain('Source: OpenRouter · confidence: exact · retrieved <time datetime="2025-10-09T08:53:20.000Z">');
    const override = renderSavedPricing(profile({}, { priceProvenance: overrideProvenance }));
    expect(override).toContain('<span class="status info" data-price-provenance="override">Custom price (override)</span>');
    expect(override).toContain('Source: entered by you · confidence: unknown');
    expect(override).not.toContain('retrieved');
    // A revision listed without provenance reads as an override, never as the catalog's price.
    expect(savedPriceProvenance(undefined)).toMatchObject({ isOverride: true, badge: 'Custom price (override)' });
  });

  it('shows cache prices and tiers, and an unknown price in words rather than $0', () => {
    const tier = { minPromptTokens: 272_000, inputMicrosPerMillionTokens: 2_500_000, outputMicrosPerMillionTokens: 15_000_000, cacheReadMicrosPerMillionTokens: null, cacheWriteMicrosPerMillionTokens: 3_000_000 };
    const markup = renderSavedPricing(profile({}, { pricing: { ...profile().activeRevision.pricing, tiers: [tier] } }));
    expect(markup).toContain('$1.25 / $10.00');
    expect(markup).toContain('cache read $0.125 · cache write Unknown (charged conservatively)');
    expect(markup).toContain('From 272,000 prompt tokens: <span class="mono">$2.50 / $15.00</span>, cache read Unknown (charged conservatively) · cache write $3.00');
    expect(formatSavedPrice(null)).toBe(UNKNOWN_SAVED_PRICE);
    expect(formatSavedPrice(undefined)).toBe('Unknown (charged conservatively)');
    expect(formatSavedPrice(0)).toBe('$0.00');
    expect(markup).not.toMatch(/\$0(?![.\d])/);
  });

  it('warns about a repriced catalog price with an action, worded for an override as a difference', () => {
    const repriced = renderModelsPage({ profiles: [profile({ pricingReview: review() })], credentials: [], providers: [] });
    expect(repriced).toContain('data-pricing-review="repriced"><span>Catalog price changed by 25% since saved</span>');
    // Both the table row and the phone card carry the action, which only opens the edit form.
    expect(repriced.match(/data-model-action="review-price" data-profile-id="gpt-5">Review catalog price<\/button>/g)).toHaveLength(2);

    const override = renderSavedPricing(profile({ pricingReview: review({ isOverride: true }) }, { priceProvenance: overrideProvenance }));
    expect(override).toContain('data-pricing-review="override"><span>Differs from catalog</span>');
    expect(override).not.toContain('since saved');
    expect(override).toContain('data-model-action="review-price"');

    expect(pricingReviewNotice(review({ changes: [{ field: 'tier', minPromptTokens: 200_000, pinned: null, catalog: 3_000_000, percent: null }] }))?.text).toBe('Catalog price changed since saved');
    expect(pricingReviewNotice(review({ changes: [{ field: 'input', minPromptTokens: null, pinned: 3, catalog: 4, percent: 12.5 }] }))?.text).toBe('Catalog price changed by 12.5% since saved');
    for (const state of ['current', 'unknown']) {
      expect(renderSavedPricing(profile({ pricingReview: review({ state, changes: [] }) }))).not.toContain('data-pricing-review');
    }
    expect(renderSavedPricing(profile())).not.toContain('data-pricing-review');
  });
});

describe('spend panel', () => {
  const profiles = [profile()];

  it('labels every figure as an estimate and explains that a run cap stays reserved until the run ends', () => {
    const markup = renderSpendPanel({ status: 'ready', summary: summary(), profiles, editor: { mode: 'create', profileId: '', period: 'day', limit: '', warnPercent: '80', errors: {} } });
    expect(SPEND_HELP_TEXT).toContain('A run\'s cap is reserved until the run ends');
    expect(markup).toContain('A run&#39;s cap is reserved until the run ends');
    // Five windows, four estimated figures each, once in the table and once in the phone card.
    const figures = markup.match(/<span class="mono">\$[\d.]+<\/span> <span class="estimate-tag">Estimate<\/span>/g) ?? [];
    expect(figures).toHaveLength(5 * 4 * 2);
    expect(markup).toContain('<span class="mono">$1.50</span> <span class="estimate-tag">Estimate</span>');
    expect(markup).toContain('<span class="mono">$4.00</span> <span class="estimate-tag">Estimate</span>');
    expect(markup).toContain('<span class="mono">$0.00</span> <span class="estimate-tag">Estimate</span>');
    for (const heading of ['Settled', 'Reserved', 'Unreconciled', 'Total']) expect(markup).toContain(`<th>${heading}</th>`);
    expect(markup).toContain('Today (UTC)');
    expect(markup).toContain('This month (UTC)');
    expect(markup).toContain('GPT 5 (gpt-5)');
    expect(markup).toContain('retired (profile deleted)');
  });

  it('states each threshold in words with the status colour of the design guidelines', () => {
    const markup = renderSpendPanel({ status: 'ready', summary: summary(), profiles, editor: { mode: 'create', errors: {} } });
    expect(markup).toContain('<span class="status active" data-threshold="ok">OK</span>');
    expect(markup).toContain('<span class="status stale" data-threshold="warning">Warning</span>');
    expect(markup).toContain('<span class="status failed" data-threshold="exceeded">Exceeded</span>');
    expect(markup).toContain('<span class="status" data-threshold="none">No limit</span>');
    expect(markup).toContain('warn at 50%');
  });

  it('labels every editor input and offers no new limit for a deleted profile', () => {
    const markup = renderSpendPanel({ status: 'ready', summary: summary(), profiles, editor: { mode: 'create', profileId: '', period: 'day', limit: '', warnPercent: '80', errors: {} } });
    for (const [id, label] of [['spend-policy-scope', 'Applies to'], ['spend-policy-period', 'Period'], ['spend-policy-limit', 'Limit (USD)'], ['spend-policy-warn', 'Warn at (% of limit)']]) {
      expect(markup).toContain(`<label for="${id}">${label}</label>`);
      expect(markup).toContain(`id="${id}"`);
    }
    expect(markup).toContain('aria-label="Edit the daily limit for All runs"');
    expect(markup).toContain('aria-label="Set a monthly limit for GPT 5 (gpt-5)"');
    expect(markup).not.toContain('Set a monthly limit for retired');
    expect(markup).toContain('aria-label="Delete the monthly limit for retired (profile deleted)"');
  });

  it('reports a failed load with the API text and a retry', () => {
    const markup = renderSpendPanel({ status: 'error', error: 'The runner is unavailable.', profiles: [], editor: { mode: 'create', errors: {} } });
    expect(markup).toContain('<p class="field-error" role="alert">The runner is unavailable.</p>');
    expect(markup).toContain('data-spend-action="retry"');
    expect(markup).not.toContain('spend-policy-form');
  });

  it('is part of the Models & Budgets page', () => {
    const markup = renderModelsPage({ profiles, credentials: [], providers: [] });
    expect(markup).toContain('<section id="model-spend" class="panel model-spend" aria-labelledby="model-spend-heading">');
    expect(markup).toContain('Loading spend…');
  });
});

describe('spend policy editor', () => {
  const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
  const problem = (message: string, status: number, code: string) => Object.assign(new Error(message), { status, code });

  function mount(overrides: Record<string, unknown> = {}) {
    const section = new TreeElement('section', [['id', 'model-spend']]);
    const api = {
      getSpend: vi.fn(async () => ({ data: { summary: summary(), policies: [] } })),
      setPolicy: vi.fn(async () => ({ data: {} })),
      deletePolicy: vi.fn(async () => ({ data: {} })),
      ...overrides
    };
    const announce = vi.fn();
    const confirm = vi.fn((options: { action: () => Promise<unknown> }) => { void options.action(); });
    const panel = createSpendPanel({ section, insert: (element: TreeElement, markup: string) => element.render(markup), api, announce, confirm, profiles: [profile()] });
    const q = (selector: string) => section.querySelector(selector);
    return {
      panel, section, api, announce, confirm, q,
      status: () => q('#model-spend-status')!.textContent,
      click: async (selector: string) => { section.dispatch('click', { target: q(selector) }); await flush(); },
      submit: async () => { section.dispatch('submit', { target: q('#spend-policy-form'), preventDefault: vi.fn() }); await flush(); },
      fill: (values: Record<string, string>) => { for (const [name, value] of Object.entries(values)) q(`#spend-policy-form [name="${name}"]`)!.value = value; }
    };
  }

  it('creates a limit without a policy id or generation and reloads the figures', async () => {
    const view = mount();
    await view.panel.load();
    expect(view.q('#spend-policy-heading')!.textContent).toBe('Add a spend limit');
    view.fill({ profileId: 'gpt-5', period: 'month', limit: '12.345678', warnPercent: '75' });
    await view.submit();
    expect(view.api.setPolicy).toHaveBeenCalledWith({ profileId: 'gpt-5', period: 'month', limitMicros: 12_345_678, warnPercent: 75 });
    const [payload] = view.api.setPolicy.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(payload).not.toHaveProperty('policyId');
    expect(payload).not.toHaveProperty('expectedGeneration');
    expect(ModelSpendPolicyInputSchema.safeParse(payload).success).toBe(true);
    expect(view.api.getSpend).toHaveBeenCalledTimes(2);
    expect(view.announce).toHaveBeenCalledWith('Spend limit added.');
    expect(view.status()).toBe('Spend limit added.');
    expect(view.q('[name="limit"]')!.value).toBe('');
  });

  it('refuses an invalid amount in place, without a request', async () => {
    const view = mount();
    await view.panel.load();
    view.fill({ limit: '1.0000001' });
    await view.submit();
    expect(view.api.setPolicy).not.toHaveBeenCalled();
    const limit = view.q('[name="limit"]')!;
    expect(limit.getAttribute('aria-invalid')).toBe('true');
    expect(limit.getAttribute('aria-describedby')).toBe('spend-policy-limit-help spend-policy-limit-error');
    expect(view.q('#spend-policy-limit-error')!.textContent).toBe('Use at most six decimal places.');
    expect(limit.value).toBe('1.0000001');
    expect(limit.focus).toHaveBeenCalled();
  });

  it('keeps the typed values on a create conflict, re-reads the summary, and shows the API text', async () => {
    const view = mount({ setPolicy: vi.fn(async () => { throw problem('A spend policy for this scope and period already exists.', 409, 'conflict'); }) });
    await view.panel.load();
    view.fill({ limit: '30', warnPercent: '90' });
    await view.submit();
    expect(view.api.getSpend).toHaveBeenCalledTimes(2);
    expect(view.status()).toBe('A spend policy for this scope and period already exists.');
    expect(view.q('#model-spend-status')!.getAttribute('role')).toBe('alert');
    expect(view.q('[name="limit"]')!.value).toBe('30');
    expect(view.q('[name="warnPercent"]')!.value).toBe('90');
  });

  it('updates with the policy id and generation, and follows the latest policy after a conflict', async () => {
    const latest = summary([spendWindow({ policy: policy({ generation: 5, limitMicros: 20_000_000, warnPercent: 60 }), thresholdState: 'ok' })]);
    const getSpend = vi.fn().mockResolvedValueOnce({ data: { summary: summary() } }).mockResolvedValue({ data: { summary: latest } });
    const setPolicy = vi.fn()
      .mockRejectedValueOnce(problem('The model spend policy changed. Reload it and try again.', 409, 'conflict'))
      .mockResolvedValueOnce({ data: {} });
    const view = mount({ getSpend, setPolicy });
    await view.panel.load();
    await view.click(`[data-spend-action="edit"][data-policy-id="${policyId}"]`);
    expect(view.q('#spend-policy-heading')!.textContent).toBe('Edit spend limit');
    expect(view.q('[name="limit"]')!.value).toBe('10.00');
    expect(view.q('[name="period"]')!.disabled).toBe(true);
    expect(view.q('[name="profileId"]')!.disabled).toBe(true);
    view.fill({ limit: '15.5' });
    await view.submit();
    expect(setPolicy).toHaveBeenLastCalledWith({ policyId, period: 'day', limitMicros: 15_500_000, warnPercent: 80, expectedGeneration: 2 });
    expect(view.status()).toBe('The model spend policy changed. Reload it and try again.');
    // The editor now shows what is stored, at its new generation, for the operator to review.
    expect(view.q('[name="limit"]')!.value).toBe('20.00');
    expect(view.q('[name="warnPercent"]')!.value).toBe('60');
    await view.submit();
    expect(setPolicy).toHaveBeenLastCalledWith({ policyId, period: 'day', limitMicros: 20_000_000, warnPercent: 60, expectedGeneration: 5 });
    expect(view.status()).toBe('Spend limit updated.');
  });

  it('names the profile scope on a profile policy update', async () => {
    const view = mount();
    await view.panel.load();
    await view.click(`[data-spend-action="edit"][data-policy-id="${profilePolicyId}"]`);
    await view.submit();
    expect(view.api.setPolicy).toHaveBeenCalledWith({ policyId: profilePolicyId, profileId: 'gpt-5', period: 'day', limitMicros: 4_000_000, warnPercent: 80, expectedGeneration: 2 });
    expect(ModelSpendPolicyInputSchema.safeParse(view.api.setPolicy.mock.calls[0]?.[0]).success).toBe(true);
  });

  it('deletes after confirmation with the policy generation', async () => {
    const view = mount();
    await view.panel.load();
    await view.click(`[data-spend-action="delete"][data-policy-id="${policyId}"]`);
    expect(view.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete spend limit?', label: 'Delete limit' }), expect.anything());
    expect(view.api.deletePolicy).toHaveBeenCalledWith(policyId, 2);
    expect(view.api.getSpend).toHaveBeenCalledTimes(2);
    expect(view.announce).toHaveBeenCalledWith('Spend limit deleted.');
  });

  it('re-reads the summary when a delete is refused as stale and shows the API text', async () => {
    const view = mount({ deletePolicy: vi.fn(async () => { throw problem('Model spend policy not found.', 404, 'not_found'); }) });
    await view.panel.load();
    await view.click(`[data-spend-action="delete"][data-policy-id="${policyId}"]`);
    expect(view.api.getSpend).toHaveBeenCalledTimes(2);
    expect(view.status()).toBe('Model spend policy not found.');
    expect(view.announce).not.toHaveBeenCalled();
  });

  it('starts a limit for the row it was asked from', async () => {
    const view = mount();
    await view.panel.load();
    await view.click('[data-spend-action="add"][data-profile-id="gpt-5"]');
    expect(view.panel.view.editor).toMatchObject({ mode: 'create', profileId: 'gpt-5', period: 'month' });
    expect(view.q('[name="limit"]')!.focus).toHaveBeenCalled();
  });

  it('shows a failed load and recovers on retry', async () => {
    const getSpend = vi.fn().mockRejectedValueOnce(problem('The workspace service is temporarily unavailable.', 503, 'unavailable')).mockResolvedValue({ data: { summary: summary() } });
    const view = mount({ getSpend });
    await view.panel.load();
    expect(view.section.textContent).toContain('The workspace service is temporarily unavailable.');
    await view.click('[data-spend-action="retry"]');
    expect(view.q('#spend-policy-form')).not.toBeNull();
  });
});
