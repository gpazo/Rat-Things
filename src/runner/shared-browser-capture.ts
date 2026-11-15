export const browserCaptureExpression = (width: number, height: number): string => String.raw`(() => {
  const elements = [];
  const candidates = document.body?.querySelectorAll('h1,h2,h3,h4,h5,h6,p,button,a,label,li,td,th,pre,img,[role="button"],[role="heading"]') || [];
  for (let index = 0; index < Math.min(candidates.length, 2000) && elements.length < 256; index++) {
    const node = candidates[index];
    const bounds = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    const left = Math.max(0, bounds.left), top = Math.max(0, bounds.top);
    const right = Math.min(${width}, bounds.right), bottom = Math.min(${height}, bounds.bottom);
    if (right - left < 2 || bottom - top < 2) continue;
    const text = (node.innerText || node.getAttribute('aria-label') || node.getAttribute('alt') || '').trim().slice(0, 500);
    if (!text && node.tagName !== 'IMG') continue;
    elements.push({id:'element_'+index, text, x:left/${width}, y:top/${height}, width:(right-left)/${width}, height:(bottom-top)/${height}});
  }
  return JSON.stringify({url:location.href,title:document.title.slice(0,1000),text:(document.body?.innerText||'').slice(0,12000),elements});
})()`;
