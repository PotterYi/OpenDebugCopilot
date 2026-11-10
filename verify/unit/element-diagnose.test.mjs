import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { runElementDiagnosis } from '../../src/diagnose/run.mjs';
import { collectElementEvidence } from '../../src/evidence/element.mjs';
import { tempDir } from './tmp.mjs';

const TMP = tempDir('element-diagnose-test');

test('diagnoses a page element with component evidence and element gates', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  const frontendProjectRoot = path.join(TMP, 'frontend');
  const sourceRoot = path.join(TMP, 'backend');
  const componentFile = path.join(frontendProjectRoot, 'src/views/UserList.vue');
  await mkdir(path.dirname(componentFile), { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(frontendProjectRoot, 'package.json'), JSON.stringify({
    name: 'frontend',
    scripts: { build: 'vite build' },
  }), 'utf8');
  await writeFile(componentFile, [
    '<template>',
    '  <div class="user-table">用户列表显示不完整</div>',
    '</template>',
    '',
    '<script setup>',
    'import { listUser } from "@/api/system/user";',
    '</script>',
  ].join('\n'), 'utf8');
  await mkdir(path.join(frontendProjectRoot, 'src/api/system'), { recursive: true });
  await writeFile(path.join(frontendProjectRoot, 'src/api/system/user.js'), [
    "import request from '@/utils/request';",
    'export function listUser(query) {',
    "  return request({ url: '/system/user/list', method: 'get', params: query });",
    '}',
  ].join('\n'), 'utf8');
  await mkdir(path.join(sourceRoot, 'com/demo'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'com/demo/SysUserController.java'), [
    '@RestController',
    '@RequestMapping("/system/user")',
    'public class SysUserController {',
    '    @GetMapping("/list")',
    '    public Object list() { return null; }',
    '}',
  ].join('\n'), 'utf8');
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });

  const element = {
    id: 'element-test-1',
    capturedAt: Date.now(),
    page: { url: 'http://localhost:5173/system/user', title: '用户管理', route: '/system/user' },
    selector: '#app > div.user-table',
    tag: 'div',
    classes: ['user-table'],
    text: '用户列表显示不完整',
    attributes: { class: 'user-table' },
    html: '<div class="user-table">用户列表显示不完整</div>',
    rect: { x: 10, y: 20, width: 300, height: 40, top: 20, left: 10, bottom: 60, right: 310 },
    styles: { display: 'block', width: '300px', color: 'rgb(0,0,0)' },
    ancestors: [{ tag: 'body', selector: 'body' }],
    framework: {
      name: 'vue3',
      componentName: 'UserList',
      componentFile: '/src/views/UserList.vue',
      hierarchy: ['App', 'UserList'],
      confidence: 'high',
    },
    nearbyRequests: [{ method: 'GET', url: '/system/user/list', status: 200 }],
    screenshotDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zt9sAAAAASUVORK5CYII=',
  };

  const agent = {
    id: 'element-agent',
    async diagnose({ evidence }) {
      assert.equal(evidence.element.selector, '#app > div.user-table');
      assert.match(evidence.element.source?.content ?? '', /listUser/);
      return {
        conclusion: '表格容器宽度不足，导致用户列表显示不完整',
        evidenceRefs: [{ type: 'element', ref: 'element.selector' }],
        confidence: 0.8,
        needsMoreInfo: [],
        fixes: [],
      };
    },
  };

  const { result, runDir } = await runElementDiagnosis(element, {
    workspace: {
      sourceRoot,
      frontendProjectRoot,
      logfiles: [],
      window: { beforeMs: 1000, afterMs: 1000 },
      agent: { toolMode: 'readonly' },
    },
    root: TMP,
    runsDir: path.join(TMP, 'runs'),
    question: '用户列表显示不完整',
    agent,
    databases: [],
    preflight: { ok: true, checks: [], databases: [] },
  });

  assert.equal(result.target.driver, 'element');
  assert.equal(result.target.componentFile, '/src/views/UserList.vue');
  assert.equal(result.element.framework.componentName, 'UserList');
  assert.match(result.element.source.content, /listUser/);
  assert.equal(result.element.screenshot, 'evidence/element.png');
  await access(path.join(runDir, 'evidence', 'element.png'));
  assert.equal(result.element.screenshotDataUrl, undefined);
  assert.equal(result.element.apiCandidates[0].url, '/system/user/list');
  assert.equal(result.element.apiCandidates[0].method, 'GET');
  assert.ok(result.element.backendCandidates.some((candidate) => (
    candidate.file.includes('SysUserController.java')
  )));
  assert.equal(result.gates.ok, true, JSON.stringify(result.gates.checks));
  assert.ok(result.gates.checks.some((check) => check.name === 'element-captured' && check.ok));
  const persisted = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'));
  assert.equal(persisted.element.selector, '#app > div.user-table');
});

test('falls back to route/text search when framework metadata is unavailable', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  const frontend = path.join(TMP, 'frontend');
  const file = path.join(frontend, 'src/views/system/user/index.vue');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(path.join(frontend, 'package.json'), '{}', 'utf8');
  await writeFile(file, [
    '<template>',
    '  <el-table prop="userName">用户列表显示不完整</el-table>',
    '</template>',
  ].join('\n'), 'utf8');
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });

  const { element } = await collectElementEvidence({
    element: {
      page: { url: 'http://localhost:5173/system/user', route: '/system/user' },
      selector: 'div.el-table',
      text: '用户列表显示不完整',
      attributes: { prop: 'userName' },
      classes: ['el-table'],
      framework: null,
    },
    frontendProjectRoot: frontend,
    frontendSourceRoot: path.join(frontend, 'src'),
  });
  assert.equal(element.componentCandidates[0].file, 'src/views/system/user/index.vue');
  assert.ok(element.componentCandidates[0].score > 0);
  assert.match(element.source.content, /用户列表显示不完整/);
});
