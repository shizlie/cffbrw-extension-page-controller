import { describe, it, expect } from "vitest";
import { filterStrategies, MAX_XPATH_DEPTH } from "../selectors.js";

describe("filterStrategies", () => {
  it("drops style-attribute selectors", () => {
    const out = filterStrategies([
      { type: "css", selector: "[style='color: red']", confidence: 0.3 },
      { type: "id", selector: "#btn", confidence: 1.0 },
    ]);
    expect(out).toEqual([{ type: "id", selector: "#btn", confidence: 1.0 }]);
  });

  it("drops inline event handler selectors", () => {
    const out = filterStrategies([
      { type: "css", selector: "[onclick]", confidence: 0.2 },
      { type: "testid", selector: "[data-testid='ok']", confidence: 0.95 },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].selector).toBe("[data-testid='ok']");
  });

  it("drops deeply nested positional xpath", () => {
    const deep = "/html/body/div[1]/div[2]/div[3]/div[4]/div[5]/div[6]/div[7]/button";
    const out = filterStrategies([
      { type: "xpath", selector: deep, confidence: 0.5 },
      { type: "aria-label", selector: "[aria-label='Save']", confidence: 0.85 },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].type).toBe("aria-label");
  });

  it("keeps shallow xpath under MAX_XPATH_DEPTH", () => {
    const shallow = "/html/body/button";
    const out = filterStrategies([{ type: "xpath", selector: shallow, confidence: 0.5 }]);
    expect(out.length).toBe(1);
  });

  it("returns [] when all strategies are rejected", () => {
    const out = filterStrategies([
      { type: "css", selector: "[style]", confidence: 0.3 },
      { type: "css", selector: "[onload]", confidence: 0.3 },
    ]);
    expect(out).toEqual([]);
  });
});
