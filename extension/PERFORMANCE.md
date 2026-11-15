# Page scan animation performance

The investigation used a local headless Chrome fixture with 1,800 sentences, a
1,200 × 900 viewport, mocked streamed responses, and no backend/network latency.
It measures Chrome's layout/style/task counters, long tasks, animation counts,
frame gaps, and loading paint events. Timings are local measurements, not a promise
about every website or device.

## Measured results

Comparison against commit `8201828`, with the same active frame sampler in both
runs. Streaming sends 80 answers 24ms apart; scroll testing sends 20 updates 32ms
apart. The benchmark includes those intentional waits in wall time.

| Workload | Before | After |
| --- | ---: | ---: |
| Loading main-thread work over 1.5 seconds | 686ms | 44ms |
| Loading 95th percentile frame gap | 83.3ms | 16.7ms |
| Infinite loading DOM animations | 448 | 0 |
| 80 streamed answers, wall time | 34.80s | 3.73s |
| Streamed-answer layouts | 2,869 | 181 |
| Streamed-answer long tasks | 100 | 2 |
| 20 scroll updates, main-thread work | 8,011ms | 173ms |
| Scroll 95th percentile frame gap | 333.3ms | 33.3ms |

The loading trace recorded zero DOM `Paint` events after optimization. This does
not mean playback draws nothing: the canvas updates its cached raster at 30fps.
The comparison includes steady loading and bursty results, and does not include
backend/model latency.

## Whole-page scan throughput

The queue also has deterministic regressions covering a complete 1,800-sentence
scan, separate from the animation benchmark above. With ten visible sentences and
a stable viewport, the previous queue measured sentence positions 198,048 times;
cached visibility reduces that to 1,800, one read per sentence. Scrolling, resizing,
host-page mutations, and resource loading invalidate the cache.

Individual streamed answers now release sentence capacity before their whole
batch finishes. For example, two answers from each of the four initial batches
can start another eight-sentence batch immediately, while the slower answers
continue. There are still at most 32 outstanding sentences and six open requests;
provider rate limits pause all new work and retain bounded retries.

Backend retrieval first merges vector rankings, then fetches evidence only for
the selected articles. An eight-sentence fixture sharing Wikipedia sources uses
34 SQL executions instead of 72, with each unique article body fetched once per
batch. The same ranking, article text, sentence-specific excerpts, and model
inputs are preserved. Stream transport validates the scan once per received
network chunk instead of awaiting extension storage separately for each answer.

These measurements count avoided work with mocked transport/database responses;
they do not measure live Ollama or Gemini latency. Run the queue and transport
regressions with `node extension/tests/page-queue.test.cjs` and
`node extension/tests/background.test.cjs`. The backend retrieval and streaming
contracts are covered by `python manage.py test factcheck.test_batch`.

## Findings and changes

- A CPU profile attributed 72.6% of sampled time to rewriting every sentence menu
  option after each answer. The UI now caches option nodes and changes their text
  only when the label changes.
- Inserting and measuring one glyph at a time forced repeated synchronous layouts.
  The renderer now reads source geometry, builds detached copies, appends them in
  a batch, reads all copy baselines, then writes positions.
- Per-word background-position animations repainted loading text continuously. A
  shared DOM mask looked inexpensive on an idle page, but tracing with an active
  frame sampler exposed repeated paints even with explicit layer promotion. The
  final renderer rasterizes visible pending words into a cached canvas only when
  content changes. Playback blits that bitmap and applies a diagonal alpha gradient
  at 30fps; it performs no font drawing, source geometry reads, or DOM style updates
  during steady loading. Canvas backing stores are capped at device pixel ratio 2.
- Queue sorting read sentence geometry repeatedly inside its comparator, including
  while every request slot was occupied. Prioritization now reads each candidate
  once, stops when enough visible work is available, and skips work at capacity.
- Continuous scrolling recreated overlays and remeasured the article. Original
  text now appears immediately while scrolling; overlays rebuild once scrolling
  has settled for 90ms. Scroll queue work is coalesced into one animation frame.
- Verdict highlights use static tint/underline layers with opacity animation;
  letter hops use transforms. Excess visible results wait for the preceding wave
  to settle, targeting at most 600 concurrent letters. One oversized sentence can
  run alone so it is never starved. Deferred geometry is cached until the viewport
  changes.

The loading cycle is 2,000ms: 1,600ms divided by 0.8 gives 20% lower speed. Peak
lightening is 49%, reduced by 30% from the previous 70%; the minimum ink alpha is
therefore 0.51. Both loading and verdict fronts lean 30° from vertical and travel
left to right. Reduced motion disables decorative animation.

## Reproduce

Install `playwright-core` outside the repository, as described in README.md, then:

```bash
NODE_PATH=/tmp/wfc-tests/node_modules node extension/tests/scan-performance.cjs
node extension/tests/page-queue.test.cjs
NODE_PATH=/tmp/wfc-tests/node_modules node extension/tests/scan-animation.test.cjs
```

The benchmark writes JSON to the system temporary directory and accepts an
alternate source directory and output path as positional arguments. Set
`CHROME_PATH` for a different Chrome/Chromium executable. `BENCH_LOADING_ONLY=1`
profiles just startup and loading. The frame sampler stays active during loading
to expose work that can be hidden by a completely idle headless page.

## Browser research

- [web.dev: high-performance CSS animations](https://web.dev/articles/animations-guide)
  recommends transform/opacity and measuring actual rendering behavior; a property
  choice alone does not guarantee inexpensive compositing in a masked subtree.
- [web.dev: avoid layout thrashing](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing)
  explains why geometry reads should precede style/DOM writes.
- [Chrome: forced reflow insight](https://developer.chrome.com/docs/performance/insights/forced-reflow)
  describes diagnosing synchronous layout from JavaScript.
- [MDN: optimizing canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)
  recommends pre-rendering repeated drawing into an offscreen canvas and reusing it
  with `drawImage()`.
