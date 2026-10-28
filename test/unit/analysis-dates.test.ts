import { describe, expect, it } from "vitest";
import {
  endOfDay,
  formatInZone,
  hourIn,
  resolveRange,
  startOfDay,
  weekdayIn,
  wholeDaysBetween,
  ymdIn,
} from "../../src/analysis/dates";

describe("analysis/dates: タイムゾーンの日付境界", () => {
  it("startOfDay / endOfDay: Asia/Tokyo の当日 00:00 と 23:59:59.999", () => {
    const ymd = { y: 2026, m: 10, d: 28 };
    expect(startOfDay(ymd, "Asia/Tokyo").toISOString()).toBe("2026-10-27T15:00:00.000Z");
    expect(endOfDay(ymd, "Asia/Tokyo").toISOString()).toBe("2026-10-28T14:59:59.999Z");
  });

  it("UTC では日付どおり、米国東部(夏時間の前後)でもその日の壁時計の境界になる", () => {
    const ymd = { y: 2026, m: 10, d: 28 };
    expect(endOfDay(ymd, "UTC").toISOString()).toBe("2026-10-28T23:59:59.999Z");
    // 10/28 の America/New_York は EDT(-04:00)、11/2 は EST(-05:00) に切り替わった後。
    expect(startOfDay(ymd, "America/New_York").toISOString()).toBe("2026-10-28T04:00:00.000Z");
    expect(startOfDay({ y: 2026, m: 11, d: 2 }, "America/New_York").toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
  });

  it("ymdIn / hourIn / weekdayIn: 瞬間をタイムゾーンの暦日・時・曜日に直す", () => {
    const t = new Date("2026-10-27T16:30:00Z"); // JST では 10/28 01:30(水)
    expect(ymdIn(t, "Asia/Tokyo")).toEqual({ y: 2026, m: 10, d: 28 });
    expect(hourIn(t, "Asia/Tokyo")).toBe(1);
    expect(weekdayIn(t, "Asia/Tokyo")).toBe(3); // 0 = 日曜
    expect(hourIn(t, "UTC")).toBe(16);
    expect(weekdayIn(t, "UTC")).toBe(2);
  });

  it("hourIn: 午前 0 時は 0(24 にならない)", () => {
    expect(hourIn(new Date("2026-10-27T15:00:00Z"), "Asia/Tokyo")).toBe(0);
  });

  it("formatInZone: オフセットつき RFC 3339", () => {
    expect(formatInZone(new Date("2026-10-25T15:00:00Z"), "Asia/Tokyo")).toBe(
      "2026-10-26T00:00:00+09:00",
    );
    expect(formatInZone(new Date("2026-10-28T23:59:59.999Z"), "UTC")).toBe(
      "2026-10-28T23:59:59.999Z",
    );
  });

  it("wholeDaysBetween: Go の int() と同じ 0 方向の切り捨て(将来日付で -1 にならない)", () => {
    const now = new Date("2026-10-28T00:00:00Z");
    expect(wholeDaysBetween("2026-10-21T00:00:00Z", now)).toBe(7);
    expect(wholeDaysBetween("2026-10-21T00:00:01Z", now)).toBe(6);
    expect(wholeDaysBetween("2026-10-28T12:00:00Z", now)).toBe(0);
    expect(wholeDaysBetween("2026-11-02T00:00:00Z", now)).toBe(-5);
  });

  describe("resolveRange(since / until の解決。until は当日を含める)", () => {
    const now = new Date("2026-10-28T03:00:00Z");
    it("日付指定: since は当日 00:00、until は当日 23:59:59.999(タイムゾーン基準)", () => {
      const r = resolveRange({
        since: "2026-10-20",
        until: "2026-10-27",
        now,
        timezone: "Asia/Tokyo",
        defaultDays: 7,
      });
      expect(r.since.toISOString()).toBe("2026-10-19T15:00:00.000Z");
      expect(r.until.toISOString()).toBe("2026-10-27T14:59:59.999Z");
    });
    it("省略時: since = now - defaultDays 日、until = now", () => {
      const r = resolveRange({ now, timezone: "Asia/Tokyo", defaultDays: 7 });
      expect(r.since.toISOString()).toBe("2026-10-21T03:00:00.000Z");
      expect(r.until.toISOString()).toBe("2026-10-28T03:00:00.000Z");
    });
    it("不正な日付と since > until は argument_error", () => {
      expect(() =>
        resolveRange({ since: "2026-13-01", now, timezone: "UTC", defaultDays: 7 }),
      ).toThrow(/since must be a date in YYYY-MM-DD/);
      expect(() =>
        resolveRange({
          since: "2026-10-28",
          until: "2026-10-27",
          now,
          timezone: "UTC",
          defaultDays: 7,
        }),
      ).toThrow(/since must not be after until/);
    });
  });
});
