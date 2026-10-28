import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// Exercise the shipped single-file loader, slot registration, hooks and native
// elements without installing React or changing the local DSH installation.
function harness(language = 'zh', slot = 'settings.section') {
  let cursor = 0;
  const hooks = [];
  const effects = [];
  const timers = new Map();
  let nextTimer = 0, currentModel = { provider: 'anthropic', model: 'claude-offline-6' };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = initial;
      return [hooks[i], (value) => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }];
    },
    useRef(value) { const i = cursor++; return hooks[i] ??= { current: value }; },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!same(hooks[i]?.deps, deps)) hooks[i] = { fn, deps };
      return hooks[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!same(hooks[i]?.deps, deps)) {
        const previous = hooks[i];
        hooks[i] = { deps };
        effects.push(() => { previous?.cleanup?.(); hooks[i].cleanup = fn(); });
      }
    }
  };
  let factory;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (value) => { factory = value.factory; } } }, Intl, Date, navigator: {}, setInterval: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearInterval: id => timers.delete(id) });
  const exports = factory((id) => { assert.equal(id, 'react'); return React; });
  const pending = [];
  const rpc = { call(_api, endpoint, payload) {
    return new Promise((resolve, reject) => pending.push({ endpoint: endpoint.replace('claude-subscription/', ''), payload, resolve, reject }));
  } };
  let section, props, dictionary;
  exports.apply({
    locale: { bind: () => (key) => dictionary[key] ?? key, register: (_namespace, dictionaries) => { dictionary = dictionaries[language]; } },
    effect: (fn) => fn(), get: name => name === 'modelDirectories' ? { directoryFor: () => ({ load: async () => ({ current: currentModel }) }) } : ({ rpc }),
    slots: { inject: (_slot, fn) => fn(), register: (metadata, component) => { if (metadata.name === slot) { section = component; props = metadata.inject('offline-session'); } } }
  });
  const expand = (node) => {
    if (node == null || typeof node === 'boolean') return null;
    if (Array.isArray(node)) return node.flatMap((n) => [expand(n)]).filter((n) => n != null);
    if (typeof node !== 'object') return String(node);
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return { ...node, props: { ...node.props, children: expand(node.props.children) } };
  };
  const render = () => {
    cursor = 0;
    const tree = expand(React.createElement(section, props));
    effects.splice(0).forEach((fn) => fn());
    return tree;
  };
  const pure = (name, props) => expand(React.createElement(exports[name], { t: (key) => dictionary[key] ?? key, ...props }));
  const request = (endpoint) => {
    const index = pending.findIndex((entry) => entry.endpoint === endpoint);
    assert.notEqual(index, -1, `Missing ${endpoint} RPC`);
    return pending.splice(index, 1)[0];
  };
  const respond = async (req, value) => { req.resolve({ ok: true, value }); await tick(); };
  return { render, pure, request, respond, pending, poll: () => timers.forEach(fn => { void fn(); }), setModel: model => { currentModel = model; } };
}

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const nodes = (node) => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props.children)];
const text = (node) => node == null ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props.children) : String(node);
const button = (tree, label) => {
  const found = nodes(tree).find((n) => n.type === 'button' && text(n).trim() === label);
  assert.ok(found, `Missing button ${label}`);
  return found.props.onClick;
};
const accounts = [
  { id: 'claude-mv-secret-a', label: 'Claude 1', displayName: 'Alice Example', email: `${'long'.repeat(30)}@example.com`, plan: 'Max', organizationName: 'Example team' },
  { id: 'claude-mv-secret-b', label: 'Claude 2', email: 'bob@example.com' }
];
const status = (activeId = accounts[0].id) => ({ signedIn: true, activeId, accounts, models: [], identity: { userAgent: 'claude-code/1.0', appHeader: 'cli', identityPrefix: 'You are Claude' } });
const quota = (accountId = accounts[0].id, remainingPercent = 66) => ({ accountId, windows: [{ window: 'daily', utilization: 100 - remainingPercent, remainingPercent, resetsAt: '2030-05-01T09:00:00Z' }] });
async function mounted(activeId = accounts[0].id) {
  const h = harness();
  h.render();
  await h.respond(h.request('status'), status(activeId));
  // 面板打开后会自动读一次额度；这里用空窗口占位，具体数值由各测试自己点。
  h.render();
  await h.respond(h.request('quota'), { accountId: activeId, windows: [] });
  return h;
}

test('real account name/email, no internal ID/default label; host font and narrow layout', async () => {
  const h = await mounted();
  const tree = h.render();
  assert.match(text(tree), /Alice Example/);
  assert.match(text(tree), /bob@example.com/);
  assert.doesNotMatch(text(tree), /claude-mv|Claude [12]|monospace/);
  assert.equal(nodes(tree).filter((n) => n.type === 'dl').length, 1);
  for (const n of nodes(tree)) {
    assert.doesNotMatch(JSON.stringify(n.props.style ?? {}), /monospace/);
    if (['button', 'input', 'progress'].includes(n.type)) assert.equal(n.props.style.fontFamily, 'inherit');
  }
  const identity = h.pure('AccountIdentity', { account: accounts[0] });
  assert.equal(identity.props.style.minWidth, 0);
  assert.equal(identity.props.style.overflowWrap, 'anywhere');
  assert.match(text(h.pure('AccountIdentity', { account: { id: accounts[0].id, label: 'Claude 1' } })), /账号资料暂未获取/);
  assert.doesNotMatch(text(h.pure('AccountIdentity', { account: { id: accounts[0].id, label: accounts[0].id } })), /claude-mv/);
});

test('independent quota cards show remaining 66 with native progress and local + relative reset', () => {
  const h = harness();
  const tree = h.pure('QuotaCards', { quota: { windows: [...quota().windows, { window: 'weekly', utilization: 75, remainingPercent: 25 }] }, now: Date.parse('2030-05-01T08:00:00Z') });
  assert.deepEqual(nodes(tree).filter((n) => n.type === 'progress').map((n) => n.props.value), [66, 25]);
  assert.match(text(tree), /66%/);
  assert.match(text(tree), /每日额度/);
  assert.match(text(tree), /每周额度/);
  assert.match(text(tree), /1小时后/);
  assert.match(text(tree), /重置时间暂未获取/);
  assert.equal(nodes(tree).find((n) => n.type === 'time').props.dateTime, '2030-05-01T09:00:00.000Z');
  const grid = nodes(tree).find((n) => n.props.style?.gridTemplateColumns);
  assert.match(grid.props.style.gridTemplateColumns, /min\(100%, 190px\)/);
});

test('0 / 100 / clamping / unknown windows and object messages are handled without fabricated data', () => {
  const h = harness();
  const windows = [0, 100, -20, 120].map((remainingPercent) => ({ window: 'weekly', utilization: 0, remainingPercent }));
  windows.push({ window: 'daily', remainingPercent: '66', utilization: 34 }, { window: 'daily', remainingPercent: 66, utilization: NaN });
  const tree = h.pure('QuotaCards', { quota: { windows } });
  assert.deepEqual(nodes(tree).filter((n) => n.type === 'progress').map((n) => n.props.value), [0, 100, 0, 100]);
  const unknown = h.pure('QuotaCards', { quota: { message: { raw: 'secret' } } });
  assert.match(text(unknown), /额度资料暂未获取/);
  assert.doesNotMatch(text(unknown), /object Object|secret/);
  assert.equal(nodes(unknown).filter((n) => n.type === 'pre' || n.type === 'progress').length, 0);
  assert.match(text(h.pure('QuotaCards', { quota: { message: 'Service temporarily unavailable' } })), /Service temporarily unavailable/);
});

test('spend object respects enabled/currency/missing fields; never assumes dollars', () => {
  const h = harness('en');
  const disabled = h.pure('QuotaCards', { quota: { spend: { enabled: false, used: 0, utilization: 0 } } });
  assert.match(text(disabled), /Extra usage Disabled/);
  assert.equal(nodes(disabled).filter((n) => n.type === 'progress').length, 0);
  const unknown = h.pure('QuotaCards', { quota: { spend: { enabled: true, used: 2 } } });
  assert.match(text(unknown), /Used: 2/);
  assert.match(text(unknown), /Limit: Unavailable/);
  assert.doesNotMatch(text(unknown), /\$|USD|object Object/);
  const known = h.pure('QuotaCards', { quota: { spend: { enabled: true, used: 10, limit: 20, currency: 'EUR', utilization: 50 } }, locale: 'en-US' });
  assert.match(text(known), /€10.00/);
  assert.equal(nodes(known).find((n) => n.type === 'progress').props.value, 50);
});

test('switch clears immediately and discards previous-account quota and stale status', async () => {
  const h = await mounted();
  button(h.render(), '查询额度')();
  const oldQuota = h.request('quota');
  button(h.render(), '刷新')();
  const oldStatus = h.request('status');
  button(h.render(), '切换')();
  await h.respond(h.request('accounts/select'), {});
  const newStatus = h.request('status');
  await h.respond(newStatus, status(accounts[1].id));
  h.render();
  await h.respond(h.request('quota'), { accountId: accounts[1].id, windows: [] });
  await h.respond(oldQuota, quota());
  await h.respond(oldStatus, status());
  assert.doesNotMatch(text(h.render()), /66%/);
  button(h.render(), '查询额度')();
  await h.respond(h.request('quota'), quota(accounts[0].id));
  assert.doesNotMatch(text(h.render()), /66%/);
  button(h.render(), '查询额度')();
  await h.respond(h.request('quota'), quota(accounts[1].id));
  assert.match(text(h.render()), /66%/);
});

test('opening the panel reads quota once without pressing the button', async () => {
  const h = harness();
  h.render();
  await h.respond(h.request('status'), status());
  h.render();
  const auto = h.request('quota');
  await h.respond(auto, quota());
  assert.match(text(h.render()), /66%/);
  assert.equal(h.pending.filter((entry) => entry.endpoint === 'quota').length, 0);
});

test('latest same-account status/quota wins even when replies arrive out of order', async () => {
  const h = await mounted();
  button(h.render(), '查询额度')(); const first = h.request('quota');
  button(h.render(), '查询额度')(); const second = h.request('quota');
  await h.respond(second, quota(accounts[0].id, 90));
  await h.respond(first, quota(accounts[0].id, 10));
  assert.match(text(h.render()), /90%/);
  assert.doesNotMatch(text(h.render()), /10%/);
  button(h.render(), '刷新')(); const firstStatus = h.request('status');
  button(h.render(), '刷新')(); const secondStatus = h.request('status');
  await h.respond(secondStatus, status(accounts[1].id));
  await h.respond(firstStatus, status());
  h.render();
  await h.respond(h.request('quota'), { accountId: accounts[1].id, windows: [] });
  button(h.render(), '查询额度')();
  await h.respond(h.request('quota'), quota(accounts[0].id));
  assert.doesNotMatch(text(h.render()), /66%|90%/);
});

test('active removal and logout clear quota before RPC completion and ignore late quota', async () => {
  for (const action of ['remove', 'logout']) {
    const h = await mounted();
    button(h.render(), '查询额度')(); await h.respond(h.request('quota'), quota());
    assert.match(text(h.render()), /66%/);
    button(h.render(), '查询额度')(); const late = h.request('quota');
    if (action === 'remove') button(h.render(), '移除')();
    else button(h.render(), '退出登录')();
    assert.doesNotMatch(text(h.render()), /66%/);
    await h.respond(late, quota());
    assert.doesNotMatch(text(h.render()), /66%/);
    await h.respond(h.request(action === 'remove' ? 'accounts/remove' : 'logout'), {});
    await h.respond(h.request('status'), { signedIn: false, accounts: [] });
    assert.doesNotMatch(text(h.render()), /66%/);
  }
});

test('settings refresh model catalog, persist routing choice and show stale quota/refresh warnings', async () => {
  const h = await mounted();
  button(h.render(), '刷新模型目录')();
  await h.respond(h.request('models/refresh'), { accountId: accounts[0].id, models: [{ id: 'claude-new-6', name: 'New Claude' }], fetchedAt: '2030-01-01T00:00:00Z' });
  assert.match(text(h.render()), /New Claude/);
  const select = nodes(h.render()).find(node => node.type === 'select');
  select.props.onChange({ target: { value: 'priority' } });
  const req = h.request('routing/set'); assert.equal(req.payload.mode, 'priority');
  await h.respond(req, { mode: 'priority' });
  assert.equal(nodes(h.render()).find(node => node.type === 'select').props.value, 'priority');
  button(h.render(), '查询额度')();
  const read = h.request('quota'); assert.equal(read.payload.force, true);
  await h.respond(read, { ...quota(), stale: true });
  assert.match(text(h.render()), /上次成功的数据/);
  button(h.render(), '刷新')();
  await h.respond(h.request('status'), { ...status(), refreshState: { warning: '请重新登录测试账号', loginRequired: true } });
  assert.match(text(h.render()), /请重新登录测试账号/);
});

test('composer badge shows the serving account, freshness and model-scoped windows; hides on other routes', async () => {
  const h = harness('zh', 'conversation.composer.dock');
  h.render(); await tick();
  const req = h.request('quota'); assert.equal(req.payload.sessionId, 'offline-session'); assert.equal(req.payload.model, 'claude-offline-6');
  await h.respond(req, { ...quota(), accountName: 'Bob', defaultAccount: false, fetchedAt: '2030-01-01T00:00:00Z', stale: true,
    windows: [{ window: 'five_hour', scope: 'Opus', utilization: 34, remainingPercent: 66 }] });
  const tree = h.render(); assert.match(text(tree), /Claude 额度.*66%/);
  nodes(tree).find(node => node.type === 'button').props.onClick();
  assert.match(text(h.render()), /本会话实际账号: Bob/);
  assert.match(text(h.render()), /Opus/); assert.match(text(h.render()), /更新于/);
  h.setModel({ provider: 'other', model: 'other-model' }); h.poll(); await tick();
  assert.equal(h.render(), null); assert.equal(h.pending.length, 0);
});

test('composer discards a late quota response when the selected model changes', async () => {
  const h = harness('zh', 'conversation.composer.dock');
  h.render(); await tick(); const req = h.request('quota');
  h.setModel({ provider: 'other', model: 'other-model' });
  await h.respond(req, quota()); assert.equal(h.render(), null);
});
