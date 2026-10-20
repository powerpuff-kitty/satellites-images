"""Run: PYTHONPATH=packages/python/src python3 tools/audit/results/2026-10-16-codebase-spatial.py"""
import json
from datetime import datetime
from satellites_images import polygon_boxes, StacProvider, SearchQuery, summarize_availability
aoi={'type':'MultiPolygon','coordinates':[
 [[[179,10],[-179,10],[-179,12],[179,12],[179,10]]],
 [[[-1,0],[1,0],[1,1],[-1,1],[-1,0]]]
]}
boxes=polygon_boxes(aoi)
point=[0,0.5]
print(json.dumps({'language':'python','boxes':boxes,'requestedInteriorPoint':point,'boxesCoverRequestedPoint':any(w<=point[0]<=e and s<=point[1]<=n for w,s,e,n in boxes)}))
requested={}
def transport(url,method,body):
 requested.update(body)
 candidate={'id':'last-second','collection':'a','properties':{'datetime':'2025-01-01T23:59:59.500Z'}}
 end=datetime.fromisoformat(body['datetime'].split('/')[1].replace('Z','+00:00'))
 return {'features':[candidate] if datetime.fromisoformat(candidate['properties']['datetime'].replace('Z','+00:00'))<=end else [],'links':[]}
provider=StacProvider(id='audit',base_url='https://example.test/v1',collections=('a',),transport=transport)
pages=list(provider.search(SearchQuery(latitude=0,longitude=0,radius_meters=1000,start='2025-01-01',end='2025-01-01')))
print(json.dumps({'language':'python','requestedDatetime':requested['datetime'],'omittedTimestamp':'2025-01-01T23:59:59.500Z','items':len(pages[0].items),'complete':summarize_availability(pages).complete}))
