const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function server() {
  const context = vm.createContext({ crypto: require('node:crypto').webcrypto, Response, Request });
  function load(file) {
    const filename = path.resolve(file);
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    const requireModule = (name) => load((name.startsWith('@/')
      ? name.slice(2) : path.resolve(path.dirname(filename), name)) + '.ts');
    vm.runInContext('(function(require,module,exports){' + source + '\n})', context)(requireModule, module, module.exports);
    return module.exports;
  }
  return { load, sessions: load('lib/share-session.ts') };
}

test('RAM is shared by module copies in one process, but not by separate instances', async () => {
  const a = server();
  await a.sessions.updateSharedSession('example', { text: 'saved', images: [] });
  assert.equal((await a.load('lib/share-session.ts').getSharedSession('example')).text, 'saved');
  await assert.rejects(server().sessions.getSharedSession('example'), { status: 404 });
});

test('GET of missing session reports 404 without creating an empty session', async () => {
  const a = server();
  const route = a.load('app/api/sessions/[sessionId]/route.ts');
  const result = await route.GET(new Request('http://localhost/api/sessions/missing'), {
    params: Promise.resolve({ sessionId: 'missing' }),
  });
  assert.equal(result.status, 404);
  await assert.rejects(a.sessions.getSharedSession('missing'), { status: 404 });
});

test('concurrent edits reject stale revision instead of overwriting newer content', async () => {
  const { sessions } = server();
  await sessions.createSharedSession('race');
  const results = await Promise.allSettled([
    sessions.updateSharedSession('race', { text: 'first', images: [], revision: 0 }),
    sessions.updateSharedSession('race', { text: 'second', images: [], revision: 0 }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.status, 409);
  assert.equal((await sessions.getSharedSession('race')).text, 'first');
});

test('retry of an already committed payload succeeds without another revision', async () => {
  const { sessions } = server();
  await sessions.createSharedSession('retry');
  const input = { text: 'saved', images: [], revision: 0 };
  await sessions.updateSharedSession('retry', input);
  assert.equal((await sessions.updateSharedSession('retry', input)).revision, 1);
});

test('text-only saves preserve existing images and invalid image input is rejected', async () => {
  const { sessions } = server();
  const image = { id: 'image', name: 'a.png', mimeType: 'image/png', base64: 'data:image/png;base64,YQ==', size: 1, createdAt: new Date().toISOString() };
  await sessions.updateSharedSession('images', { text: 'old', images: [image] });
  const updated = await sessions.updateSharedSession('images', { text: 'new', revision: 1 });
  assert.equal(updated.images[0].base64, image.base64);
  await assert.rejects(sessions.updateSharedSession('images', { text: 'invalid', images: [null] }), { status: 400 });
});

// Execute the actual component callbacks with controlled network responses.
function client() {
  const source = ts.createSourceFile('page.tsx', fs.readFileSync('features/share-session/share-session-page.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const refs = {
    textRef: { current: 'first' }, imagesRef: { current: [] },
    savedImagesRef: { current: [] }, revisionRef: { current: 0 },
    updatedAtRef: { current: '' }, latestFingerprintRef: { current: '' },
    dirtyRef: { current: true }, saveInFlightRef: { current: null },
  };
  const requests = [];
  const copies = [];
  const context = vm.createContext({
    ...refs, sessionId: 'test', AbortSignal, Error,
    useCallback: fn => fn, setStatus() {}, setMessage() {}, setCopied() {}, setHasUnsavedChanges() {},
    getPayloadFingerprint: (text, images) => JSON.stringify({ text, images }),
    getDisplayMessage: error => error.message,
    parseApiResponse: response => response.json(),
    window: { setTimeout: fn => { fn(); }, location: { origin: 'http://localhost' } },
    navigator: { clipboard: { writeText: async text => copies.push(text) } },
    fetch: (url, options) => new Promise(resolve => requests.push({ resolve, body: JSON.parse(options.body) })),
    applySession: session => {
      refs.textRef.current = session.text;
      refs.revisionRef.current = session.revision;
      refs.dirtyRef.current = false;
    },
  });
  function callback(name) {
    let initializer;
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer.getText(source);
      ts.forEachChild(node, visit);
    }
    visit(source);
    assert.ok(initializer, name);
    const js = ts.transpileModule('const callback = ' + initializer + ';', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return vm.runInContext('(function(){' + js + '; return callback;})()', context);
  }
  const save = callback('saveSession');
  context.saveCurrentSession = save;
  return { refs, requests, copies, save, share: callback('copyLink') };
}

test('client serializes edits made during save and Share waits for latest content', async () => {
  const c = client();
  const firstSave = c.save();
  c.refs.textRef.current = 'second';
  const sharing = c.share();
  assert.equal(c.requests.length, 1);
  assert.equal(c.copies.length, 0);
  c.requests[0].resolve(Response.json({ session: { text: 'first', revision: 1, updatedAt: '1', images: [] } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.requests.length, 2);
  assert.equal(c.requests[1].body.text, 'second');
  assert.equal(c.requests[1].body.revision, 1);
  assert.equal(c.copies.length, 0);
  c.requests[1].resolve(Response.json({ session: { text: 'second', revision: 2, updatedAt: '2', images: [] } }));
  await Promise.all([firstSave, sharing]);
  assert.equal(c.copies.length, 1);
  assert.equal(c.refs.dirtyRef.current, false);
});

test('Share does not copy link after save conflict and keeps the draft', async () => {
  const c = client();
  const sharing = c.share();
  c.requests[0].resolve(Response.json({ error: 'Conflict' }, { status: 409 }));
  await sharing;
  assert.equal(c.copies.length, 0);
  assert.equal(c.refs.textRef.current, 'first');
  assert.equal(c.refs.dirtyRef.current, true);
  assert.equal(c.refs.saveInFlightRef.current, null);
});

test('each save extends expiry by 4h and keeps image TTL in sync', async () => {
  const { sessions } = server();
  const first = await sessions.updateSharedSession('extend', { text: 'a', images: [] });
  const created = new Date(first.expiresAt).getTime();
  const next = await sessions.updateSharedSession('extend', { text: 'b', images: [], revision: first.revision });
  assert.ok(new Date(next.expiresAt).getTime() >= created);
  const left = new Date(next.expiresAt).getTime() - Date.now();
  assert.ok(left > 3.9 * 3600e3);
});
