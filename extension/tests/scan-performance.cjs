// Run: NODE_PATH=/tmp/wfc-tests/node_modules node extension/tests/scan-performance.cjs [sourceDir] [outputJson]
// Local synthetic benchmark; requests are mocked and no backend or network is used.
// BENCH_LOADING_ONLY=1 runs just startup and loading; BENCH_PROFILE=path saves a CPU profile.
// Continuous rAF samples simulate a busy page and expose masks that repaint per frame.
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const sourceDir = process.argv[2] || path.resolve(__dirname, '..');
const outputPath = process.argv[3] || path.join(os.tmpdir(), 'wfc-scan-performance.json');
const streamCount = Number(process.env.BENCH_STREAM_COUNT || 80);
const selectedMetrics = ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration', 'ScriptDuration'];

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto('about:blank');
    await page.setContent(`<html lang="en"><head><title>Science history</title><style>
      body{margin:24px;background:#fff;color:#111}article{width:1050px;font:16px/1.6 Georgia,serif}
      p{margin:0 0 6px}a{color:#18519d}strong{font-weight:700}
      </style></head><body><article>${Array.from({ length: 1800 }, (_, i) => `<p id="p${i}">Research station ${i} was founded in <strong>1957</strong> and studies atmospheric conditions near the <a href="https://example.org">polar coast</a>.</p>`).join('')}</article></body></html>`);
    await page.evaluate(() => {
      window.bench = { listeners: [], requests: [], answered: 0, bounding: 0, rects: 0, animateCalls: 0, peakAnimations: 0, peakOverlayNodes: 0, longTasks: [], frameGaps: [] };
      let previousFrame;
      function sampleFrame(now) {
        if (previousFrame !== undefined) bench.frameGaps.push(now - previousFrame);
        previousFrame = now;
        requestAnimationFrame(sampleFrame);
      }
      requestAnimationFrame(sampleFrame);
      for (const method of ['getBoundingClientRect', 'getClientRects']) {
        const original = Range.prototype[method];
        Range.prototype[method] = function(...args) {
          bench[method === 'getBoundingClientRect' ? 'bounding' : 'rects']++;
          return original.apply(this, args);
        };
      }
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(...args) {
        bench.animateCalls++;
        return animate.apply(this, args);
      };
      new PerformanceObserver(list => {
        bench.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })));
      }).observe({ type: 'longtask', buffered: true });
      window.chrome = { runtime: {
        onMessage: { addListener(listener) { bench.listeners.push(listener); } },
        sendMessage(message) {
          if (message.type !== 'WFC_FAST_BATCH') return Promise.resolve({});
          const batch = { remaining: message.items.length, resolve: null };
          return new Promise(resolve => {
            batch.resolve = resolve;
            for (const item of message.items) bench.requests.push({ message: { ...message, ...item }, batch, finished: false });
          });
        },
      } };
      bench.sample = () => {
        const host = document.querySelector('[data-wfc-ui]');
        const shadow = host?.shadowRoot;
        const active = shadow?.getAnimations?.({ subtree: true }).filter(item => item.playState !== 'finished' && item.playState !== 'idle').length || 0;
        const nodes = shadow?.querySelectorAll('.sentence-animation *').length || 0;
        bench.peakAnimations = Math.max(bench.peakAnimations, active);
        bench.peakOverlayNodes = Math.max(bench.peakOverlayNodes, nodes);
        return { bounding: bench.bounding, rects: bench.rects, animateCalls: bench.animateCalls, activeAnimations: active, overlayNodes: nodes,
          peakAnimations: bench.peakAnimations, peakOverlayNodes: bench.peakOverlayNodes, requests: bench.requests.length, answered: bench.answered,
          checked: shadow?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'),
          sentences: shadow?.querySelector('select')?.options.length,
          frameCount: bench.frameGaps.length, longTasks: bench.longTasks.length, longTaskDuration: bench.longTasks.reduce((sum, item) => sum + item.duration, 0) };
      };
      bench.answer = request => {
        request.finished = true;
        const answer = { result: { check_id: 'benchmark-check-' + ++bench.answered,
          decision: bench.answered % 3 === 0 ? 'REFUTED' : 'SUPPORTED', confidence: .9, sources: [] } };
        for (const listener of bench.listeners) listener({ type: 'WFC_FAST_ITEM', scanId: request.message.scanId, sentenceId: request.message.sentenceId, answer }, {}, () => {});
        if (--request.batch.remaining === 0) request.batch.resolve({});
      };
    });
    for (const file of ['vendor/Readability.js', 'article.js', 'page-ui.js', 'page-scan.js'])
      await page.addScriptTag({ path: path.resolve(sourceDir, file) });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => {
      const values = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
      return Object.fromEntries(selectedMetrics.map(name => [name, values[name] || 0]));
    };
    const stages = {};
    const measure = async (name, action) => {
      const before = await metrics();
      const beforeCounts = await page.evaluate(() => bench.sample());
      const start = Date.now();
      await action();
      const after = await metrics();
      const afterCounts = await page.evaluate(() => bench.sample());
      const frameGaps = await page.evaluate(index => bench.frameGaps.slice(index), beforeCounts.frameCount);
      const sortedGaps = frameGaps.toSorted((a, b) => a - b);
      stages[name] = { wallMs: Date.now() - start,
        frames: { count: frameGaps.length, p95GapMs: +(sortedGaps[Math.floor(sortedGaps.length * .95)] || 0).toFixed(2),
          maxGapMs: +(sortedGaps.at(-1) || 0).toFixed(2), over50ms: frameGaps.filter(gap => gap > 50).length },
        metrics: Object.fromEntries(selectedMetrics.map(key => [key, +(after[key] - before[key]).toFixed(6)])),
        work: Object.fromEntries(['bounding', 'rects', 'animateCalls', 'answered', 'longTasks', 'longTaskDuration'].map(key => [key, afterCounts[key] - beforeCounts[key]])),
        state: afterCounts,
      };
    };
    await measure('startup', async () => {
      await page.evaluate(() => WikiFactPageScan.start());
      await page.waitForFunction(() => bench.requests.length >= 32);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    });
    const traceEvents = [];
    cdp.on('Tracing.dataCollected', event => traceEvents.push(...event.value));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline', options: 'record-as-much-as-possible' });
    await measure('loading1500ms', async () => { await page.waitForTimeout(1500); });
    const traceComplete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    await traceComplete;
    stages.loading1500ms.trace = Object.fromEntries(['Paint', 'PrePaint', 'Layout', 'UpdateLayoutTree', 'CompositeLayers'].map(name =>
      [name, traceEvents.filter(event => event.name === name && event.ph === 'X').length]));
    if (!process.env.BENCH_LOADING_ONLY) {
      if (process.env.BENCH_PROFILE) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.start');
      }
      await measure('stream' + streamCount, async () => {
        await page.evaluate(async count => {
          for (let i = 0; i < count; i++) {
            const request = bench.requests.find(item => !item.finished);
            if (!request) throw new Error('No pending benchmark request');
            bench.answer(request);
            await new Promise(resolve => setTimeout(resolve, 24));
            bench.sample();
          }
        }, streamCount);
      });
      if (process.env.BENCH_PROFILE) {
        const { profile } = await cdp.send('Profiler.stop');
        fs.writeFileSync(process.env.BENCH_PROFILE, JSON.stringify(profile));
      }
      await measure('scroll20', async () => {
        await page.evaluate(async () => {
          for (let i = 0; i < 20; i++) {
            window.scrollTo(0, 900 + i * 55);
            await new Promise(resolve => setTimeout(resolve, 32));
            bench.sample();
          }
        });
      });
      await measure('settle1500ms', async () => { await page.waitForTimeout(1500); });
    }
    const result = { sourceDir, viewport: { width: 1200, height: 900 }, articleParagraphs: 1800, stages };
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    await page.evaluate(() => WikiFactPageScan.clear());
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
