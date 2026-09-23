import { describe, expect, it } from "vitest";
import { defaultRiskConfig, evaluateRisk, riskConfigSchema, type RiskConfig, type RiskInput } from "../../../apps/server/src/lib/risk";

const quiet: RiskInput = {
  signals: { newDevice: false, newIp: false, ip: { version: 4, isPrivate: false }, phonesFromIp: 1, phonesFromDevice: 1 },
  user: { isNew: false, deviceCount: 2, codesLastHour: 1, failedAttemptsLastHour: 0 },
  country: "IN",
};
const input = (over: { signals?: Partial<RiskInput["signals"]>; user?: Partial<RiskInput["user"]>; country?: string | null } = {}): RiskInput => ({
  signals: { ...quiet.signals, ...over.signals },
  user: { ...quiet.user, ...over.user },
  country: over.country === undefined ? quiet.country : over.country,
});
const config = (over: Record<string, unknown> = {}): RiskConfig => riskConfigSchema.parse({ mode: "enforce", ...over });
const codes = (i: RiskInput, c = config()) => evaluateRisk(i, c).reasons.map((r) => r.code);

describe("evaluateRisk", () => {
  it("allows a calm, familiar request with no reasons and a zero score", () => {
    expect(evaluateRisk(quiet, config())).toEqual({ decision: "allow", score: 0, reasons: [] });
  });

  it("is deterministic: the same input always gives the same result", () => {
    const i = input({ signals: { newDevice: true, newIp: true } });
    expect(evaluateRisk(i, config())).toEqual(evaluateRisk(i, config()));
  });

  describe("scoring rules", () => {
    it("adds points for a new device on a user with history, but alone it only allows", () => {
      const r = evaluateRisk(input({ signals: { newDevice: true } }), config());
      expect(r.reasons.map((x) => [x.code, x.points])).toEqual([["new_device", 25]]);
      expect(r.decision).toBe("allow");
    });

    it("ignores a new device or IP for a user with no history (their first login)", () => {
      const i = input({ signals: { newDevice: true, newIp: true }, user: { deviceCount: 0, isNew: true } });
      expect(codes(i)).toEqual([]);
    });

    it("challenges when several weak signals add up", () => {
      const r = evaluateRisk(input({ signals: { newDevice: true, newIp: true, ip: { version: 4, isPrivate: true } } }), config());
      expect(r.reasons.map((x) => x.code)).toEqual(["new_device", "new_ip", "private_ip"]);
      expect(r.score).toBe(55);
      expect(r.decision).toBe("challenge");
    });

    it("scores private IPs, repeated codes and repeated failures", () => {
      expect(codes(input({ signals: { ip: { version: 4, isPrivate: true } } }))).toEqual(["private_ip"]);
      expect(codes(input({ user: { codesLastHour: 3 } }))).toEqual(["many_codes"]);
      expect(codes(input({ user: { failedAttemptsLastHour: 3 } }))).toEqual(["recent_failures"]);
      expect(codes(input({ user: { codesLastHour: 2, failedAttemptsLastHour: 2 } }))).toEqual([]);
    });

    it("blocks when the total reaches blockScore even without a hard rule", () => {
      const i = input({
        signals: { newDevice: true, newIp: true, ip: { version: 4, isPrivate: true }, phonesFromDevice: 3 },
        user: { codesLastHour: 3, failedAttemptsLastHour: 3 },
      });
      const r = evaluateRisk(i, config());
      // 25 + 10 + 20 + 35 + 20 + 25 = 135, capped
      expect(r.score).toBe(100);
      expect(r.decision).toBe("block");
      expect(r.reasons.every((x) => !x.hard)).toBe(true);
    });

    it("caps the score at 100", () => {
      const r = evaluateRisk(
        input({ signals: { newDevice: true, phonesFromIp: 5, phonesFromDevice: 3, ip: { version: 4, isPrivate: true } }, user: { codesLastHour: 3, failedAttemptsLastHour: 3 } }),
        config()
      );
      expect(r.reasons.reduce((n, x) => n + x.points, 0)).toBeGreaterThan(100);
      expect(r.score).toBe(100);
    });
  });

  describe("velocity", () => {
    it("scores medium IP and device velocity and blocks at the hard limits", () => {
      expect(codes(input({ signals: { phonesFromIp: 5 } }))).toEqual(["ip_velocity"]);
      expect(evaluateRisk(input({ signals: { phonesFromIp: 5 } }), config()).decision).toBe("allow");
      expect(codes(input({ signals: { phonesFromIp: 10 } }))).toEqual(["ip_velocity_block"]);
      expect(evaluateRisk(input({ signals: { phonesFromIp: 10 } }), config()).decision).toBe("block");
      expect(evaluateRisk(input({ signals: { phonesFromDevice: 6 } }), config()).decision).toBe("block");
      expect(codes(input({ signals: { phonesFromDevice: 3 } }))).toEqual(["device_velocity"]);
    });

    it("respects custom thresholds", () => {
      const c = config({ ipVelocity: { challenge: 2, block: 3 } });
      expect(evaluateRisk(input({ signals: { phonesFromIp: 2 } }), c).reasons[0]?.code).toBe("ip_velocity");
      expect(evaluateRisk(input({ signals: { phonesFromIp: 3 } }), c).decision).toBe("block");
    });

    it("does nothing when velocity is unknown (no context was sent)", () => {
      expect(codes(input({ signals: { phonesFromIp: null, phonesFromDevice: null } }))).toEqual([]);
    });
  });

  describe("country rules", () => {
    it("blocks a blocked country whatever the score", () => {
      const r = evaluateRisk(input({ country: "KP" }), config({ blockedCountries: ["kp"] }));
      expect(r.decision).toBe("block");
      expect(r.reasons[0]).toMatchObject({ code: "country_blocked", hard: true });
    });

    it("with an allow-list, blocks every other country and lets listed ones through", () => {
      const c = config({ allowedCountries: ["IN", "US"] });
      expect(evaluateRisk(input({ country: "IN" }), c).decision).toBe("allow");
      expect(evaluateRisk(input({ country: "RU" }), c).reasons[0]?.code).toBe("country_not_allowed");
      expect(evaluateRisk(input({ country: "RU" }), c).decision).toBe("block");
    });

    it("an empty allow-list means everywhere is allowed", () => {
      expect(evaluateRisk(input({ country: "RU" }), config()).decision).toBe("allow");
    });

    it("cannot judge an unknown country, so does not block on it", () => {
      expect(evaluateRisk(input({ country: null }), config({ allowedCountries: ["IN"] })).decision).toBe("allow");
    });

    it("the blocked list wins over the allow list", () => {
      const c = config({ allowedCountries: ["IN"], blockedCountries: ["IN"] });
      expect(evaluateRisk(input({ country: "IN" }), c).decision).toBe("block");
    });
  });

  describe("requireContext", () => {
    const noContext = { signals: { newDevice: null, newIp: null, ip: null, phonesFromIp: null, phonesFromDevice: null } };
    it("challenges requests with no forwarded information when required", () => {
      const r = evaluateRisk(input(noContext), config({ requireContext: true }));
      expect(r.reasons.map((x) => x.code)).toEqual(["context_missing"]);
      expect(r.decision).toBe("challenge");
    });
    it("is off by default", () => {
      expect(codes(input(noContext))).toEqual([]);
    });
    it("is satisfied by sending either an ip or a device id", () => {
      const partial = { signals: { ...noContext.signals, newIp: false } };
      expect(codes(input(partial), config({ requireContext: true }))).toEqual([]);
    });
  });

  it("can switch individual rules off, including hard ones", () => {
    const i = input({ signals: { phonesFromIp: 10 } });
    expect(evaluateRisk(i, config({ disabledRules: ["ip_velocity_block"] })).decision).toBe("allow");
    expect(codes(input({ signals: { newDevice: true } }), config({ disabledRules: ["new_device"] }))).toEqual([]);
  });

  it("moves the challenge and block lines with the configured scores", () => {
    const i = input({ signals: { newDevice: true } }); // 25 points
    expect(evaluateRisk(i, config({ challengeScore: 20 })).decision).toBe("challenge");
    expect(evaluateRisk(i, config({ challengeScore: 10, blockScore: 25 })).decision).toBe("block");
  });

  it("explains every reason in words", () => {
    const r = evaluateRisk(input({ signals: { newDevice: true } }), config());
    expect(r.reasons[0]!.message).toMatch(/device/);
  });
});

describe("riskConfigSchema", () => {
  it("fills every default from an empty object, starting in log-only mode", () => {
    expect(riskConfigSchema.parse({})).toMatchObject({
      mode: "log", challengeScore: 40, blockScore: 80, allowedCountries: [], blockedCountries: [], requireContext: false, disabledRules: [],
    });
    expect(defaultRiskConfig.mode).toBe("log");
  });

  it("normalises country codes to upper case", () => {
    expect(riskConfigSchema.parse({ blockedCountries: ["in", " us "] }).blockedCountries).toEqual(["IN", "US"]);
  });

  it.each([
    [{ mode: "sometimes" }],
    [{ challengeScore: 90, blockScore: 50 }],
    [{ challengeScore: 50, blockScore: 50 }],
    [{ blockedCountries: ["India"] }],
    [{ blockedCountries: ["1N"] }],
    [{ ipVelocity: { challenge: 8, block: 4 } }],
    [{ deviceVelocity: { challenge: 1, block: 4 } }],
    [{ disabledRules: ["not_a_rule"] }],
    [{ challengeScore: 0 }],
    [{ blockScore: 101 }],
  ])("rejects invalid config %j", (bad) => {
    expect(riskConfigSchema.safeParse(bad).success).toBe(false);
  });
});
