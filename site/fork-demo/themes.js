export const themes = {
  starter: {
    name: 'The starting point',
    eyebrow: 'FIELDNOTES / A PLACE TO THINK',
    headline: 'Make room for your next idea.',
    background: '#eff0ec',
    ink: '#25352b',
    accent: '#526649',
    surface: '#fff',
    detail: 'A calm workspace for people with a lot on their minds.',
  },
  paper: {
    name: 'Paper & ink',
    eyebrow: 'FIELDNOTES / SLOW DOWN. LOOK CLOSER.',
    headline: 'Good ideas need a little space.',
    background: '#f3e9d8',
    ink: '#35291f',
    accent: '#a6452d',
    surface: '#fbf5e9',
    detail:
      'A warm, thoughtful home for notes, small discoveries, and the things you want to remember.',
  },
  midnight: {
    name: 'After hours',
    eyebrow: 'FIELDNOTES / YOUR NEXT BRIGHT IDEA',
    headline: 'A little less noise. A lot more spark.',
    background: '#171e2c',
    ink: '#f5f3ff',
    accent: '#c4ff73',
    surface: '#242e40',
    detail:
      'Catch the thought. Connect the dots. Turn a flash of inspiration into something worth keeping.',
  },
};
export function renderPreview(key) {
  const t = themes[key];
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fieldnotes — ${t.name}</title><style>
  *{box-sizing:border-box}body{margin:0;background:${t.background};color:${t.ink};font:14px/1.6 system-ui,sans-serif;padding:28px 34px}nav{display:flex;justify-content:space-between;align-items:center;font-size:11px}nav strong{font-size:19px;letter-spacing:-1px}nav span{opacity:.7}.hero{padding:54px 0 30px;position:relative}.eyebrow{font-size:9px;letter-spacing:2px;font-weight:700;color:${t.accent}}h1{font-family:${key === 'midnight' ? 'system-ui,sans-serif' : 'Georgia,serif'};font-weight:${key === 'midnight' ? '750' : '400'};font-size:clamp(36px,7vw,54px);line-height:1.03;letter-spacing:-2px;max-width:440px;margin:20px 0}p{opacity:.75;max-width:320px;font-size:12px}.cta{display:inline-block;border-radius:${key === 'midnight' ? '24px' : '4px'};background:${t.accent};color:${key === 'midnight' ? '#172113' : '#fff'};padding:11px 18px;font-size:11px;font-weight:700;margin:14px 0 28px}.cards{display:grid;grid-template-columns:1fr 1fr;gap:12px}.note{background:${t.surface};border:1px solid ${t.ink}18;border-radius:${key === 'midnight' ? '15px' : '3px'};padding:18px;min-height:130px}.note small{opacity:.55;font-size:9px;letter-spacing:1px}.note h2{font:400 20px/1.25 Georgia,serif;margin:14px 0}.dots{display:flex;gap:5px}.dots i{width:8px;height:8px;background:${t.accent};border-radius:50%}.footer{display:flex;justify-content:space-between;margin-top:28px;font-size:9px;opacity:.5}@media(max-width:420px){body{padding:23px}.hero{padding-top:35px}h1{font-size:38px}.cards{gap:8px}.note{padding:12px}.note h2{font-size:17px}.note>small:last-child:not(:first-child){display:none}}
  </style><nav><strong>fieldnotes<span style="color:${t.accent}"> ✳</span></strong><span>Your thoughts, collected.</span></nav><main><section class="hero"><div class="eyebrow">${t.eyebrow}</div><h1>${t.headline}</h1><p>${t.detail}</p><span class="cta">Start a fresh page ↗</span></section><section class="cards"><article class="note"><small>01 / COLLECT</small><h2>Small things.<br>Big possibilities.</h2><div class="dots"><i></i><i></i><i></i></div></article><article class="note"><small>02 / CONNECT</small><h2>Follow a thought.<br>See where it goes.</h2><small>THERE'S SOMETHING HERE ↗</small></article></section></main><div class="footer"><span>A little space for what matters.</span><span>MADE FOR YOUR MIND</span></div></html>`;
}
