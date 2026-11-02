import { useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { createPromptEditorModel } from '@codecaine-ai/prompt-kit/ui';
import { PROMPT_STYLE_DEFAULTS, promptStyleVars } from '@codecaine-ai/prompt-kit/ui/style';
import { PromptFlowXml } from '../../../../prompt-kit/packages/prompt-kit/src/ui/editor/buffer';
import { fixtures } from './fixtures';
import '../index.css';
import './style.css';
const options=[['baseline','Previous blue','Color alone; lighter tag weight.'],['plum','Plum + bold tags','One structural hue, heavier paired tags.'],['depth','Depth colors + guides','Purple chapters, teal sections, ochre details.'],['ink','Ink + section bands','Dark tags, restrained chapter tint, stronger guides.']] as const;
function Sample({variant,index,theme}:{variant:string;index:number;theme:string}) {
 const [prompt,setPrompt]=useState(()=>createPromptEditorModel(fixtures[index]!.prompt).prompt);
 const [selected,setSelected]=useState<string>();
 const model=createPromptEditorModel(prompt);
 return <div className={`sample observatory-prompt-theme ${variant}`} data-theme={theme} style={{...promptStyleVars({...PROMPT_STYLE_DEFAULTS,marginLeft:8,contentWidth:88}),...{fontFamily:'var(--prompt-editor-font-family)'}} as CSSProperties}>
 <PromptFlowXml prompt={prompt} model={model} onSelectNode={setSelected} selectedNodeId={selected} onPromptChange={setPrompt}/></div>
}
function App(){
 const [index,setIndex]=useState(1); const [theme,setTheme]=useState('light'); const [view,setView]=useState('all');
 return <><header className="comparison-controls"><div><h1>Prompt readability comparisons</h1><p>Six synthetic prompts. Real editor. Changes here stay in this page.</p></div><label>Prompt<select value={index} onChange={e=>setIndex(Number(e.target.value))}>{fixtures.map((f,i)=><option key={f.name} value={i}>{f.name}</option>)}</select></label><label>Theme<select value={theme} onChange={e=>setTheme(e.target.value)}><option>light</option><option>dark</option></select></label><label>View<select value={view} onChange={e=>setView(e.target.value)}><option value="all">Compare four</option>{options.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label></header><main className={view==='all'?'comparisons':'comparisons single'}>{options.filter(([id])=>view==='all'||view===id).map(([id,name,description])=><article key={id}><header><h2>{name}</h2><p>{description}</p></header><Sample key={`${id}:${index}`} variant={id} index={index} theme={theme}/></article>)}</main></>
}
createRoot(document.getElementById('root')!).render(<App/>);
