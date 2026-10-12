import type { Scene, SearchPage } from "./index.js";

/**
 * All counts describe STAC items returned by the pages actually scanned.
 * They never imply all satellites, all providers or complete remote archives.
 */
export interface AvailabilityDay {
  date: string;                         // UTC YYYY-MM-DD
  count: number;                        // unique provider-native items
  missions: Record<string, number>;
  collections: Record<string, number>;
}
export interface AvailabilityMonth {
  month: string;                        // UTC YYYY-MM
  count: number;                        // unique provider-native items
  daysWithObservations: number;
  missions: Record<string, number>;
}
export interface ProviderAvailability {
  id: string;
  pagesScanned: number;
  rawItems: number;
  uniqueItems: number;
  matched: number | null;               // provider-estimated count, may be absent
  hasMore: boolean;                     // last scanned page has a next link
}
export interface AvailabilitySummary {
  days: AvailabilityDay[];
  months: AvailabilityMonth[];
  providers: ProviderAvailability[];
  pagesScanned: number;
  rawItems: number;
  uniqueItems: number;
  complete: boolean;                    // all next links exhausted in scanned providers
  truncatedProviders: string[];
}

function increment(map: Record<string,number>,key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}
function sortedRecord(record:Record<string,number>):Record<string,number> {
  return Object.fromEntries(Object.entries(record).sort(([a],[b]) => a.localeCompare(b)));
}
interface MutableDay { count:number; missions:Record<string,number>; collections:Record<string,number> }
interface MutableMonth extends MutableDay { days:Set<string> }

/** Incremental aggregation that can update a map/calendar after every streamed page. */
export class AvailabilityAccumulator {
  private readonly ids=new Set<string>();
  private readonly days=new Map<string,MutableDay>();
  private readonly months=new Map<string,MutableMonth>();
  private readonly providerStates=new Map<string,ProviderAvailability>();
  private pagesScanned=0;
  private rawItems=0;

  addPage(page:SearchPage): Scene[] {
    if (!page.providerId || !Number.isInteger(page.pageNumber) || page.pageNumber < 1 ||
      !Array.isArray(page.items)) throw new Error("Invalid availability search page");
    let source=this.providerStates.get(page.providerId);
    if (!source) {
      source={id:page.providerId,pagesScanned:0,rawItems:0,uniqueItems:0,
        matched:null,hasMore:false};
      this.providerStates.set(page.providerId,source);
    }
    this.pagesScanned++;
    source.pagesScanned++;
    source.rawItems+=page.items.length;
    source.hasMore=page.hasNext;
    if (page.matched!==null && Number.isFinite(page.matched) && page.matched>=0)
      source.matched=page.matched;
    this.rawItems+=page.items.length;
    const novel:Scene[]=[];
    for (const scene of page.items) {
      // A provider can return repeated STAC IDs on overlapping/paginated searches.
      // Equivalent items in *different* catalogues remain distinct and traceable.
      const key=JSON.stringify([page.providerId,scene.collection,scene.id]);
      if (this.ids.has(key)) continue;
      this.ids.add(key);
      source.uniqueItems++;
      novel.push(scene);
      const date=scene.acquiredAt.slice(0,10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        throw new Error("Invalid acquisition UTC date in normalized scene");
      const month=date.slice(0,7);
      const mission=scene.mission || "unknown";
      let day=this.days.get(date);
      if(!day) {
        day={count:0,missions:{},collections:{}};
        this.days.set(date,day);
      }
      day.count++;
      increment(day.missions,mission);
      increment(day.collections,scene.collection || "unknown");
      let monthly=this.months.get(month);
      if(!monthly) {
        monthly={count:0,missions:{},collections:{},days:new Set<string>()};
        this.months.set(month,monthly);
      }
      monthly.count++;
      monthly.days.add(date);
      increment(monthly.missions,mission);
      increment(monthly.collections,scene.collection || "unknown");
    }
    return novel;
  }

  summary(): AvailabilitySummary {
    const providers=[...this.providerStates.values()].map(p=>({...p}))
      .sort((a,b)=>a.id.localeCompare(b.id));
    const truncatedProviders=providers.filter(p=>p.hasMore).map(p=>p.id);
    return {
      days:[...this.days.entries()]
        .sort(([a],[b])=>a.localeCompare(b))
        .map(([date,d])=>({date,count:d.count,
          missions:sortedRecord(d.missions),
          collections:sortedRecord(d.collections)})),
      months:[...this.months.entries()]
        .sort(([a],[b])=>a.localeCompare(b))
        .map(([month,m])=>({month,count:m.count,daysWithObservations:m.days.size,
          missions:sortedRecord(m.missions)})),
      providers,
      pagesScanned:this.pagesScanned,
      rawItems:this.rawItems,
      uniqueItems:this.ids.size,
      complete:providers.length>0 && truncatedProviders.length===0,
      truncatedProviders,
    };
  }
}

/** Useful when the caller already streamed/retained several STAC pages. */
export function summarizeAvailability(pages:Iterable<SearchPage>):AvailabilitySummary {
  const aggregator=new AvailabilityAccumulator();
  for(const page of pages) aggregator.addPage(page);
  return aggregator.summary();
}
