import { ScenarioError, NotImplementedError } from '../core/errors.mjs';

/** @typedef {{ kind: 'browser' | 'http', load: () => Promise<any> }} DriverSelection */

const REGISTRY = Object.freeze({
  browser: () => import('./browser.mjs'),
  http: () => import('./http.mjs'),
});

/**
 * Select the driver for a normalized scenario. Ambiguity is already rejected
 * by the scenario parser; this guards against unknown/absent driver kinds.
 *
 * @param {Readonly<Record<string, any>>} scenario
 * @returns {DriverSelection}
 */
export function selectDriver(scenario) {
  const kind = scenario?.driverKind;
  if (typeof kind !== 'string' || !(kind in REGISTRY)) {
    throw new ScenarioError('SCENARIO_UNKNOWN_DRIVER', `Unknown driver kind: ${String(kind)}`);
  }
  return Object.freeze({ kind, load: REGISTRY[kind] });
}

/**
 * Execute a scenario through its driver.
 * The driver contract: fire(scenario, ctx) -> { request, response, firedAt, marker }.
 *
 * @param {Readonly<Record<string, any>>} scenario
 * @param {Record<string, any>} [ctx]
 * @returns {Promise<{ request: any, response: any, firedAt: number, marker?: string }>}
 */
export async function fireScenario(scenario, ctx = {}) {
  const { load } = selectDriver(scenario);
  const driver = await load();
  if (typeof driver.fire !== 'function') {
    throw new NotImplementedError('DRIVER_INVALID', 'Driver module does not export fire()');
  }
  return driver.fire(scenario, ctx);
}
