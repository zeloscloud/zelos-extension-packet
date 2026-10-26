import type { LatestSignalValue } from "@zeloscloud/app-extension-sdk";
import { describe, expect, it } from "vitest";
import { formatPacketStats, summarizePacketStats } from "../stats";

function value(signal: string, v: number, over: Partial<LatestSignalValue> = {}): LatestSignalValue {
  return {
    source: "packet",
    message: "en0/stats",
    signal,
    producer: null,
    value: String(v),
    tracePath: null,
    timeNs: "100",
    dataSegmentId: null,
    ...over,
  };
}

const EN0 = [
  value("packets_captured", 1500),
  value("packets_dropped_kernel", 2),
  value("packets_dropped_agent", 0),
  value("truncated_count", 0),
  value("pps", 120.4),
  value("bps", 1_500_000),
];

describe("packet stats strip", () => {
  it("reads one capture into the Wireshark line, hiding a zero truncated count", () => {
    const summary = summarizePacketStats(EN0);
    expect(summary).toEqual({
      captures: 1,
      packets: 1500,
      droppedKernel: 2,
      droppedAgent: 0,
      truncated: 0,
      pps: 120.4,
      bps: 1_500_000,
    });
    expect(summary && formatPacketStats(summary)).toBe(
      "Packets 1,500 · Dropped 2 kernel / 0 agent · 120 pps · 1.5 Mbit/s",
    );
  });

  it("sums captures and names how many, and shows truncation once it is non-zero", () => {
    const wlan = EN0.map((v) => value(v.signal, Number(v.value), { message: "wlan0/stats" }));
    const both = [...EN0, ...wlan, value("truncated_count", 7, { message: "wlan0/stats", timeNs: "200" })];
    const summary = summarizePacketStats(both);
    expect(summary && formatPacketStats(summary)).toBe(
      "Packets 3,000 · Dropped 4 kernel / 0 agent · 241 pps · 3.0 Mbit/s · Truncated 7 · 2 captures",
    );
  });

  it("drops the two rates on request and keeps the counts", () => {
    const summary = summarizePacketStats([...EN0, value("truncated_count", 3, { timeNs: "200" })]);
    expect(summary && formatPacketStats(summary, { rates: false })).toBe(
      "Packets 1,500 · Dropped 2 kernel / 0 agent · Truncated 3",
    );
  });

  it("answers null with no stats values, and takes the newest answer per field", () => {
    expect(summarizePacketStats([])).toBeNull();
    expect(
      summarizePacketStats([
        value("packets_captured", 5, { timeNs: "300" }),
        value("packets_captured", 9, { timeNs: "200" }),
      ])?.packets,
    ).toBe(5);
  });
});
