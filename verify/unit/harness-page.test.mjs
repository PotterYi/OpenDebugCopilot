import test from 'node:test';
import assert from 'node:assert/strict';
import { pageHtml } from '../manual/page.mjs';

function extractScript(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'harness page must contain a script block');
  return match[1];
}

function createDom() {
  const listeners = {};
  const elements = {
    create: { addEventListener: (type, handler) => { listeners[type] = handler; } },
    result: { textContent: '' },
  };
  return {
    document: {
      title: '',
      getElementById: (id) => elements[id] ?? { addEventListener() {}, textContent: '' },
    },
    elements,
    listeners,
  };
}

test('manual harness click handler actually performs the POST and renders the result', async () => {
  const script = extractScript(pageHtml());
  const { document, elements, listeners } = createDom();
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return { status: 500, text: async () => '{"error":"inventory"}' };
  };

  new Function('document', 'fetch', script)(document, fetch);
  assert.equal(typeof listeners.click, 'function', 'click handler must be registered');
  await listeners.click();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/order');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.match(elements.result.textContent, /HTTP 500/);
  assert.match(elements.result.textContent, /inventory/);
  assert.equal(document.title, 'ok');
});

test('manual harness click handler reports fetch failures', async () => {
  const script = extractScript(pageHtml());
  const { document, elements, listeners } = createDom();
  const fetch = async () => { throw new Error('Failed to fetch'); };

  new Function('document', 'fetch', script)(document, fetch);
  await listeners.click();

  assert.match(elements.result.textContent, /请求失败/);
  assert.match(elements.result.textContent, /Failed to fetch/);
  assert.match(document.title, /^blocked:/);
});
