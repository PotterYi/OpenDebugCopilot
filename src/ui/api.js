const dc = typeof window !== 'undefined' ? window.dc : undefined;

async function http(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || response.statusText);
  }
  return data;
}

/**
 * One API surface for both shells:
 * - Electron: window.dc.invoke (preload whitelist)
 * - WebUI: /api/*
 */
export const api = {
  async health() {
    if (dc?.invoke) return { ok: true };
    return http('/api/health');
  },
  async getConfig() {
    if (dc?.invoke) return dc.invoke('dc:config', { action: 'get' });
    return http('/api/config');
  },
  async saveConfig(patch) {
    if (dc?.invoke) return dc.invoke('dc:config', { action: 'save', ...patch });
    return http('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
  },
  async listRuns() {
    if (dc?.invoke) return (await dc.invoke('dc:runs', { action: 'list' })).runs;
    return (await http('/api/runs')).runs;
  },
  async getRun(runId) {
    if (dc?.invoke) return dc.invoke('dc:runs', { action: 'get', runId });
    return http(`/api/runs/${encodeURIComponent(runId)}`);
  },
};
