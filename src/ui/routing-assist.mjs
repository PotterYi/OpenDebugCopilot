/**
 * Derive routing candidates from three sources:
 *   1. observed  - captured XHR/Fetch requests (host + first two path segments)
 *   2. declared  - target addresses already present in config (workspace / existing rules)
 *   3. probed    - only targets that actually answer a reachability probe
 * A rule is emitted only when all three are satisfied.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parseHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isLocalBase(baseUrl) {
  return LOCAL_HOSTS.has(parseHost(baseUrl));
}

function groupKey(host, prefix) {
  return `${host.toLowerCase()}|${prefix}`;
}

/**
 * @param {Array<{ url: string, method?: string, resourceType?: string }>} requests
 * @param {{
 *   existingRules?: Array<any>,
 *   declaredTargets?: Array<{ kind: 'local'|'sit', baseUrl: string, source?: string }>,
 *   probe?: (baseUrl: string) => Promise<boolean>
 * }} [options]
 * @returns {Promise<{ rules: Array<any>, unreachable: Array<any>, declaredTargets: Array<any> }>}
 */
export async function deriveCandidateRules(requests, {
  existingRules = [],
  declaredTargets = [],
  probe = async () => false,
} = {}) {
  const groups = new Map();

  for (const request of requests ?? []) {
    const type = String(request.resourceType ?? '').toLowerCase();
    if (type !== 'xhr' && type !== 'fetch') continue;
    let parsed;
    try {
      parsed = new URL(request.url);
    } catch {
      continue;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    const prefix = `/${segments.slice(0, 2).join('/')}`;
    if (prefix === '/') continue;
    const key = groupKey(parsed.hostname, prefix);
    if (!groups.has(key)) {
      groups.set(key, {
        host: parsed.hostname,
        prefix,
        count: 0,
        sample: request.url,
        methods: new Set(),
      });
    }
    const group = groups.get(key);
    group.count += 1;
    if (request.method) group.methods.add(request.method);
  }

  const targets = [];
  const seenTargets = new Set();
  const addTarget = (target, source) => {
    if (!target?.baseUrl) return;
    // SIT means passthrough; it is never an API redirection target.
    if (target.kind === 'sit') return;
    const kind = 'local';
    const baseUrl = String(target.baseUrl).replace(/\/+$/, '');
    const key = `${kind}|${baseUrl}`;
    if (seenTargets.has(key)) return;
    seenTargets.add(key);
    targets.push({ kind, baseUrl, source });
  };
  for (const target of declaredTargets) {
    addTarget(target, target.source ?? 'declared');
  }
  for (const rule of existingRules) {
    addTarget(rule.target, `rule:${rule.id}`);
  }

  const probeCache = new Map();
  const probeOnce = (baseUrl) => {
    if (!probeCache.has(baseUrl)) {
      probeCache.set(baseUrl, Promise.resolve().then(() => probe(baseUrl)).catch(() => false));
    }
    return probeCache.get(baseUrl);
  };

  const coveredByExisting = (group) =>
    (existingRules ?? []).some((rule) => {
      if (rule.enabled === false) return false;
      const host = String(rule.match?.host ?? '').toLowerCase();
      if (host && host !== group.host.toLowerCase()) return false;
      const prefix = String(rule.match?.prefix ?? '');
      // A catch-all "/" must not block deriving more specific candidates.
      return prefix.length > 1 && group.prefix.startsWith(prefix);
    });

  const rules = [];
  const unreachable = [];

  for (const group of groups.values()) {
    if (coveredByExisting(group)) continue;

    let chosen = null;
    for (const target of targets) {
      if (await probeOnce(target.baseUrl)) {
        chosen = target;
        break;
      }
    }
    if (!chosen) {
      unreachable.push({
        host: group.host,
        prefix: group.prefix,
        count: group.count,
        candidates: targets.map((target) => target.baseUrl),
      });
      continue;
    }

    rules.push({
      id: `rule-${group.host}-${group.prefix}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
      enabled: true,
      match: { host: group.host, prefix: group.prefix },
      target: { kind: chosen.kind, baseUrl: chosen.baseUrl },
      assistant: {
        count: group.count,
        sample: group.sample,
        methods: [...group.methods],
        sources: ['observed', 'declared', 'probed'],
        targetSource: chosen.source,
        probed: true,
        suspicious: chosen.kind === 'sit' && isLocalBase(chosen.baseUrl),
      },
    });
  }

  return { rules, unreachable, declaredTargets: targets };
}
