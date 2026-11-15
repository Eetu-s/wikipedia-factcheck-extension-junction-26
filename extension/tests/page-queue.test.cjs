// Queue regressions without a browser: real controller, deterministic transport and clock.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(visibleIds = new Set(), count = 100) {
  let now = 0, nextId = 0, scanId = 0, observer, snapshotValid = true, meta = {};
  const frames = new Map(), timers = new Map(), requests = [], listeners = [];
  const events = new Map(), viewportEvents = new Map(), documentEvents = new Map(), fontEvents = new Map();
  const reads = Array(count).fill(0);
  const sentences = reads.map((_, index) => ({
    id: String(index), text: `Claim ${index}.`, context: {}, isValid: () => snapshotValid,
    segments: [{ node: {} }],
    range: { getBoundingClientRect() {
      reads[index]++;
      const top = visibleIds.has(index) ? 10 : 2000;
      return { left: 0, right: 100, top, bottom: top + 20 };
    } },
  }));
  class TestDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    Date: TestDate, Uint8Array, innerWidth: 1000, innerHeight: 700,
    location: { href: "https://example.test/article" },
    crypto: { getRandomValues: value => value.fill(++scanId) },
    CSS: { highlights: new Map() }, Highlight: class extends Set { constructor(...ranges) { super(ranges); } },
    CSSStyleSheet: class { replaceSync() {} },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observer = this; }
      disconnect() { if (observer === this) observer = null; }
    },
    requestAnimationFrame(fn) { const id = ++nextId; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 0; }, clearInterval() {},
    window: {
      addEventListener(type, fn) { events.set(type, fn); },
      visualViewport: { addEventListener(type, fn) { viewportEvents.set(type, fn); } },
    },
    document: {
      adoptedStyleSheets: [], documentElement: {},
      addEventListener(type, fn) { documentEvents.set(type, fn); },
      fonts: { addEventListener(type, fn) { fontEvents.set(type, fn); } },
    },
    WikiFactArticle: { extract: () => ({ sentences, isValid: () => snapshotValid }) },
    WikiFactPageUI: { create: () => ({
      update(items, nextMeta) { meta = nextMeta; },
      isAnimating: () => false, clearAnimations() {}, hide() {}, destroy() {}, animateSentence() {},
    }) },
    chrome: { runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      async sendMessage(message) {
        if (message.type === "WFC_FAST_BATCH") return new Promise(resolve => {
          requests.push({ message, resolve, answered: new Set(), settled: false });
        });
        return {};
      },
    } },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../page-scan.js"), "utf8"), context);
  const result = { result: { check_id: "checked", decision: "SUPPORTED" } };
  function emit(request, index, answer = result) {
    const item = request.message.items[index];
    for (const listener of listeners) listener({
      type: "WFC_FAST_ITEM", scanId: request.message.scanId, batchId: request.message.batchId,
      sentenceId: item.sentenceId, answer,
    }, {}, () => {});
  }
  function finish(request, response = {}) { request.settled = true; request.resolve(response); }
  function answer(request, index, response = result) {
    assert.ok(!request.answered.has(index), "fixture must not answer an item twice");
    request.answered.add(index); emit(request, index, response);
    if (request.answered.size === request.message.items.length) finish(request);
  }
  return {
    reads, requests, controller: context.WikiFactPageScan, emit, answer, finish,
    get meta() { return meta; },
    geometryReads: () => reads.reduce((sum, count) => sum + count, 0),
    open: () => requests.filter(request => !request.settled).length,
    outstanding: () => requests.filter(request => !request.settled)
      .reduce((sum, request) => sum + request.message.items.length - request.answered.size, 0),
    viewport(ids, event = "scroll") {
      visibleIds.clear(); for (const id of ids) visibleIds.add(id);
      if (event.startsWith("visualViewport:")) viewportEvents.get(event.split(":")[1])();
      else if (event === "load") documentEvents.get(event)();
      else if (event === "loadingdone") fontEvents.get(event)();
      else if (event === "mutation") observer.callback([{ type: "attributes", target: {} }]);
      else events.get(event)();
    },
    scroll() { events.get("scroll")(); },
    invalidate() { snapshotValid = false; observer.callback([{ type: "characterData", target: {} }]); },
    frame() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); },
    answerBatch(request, response = result) {
      for (let index = 0; index < request.message.items.length; index++)
        if (!request.answered.has(index)) answer(request, index, response);
    },
    advance(time) {
      now += time;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    },
  };
}
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const ids = request => Array.from(request.message.items, item => Number(item.sentenceId));

(async () => {
  const middle = fixture(new Set([45, 46, 47, 48, 49, 50]));
  await middle.controller.start();
  assert.equal(middle.requests.length, 4, "four batches fill the initial 32-sentence budget");
  const firstIds = middle.requests.flatMap(ids);
  assert.deepEqual(firstIds.slice(0, 6), [45, 46, 47, 48, 49, 50], "visible sentences beat earlier offscreen text");
  assert.deepEqual(firstIds.slice(6), Array.from({ length: 26 }, (_, index) => index), "offscreen sentences retain article order");
  assert.ok(middle.reads.every(count => count <= 1));
  const beforeScroll = middle.geometryReads();
  for (let i = 0; i < 100; i++) middle.scroll();
  middle.frame();
  assert.equal(middle.geometryReads(), beforeScroll, "scrolling at capacity performs no geometry work");
  middle.answerBatch(middle.requests[0], { error: "Rate limited", status: 429, retryAfter: 1000 });
  await settle();
  const beforeCooldown = middle.geometryReads();
  for (let i = 0; i < 100; i++) middle.scroll();
  middle.frame();
  assert.equal(middle.geometryReads(), beforeCooldown, "cooldown suppresses geometry work");
  middle.advance(999);
  assert.equal(middle.requests.length, 4, "retry cannot start before cooldown ends");
  middle.advance(1);
  assert.equal(middle.requests.length, 5, "a freed slot resumes when cooldown expires");
  assert.ok(ids(middle.requests[4]).includes(45), "rate-limited visible sentences remain queued");
  await middle.controller.clear();

  for (const visible of [[], Array.from({ length: 10 }, (_, index) => index)]) {
    const full = fixture(new Set(visible), 1800);
    await full.controller.start();
    assert.equal(full.geometryReads(), 1800);
    for (let index = 0; index < full.requests.length; index++) {
      full.answerBatch(full.requests[index]); await settle(); full.frame();
      assert.ok(full.outstanding() <= 32); assert.ok(full.open() <= 6);
    }
    full.frame();
    assert.equal(full.requests.length, 225, "all 1,800 sentences get eight-sentence batches");
    assert.equal(full.meta.completed, 1800);
    assert.equal(full.geometryReads(), 1800, "stable viewport measures each sentence only once across a full scan");
    assert.ok(full.reads.every(count => count === 1));
    await full.controller.clear();
  }

  for (const event of ["scroll", "resize", "visualViewport:scroll", "visualViewport:resize", "load", "loadingdone", "mutation"]) {
    const moving = fixture(new Set([45, 46, 47, 48, 49, 50]));
    await moving.controller.start();
    const before = moving.geometryReads();
    moving.viewport([80, 81, 82, 83, 84, 85], event); moving.frame();
    assert.equal(moving.geometryReads(), before, `${event} at capacity does not read geometry`);
    moving.answerBatch(moving.requests[0]); await settle(); moving.frame();
    assert.deepEqual(ids(moving.requests[4]).slice(0, 6), [80, 81, 82, 83, 84, 85], `${event} invalidates cached visibility before refill`);
    assert.ok(moving.geometryReads() > before);
    await moving.controller.clear();
  }

  const pipeline = fixture(new Set(), 1800);
  await pipeline.controller.start();
  const initial = pipeline.requests.slice();
  for (const request of initial) for (let index = 0; index < 2; index++) pipeline.answer(request, index);
  await settle(); pipeline.frame();
  assert.equal(pipeline.requests.length, 5, "eight streamed answers open a fifth batch before any initial transport settles");
  assert.equal(pipeline.open(), 5); assert.equal(pipeline.outstanding(), 32);
  for (const request of initial) for (let index = 2; index < 4; index++) pipeline.answer(request, index);
  await settle(); pipeline.frame();
  assert.equal(pipeline.requests.length, 6, "a sixth transport overlaps earlier stragglers");
  assert.equal(pipeline.outstanding(), 32);
  for (const request of initial) for (let index = 4; index < 6; index++) pipeline.answer(request, index);
  await settle(); pipeline.frame();
  assert.equal(pipeline.requests.length, 6, "open batches remain bounded at six with spare sentence budget");
  assert.equal(pipeline.outstanding(), 24);
  pipeline.answerBatch(initial[0]); await settle(); pipeline.frame();
  assert.equal(pipeline.requests.length, 7, "closing a transport permits another bounded refill");
  assert.ok(pipeline.open() <= 6); assert.ok(pipeline.outstanding() <= 32);
  await pipeline.controller.clear();

  const rate = fixture();
  await rate.controller.start();
  for (let index = 0; index < 7; index++) rate.answer(rate.requests[0], index);
  rate.answer(rate.requests[1], 0, { error: "Rate limited", status: 429, retryAfter: 1000 });
  await settle(); rate.frame();
  assert.equal(rate.requests.length, 4, "one streamed 429 immediately blocks a ready refill");
  rate.advance(999); rate.frame(); assert.equal(rate.requests.length, 4);
  rate.advance(1); rate.frame(); assert.equal(rate.requests.length, 5);
  rate.controller.stop(); rate.frame(); rate.advance(10000);
  assert.equal(rate.requests.length, 5, "stop cancels refill frames and cooldown wakeups");
  await rate.controller.clear();

  // Cancellation ACK precedes request settlement; retry must drain every old batch.
  const retry = fixture();
  await retry.controller.start();
  const old = retry.requests.slice();
  retry.controller.stop(); const retrying = retry.controller.retry(); await settle();
  retry.finish(old[2], { stale: true }); await settle(); retry.frame();
  assert.equal(retry.requests.length, 4, "retry waits beyond ACK and the first old batch");
  retry.finish(old[0], { stale: true }); retry.finish(old[3], { stale: true }); await settle();
  assert.equal(retry.requests.length, 4, "retry waits for every old batch");
  retry.finish(old[1], { stale: true }); await retrying; retry.frame();
  assert.equal(retry.requests.length, 8);
  assert.notEqual(retry.requests[4].message.batchId, old[0].message.batchId);
  retry.emit(old[0], 0); retry.frame();
  assert.equal(retry.meta.completed, 0, "late old item cannot consume the new waiting entry");
  retry.answer(retry.requests[4], 0); retry.frame();
  assert.equal(retry.meta.completed, 1, "actual retried answer survives old messages");
  await retry.controller.clear();

  // Retrying a failed item while its original transport is still open also reuses
  // its sentence ID. Neither an old duplicate nor that transport's fallback owns it.
  const partialRetry = fixture();
  await partialRetry.controller.start();
  const original = partialRetry.requests[0];
  partialRetry.answer(original, 0, { error: "Temporary error", status: 503 });
  await partialRetry.controller.retry();
  for (let index = 0; index < 7; index++) partialRetry.answer(partialRetry.requests[1], index);
  await settle(); partialRetry.frame();
  assert.equal(partialRetry.requests.length, 5);
  assert.equal(ids(partialRetry.requests[4])[0], ids(original)[0]);
  partialRetry.emit(original, 0);
  partialRetry.finish(original, { error: "Transport ended" });
  await settle(); partialRetry.frame();
  assert.equal(partialRetry.meta.completed, 7);
  partialRetry.answer(partialRetry.requests[4], 0); partialRetry.frame();
  assert.equal(partialRetry.meta.completed, 8, "a retry survives an open old transport's late item and fallback");
  await partialRetry.controller.clear();

  const restart = fixture();
  await restart.controller.start(); const abandoned = restart.requests.slice();
  await restart.controller.clear(); await restart.controller.start();
  const fresh = restart.requests[4];
  assert.notEqual(fresh.message.scanId, abandoned[0].message.scanId);
  for (const request of abandoned) restart.answerBatch(request);
  await settle(); restart.frame();
  assert.equal(restart.requests.length, 8, "old transport settlement cannot refill a new scan");
  assert.equal(restart.meta.completed, 0);
  restart.answer(fresh, 0); restart.frame(); assert.equal(restart.meta.completed, 1);
  restart.invalidate(); restart.frame();
  restart.answerBatch(fresh); await settle(); restart.frame();
  assert.equal(restart.requests.length, 8, "invalidated snapshots reject late results and refills");
  assert.ok(restart.meta.changed);
  await restart.controller.clear();
  console.log("Page queue passed: 1,800 sentences / 1,800 geometry reads; viewport invalidation; streamed pipelining (32 sentences, six batches); immediate cooldown; stop/retry races; stale/clear cleanup.");
})().catch(error => { console.error(error); process.exitCode = 1; });
