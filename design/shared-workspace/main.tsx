import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import Presence from './examples/presence'
import Panel from './examples/panel-annotation'
import AiChat from './examples/ai-chat'
import Session from './examples/session'
import Workspace from './examples/workspace'
import '../../site/brand.css'
import './kit/stageshow.css'
import './host.css'
const params=new URLSearchParams(location.search)
function App(){
  const [mode,setMode]=useState<'watch'|'try'>(params.has('try')?'try':'watch')
  const [replay,setReplay]=useState(0),[actor,setActor]=useState(0),[viewer,setViewer]=useState(false)
  const capture=params.get('capture')
  if(capture==='ai-chat')return <div id="example" className="gold"><AiChat/></div>
  if(capture==='presence'||capture==='panel-annotation')return <div id="example" className="gold">{capture==='presence'?<Presence/>:<Panel/>}</div>
  const isSession=capture==='session'||params.get('scene')==='session'
  const scene=isSession?<Session key={mode+'-'+replay} manual={mode==='try'} viewer={viewer}/>:<Workspace key={mode+'-'+replay} manual={mode==='try'} actor={actor} viewer={viewer}/>
  if(capture)return <div id="example" className="capture">{scene}</div>
  return <main className="design-host">
    <header className="host-header"><a href="/" aria-label="Rat Things design study"><img src="/mark.png" alt="" width="30" height="30"/><span>Rat Things</span></a><span className="host-label">Interactive design study</span></header>
    <section className="host-intro"><h1>{isSession?'Keep everyone in the conversation.':'Stay in the work.'}</h1><p>{isSession?'Clear authorship, visible progress, and one agent carrying the context.':'One shared Session. The artifact and the conversation, side by side.'}</p></section>
    <nav className="host-studies" aria-label="Design studies"><a href="/">Shared workspace</a><a href="/?scene=session">Session conversation</a></nav><nav className="host-controls" aria-label="Prototype controls"><div className="host-modes"><button aria-pressed={mode==='watch'} onClick={()=>setMode('watch')}>Watch the flow</button><button aria-pressed={mode==='try'} onClick={()=>setMode('try')}>Try it yourself</button></div>{mode==='watch'?<button className="host-replay" onClick={()=>setReplay(n=>n+1)}>Replay</button>:<div className="host-options">{!isSession&&<label>Act as <select value={actor} onChange={e=>setActor(Number(e.target.value))}><option value="0">Maya · Designer</option><option value="1">Eli · Engineer</option><option value="2">Sam · QA</option></select></label>}<label><input type="checkbox" checked={viewer} onChange={e=>setViewer(e.target.checked)}/>Viewer access</label></div>}</nav>
    <div id="example">{scene}</div>
    <footer className="host-notes"><p><strong>{isSession?'Reply → contribute → continue.':'Capture → pin → discuss → continue.'}</strong> {isSession?'Quoted replies keep the original context beside each contribution. The agent continues with the shared discussion.':'Everyone contributes to the same agent’s context. Captured evidence keeps its original version.'}</p><p>Design prototype. Sample people, browser and agent responses; no service calls. The existing role model and fixed Session capabilities still apply.</p></footer>
  </main>
}
createRoot(document.getElementById('root')!).render(<App/>)
