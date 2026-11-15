/* Article extraction with clone-only Readability provenance and original DOM offsets. */
(() => {
  "use strict";
  if (globalThis.WikiFactArticle) return;

  const EXCLUDED = [
    "script", "style", "noscript", "template", "nav", "aside", "footer", "form",
    "button", "input", "textarea", "select", "option", "label", "dialog", "canvas",
    "svg", "iframe", "object", "embed", "audio", "video", "[hidden]", "[inert]",
    '[aria-hidden="true"]', '[role="navigation"]', '[role="menu"]', '[role="menubar"]',
    '[role="complementary"]', '[role="toolbar"]', '[role="button"]', '[role="search"]',
    '[role="dialog"]', '[role="banner"]', '[role="checkbox"]', '[role="radio"]',
    '[role="switch"]', '[role="slider"]', '[role="spinbutton"]', '[role="combobox"]',
    '[role="listbox"]', '[role="option"]', '[role="textbox"]', '[role="tab"]', '[role="tablist"]',
    '[contenteditable]:not([contenteditable="false"])',
    '[class~="sr-only"]', '[class~="visually-hidden"]', '[class~="screen-reader-text"]',
    '[class~="screen-reader-only"]',
    "[data-wfc-ui]", "[data-wikifact-ui]", "[data-wikipedia-factcheck]",
    '[itemprop="advertisement"]', '[aria-label*="advertisement" i]',
    '[id^="google_ads"]', '[id^="ad-"]', '[class~="advertisement"]',
    '[class~="ads"]', '[class~="ad"]', '[class~="advert"]', '[class~="ad-container"]',
    '[class~="ad-slot"]', '[class~="adsbygoogle"]', '[data-ad-slot]', '[data-ad-client]',
    '[class~="sidebar"]', '[class~="social-share"]',
    '[class~="related-articles"]', '[class~="cookie-banner"]', '[class~="menu"]',
    '[class~="navigation"]', '[class~="controls"]', '[class~="comments"]',
  ].join(",");
  const PARAGRAPH = "p,li,blockquote,dd,dt,figcaption,td,th,pre,h1,h2,h3,h4,h5,h6";
  const MARKER = "data-wfc-text-map";
  const LANGUAGES = new Set(["fi", "en", "sv"]);
  const MAX_PARAGRAPH = 3200;
  const MAX_NEIGHBOR = 700;

  function hash(value) {
    let result = 2166136261;
    for (let i = 0; i < value.length; i++) {
      result ^= value.charCodeAt(i);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  }

  function nodePath(node) {
    const path = [];
    while (node && node.parentNode) {
      path.push(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
      node = node.parentNode;
    }
    return path.reverse().join(".");
  }

  function fullyClipped(css) {
    // Detect CSS clipping used for visually hidden accessibility text without relying
    // on viewport geometry (which would omit legitimate offscreen article content).
    const rect = css.clip.match(/^rect\(([^)]+)\)$/);
    if (rect) {
      const edges = rect[1].split(/[,\s]+/).map(value => Number.parseFloat(value));
      if (edges.length === 4 && edges.every(Number.isFinite)
          && (edges[0] >= edges[2] || edges[3] >= edges[1])) return true;
    }
    const inset = css.clipPath.match(/^inset\(([^)]+)\)$/);
    if (inset && !inset[1].includes("round")) {
      const values = inset[1].trim().split(/\s+/);
      if (values.every(value => /^\d+(?:\.\d+)?%$/.test(value))) {
        const [top, right = top, bottom = top, left = right] = values.map(Number.parseFloat);
        if (top + bottom >= 100 || right + left >= 100) return true;
      }
    }
    return (Number.parseFloat(css.width) === 0 && /^(hidden|clip)$/.test(css.overflowX))
      || (Number.parseFloat(css.height) === 0 && /^(hidden|clip)$/.test(css.overflowY));
  }

  function visibilityFilter(doc) {
    const memo = new WeakMap();
    return function allowed(element) {
      if (!element || element.nodeType !== 1) return true;
      if (memo.has(element)) return memo.get(element);
      let good = !element.matches(EXCLUDED);
      if (good && element.parentElement) good = allowed(element.parentElement);
      if (good) {
        const css = doc.defaultView?.getComputedStyle(element);
        // Do not use viewport or content-visibility:auto geometry: offscreen text is included.
        if (css && (css.display === "none" || css.visibility === "hidden"
            || css.visibility === "collapse" || css.contentVisibility === "hidden"
            || Number(css.opacity) === 0 || fullyClipped(css))) good = false;
        if (element.tagName === "DETAILS" && !element.open) good = false;
      }
      memo.set(element, good);
      return good;
    };
  }

  function metadataDate(doc, article) {
    const meta = doc.querySelector('meta[property="article:published_time"],meta[name="date"],meta[itemprop="datePublished"],meta[name="pubdate"]');
    if (meta?.content) return meta.content.slice(0, 100);
    const time = doc.querySelector('article time[datetime],main time[datetime],time[itemprop="datePublished"][datetime]');
    if (time?.dateTime) return time.dateTime.slice(0, 100);
    if (article?.publishedTime) return String(article.publishedTime).slice(0, 100);
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const pending = [JSON.parse(script.textContent)];
        let visits = 0;
        while (pending.length && visits++ < 200) {
          const item = pending.pop();
          if (!item || typeof item !== "object") continue;
          if (typeof item.datePublished === "string") return item.datePublished.slice(0, 100);
          for (const value of Object.values(item)) {
            if (value && typeof value === "object") pending.push(...(Array.isArray(value) ? value : [value]));
          }
        }
      } catch (_) { /* Malformed site metadata must not stop the scan. */ }
    }
    return "";
  }

  function locale(doc, article, text) {
    for (const value of [doc.documentElement.lang, article?.lang,
      doc.querySelector('meta[property="og:locale"]')?.content]) {
      const language = String(value || "").toLowerCase().split(/[-_]/)[0];
      if (LANGUAGES.has(language)) return language;
    }
    const words = text.toLocaleLowerCase().match(/[\p{L}]+/gu) || [];
    const scores = { fi: 0, en: 0, sv: 0 };
    const hints = {
      fi: new Set(["on", "ja", "oli", "ovat", "että", "myös", "hän", "sen", "ei", "suomessa"]),
      sv: new Set(["är", "och", "var", "att", "som", "en", "ett", "det", "han", "hon", "med"]),
      en: new Set(["the", "is", "and", "was", "were", "that", "of", "in", "he", "she", "with"]),
    };
    for (const word of words.slice(0, 1000)) {
      for (const language of LANGUAGES) if (hints[language].has(word)) scores[language]++;
    }
    const best = Object.keys(scores).sort((a, b) => scores[b] - scores[a])[0];
    return scores[best] ? best : "en";
  }

  function paragraphNode(node, doc) {
    let element = node.parentElement;
    const semantic = element.closest(PARAGRAPH);
    if (semantic) return semantic;
    while (element && element !== doc.body) {
      const display = doc.defaultView?.getComputedStyle(element).display;
      if (["block", "list-item", "table-cell", "flex", "grid"].includes(display)) return element;
      element = element.parentElement;
    }
    return node.parentElement;
  }

  function boundedParagraph(text, start, end) {
    if (text.length <= MAX_PARAGRAPH) return text;
    // Keep the whole target even when an unusually long sentence exceeds the context budget.
    const spare = Math.max(0, MAX_PARAGRAPH - (end - start));
    const left = Math.max(0, start - Math.floor(spare / 2));
    return text.slice(left, Math.min(text.length, Math.max(end, left + MAX_PARAGRAPH)));
  }

  function semanticFallback(doc, allowed) {
    const candidates = [...doc.querySelectorAll("article,main,[role=main],[itemprop=articleBody]")]
      .filter(allowed);
    if (!candidates.length) return null;
    // Avoid a small related-card <article> when the page has a complete main article.
    return candidates.sort((a, b) => b.textContent.length - a.textContent.length)[0];
  }

  function sameSnapshot(snapshot, nodes) {
    return snapshot.length === nodes.length && snapshot.every((item, index) =>
      item.node === nodes[index] && item.text === nodes[index].data);
  }

  function blockNodes(element, doc, allowed) {
    if (!element?.isConnected || !allowed(element)) return [];
    const nodes = [];
    const walker = doc.createTreeWalker(element, 4);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (allowed(node.parentElement) && paragraphNode(node, doc) === element) nodes.push(node);
    }
    return nodes;
  }

  function gapNodes(left, right, doc, allowed) {
    if (!left?.isConnected || !right?.isConnected || left === right) return [];
    let common = left.parentElement;
    while (common && !common.contains(right)) common = common.parentElement;
    if (!common) return [];
    const nodes = [];
    const walker = doc.createTreeWalker(common, 4);
    // Start at the boundary rather than walking the whole article for every pair.
    // Adjacent paragraph gaps are therefore O(gap text), not O(article text).
    walker.currentNode = left;
    while (walker.nextNode() && walker.currentNode !== right) {
      const node = walker.currentNode;
      if (node.data.trim() && allowed(node.parentElement)) nodes.push(node);
    }
    return nodes;
  }

  function snapshot(nodes) { return nodes.map(node => ({ node, text: node.data })); }

  function validGap(gap, doc, allowed) {
    if (!gap.first.isConnected || !gap.last.isConnected) return false;
    const order = gap.first.compareDocumentPosition(gap.last);
    if (order & 1 || !(order & 4)) return false;
    return sameSnapshot(gap.nodes, gapNodes(gap.first, gap.last, doc, allowed));
  }

  function extract(doc = document) {
    if (!doc.body) throw new Error("This page has no loaded article content.");
    if (typeof Intl.Segmenter !== "function") throw new Error("This browser needs Intl.Segmenter to check a page.");
    const allowed = visibilityFilter(doc);
    const clone = doc.cloneNode(true);
    const originalText = new Map();
    const originalOrder = new WeakMap();
    const originalLine = new WeakMap();
    let sequence = 0;
    let line = 0;

    // Walk the two trees in parallel. Markers exist only in the cloned document and carry
    // exact original Text references through Readability's rewriting and cleanup.
    function pair(original, copy) {
      if (original.nodeType === 1 && !allowed(original)) {
        copy.remove();
        return;
      }
      if (original.nodeType === 1 && original.tagName === "BR") line++;
      if (original.nodeType === 3) {
        originalLine.set(original, line);
        const id = String(sequence++);
        originalOrder.set(original, Number(id));
        originalText.set(id, original);
        const marker = clone.createElement("span");
        marker.setAttribute(MARKER, id);
        copy.replaceWith(marker);
        marker.append(copy);
        return;
      }
      const originals = [...original.childNodes];
      const copies = [...copy.childNodes];
      for (let i = 0; i < originals.length; i++) pair(originals[i], copies[i]);
    }
    pair(doc.documentElement, clone.documentElement);

    let article = null;
    try {
      if (typeof globalThis.Readability === "function") {
        article = new globalThis.Readability(clone, {
          charThreshold: 80, keepClasses: true, serializer: element => element,
        }).parse();
      }
    } catch (_) { /* Semantic fallback also covers documents Readability cannot parse. */ }

    let nodes = [];
    if (article?.content?.querySelectorAll) {
      nodes = [...article.content.querySelectorAll(`[${MARKER}]`)]
        .map(marker => originalText.get(marker.getAttribute(MARKER)))
        .filter(node => node?.isConnected && doc.body.contains(node) && allowed(node.parentElement));
    }
    let root = null;
    if (!nodes.some(node => node.data.trim())) {
      root = semanticFallback(doc, allowed);
      if (!root) throw new Error("No readable article was found on this page.");
      nodes = [];
      const walker = doc.createTreeWalker(root, 4);
      while (walker.nextNode()) {
        if (allowed(walker.currentNode.parentElement)) nodes.push(walker.currentNode);
      }
    }
    nodes = [...new Set(nodes)].sort((a, b) =>
      (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0));
    if (!nodes.length) throw new Error("No readable article text was found on this page.");
    if (!root) {
      root = nodes[0].parentElement;
      while (root && !nodes.every(node => root.contains(node))) root = root.parentElement;
      root ||= doc.body;
    }

    const blocks = [];
    let previousBlock;
    for (const node of nodes) {
      const element = paragraphNode(node, doc);
      if (element !== previousBlock?.element || originalLine.get(node) !== previousBlock?.line) {
        previousBlock = { element, line: originalLine.get(node), text: "", pieces: [] };
        blocks.push(previousBlock);
      }
      const start = previousBlock.text.length;
      previousBlock.text += node.data;
      previousBlock.pieces.push({ node, start, end: start + node.data.length, original: node.data });
    }
    const useful = blocks.filter(block => block.text.trim());
    const paragraphs = new Map();
    for (const block of useful) {
      const previous = paragraphs.get(block.element) || "";
      block.paragraphStart = previous.length + (previous ? 1 : 0);
      paragraphs.set(block.element, previous + (previous ? "\n" : "") + block.text);
    }
    const language = locale(doc, article, useful.map(block => block.text).join(" "));
    const title = String(article?.title || doc.title || "").trim().slice(0, 500);
    const publication_date = metadataDate(doc, article);
    const headings = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(allowed);
    if (root.matches("h1,h2,h3,h4,h5,h6")) headings.unshift(root);
    const segmenter = new Intl.Segmenter(language, { granularity: "sentence" });
    const sentences = [];
    const sourceTitle = doc.title;
    const sourceDate = publication_date;
    const blockSnapshots = new Map();
    const takeBlockSnapshot = element => {
      if (!blockSnapshots.has(element)) blockSnapshots.set(element, snapshot(blockNodes(element, doc, allowed)));
      return blockSnapshots.get(element);
    };

    // Each adjacent boundary is shared by the two neighboring blocks and every
    // sentence they contain. Keep one snapshot for the article-wide validator.
    const articleGaps = useful.slice(1).map((block, index) => {
      const left = useful[index];
      const first = left.pieces[left.pieces.length - 1].node;
      const last = block.pieces[0].node;
      return { first, last, nodes: snapshot(gapNodes(first, last, doc, allowed)) };
    });

    useful.forEach((block, index) => {
      let heading = "";
      let headingElement = null;
      for (const candidate of headings) {
        if (candidate === block.element || candidate.compareDocumentPosition(block.element) & 4) {
          heading = candidate.textContent.trim().slice(0, 500);
          headingElement = candidate;
        }
      }
      const contextElements = [...new Set([block.element, useful[index - 1]?.element,
        useful[index + 1]?.element, headingElement].filter(Boolean))];
      const contextSnapshots = contextElements.map(element => ({ element, nodes: takeBlockSnapshot(element) }));
      const gaps = [articleGaps[index - 1], articleGaps[index]].filter(Boolean);
      for (const item of segmenter.segment(block.text)) {
        const leading = item.segment.length - item.segment.trimStart().length;
        const text = item.segment.trim();
        if (!text) continue;
        const start = item.index + leading;
        const end = start + text.length;
        const pieces = block.pieces.filter(piece => piece.end > start && piece.start < end);
        const segments = pieces.map(piece => ({
          node: piece.node,
          start: Math.max(0, start - piece.start),
          end: Math.min(piece.node.data.length, end - piece.start),
          original: piece.original,
        }));
        const ranges = segments.map(segment => {
          const range = doc.createRange();
          range.setStart(segment.node, segment.start);
          range.setEnd(segment.node, segment.end);
          return range;
        });
        if (!ranges.length) continue;
        const range = doc.createRange();
        range.setStart(segments[0].node, segments[0].start);
        const last = segments[segments.length - 1];
        range.setEnd(last.node, last.end);
        const anchor = segments.map(segment => `${nodePath(segment.node)}:${segment.start}:${segment.end}`).join("|");
        sentences.push({
          id: `wfc-${hash(anchor)}-${hash(text)}`, text, range, ranges, segments,
          block: block.element, start, end,
          context: {
            page_title: title, section_heading: heading,
            paragraph: boundedParagraph(paragraphs.get(block.element), block.paragraphStart + start, block.paragraphStart + end),
            previous: index ? useful[index - 1].text.slice(-MAX_NEIGHBOR) : "",
            next: index + 1 < useful.length ? useful[index + 1].text.slice(0, MAX_NEIGHBOR) : "",
            publication_date, language,
          },
          isValid() {
            if (doc.title !== sourceTitle || metadataDate(doc, article) !== sourceDate
                || !segments.every(segment => segment.node.isConnected
                  && segment.node.data === segment.original)) return false;
            const currentAllowed = visibilityFilter(doc);
            return contextSnapshots.every(item => item.element.isConnected
              && currentAllowed(item.element)
              && sameSnapshot(item.nodes, blockNodes(item.element, doc, currentAllowed)))
              && gaps.every(gap => validGap(gap, doc, currentAllowed));
          },
        });
      }
    });
    if (!sentences.length) throw new Error("No sentences were found in this article.");
    return {
      title, language, publication_date, root, sentences,
      isValid() {
        if (doc.title !== sourceTitle || metadataDate(doc, article) !== sourceDate) return false;
        const currentAllowed = visibilityFilter(doc);
        for (const [element, nodes] of blockSnapshots) {
          if (!element.isConnected || !currentAllowed(element)
              || !sameSnapshot(nodes, blockNodes(element, doc, currentAllowed))) return false;
        }
        return articleGaps.every(gap => validGap(gap, doc, currentAllowed));
      },
    };
  }

  globalThis.WikiFactArticle = Object.freeze({ extract });
})();
