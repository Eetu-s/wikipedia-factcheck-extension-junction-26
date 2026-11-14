// Run: NODE_PATH=<directory containing playwright-core> node extension/tests/page-ui.test.cjs
const { chromium } = require("playwright-core");
const path = require("node:path");
const fs = require("node:fs");
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless:true });
  try {
    const page = await browser.newPage({viewport:{width:800,height:600}});
    const strictCsp = process.argv.includes('--csp');
    await page.setContent((strictCsp ? '<meta http-equiv="Content-Security-Policy" content="style-src \'none\'">' : '') + '<style>section{background:red!important;font-size:80px!important}button{display:none!important}</style><article><p>😀 Helsinki is in Finland.</p><p>Stockholm is in Norway.</p><p>He may have visited.</p></article>');
    if (strictCsp) await page.evaluate(source => (0, eval)(source), fs.readFileSync(path.resolve(__dirname, '../page-ui.js'), 'utf8'));
    else await page.addScriptTag({path:path.resolve(__dirname, "../page-ui.js")});
    await page.evaluate(() => {
      window.chosen = [];
      window.sents = [...document.querySelectorAll('article p')].map((p,i) => {
        const range = document.createRange(); range.selectNodeContents(p);
        return {id:String(i),text:p.textContent,range,status:'done',result:{decision:['SUPPORTED','REFUTED','NOT ENOUGH INFO'][i],confidence:.8,sources:['https://en.wikipedia.org/wiki/Helsinki'],check_id:'check-'+i}};
      });
      window.ui = WikiFactPageUI.create({onSelect:id=>chosen.push(id)});
      ui.update(sents,{completed:3,total:3});
      ui.show(sents[0],{x:795,y:595});
    });
    const host=page.locator('[data-wfc-ui]');
    const popover=host.locator('.popover');
    if (strictCsp) {
      const styles = await page.evaluate(() => {
        const host = document.querySelector('[data-wfc-ui]');
        const shadow = host.shadowRoot;
        return {
          adopted: shadow.adoptedStyleSheets.length,
          inlineStyles: shadow.querySelectorAll('style').length,
          hostPosition: getComputedStyle(host).position,
          guidePosition: getComputedStyle(shadow.querySelector('.guide')).position,
          guideBorder: getComputedStyle(shadow.querySelector('.guide')).borderTopWidth,
          guideFont: getComputedStyle(shadow.querySelector('.guide')).fontFamily,
          popoverPosition: getComputedStyle(shadow.querySelector('.popover')).position,
          popoverBorder: getComputedStyle(shadow.querySelector('.popover')).borderTopWidth,
          popoverFont: getComputedStyle(shadow.querySelector('.popover')).fontFamily,
          buttonDisplay: getComputedStyle(shadow.querySelector('button')).display,
        };
      });
      assert.equal(styles.adopted,1);
      assert.equal(styles.inlineStyles,0);
      assert.equal(styles.hostPosition,'fixed');
      assert.equal(styles.guidePosition,'fixed');
      assert.equal(styles.popoverPosition,'fixed');
      assert.equal(styles.guideBorder,'2px');
      assert.equal(styles.popoverBorder,'2px');
      assert.match(styles.guideFont,/ui-sans-serif/);
      assert.match(styles.popoverFont,/ui-sans-serif/);
      assert.notEqual(styles.buttonDisplay,'none');
      const box = await popover.boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 800 && box.y + box.height <= 600);
      await popover.getByRole('button',{name:'Click for deeper analysis'}).click();
      assert.deepEqual(await page.evaluate(()=>chosen),['0']);
      await page.evaluate(()=>ui.destroy());
      console.log("PASS overlay CSP: style-src 'none' preserves constructed styles, fixed positioning, borders, viewport clamp, controls");
      return;
    }
    if (process.argv.includes('--accessibility')) {
      const live = host.getByRole('status');
      assert.ok((await live.textContent()).includes('Sentence result: Supported.'));
      await page.evaluate(() => {
        window.liveChanges = 0;
        new MutationObserver(() => liveChanges++).observe(document.querySelector('[data-wfc-ui]').shadowRoot.querySelector('[role="status"]'), {childList:true,subtree:true});
        for(let i=0;i<5;i++) ui.show(sents[0],{x:100+i,y:100+i});
      });
      assert.equal(await page.evaluate(()=>liveChanges),0,'pointer movement does not repeat announcements');
      await page.evaluate(() => {
        ui.hide(); sents[2].status='pending'; delete sents[2].result;
        ui.update(sents,{completed:2,total:3}); ui.show(sents[2],{pinned:true});
      });
      assert.ok((await live.textContent()).includes('Pending.'));
      await page.evaluate(() => {
        sents[2].status='done'; sents[2].result={decision:'NOT ENOUGH INFO',sources:[],check_id:'gray'};
        ui.update(sents,{completed:3,total:3});
      });
      assert.ok((await live.textContent()).includes('Uncertain / not fact-checkable.'));
      assert.deepEqual(await page.evaluate(()=>chosen),[],'pending pin and subsequent completion do not auto-analyze');
      await popover.getByRole('button',{name:'Click for deeper analysis'}).click();
      assert.deepEqual(await page.evaluate(()=>chosen),['2'],'completed pending sentence can be explicitly analyzed');
      await page.evaluate(()=>{sents[2].deep={status:'pending'};ui.update(sents,{completed:3,total:3});});
      assert.ok((await live.textContent()).includes('Deeper analysis is running.'));
      await page.evaluate(()=>{sents[2].deep={status:'done',explanation:'No conclusive evidence.'};ui.update(sents,{completed:3,total:3});});
      assert.ok((await live.textContent()).includes('Deeper analysis complete.'));
      await page.evaluate(()=>{sents[2].deep={status:'error',error:'Service unavailable.'};ui.update(sents,{completed:3,total:3});});
      assert.ok((await live.textContent()).includes('Deeper analysis failed. Service unavailable.'));
      await page.evaluate(()=>ui.update(sents,{completed:3,total:3,changed:true}));
      assert.ok((await live.textContent()).includes('Article changed. Select Rescan'));
      await page.evaluate(()=>ui.update(sents,{completed:3,total:3,changed:true,error:'Rate limit reached.'}));
      assert.ok((await live.textContent()).includes('Rate limit reached.'));
      await page.evaluate(()=>{liveChanges=0;ui.update(sents,{completed:3,total:3,changed:true,error:'Rate limit reached.'});});
      assert.equal(await page.evaluate(()=>liveChanges),0,'unchanged status does not repeat announcements');
      await page.evaluate(()=>ui.destroy());
      console.log('PASS overlay accessibility: fast/deep transitions, pending click, changed/error guide status, no pointer chatter');
      return;
    }
    assert.equal(await popover.getAttribute('hidden'),null);
    assert.match(await host.locator('.guide').evaluate(node=>getComputedStyle(node).fontFamily),/ui-sans-serif/);
    assert.match(await popover.evaluate(node=>getComputedStyle(node).fontFamily),/ui-sans-serif/);
    assert.equal(await host.locator('.verdict strong').innerText(),'✓ Supported');
    assert.deepEqual(await page.evaluate(()=>chosen),[]);
    const box=await popover.boundingBox();
    assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=800&&box.y+box.height<=600,'popover clamped');
    await page.evaluate(()=>ui.scheduleHide());
    await popover.hover();
    await page.waitForTimeout(260);
    assert.equal(await popover.getAttribute('hidden'),null,'pointer entry cancels delayed hide');
    await popover.getByRole('button',{name:'Click for deeper analysis'}).click();
    assert.deepEqual(await page.evaluate(()=>chosen),['0']);
    assert.equal(await page.evaluate(()=>ui.isPinned()),true);
    await page.keyboard.press('Escape');
    assert.equal(await popover.getAttribute('hidden'),'');
    for(const i of [1,2]){
      await page.evaluate(i=>ui.show(sents[i],{x:200,y:100}),i);
      await popover.getByRole('button',{name:'Click for deeper analysis'}).click();
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(await page.evaluate(()=>chosen),['0','1','2'],'all done verdict colors allow deep');
    await host.getByRole('combobox').selectOption('0');
    await host.getByRole('button',{name:'Open result'}).focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(()=>chosen),['0','1','2','0'],'keyboard opens and analyzes');
    assert.equal(await page.evaluate(()=>document.querySelector('[data-wfc-ui]').shadowRoot.activeElement.className),'popover');
    await page.evaluate(()=>{sents[0].deep={status:'pending'};ui.update(sents,{completed:3,total:3});});
    assert.ok((await popover.innerText()).includes('Analyzing this sentence'));
    await page.evaluate(()=>{sents[0].deep={status:'done',explanation:'Checked against Wikipedia.',errors:[{original_text:'Helsinki',start:2,end:10,explanation:'Exact original offsets retained.',correction:'Helsinki, Finland',evidence:[{source:'https://en.wikipedia.org/wiki/Helsinki',quote:'Helsinki is the capital of Finland.'}]}],paragraphs:[],unverified_facts:[{text:'Unknown date',reason:'No dated evidence'}]};ui.update(sents,{completed:3,total:3});});
    assert.equal(await popover.locator('mark').innerText(),'Helsinki','offsets count codepoints, including emoji');
    assert.ok((await popover.innerText()).includes('Checked against Wikipedia.'));
    assert.ok((await popover.innerText()).includes('Exact original offsets retained.'));
    assert.ok((await popover.innerText()).includes('Correction: Helsinki, Finland'));
    assert.ok((await popover.innerText()).includes('Unverified facts (1)'));
    await page.evaluate(()=>{sents[0].result.sources=['javascript:alert(1)'];ui.update(sents,{completed:3,total:3});});
    assert.equal(await popover.locator('a[href^="javascript:"]').count(),0,'source links restricted');
    for (const viewport of [{width:320,height:480},{width:390,height:320},{width:800,height:600}]) {
      await page.setViewportSize(viewport);
      await page.evaluate(()=>ui.show(sents[0],{pinned:true,x:window.innerWidth-10,y:window.innerHeight-10}));
      const pop = await popover.boundingBox();
      const guide = await host.locator('.guide').boundingBox();
      assert.ok(pop.x >= 0 && pop.y >= 0 && pop.x + pop.width <= viewport.width && pop.y + pop.height <= viewport.height, 'narrow popover clamped');
      assert.ok(pop.x + pop.width <= guide.x || pop.x >= guide.x + guide.width || pop.y + pop.height <= guide.y || pop.y >= guide.y + guide.height, 'pinned popover leaves guide reachable');
      await page.keyboard.press('Escape');
    }
    await page.evaluate(()=>ui.destroy());
    assert.equal(await host.count(),0);
    console.log('PASS overlay: Shadow DOM isolation, viewport clamp, hover transfer, all verdict deep actions, keyboard, pending/completed deep, Unicode correction offsets, safe links, cleanup');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
