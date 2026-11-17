// Keep in sync with src/core/triage.mjs; the UI is served from src/ui and
// cannot import from src/core directly.
export const TRIAGE_OPTIONS = {
  environment: [
    { value: 'unknown', label: '不确定 / 尚未验证' },
    { value: 'local-only', label: '仅本机复现' },
    { value: 'deploy-only', label: '仅部署环境复现' },
    { value: 'both', label: '本机与部署都复现' },
  ],
  scope: [
    { value: 'unknown', label: '不确定' },
    { value: 'endpoint', label: '仅当前接口/页面' },
    { value: 'module', label: '同模块多个接口' },
    { value: 'service', label: '整个服务/多个模块' },
  ],
  change: [
    { value: 'unknown', label: '不确定' },
    { value: 'dependency', label: '依赖或版本升级' },
    { value: 'config', label: '配置/环境变量/部署脚本' },
    { value: 'code', label: '业务代码' },
    { value: 'none', label: '没有明显变更' },
  ],
};

export const TRIAGE_FIELDS = [
  { key: 'environment', label: '复现环境' },
  { key: 'scope', label: '影响范围' },
  { key: 'change', label: '最近变更' },
];
