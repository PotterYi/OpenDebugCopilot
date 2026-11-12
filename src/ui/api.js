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
  get isDesktop() {
    return Boolean(dc?.invoke);
  },
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
  async getDatabases() {
    if (dc?.invoke) return dc.invoke('dc:databases', { action: 'get' });
    return http('/api/databases');
  },
  async saveDatabases(config) {
    if (dc?.invoke) return dc.invoke('dc:databases', { action: 'save', config });
    return http('/api/databases', { method: 'PUT', body: JSON.stringify(config) });
  },
  async testDatabase(connection) {
    if (dc?.invoke) return dc.invoke('dc:databases', { action: 'test', connection });
    return http('/api/databases/test', { method: 'POST', body: JSON.stringify({ connection }) });
  },
  async getAgentAuth() {
    if (!dc?.invoke) return { mode: 'user', baseUrl: '', tokenEnv: '', hasToken: false };
    return dc.invoke('dc:agent-auth', { action: 'get' });
  },
  async saveAgentAuth(auth) {
    if (!dc?.invoke) throw new Error('凭据加密保存仅桌面版可用，请使用环境变量');
    return dc.invoke('dc:agent-auth', { action: 'save', auth });
  },
  async listRuns() {
    if (dc?.invoke) return (await dc.invoke('dc:runs', { action: 'list' })).runs;
    return (await http('/api/runs')).runs;
  },
  async getRun(runId) {
    if (dc?.invoke) return dc.invoke('dc:runs', { action: 'get', runId });
    return http(`/api/runs/${encodeURIComponent(runId)}`);
  },
  async deleteRun(runId, options = {}) {
    const keepPending = options.keepPending === true;
    if (dc?.invoke) {
      return dc.invoke('dc:runs', { action: 'delete', runId, keepPending });
    }
    const response = await fetch(
      `/api/runs/${encodeURIComponent(runId)}${keepPending ? '?keep=1' : ''}`,
      { method: 'DELETE' },
    );
    const data = await response.json().catch(() => ({}));
    if (response.status === 409) return data;
    if (!response.ok) throw new Error(data.message || data.error || response.statusText);
    return data;
  },
  async browser(action, payload = {}) {
    if (!dc?.invoke) return { pending: true };
    return dc.invoke('dc:browser', { action, ...payload });
  },
  async element(action, payload = {}) {
    if (!dc?.invoke) return { pending: true };
    return dc.invoke('dc:element', { action, ...payload });
  },
  async capture(action, payload = {}) {
    if (!dc?.invoke) return action === 'list' ? { requests: [] } : { pending: true };
    return dc.invoke('dc:capture', { action, ...payload });
  },
  async diagnose(payload) {
    if (dc?.invoke) return dc.invoke('dc:diagnose', payload);
    return http('/api/diagnose', { method: 'POST', body: JSON.stringify(payload) });
  },
  async listProfiles() {
    if (dc?.invoke) return dc.invoke('dc:profiles', { action: 'list' });
    return http('/api/profiles');
  },
  async createProfile(name, snapshot = {}) {
    if (dc?.invoke) return dc.invoke('dc:profiles', { action: 'create', name, ...snapshot });
    return http('/api/profiles', { method: 'POST', body: JSON.stringify({ name, ...snapshot }) });
  },
  async switchProfile(profileId) {
    if (dc?.invoke) return dc.invoke('dc:profiles', { action: 'switch', profileId });
    return http(`/api/profiles/${encodeURIComponent(profileId)}/activate`, { method: 'POST' });
  },
  async renameProfile(profileId, name) {
    if (dc?.invoke) return dc.invoke('dc:profiles', { action: 'rename', profileId, name });
    return http(`/api/profiles/${encodeURIComponent(profileId)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  },
  async deleteProfile(profileId) {
    if (dc?.invoke) return dc.invoke('dc:profiles', { action: 'delete', profileId });
    return http(`/api/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
  },
  async devServer(action, payload = {}) {
    if (!dc?.invoke) return { pending: true };
    return dc.invoke('dc:devserver', { action, ...payload });
  },
  async workspace(action, payload = {}) {
    if (!dc?.invoke) return { pending: true };
    return dc.invoke('dc:workspace', { action, ...payload });
  },
  async fixes(action, payload = {}) {
    if (!dc?.invoke) return { pending: true };
    return dc.invoke('dc:fixes', { action, ...payload });
  },
  async verify(action, payload = {}) {
    if (!dc?.invoke) return { pending: true };
    return dc.invoke('dc:verify', { action, ...payload });
  },
  async followUp(payload) {
    if (!dc?.invoke) return { pending: true };
    return dc.invoke('dc:followup', payload);
  },
  async pickLogs() {
    if (dc?.invoke) return dc.invoke('dc:logs', { action: 'pick' });
    return { paths: [] };
  },
  async queryLogs(payload) {
    if (dc?.invoke) return dc.invoke('dc:logs', { action: 'query', ...payload });
    return { pending: true };
  },
  onCapture(handler) {
    if (!dc?.on) return () => {};
    return dc.on('dc:capture:event', handler);
  },
  onElementEvent(handler) {
    if (!dc?.on) return () => {};
    return dc.on('dc:element:event', handler);
  },
  onWorkspaceEvent(handler) {
    if (!dc?.on) return () => {};
    return dc.on('dc:workspace:event', handler);
  },
  onDevServer(handler) {
    if (!dc?.on) return () => {};
    return dc.on('dc:devserver:event', handler);
  },
  onDiagnoseProgress(handler) {
    if (!dc?.on) return () => {};
    return dc.on('dc:diagnose:progress', handler);
  },
  onFollowUpProgress(handler) {
    if (!dc?.on) return () => {};
    return dc.on('dc:followup:progress', handler);
  },
  onModelSettings(handler) {
    if (!dc?.on) return () => {};
    return dc.on('dc:model:open', handler);
  },
  onDatabaseSettings(handler) {
    if (!dc?.on) return () => {};
    return dc.on('dc:database:open', handler);
  },
};
