import { describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";

describe("web shell", () => {
  const app = createApp();

  it("exposes health and readiness endpoints", async () => {
    await expect(request(app).get("/health")).resolves.toMatchObject({ status: 200 });
    await expect(request(app).get("/ready")).resolves.toMatchObject({ status: 200 });
  });
});
