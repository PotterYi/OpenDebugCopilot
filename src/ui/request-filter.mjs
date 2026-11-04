/** Request list filters: backend API calls vs. frontend scripts. */

export const REQUEST_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'backend', label: '后端请求' },
  { id: 'script', label: '前端 Script' },
];

export function matchesRequestFilter(item, filter = 'all') {
  const type = String(item?.resourceType ?? '').toLowerCase();
  if (filter === 'backend') return type === 'xhr' || type === 'fetch';
  if (filter === 'script') return type === 'script';
  return true;
}
