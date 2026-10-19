// Run after npm run build -w @powerpuff-kitty/satellites-images.
import { polygonBoxes, StacProvider, summarizeAvailability } from '../../../packages/typescript/dist/index.js';
const aoi = {type:'MultiPolygon', coordinates:[
  [[[179,10],[-179,10],[-179,12],[179,12],[179,10]]],
  [[[-1,0],[1,0],[1,1],[-1,1],[-1,0]]]
]};
const boxes = polygonBoxes(aoi);
const point=[0,0.5];
console.log(JSON.stringify({language:'typescript', boxes, requestedInteriorPoint:point,
  boxesCoverRequestedPoint:boxes.some(([w,s,e,n])=>w<=point[0]&&point[0]<=e&&s<=point[1]&&point[1]<=n)}));
let requested;
const provider = new StacProvider({id:'audit',baseUrl:'https://example.test/v1',collections:['a'],fetchImpl:async (_url,init)=>{
  requested=JSON.parse(init.body);
  const candidate={id:'last-second',collection:'a',properties:{datetime:'2025-01-01T23:59:59.500Z'}};
  // Inclusive interval semantics: provider only returns timestamps within the requested bounds.
  const end=Date.parse(requested.datetime.split('/')[1]);
  return Response.json({features:Date.parse(candidate.properties.datetime)<=end?[candidate]:[],links:[]});
}});
const pages=[];
for await (const page of provider.search({latitude:0,longitude:0,radiusMeters:1000,from:'2025-01-01',to:'2025-01-01'}))pages.push(page);
console.log(JSON.stringify({language:'typescript',requestedDatetime:requested.datetime,omittedTimestamp:'2025-01-01T23:59:59.500Z',items:pages[0].items.length,complete:summarizeAvailability(pages).complete}));
