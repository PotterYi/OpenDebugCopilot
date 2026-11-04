export function pageHtml(apiBase = '', extraHeaders = {}) {
  return `<!doctype html>
<html><body>
  <h2>Manual E2E Frontend</h2>
  <button id="create">创建订单</button>
  <pre id="result">等待点击…</pre>
  <script>
    let apiBase = String(${JSON.stringify(apiBase)});
    const extraHeaders = ${JSON.stringify(extraHeaders)};
    while (apiBase.endsWith('/')) apiBase = apiBase.slice(0, -1);
    document.getElementById('create').addEventListener('click', async () => {
      const result = document.getElementById('result');
      try {
        const response = await fetch(apiBase + '/api/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...extraHeaders },
          body: JSON.stringify({ qty: 2, orderId: 'ORD-MANUAL-001' }),
        });
        const text = await response.text();
        result.textContent = 'HTTP ' + response.status + String.fromCharCode(10) + text;
        document.title = 'ok';
      } catch (error) {
        result.textContent = '请求失败：' + error.message;
        document.title = 'blocked:' + error.message;
      }
    });
  </script>
</body></html>`;
}
