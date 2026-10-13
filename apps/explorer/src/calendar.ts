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
