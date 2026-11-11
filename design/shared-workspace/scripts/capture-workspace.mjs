import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const output=new URL('../../../artifacts/shared-workspace/design/',import.meta.url).pathname;
await mkdir(output+'beats',{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
try {
 for(const width of [1080,390]) {
  const page=await browser.newPage({viewport:{width,height:850},deviceScaleFactor:2,reducedMotion:'reduce'});
  await page.goto('http://127.0.0.1:4177/?capture=workspace');await page.evaluate(()=>document.fonts.ready);
  await page.locator('.ss-fit').screenshot({path:output+`poster-${width===1080?'wide':'compact'}.png`});
  await page.close();
 }
 const page=await browser.newPage({viewport:{width:1080,height:750},deviceScaleFactor:1});
 await page.goto('http://127.0.0.1:4177/?capture=workspace');await page.evaluate(()=>document.fonts.ready);
 const marks=['capture','pin','reply','agent','complete'];
 for(const mark of marks) {
  await page.waitForSelector(`[data-mark="${mark}"]`,{timeout:20000});
  for(let i=0;i<8;i++) {
   await page.locator('.ss-fit').screenshot({path:output+`beats/${mark}-${i}.png`});
   await delay(40);
  }
 }
 await page.close();
 const movie=await browser.newPage({viewport:{width:1080,height:750},deviceScaleFactor:1});
 await mkdir(output+'movie-frames',{recursive:true});
 await movie.goto('http://127.0.0.1:4177/?capture=workspace');await movie.evaluate(()=>document.fonts.ready);
 const times=[];const start=performance.now();
 for(let i=0;i<160;i++){
  const file=`movie-frames/${String(i).padStart(4,'0')}.jpg`;
  times.push({file,at:(performance.now()-start)/1000});
  await movie.screenshot({path:output+file,type:'jpeg',quality:90});
  await delay(Math.max(0,start+(i+1)*100-performance.now()));
 }
 let concat=times.map((frame,i)=>`file '${frame.file}'\nduration ${(times[i+1]?.at??16)-frame.at}\n`).join('');
 concat+=`file '${times.at(-1).file}'\n`;
 await writeFile(output+'movie-frames.txt',concat);
 await writeFile(output+'movie-timing.json',JSON.stringify(times,null,2));
 await movie.close();
} finally{await browser.close()}
