import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

export const storyboard = JSON.parse(await readFile(new URL('./storyboard.json', import.meta.url), 'utf8'));
const markerColors = ['#ff3838','#39e85b','#3f66f4','#f3de37','#ed49de','#3adbdc','#ff9940','#a567f7','#7cc624','#de457e','#418bae','#d6ab72'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const escape = text => text.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);

// Record the unmodified explorer. The timing slate stays outside the exported crop.
export async function beginRecording(browser, options = {}) {
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:4173/';
  if (!['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname)) throw new Error('Record a local explorer build.');
  const directory = resolve(options.directory ?? 'test-results/architecture-demo');
  await mkdir(directory, {recursive:true});
  await mkdir(resolve(directory,'raw'), {recursive:true});
  const context = await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1, reducedMotion:'no-preference',recordVideo:{dir:resolve(directory,'raw'),size:{width:1440,height:900}}});
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror', error => errors.push(error.message));
  const recorded=[];
  let stage;

  async function load(hash='') {
    // Force a document navigation between cuts so URL state and the timing slate reset.
    await page.goto('about:blank');
    await page.goto(`${baseUrl}${hash}`,{waitUntil:'networkidle'});
    await page.locator('#explorer[data-ready="true"]').waitFor();
    await page.locator('canvas[data-renderer="webgl"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await pause(250);
    stage = await page.locator('.stage').boundingBox();
    if (!stage || stage.width < 700 || stage.height < 450) throw new Error('The architecture stage does not fit the capture frame.');
    await page.evaluate(() => {
      const slate=document.createElement('div');slate.id='recording-slate';
      slate.style.cssText='position:fixed;left:0;top:0;width:64px;height:64px;background:#000;z-index:2147483647;pointer-events:none';
      slate.setAttribute('aria-hidden','true');document.body.append(slate);
    });
  }
  async function slate(color) {
    await page.locator('#recording-slate').evaluate((element,color) => element.style.background=color,color);
  }
  async function rotation(enabled) {
    const control=page.getByRole('button',{name:'Auto rotate',exact:true});
    if ((await control.getAttribute('aria-pressed')==='true')!==enabled) await control.click();
    if ((await control.getAttribute('aria-pressed')==='true')!==enabled) throw new Error('Rotation control did not change state.');
  }
  async function selectResource(title) {
    await page.getByRole('button',{name:`Inspect ${title} in 3D`,exact:true}).click();
    if(await page.locator('#detail-title').textContent()!==title) throw new Error(`Could not inspect ${title}`);
  }

  async function recordChapter(index) {
    const chapter=storyboard[index];
    if (!chapter || recorded.some(item=>item.id===chapter.id)) throw new Error('Unknown or already recorded chapter.');
    const system=chapter.id==='source'?'execution':chapter.id;
    if(['overview','explode','trace'].includes(chapter.id)) await load();
    else await load(`#node=${chapter.id==='source'?'runner':system}&inside=${system}&explode=100`);
    if(chapter.id==='trace') await page.getByRole('combobox',{name:'Request entry point'}).selectOption('webhook');
    if(chapter.id==='source') {
      await page.locator('#detail-content .source-details').evaluate(element => element.open=true);
      await page.locator('#detail-content .source-details').scrollIntoViewIfNeeded();
      await page.locator('#inspector').evaluate(element=>element.scrollTop=Math.max(0,element.scrollTop-120));
    }
    const start = performance.now();
    await slate(markerColors[index]);
    if(chapter.id==='explode') {
      const slider=page.getByRole('slider',{name:'Explode layers'});
      await slider.focus();
      for(let i=0;i<100;i++){await slider.press('ArrowRight');await pause(16);}
      if(await slider.inputValue()!=='100') throw new Error('Explosion did not reach 100%.');
      // The complete resource inventory is a reading view with pan instead of orbit.
      await rotation(false);
    } else if(chapter.id==='trace') {
      await page.getByRole('button',{name:'Play tour',exact:true}).click();
      for(let step=0;step<8;step++) {
        if(step) {
          await page.getByRole('button',{name:'Next step',exact:true}).click();
          if(step<7) await page.getByRole('button',{name:'Play tour',exact:true}).click();
        }
        await pause(740);
      }
      if(await page.locator('#step-title').textContent()!=='Deliver the result') throw new Error('The illustrated request did not reach delivery.');
    } else {
      await rotation(true);
      if(chapter.id==='execution') {
        await pause(2500);await rotation(false);await selectResource('Lambda MicroVM');
        await pause(1400);await selectResource('Browser & tools');
        await pause(1400);await selectResource('Codex runner');
      } else if(chapter.id==='control') {
        await pause(2700);await rotation(false);await selectResource('Run queue');
      } else if(chapter.id==='access') {
        await pause(2700);await rotation(false);await selectResource('Credential broker');
      } else if(chapter.id==='delivery') {
        await pause(2600);await rotation(false);await selectResource('Result notifier');
      }
    }
    const remaining=chapter.seconds*1000-(performance.now()-start);
    if(remaining>0) await pause(remaining);
    const crop=chapter.id==='source'?{x:0,y:0,width:1440,height:900}:await page.locator('.stage').boundingBox();
    if (!crop) throw new Error('The capture stage disappeared.');
    await page.screenshot({path:resolve(directory,`${chapter.id}-source.png`)});
    const actualDuration=(performance.now()-start)/1000;
    await slate('#000000');
    recorded.push({...chapter,color:markerColors[index],captureSeconds:actualDuration,crop,url:page.url()});
    await writeFile(resolve(directory,'recording.json'),JSON.stringify({baseUrl,recorded,errors},null,2));
    return {chapter:chapter.id,seconds:actualDuration.toFixed(2),selected:(await page.locator('#detail-title').count())?await page.locator('#detail-title').textContent():null};
  }

  async function finish() {
    const video=page.video();
    await context.close();
    const raw=await video.path();
    if(errors.length) throw new Error(`Browser errors during capture: ${errors.join('; ')}`);
    if(recorded.length!==storyboard.length) throw new Error('The storyboard is incomplete.');
    await writeFile(resolve(directory,'recording.json'),JSON.stringify({baseUrl,raw,recorded,errors},null,2));
    return {directory,raw,chapters:recorded.length};
  }
  return {page,context,recordChapter,finish,directory};
}

export async function makeCaptions(browser,directory='test-results/architecture-demo') {
  directory=resolve(directory);
  await mkdir(directory, {recursive:true});
  const context=await browser.newContext({viewport:{width:1080,height:1080},deviceScaleFactor:1});
  const page=await context.newPage();
  for(const [index,chapter] of storyboard.entries()) {
    const template=`<!doctype html><html><head><style>
      *{box-sizing:border-box}html,body{margin:0;width:1080px;height:1080px;background:transparent;font-family:Arial,Helvetica,sans-serif;color:#edf6f4}
      .top{position:absolute;inset:0 0 auto;height:222px;background:#081316;padding:32px 42px 0}
      .brand{font-size:19px;letter-spacing:3px;font-weight:700;display:flex;justify-content:space-between;align-items:center}.brand span{font:13px monospace;letter-spacing:1.7px;color:#89edc8}
      h1{font-size:53px;font-weight:500;line-height:1.08;letter-spacing:-1.9px;margin:23px 0 0;white-space:pre-line}
      .bottom{position:absolute;inset:832px 0 0;background:#081316;padding:31px 42px 0}
      .chapter{font:16px monospace;letter-spacing:1.2px;color:#89edc8;margin-bottom:16px}
      .caption{font-size:31px;line-height:1.38;color:#d1e2dc;white-space:pre-line;letter-spacing:-.25px;margin:0}
      .foot{position:absolute;left:42px;right:42px;bottom:51px;display:flex;justify-content:space-between;font-size:14px;letter-spacing:.1px;color:#809f91}
      .progress{position:absolute;bottom:27px;left:42px;right:42px;display:flex;gap:7px}.progress i{height:3px;flex:1;background:#284138}.progress i.current{background:#89edc8}.progress i.before{background:#597d6a}
    </style></head><body><header class="top"><div class="brand">RAT THINGS<span>INSIDE THE AGENT CLOUD</span></div><h1>${escape(chapter.title)}</h1></header><footer class="bottom"><div class="chapter">${String(index+1).padStart(2,'0')} / ${String(storyboard.length).padStart(2,'0')} &nbsp; · &nbsp; ${escape(chapter.label)}</div><p class="caption">${escape(chapter.caption)}</p><div class="foot"><span>Engineering preview · source-backed architecture</span><span>3D EXPLORER</span></div><div class="progress">${storyboard.map((_,i)=>`<i class="${i===index?'current':i<index?'before':''}"></i>`).join('')}</div></footer></body></html>`;
    await page.setContent(template);
    await page.evaluate(()=>document.fonts.ready);
    const overflow=await page.locator('h1,.caption').evaluateAll(nodes=>nodes.some(node=>node.scrollWidth>node.clientWidth));
    const captionBottom=await page.locator('.caption').evaluate(node=>node.getBoundingClientRect().bottom);
    const footerTop=await page.locator('.foot').evaluate(node=>node.getBoundingClientRect().top);
    if(overflow || captionBottom>footerTop-10)throw new Error(`Caption overflows in ${chapter.id}`);
    await page.screenshot({path:resolve(directory,`${chapter.id}-caption.png`),omitBackground:true});
  }
  await context.close();
  return {captions:storyboard.length};
}
