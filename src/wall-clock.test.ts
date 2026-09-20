import { describe,it,expect } from "vitest";
import { wallClockRecurrence,nextWallClock } from "./wall-clock.js";
describe("local-clock recurrence",()=>{
 it("keeps 9am through spring and autumn DST",()=>{
  for(const [first,next] of [["2026-03-07T14:00:00Z","2026-03-08T13:00:00.000Z"],["2026-10-31T13:00:00Z","2026-11-01T14:00:00.000Z"]]){
   const r=wallClockRecurrence(first!,"daily","America/New_York");
   expect(nextWallClock(r,new Date(first!))).toBe(next);
  }
 });
 it("moves a skipped time forward without permanently drifting the series",()=>{
  const r=wallClockRecurrence("2026-03-07T07:30:00Z","daily","America/New_York");
  const gap=nextWallClock(r,new Date("2026-03-07T07:30:00Z"));
  expect(gap).toBe("2026-03-08T07:30:00.000Z");
  expect(nextWallClock(r,new Date(gap))).toBe("2026-03-09T06:30:00.000Z");
 });
 it("fires only at the first occurrence of a repeated local time",()=>{
  const r=wallClockRecurrence("2026-10-31T05:30:00Z","daily","America/New_York");
  expect(nextWallClock(r,new Date("2026-10-31T05:30:00Z"))).toBe("2026-11-01T05:30:00.000Z");
  expect(nextWallClock(r,new Date("2026-11-01T05:30:00Z"))).toBe("2026-11-02T06:30:00.000Z");
 });
 it("coalesces long offline periods and skips weekends",()=>{
  const r=wallClockRecurrence("2026-01-02T09:00:00Z","weekdays","UTC");
  expect(nextWallClock(r,new Date("2026-09-19T12:00:00Z"))).toBe("2026-09-21T09:00:00.000Z");
  const weekly=wallClockRecurrence("2026-01-02T09:00:00Z","weekly","UTC");
  expect(nextWallClock(weekly,new Date("2026-09-19T12:00:00Z"))).toBe("2026-09-25T09:00:00.000Z");
 });
});
