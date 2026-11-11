import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
const output=new URL('../../../artifacts/shared-workspace/design/',import.meta.url).pathname;
await mkdir(output,{recursive:true});
const findings=[];
try {
 for(const width of [1280,390]) {
  const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:4177/?try=1');
  await page.getByRole('button',{name:'Add comment',exact:true}).click();
  await page.locator('[data-target=artifact]').click({position:{x:80,y:70}});
  await page.getByRole('textbox',{name:'Your feedback'}).fill('Keep this evidence attached to the original page.');
  if(width<760)await page.getByRole('button',{name:'Work',exact:true}).click();
  await page.getByRole('tab',{name:'Mockup'}).click();
  if(width<760)await page.getByRole('button',{name:'Conversation',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'Your feedback'}).inputValue(),'');
  if(width<760)await page.getByRole('button',{name:'Work',exact:true}).click();
  await page.getByRole('tab',{name:'Browser'}).click();
  if(width<760)await page.getByRole('button',{name:'Conversation',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'Your feedback'}).inputValue(),'Keep this evidence attached to the original page.');
  await page.getByRole('button',{name:'Send feedback'}).click();
  assert.equal(await page.getByRole('textbox',{name:'Your feedback'}).inputValue(),'');
  await page.getByRole('button',{name:'Reply to Maya'}).click();
  await page.getByRole('textbox',{name:'Your feedback'}).fill('This draft survives cancellation.');
  await page.getByRole('button',{name:'Cancel reply'}).click();
  assert.equal(await page.getByRole('textbox',{name:'Your feedback'}).inputValue(),'This draft survives cancellation.');
  await page.getByRole('combobox',{name:'Act as'}).selectOption('1');
  await page.getByRole('button',{name:'Send feedback'}).click();
  assert.equal(await page.getByRole('button',{name:'Reply to Eli'}).count(),1);
  await page.getByRole('checkbox',{name:'Viewer access'}).check();
  assert.equal(await page.getByRole('textbox',{name:'Your feedback'}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Resolve',exact:true}).isDisabled(),true);
  await page.getByRole('checkbox',{name:'Viewer access'}).uncheck();
  await page.getByRole('button',{name:'View Maya',exact:true}).click();
  assert.equal(await page.getByText('Access follows the Product team space.').isVisible(),true);
  await page.getByRole('button',{name:'View Maya',exact:true}).click();
  await page.screenshot({path:output+`interactive-${width}.png`,fullPage:true});
  assert.deepEqual(errors,[]);
  findings.push({width,draftPerArtifact:true,replyCancellationPreservesDraft:true,actorSwitch:true,viewerReadOnly:true,peoplePopover:true,pageErrors:errors});
  await page.close();
 }
 await writeFile(output+'interaction-checks.json',JSON.stringify(findings,null,2));
 console.log(JSON.stringify(findings));
} finally {await browser.close()}
