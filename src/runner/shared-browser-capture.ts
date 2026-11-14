export const browserCaptureExpression = String.raw`(() => {
  const elements = [];
  const candidates = document.body?.querySelectorAll('h1,h2,h3,h4,h5,h6,p,button,a,label,li,td,th,pre,img,[role="button"],[role="heading"]') || [];
  for (let index = 0; index < Math.min(candidates.length, 2000) && elements.length < 256; index++) {
    const node = candidates[index];
    const bounds = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    const left = Math.max(0, bounds.left), top = Math.max(0, bounds.top);
    const right = Math.min(1280, bounds.right), bottom = Math.min(800, bounds.bottom);
    if (right - left < 2 || bottom - top < 2) continue;
    const text = (node.innerText || node.getAttribute('aria-label') || node.getAttribute('alt') || '').trim().slice(0, 500);
    if (!text && node.tagName !== 'IMG') continue;
    elements.push({id:'element_'+index, text, x:left/1280, y:top/800, width:(right-left)/1280, height:(bottom-top)/800});
  }
  return JSON.stringify({url:location.href,title:document.title.slice(0,1000),text:(document.body?.innerText||'').slice(0,12000),elements});
})()`;
