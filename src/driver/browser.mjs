import { AppError } from '../core/errors.mjs';
import { applyMarker, createMarker } from './marker.mjs';

const DEFAULT_NAV_TIMEOUT_MS = 15_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_NETWORK_IDLE_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setHeader(headers, name, value) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
  headers[name] = value;
}

/**
 * Browser driver: playwright-core + system Edge (channel=msedge), headless by default.
 * Opens the page, runs actions (click / fill), captures via page.on, injects marker via page.route.
 *
 * @param {Readonly<Record<string, any>>} scenario
 * @param {{
 *   headless?: boolean, channel?: string | null, timeoutMs?: number,
 *   navigationTimeoutMs?: number, actionTimeoutMs?: number,
 *   networkIdleTimeoutMs?: number, maxBodyBytes?: number
 * }} [ctx]
 */
export async function fire(scenario, ctx = {}) {
  const { browser: spec, baseUrl, marker: markerConfig } = scenario;
  if (!spec) {
    throw new AppError('SCENARIO_DRIVER_MISMATCH', 'Browser driver requires a "browser" block', { exitCode: 3 });
  }
  if (!baseUrl) {
    throw new AppError('SCENARIO_BASE_URL_REQUIRED', 'Browser driver requires "baseUrl"', { exitCode: 3 });
  }

  const { chromium } = await import('playwright-core');
  const launchOptions = { headless: ctx.headless ?? true };
  if (ctx.channel !== null) launchOptions.channel = ctx.channel ?? 'msedge';

  let browserHandle;
  try {
    browserHandle = await chromium.launch(launchOptions);
  } catch (err) {
    throw new AppError(
      'BROWSER_LAUNCH_FAILED',
      `Cannot launch browser (${launchOptions.channel ?? 'bundled chromium'}): ${err?.message ?? err}`,
      { exitCode: 3, cause: err },
    );
  }

  const context = await browserHandle.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const navigationTimeoutMs = ctx.navigationTimeoutMs ?? ctx.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const actionTimeoutMs = ctx.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const networkIdleTimeoutMs = ctx.networkIdleTimeoutMs ?? DEFAULT_NETWORK_IDLE_MS;
  const maxBodyBytes = ctx.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  /** @type {Map<any, { startedAt: number }>} */
  const captures = new Map();
  /** @type {Map<any, any>} */
  const responses = new Map();
  /** @type {Map<any, string>} */
  const failures = new Map();
  /** @type {Map<string, any>} */
  const appliedByUrl = new Map();
  const markerValue = markerConfig?.mode && markerConfig.mode !== 'none' ? createMarker() : null;

  page.on('request', (request) => {
    captures.set(request, { startedAt: Date.now() });
  });
  page.on('response', (response) => {
    responses.set(response.request(), response);
  });
  page.on('requestfailed', (request) => {
    failures.set(request, request.failure()?.errorText ?? 'request failed');
  });

  try {
    if (markerValue) {
      await page.route(
        (url) => url.toString().includes(spec.match),
        async (route) => {
          const request = route.request();
          const headers = { ...request.headers() };
          const postData = request.postData();
          const applied = applyMarker({
            marker: markerConfig,
            headers,
            body: postData ?? undefined,
            contentType: headers['content-type'] ?? null,
            value: markerValue,
          });
          if (applied.contentType) setHeader(headers, 'content-type', applied.contentType);
          appliedByUrl.set(request.url(), applied);
          const options = { headers };
          if (applied.targets.body && applied.body !== undefined) {
            options.postData = typeof applied.body === 'string' ? applied.body : JSON.stringify(applied.body);
          }
          await route.continue(options);
        },
      );
    }

    const targetUrl = new URL(spec.path, baseUrl).toString();
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
      for (const action of spec.actions ?? []) {
        if (action.click) {
          await page.locator(action.click).first().click({ timeout: actionTimeoutMs });
        } else if (action.fill) {
          await page.locator(action.fill.selector).first().fill(action.fill.value, { timeout: actionTimeoutMs });
        }
      }
      await page.waitForLoadState('networkidle', { timeout: networkIdleTimeoutMs }).catch(() => {});
    } catch (err) {
      throw new AppError('BROWSER_ACTION_FAILED', `Browser scenario failed at ${targetUrl}: ${err?.message ?? err}`, {
        exitCode: 3,
        cause: err,
      });
    }

    const primary = await pickPrimary({ captures, responses, failures, match: spec.match });
    if (!primary) {
      throw new AppError(
        'BROWSER_NO_MATCHING_REQUEST',
        `No request matching "${spec.match}" was captured (captured ${captures.size} request(s))`,
        { exitCode: 3 },
      );
    }

    const startedAt = captures.get(primary)?.startedAt ?? Date.now();
    const applied = appliedByUrl.get(primary.url());
    const requestHeaders = applied ? applied.headers : await primary.allHeaders().catch(() => primary.headers());
    const requestBody = applied?.targets?.body && applied.body !== undefined
      ? applied.body
      : primary.postData() ?? null;

    const responseHandle = responses.get(primary);
    let response;
    if (responseHandle) {
      const raw = await responseHandle.body().catch(() => Buffer.alloc(0));
      const truncated = raw.length > maxBodyBytes;
      response = {
        status: responseHandle.status(),
        statusText: responseHandle.statusText(),
        ok: responseHandle.ok(),
        headers: await responseHandle.allHeaders().catch(() => responseHandle.headers()),
        body: (truncated ? raw.subarray(0, maxBodyBytes) : raw).toString('utf8'),
        truncated,
        bytes: raw.length,
        durationMs: Date.now() - startedAt,
      };
    } else if (failures.has(primary)) {
      response = {
        status: null,
        statusText: '',
        ok: false,
        headers: {},
        body: null,
        error: failures.get(primary),
        durationMs: Date.now() - startedAt,
      };
    } else {
      response = {
        status: null,
        statusText: '',
        ok: false,
        headers: {},
        body: null,
        pending: true,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      request: {
        method: primary.method(),
        url: primary.url(),
        headers: requestHeaders,
        body: requestBody,
        startedAt,
      },
      response,
      firedAt: startedAt,
      marker: applied ?? {
        value: markerValue,
        mode: markerConfig?.mode ?? 'none',
        injected: false,
        targets: { header: false, body: false },
      },
    };
  } finally {
    await context.close().catch(() => {});
    await browserHandle.close().catch(() => {});
  }
}

async function pickPrimary({ captures, responses, failures, match, retries = 15, delayMs = 200 }) {
  let lastMatching = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const matching = [...captures.keys()].filter(
      (request) => request.url().includes(match) && request.method() !== 'OPTIONS',
    );
    if (matching.length > 0) lastMatching = matching[matching.length - 1];
    const settled = matching.filter((request) => responses.has(request) || failures.has(request));
    if (settled.length > 0) return settled[settled.length - 1];
    if (attempt >= 2 && lastMatching) return lastMatching;
    await sleep(delayMs);
  }
  return lastMatching;
}
