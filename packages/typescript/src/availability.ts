import type { Scene, SearchPage } from "./index.js";
import { acquisitionTimestamp } from "./datetime.js";

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
  hasMore: boolean;                     // pending or possibly truncated provider
}
export interface AvailabilitySummary {
  days: AvailabilityDay[];
  months: AvailabilityMonth[];
  providers: ProviderAvailability[];
  pagesScanned: number;
  rawItems: number;
  uniqueItems: number;
  complete: boolean;                    // expected providers finished without errors/truncation
  truncatedProviders: string[];
  erroredProviders: string[];           // providers whose scan failed mid-stream
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
  private readonly errors=new Set<string>();
  private readonly utcDates=new Map<string,string>();
  private pagesScanned=0;
  private rawItems=0;

  /** Record that a provider's scan failed part-way; partial counts are retained. */
  markError(providerId:string):void { if(providerId) this.errors.add(providerId); }

  /** Keep a not-yet-scanned provider from making an aggregate look complete. */
  expectProvider(providerId: string): void {
    if (!providerId) throw new Error("Invalid availability provider identity");
    if (!this.providerStates.has(providerId)) {
      this.providerStates.set(providerId, { id: providerId, pagesScanned: 0,
        rawItems: 0, uniqueItems: 0, matched: null, hasMore: true });
    }
  }

  addPage(page:SearchPage): Scene[] {
    if (!page.providerId || !Number.isInteger(page.pageNumber) || page.pageNumber < 1 ||
      !Array.isArray(page.items)) throw new Error("Invalid availability search page");
    // Validate before mutating counters, so a bad page can be corrected and retried.
    const dates = page.items.map(scene => {
      const cached = this.utcDates.get(scene.acquiredAt);
      if (cached !== undefined) return cached;
      const timestamp = acquisitionTimestamp(scene.acquiredAt);
      if (!timestamp) throw new Error("Invalid acquisition UTC date in normalized scene");
      const date = timestamp.slice(0, 10);
      if (this.utcDates.size >= 1024) this.utcDates.delete(this.utcDates.keys().next().value!);
      this.utcDates.set(scene.acquiredAt, date);
      return date;
    });
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
    for (const [index, scene] of page.items.entries()) {
      // A provider can return repeated STAC IDs on overlapping/paginated searches.
      // Equivalent items in *different* catalogues remain distinct and traceable.
      const key=JSON.stringify([page.providerId,scene.collection,scene.id]);
      if (this.ids.has(key)) continue;
      this.ids.add(key);
      source.uniqueItems++;
      novel.push(scene);
      const date=dates[index];
      const month=date.slice(0,7);
      const mission=scene.mission || "unknown";
      let day=this.days.get(date);
      if(!day) {
        day={count:0,missions:Object.create(null),collections:Object.create(null)};
        this.days.set(date,day);
      }
      day.count++;
      increment(day.missions,mission);
      increment(day.collections,scene.collection || "unknown");
      let monthly=this.months.get(month);
      if(!monthly) {
        monthly={count:0,missions:Object.create(null),collections:Object.create(null),days:new Set<string>()};
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
      complete:this.pagesScanned>0 && truncatedProviders.length===0 && this.errors.size===0,
      truncatedProviders,
      erroredProviders:[...this.errors].sort(),
    };
  }
}

/** Useful when the caller already streamed/retained several STAC pages. */
export function summarizeAvailability(pages:Iterable<SearchPage>):AvailabilitySummary {
  const aggregator=new AvailabilityAccumulator();
  for(const page of pages) aggregator.addPage(page);
  return aggregator.summary();
}
