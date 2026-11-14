// Run: NODE_PATH=<directory containing playwright-core> node extension/tests/article.test.cjs
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright-core");

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    for (const language of ["en", "fi", "sv"]) {
      const phrases = {
        en: ["The Eiffel Tower is in Paris.", "It was completed in 1889.", "A loaded sentence below the viewport."],
        fi: ["Eiffel-torni sijaitsee Pariisissa.", "Se valmistui vuonna 1889.", "Valmiiksi ladattu lause näkymän alapuolella."],
        sv: ["Eiffeltornet ligger i Paris.", "Det färdigställdes år 1889.", "En inläst mening under visningsområdet."],
      }[language];
      await page.setContent(`<!doctype html><html lang="${language}"><head><title>Tower facts</title>
        <meta property="article:published_time" content="2026-11-01">
        <style>.clip-hidden { position:absolute; clip:rect(1px,1px,1px,1px); width:1px; height:1px; overflow:hidden }
        .inset-hidden { clip-path:inset(50%); }</style></head><body>
        <nav>Navigation excluded.</nav><main><article><h1>Tower facts</h1><h2>History</h2>
        <p id="inline">${phrases[0].replace(/(Paris|Pariisissa)/, '<a href="/city"><strong>$1</strong></a>')} ${phrases[1]}</p>
        <p id="duplicate">${phrases[0]}</p><p id="duplicate-again">${phrases[0]}</p>
        <div style="height:3000px"></div><p id="bottom">${phrases[2]}</p>
        <p>Visible text.<span hidden>Hidden inline text.</span> Next visible sentence.</p><p>First line.<br>Second line.</p>
        <aside>Sidebar excluded.</aside><p style="display:none">Hidden excluded.</p>
        <p aria-hidden="true">Aria hidden excluded.</p><div contenteditable>Editable excluded.</div>
        <p><button>Control excluded.</button></p><div class="advertisement">Advertisement excluded.</div>
        <div data-wfc-ui>Extension excluded.</div>
        ${["sr-only", "visually-hidden", "screen-reader-text", "screen-reader-only", "clip-hidden", "inset-hidden"].map(className =>
          `<p class="${className}">Visually hidden excluded.</p>`).join("")}
        ${["checkbox", "radio", "switch", "slider", "spinbutton", "combobox", "listbox", "option", "textbox", "tab", "tablist", "banner"].map(role =>
          `<div role="${role}">ARIA control excluded.</div>`).join("")}
        </article></main><footer>Footer excluded.</footer>
        </body></html>`);
      await page.addScriptTag({ path: path.resolve(__dirname, "../vendor/Readability.js") });
      await page.addScriptTag({ path: path.resolve(__dirname, "../article.js") });
      const result = await page.evaluate(() => {
        const before = document.documentElement.outerHTML;
        const article = WikiFactArticle.extract(document);
        if (!article.isValid()) throw new Error("Fresh whole-article snapshot must be valid");
        globalThis.savedArticle = article;
        return {
          language: article.language, date: article.publication_date,
          unchanged: before === document.documentElement.outerHTML,
          sentences: article.sentences.map(sentence => ({
            id: sentence.id, text: sentence.text, context: sentence.context,
            exact: sentence.ranges.map(range => range.toString()).join("") === sentence.text,
            valid: sentence.isValid(), crossing: sentence.segments.length,
          })),
          stable: article.sentences.map(s => s.id).join("|") === WikiFactArticle.extract(document).sentences.map(s => s.id).join("|"),
        };
      });
      assert.equal(result.language, language);
      assert.equal(result.date, "2026-11-01");
      assert.equal(result.unchanged, true, "Extraction must leave original DOM untouched");
      assert.equal(result.stable, true);
      assert.ok(result.sentences.some(sentence => sentence.text === phrases[2]), "Below viewport text is included");
      assert.ok(result.sentences.every(sentence => !/excluded|Hidden inline/.test(sentence.text)), JSON.stringify(result));
      assert.ok(result.sentences.every(sentence => sentence.exact && sentence.valid));
      assert.ok(result.sentences.some(sentence => sentence.text === "First line."));
      assert.ok(result.sentences.some(sentence => sentence.text === "Second line."));
      const duplicate = result.sentences.filter(sentence => sentence.text === phrases[0]);
      assert.equal(duplicate.length, 3);
      assert.equal(new Set(duplicate.map(sentence => sentence.id)).size, 3, "Repeated text has separate anchors");
      assert.ok(duplicate[0].crossing >= 3, "One sentence spans inline markup");
      assert.equal(duplicate[0].context.section_heading, "History");
      const invalid = await page.evaluate(() => {
        const sentence = savedArticle.sentences.find(s => s.block.id === "inline");
        sentence.segments[0].node.data = "Changed content. ";
        return !sentence.isValid();
      });
      assert.equal(invalid, true, "Changed source nodes invalidate original offsets");
      const mutations = await page.evaluate(() => {
        // Re-extract after the deliberate text edit above.
        const article = WikiFactArticle.extract(document);
        let wholeArticleCorrect = article.isValid();
        const sentence = article.sentences.find(s => s.block.id === "duplicate");
        const block = sentence.block;
        const inserted = document.createElement("span");
        inserted.textContent = " Newly inserted article text.";
        block.append(inserted);
        const inlineInvalid = !sentence.isValid();
        wholeArticleCorrect &&= !article.isValid();
        inserted.remove();
        const restoredValid = sentence.isValid();
        wholeArticleCorrect &&= article.isValid();
        const button = document.createElement("button");
        button.textContent = "Share control";
        block.append(button);
        const controlValid = sentence.isValid();
        wholeArticleCorrect &&= article.isValid();
        button.remove();
        const newParagraph = document.createElement("p");
        newParagraph.textContent = "A new neighboring subject.";
        block.after(newParagraph);
        const neighborInvalid = !sentence.isValid();
        wholeArticleCorrect &&= !article.isValid();
        newParagraph.remove();
        const inlineSentence = article.sentences.find(s => s.block.id === "inline");
        const lastChild = inlineSentence.block.lastChild;
        inlineSentence.block.prepend(lastChild);
        const reorderedInvalid = !inlineSentence.isValid();
        wholeArticleCorrect &&= !article.isValid();
        inlineSentence.block.append(lastChild);
        const heading = document.querySelector("h2");
        const headingText = heading.firstChild.data;
        heading.firstChild.data = "Changed heading";
        const headingInvalid = !sentence.isValid();
        wholeArticleCorrect &&= !article.isValid();
        heading.firstChild.data = headingText;
        const originalLast = article.sentences[article.sentences.length - 1];
        document.querySelector("article").append(newParagraph);
        const appendedValid = originalLast.isValid();
        wholeArticleCorrect &&= article.isValid();
        newParagraph.remove();
        block.style.visibility = "hidden";
        const hiddenInvalid = !sentence.isValid();
        wholeArticleCorrect &&= !article.isValid();
        block.style.visibility = "";
        return { inlineInvalid, restoredValid, controlValid, neighborInvalid, reorderedInvalid, headingInvalid, appendedValid, hiddenInvalid, wholeArticleCorrect };
      });
      assert.deepEqual(mutations, {
        inlineInvalid: true, restoredValid: true, controlValid: true, neighborInvalid: true, reorderedInvalid: true,
        headingInvalid: true, appendedValid: true, hiddenInvalid: true, wholeArticleCorrect: true,
      });
    }
    await page.setContent(`<html lang="en"><head><title>Head only title.</title></head><body>
      <nav>Menu exclusion.</nav><main><article><h1>Long article</h1>${Array.from({ length: 800 }, (_, i) =>
        `<p>The city numbered ${i} lies in the north. Its history is documented in <a href="/history">historical records</a>. It has a railway station.</p>`).join("")}
      </article></main><aside>Unrelated account panel.</aside></body></html>`);
    await page.addScriptTag({ path: path.resolve(__dirname, "../vendor/Readability.js") });
    await page.addScriptTag({ path: path.resolve(__dirname, "../article.js") });
    const performance = await page.evaluate(() => {
      const started = globalThis.performance.now();
      const article = WikiFactArticle.extract(document);
      const extracted = globalThis.performance.now();
      const valid = article.isValid();
      const checked = globalThis.performance.now();
      const paragraph = document.querySelector("p");
      const next = paragraph.nextElementSibling;
      next.after(paragraph);
      const reorderedInvalid = !article.isValid();
      return { count: article.sentences.length, valid, reorderedInvalid,
        noOrphans: !article.sentences.some(s => /Head only|Menu exclusion|Unrelated account/.test(s.text)),
        extractionMs: Math.round(extracted - started), validationMs: Math.round(checked - extracted) };
    });
    assert.equal(performance.valid, true);
    assert.equal(performance.reorderedInvalid, true, "Moving a whole paragraph invalidates context order");
    assert.equal(performance.noOrphans, true);
    assert.ok(performance.count >= 2400, "Long loaded article must not be truncated");
    console.log(`Long article: ${performance.count} sentences, extraction ${performance.extractionMs}ms, shared validation ${performance.validationMs}ms.`);
    // Readability may return null for a very short page. The semantic fallback still maps it.
    await page.setContent('<html lang="fi"><body><main><p>Lyhyt väite.</p></main></body></html>');
    await page.addScriptTag({ path: path.resolve(__dirname, "../article.js") });
    const fallback = await page.evaluate(() => WikiFactArticle.extract(document).sentences.map(s => s.text));
    assert.deepEqual(fallback, ["Lyhyt väite."]);
    console.log("Article extraction passed: en/fi/sv, offscreen, exclusions, inline ranges, duplicate anchors, invalidation, fallback.");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
