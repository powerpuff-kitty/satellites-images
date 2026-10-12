import type { AvailabilitySummary } from "@powerpuff-kitty/satellites-images";

export function shiftMonth(value:string,offset:number):string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || !Number.isInteger(offset))
    throw new Error("Invalid UTC month or offset");
  const [year,month]=value.split("-").map(Number);
  return new Date(Date.UTC(year,month-1+offset,1)).toISOString().slice(0,7);
}
export function monthDates(month:string):{from:string;to:string} {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid UTC month");
  const [year,number]=month.split("-").map(Number);
  const last=new Date(Date.UTC(year,number,0)).toISOString().slice(0,10);
  return {from:month+"-01",to:last};
}
export function asMonthLabel(month:string):string {
  const date=new Date(month+"-01T00:00:00Z");
  return new Intl.DateTimeFormat(undefined,{month:"short",year:"numeric",timeZone:"UTC"}).format(date);
}
function labelDay(day:string,count:number,complete:boolean):string {
  return count
    ? day+": "+count+" observation"+(count===1?"":"s")+" returned"
    : day+": none in loaded pages"+(complete?"":" (search may be incomplete)");
}
/** DOM-only calendar; zero values represent loaded pages, not guaranteed archive absence. */
export function renderDayCalendar(
  container:HTMLElement,
  summary:AvailabilitySummary,
  focusMonth:string,
  selectedDay:string|null,
  onSelect:(day:string|null)=>void,
):void {
  const {to}=monthDates(focusMonth);
  const countByDay=new Map(summary.days.map(d=>[d.date,d.count]));
  const numberOfDays=Number(to.slice(8,10));
  const start=new Date(focusMonth+"-01T00:00:00Z").getUTCDay();
  const mondayOffset=(start+6)%7;
  const fragment=document.createDocumentFragment();
  for(const label of ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]) {
    const header=document.createElement("div");
    header.className="weekday";
    header.textContent=label;
    fragment.append(header);
  }
  for(let index=0;index<mondayOffset;index++) {
    const spacer=document.createElement("span");
    spacer.className="day-spacer";
    spacer.setAttribute("aria-hidden","true");
    fragment.append(spacer);
  }
  for(let index=1;index<=numberOfDays;index++){
    const date=focusMonth+"-"+String(index).padStart(2,"0");
    const count=countByDay.get(date)??0;
    const button=document.createElement("button");
    button.className="day-cell"+(count?" has-scenes":"")+(selectedDay===date?" selected":"");
    button.type="button";
    button.setAttribute("aria-pressed",String(selectedDay===date));
    button.setAttribute("aria-label",labelDay(date,count,summary.complete));
    button.title=labelDay(date,count,summary.complete);
    const day=document.createElement("span");
    day.textContent=String(index);
    const number=document.createElement("small");
    number.textContent=count?String(count):"·";
    button.append(day,number);
    button.addEventListener("click",()=>onSelect(selectedDay===date?null:date));
    fragment.append(button);
  }
  container.replaceChildren(fragment);
}
export function renderMonthStrip(
  container:HTMLElement,summary:AvailabilitySummary,from:string,to:string,focusMonth:string,
  onSelect:(month:string)=>void,
):void {
  const byMonth=new Map(summary.months.map(d=>[d.month,d.count]));
  const start=from.slice(0,7),end=to.slice(0,7);
  // Keep the strip bounded for extremely long search windows.
  const months:string[]=[];
  let month=start;
  while(month<=end && months.length<240) {
    months.push(month);
    month=shiftMonth(month,1);
  }
  const visible=months.length>24?months.filter((m,i)=>i>=months.length-24):months;
  const fragment=document.createDocumentFragment();
  for(const name of visible) {
    const button=document.createElement("button");
    button.type="button";
    button.className="month-pill"+(name===focusMonth?" active":"");
    button.setAttribute("aria-pressed",String(name===focusMonth));
    button.setAttribute("aria-label",asMonthLabel(name)+", "+(byMonth.get(name)??0)+" returned scenes");
    const monthLabel=document.createElement("span");
    monthLabel.textContent=asMonthLabel(name);
    const count=document.createElement("small");
    count.textContent=String(byMonth.get(name)??0);
    button.append(monthLabel,count);
    button.addEventListener("click",()=>onSelect(name));
    fragment.append(button);
  }
  container.replaceChildren(fragment);
}
