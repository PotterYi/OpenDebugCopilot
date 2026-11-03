/**
 * Derive routing candidates from captured XHR/Fetch requests.
 * Groups by host + first path segment, skips prefixes already covered by a rule.
 *
 * @param {Array<{ url: string, method?: string, resourceType?: string }>} requests
 * @param {{ existingRules?: Array<any>, defaultBaseUrl?: string }} [options]
 */
export function deriveCandidateRules(requests, { existingRules = [], defaultBaseUrl = 'http://localhost:8080' } = {}) {
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
    const key = `${parsed.hostname}|${prefix}`;
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

  const covered = (group) =>
    (existingRules ?? []).some((rule) => {
      if (rule.enabled === false) return false;
      const host = String(rule.match?.host ?? '').toLowerCase();
      if (host && host !== group.host.toLowerCase()) return false;
      const prefix = String(rule.match?.prefix ?? '');
      return Boolean(prefix) && group.prefix.startsWith(prefix);
    });

  return [...groups.values()]
    .filter((group) => !covered(group))
    .map((group) => ({
      id: `rule-${group.host}-${group.prefix}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
      enabled: true,
      match: { host: group.host, prefix: group.prefix },
      target: { kind: 'local', baseUrl: defaultBaseUrl },
      assistant: {
        count: group.count,
        sample: group.sample,
        methods: [...group.methods],
      },
    }));
}
