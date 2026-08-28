import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getMode, isClientMode } from "@/lib/mode";
import { resolveDataSource } from "@/lib/data-source/resolve";

const SAVED_ENV = { ...process.env };

describe("mode resolver", () => {
  beforeEach(() => {
    delete process.env.PREVIOUSLY_MODE;
    delete process.env.STORAGE;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...SAVED_ENV };
  });

  describe("getMode", () => {
    it("defaults to cloud when PREVIOUSLY_MODE is unset", () => {
      expect(getMode()).toBe("cloud");
    });

    it("returns client when PREVIOUSLY_MODE=client", () => {
      process.env.PREVIOUSLY_MODE = "client";
      expect(getMode()).toBe("client");
    });

    it("treats any other value as cloud", () => {
      process.env.PREVIOUSLY_MODE = "production";
      expect(getMode()).toBe("cloud");
    });
  });

  describe("isClientMode", () => {
    it("is false in cloud mode", () => {
      expect(isClientMode()).toBe(false);
    });

    it("is true in client mode", () => {
      process.env.PREVIOUSLY_MODE = "client";
      expect(isClientMode()).toBe(true);
    });
  });

  describe("resolveDataSource in client mode", () => {
    it("defaults to local regardless of NODE_ENV", () => {
      process.env.PREVIOUSLY_MODE = "client";
      vi.stubEnv("NODE_ENV", "production");
      expect(resolveDataSource()).toBe("local");
    });

    it("defaults to local even when GITHUB_TOKEN is present", () => {
      process.env.PREVIOUSLY_MODE = "client";
      process.env.GITHUB_TOKEN = "ghp_test";
      vi.stubEnv("NODE_ENV", "production");
      expect(resolveDataSource()).toBe("local");
    });

    it("still honors an explicit STORAGE override", () => {
      process.env.PREVIOUSLY_MODE = "client";
      process.env.STORAGE = "github";
      expect(resolveDataSource()).toBe("github");
    });

    it("keeps cloud auto-detection unchanged when not in client mode", () => {
      process.env.GITHUB_TOKEN = "ghp_test";
      vi.stubEnv("NODE_ENV", "production");
      expect(resolveDataSource()).toBe("github");
    });
  });
});
