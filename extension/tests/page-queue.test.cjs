// Queue regressions without a browser: real controller, deterministic transport and clock.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(visibleIds) {
  let now = 0, nextId = 0;
  const frames = new Map(), timers = new Map(), requests = [], listeners = [], windowEvents = new Map();
  const reads = Array(100).fill(0);
  const sentences = reads.map((_, index) => ({
    id: String(index), text: `Claim ${index}.`, context: {}, isValid: () => true,
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
    crypto: { getRandomValues: value => value.fill(1) },
    CSS: { highlights: new Map() }, Highlight: class extends Set { constructor(...ranges) { super(ranges); } },
    CSSStyleSheet: class { replaceSync() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame(fn) { const id = ++nextId; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 0; }, clearInterval() {},
    window: { addEventListener(type, fn) { windowEvents.set(type, fn); } },
    document: { adoptedStyleSheets: [], documentElement: {}, addEventListener() {} },
    WikiFactArticle: { extract: () => ({ sentences, isValid: () => true }) },
    WikiFactPageUI: { create: () => ({ update() {}, isAnimating: () => false, clearAnimations() {}, hide() {}, destroy() {}, animateSentence() {} }) },
    chrome: { runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      async sendMessage(message) {
        if (message.type === "WFC_FAST_BATCH") return new Promise(resolve => requests.push({ message, resolve }));
        return {};
      },
    } },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../page-scan.js"), "utf8"), context);
  return {
    reads, requests, controller: context.WikiFactPageScan,
    scroll() { windowEvents.get("scroll")(); },
    frame() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); },
    answerBatch(request, answer = { result: { check_id: "checked", decision: "SUPPORTED" } }) {
      for (const item of request.message.items) for (const listener of listeners)
        listener({ type: "WFC_FAST_ITEM", scanId: request.message.scanId, sentenceId: item.sentenceId, answer }, {}, () => {});
      request.resolve({});
    },
    advance(time) {
      now += time;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    },
  };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

(async () => {
  const middle = fixture(new Set([45, 46, 47, 48, 49, 50]));
  await middle.controller.start();
  assert.equal(middle.requests.length, 4, "four bounded batches start immediately");
  const firstIds = middle.requests.flatMap(request => Array.from(request.message.items, item => Number(item.sentenceId)));
  assert.deepEqual(firstIds.slice(0, 6), [45, 46, 47, 48, 49, 50], "visible sentences beat earlier offscreen text");
  assert.deepEqual(firstIds.slice(6), Array.from({ length: 26 }, (_, index) => index), "offscreen sentences retain article order");
  assert.ok(middle.reads.every(count => count <= 1), "prioritizing reads each candidate's geometry at most once");
  const beforeScroll = middle.reads.reduce((sum, count) => sum + count, 0);
  for (let i = 0; i < 100; i++) middle.scroll();
  middle.frame();
  assert.equal(middle.reads.reduce((sum, count) => sum + count, 0), beforeScroll, "scrolling with full request slots performs no queue geometry work");

  // A rate-limited batch frees a slot but its retry deadline still gates all new requests.
  middle.answerBatch(middle.requests[0], { error: "Rate limited", status: 429, retryAfter: 1000 });
  await settle();
  const beforeCooldown = middle.reads.reduce((sum, count) => sum + count, 0);
  for (let i = 0; i < 100; i++) middle.scroll();
  middle.frame();
  assert.equal(middle.reads.reduce((sum, count) => sum + count, 0), beforeCooldown, "batched scroll pumping respects cooldown without measuring text");
  middle.advance(999);
  assert.equal(middle.requests.length, 4, "retry cannot start before cooldown ends");
  middle.advance(1);
  assert.equal(middle.requests.length, 5, "a freed slot resumes when cooldown expires");
  assert.ok(middle.requests[4].message.items.some(item => item.sentenceId === "45"), "rate-limited visible sentences remain in the finite retry queue");
  await middle.controller.clear();

  const top = fixture(new Set(Array.from({ length: 60 }, (_, index) => index)));
  await top.controller.start();
  assert.equal(top.reads.reduce((sum, count) => sum + count, 0), 32, "enough visible work fills slots without measuring the rest of the article");
  top.answerBatch(top.requests[0], { error: "Rate limited", status: 429, retryAfter: 1000 });
  await settle();
  top.scroll();
  top.controller.stop();
  top.frame();
  top.advance(1000);
  assert.equal(top.requests.length, 4, "stopping cancels queued scroll work and retry wakeups");
  await top.controller.clear();
  console.log("Page queue passed: visible priority, bounded geometry, no full-slot scroll work, cooldown/retry, stop cleanup.");
})().catch(error => { console.error(error); process.exitCode = 1; });
