// Executes the current scanNextBatch function, extracted verbatim from main.ts,
// with real SDK split-box pages and UI rendering replaced by no-op stubs.
// Offline: node tools/audit/results/2026-10-16-codebase-cap.mjs
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import {StacProvider, AvailabilityAccumulator} from '../../../packages/typescript/dist/index.js';
const main=fs.readFileSync(new URL('../../../apps/explorer/src/main.ts',import.meta.url),'utf8');
const start=main.indexOf('async function scanNextBatch(');
const end=main.indexOf('\nloadNextPagesButton.addEventListener',start);
const compiled=stripTypeScriptTypes(main.slice(start,end),{mode:'strip'});
let currentSummary=null,loadedScenes=[],searchErrored=false,autoSelectionPending=false;
let selectedDay=null,displayedLimit=40;
const status={textContent:''},loadNextPagesButton={disabled:false,hidden:false};
const dedupeScenes=x=>x;
const currentSearchSignature=()=> 'audit';
const updateFilterChoices=()=>{},redrawAvailability=()=>{},renderLoadedScenes=()=>{},storeSearchLink=()=>{};
const calls=[];
function provider(id,firstBoxPages,secondBoxPages){
 return new StacProvider({id,baseUrl:'https://'+id+'.test/v1',collections:['a'],fetchImpl:async (url,init)=>{
   const body=JSON.parse(init.body);
   const box=body.box??(body.bbox[0]>0?'east':'west');
   const number=body.page??1;
   calls.push({id,box,number});
   const maximum=box==='east'?firstBoxPages:secondBoxPages;
   const features=id==='earth-search'&&box==='west'?[{id:'omitted-west-scene',collection:'a',properties:{datetime:'2025-01-01T12:00:00Z'}}]:[];
   return Response.json({features,links:number<maximum?[{rel:'next',href:String(url),method:'POST',body:{box,page:number+1}}]:[]});
 }});
}
const providers=[provider('planetary-computer',1,4),provider('earth-search',45,1)];
const accumulator=new AvailabilityAccumulator();
for(const provider of providers)accumulator.expectProvider(provider.id);
const query={latitude:0,longitude:180,radiusMeters:1000,from:'2025-01-01',to:'2025-01-01',maxPages:50};
const iterator=(async function*(){for(const provider of providers)yield*provider.search(query);})();
const session={controller:new AbortController(),accumulator,iterator,fetching:false,ended:false,signature:'audit'};
const activeScan=session;
// Direct eval retains this fixture's lexical UI state, as the real module does.
eval(compiled+'\nglobalThis.auditScanNextBatch=scanNextBatch;');
for(let i=0;i<20&&!session.ended;i++)await globalThis.auditScanNextBatch(session);
const before=calls.length;
const pending=await iterator.next();
console.log(JSON.stringify({pagesScanned:currentSummary.pagesScanned,complete:currentSummary.complete,
 stoppedByExplorer:session.ended,status:status.textContent,calendarTruncatedProviders:currentSummary.truncatedProviders,
 unconsumedPageExists:!pending.done,omittedScenes:pending.value?.items.map(scene=>scene.id),extraRequestsToExposeOmittedPage:calls.length-before,lastRequest:calls.at(-1)},null,2));
