import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isAIConfigured, isDemo, canWrite, getRepoConfig, DEPLOY_GUIDE_URL } from "@/lib/capabilities";

const SAVED_ENV = { ...process.env };

describe("capabilities", () => {
  beforeEach(() => {
    // Reset to a clean state before each test.
    // vi.stubEnv is not used here because these functions read
    // process.env at call time (not import time), and direct
    // manipulation matches the existing project conventions.
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPO_OWNER;
    delete process.env.GITHUB_REPO_NAME;
  });

  afterEach(() => {
    process.env = { ...SAVED_ENV };
  });

  // ─── isAIConfigured ──────────────────────────────────────────────

  describe("isAIConfigured", () => {
    it("returns false when DEEPSEEK_API_KEY is not set", () => {
      expect(isAIConfigured()).toBe(false);
    });

    it("returns false when DEEPSEEK_API_KEY is empty string", () => {
      process.env.DEEPSEEK_API_KEY = "";
      expect(isAIConfigured()).toBe(false);
    });

    it("returns true when DEEPSEEK_API_KEY is set", () => {
      process.env.DEEPSEEK_API_KEY = "sk-abc123";
      expect(isAIConfigured()).toBe(true);
    });
  });

  // ─── isDemo ──────────────────────────────────────────────────────

  describe("isDemo", () => {
    it("returns true when GITHUB_TOKEN is not set", () => {
      expect(isDemo()).toBe(true);
    });

    it("returns true when GITHUB_TOKEN is empty string", () => {
      process.env.GITHUB_TOKEN = "";
      expect(isDemo()).toBe(true);
    });

    it("returns false when GITHUB_TOKEN is set", () => {
      process.env.GITHUB_TOKEN = "ghp_test123";
      expect(isDemo()).toBe(false);
    });
  });

  // ─── canWrite ────────────────────────────────────────────────────

  describe("canWrite", () => {
    it("returns false when GITHUB_TOKEN is not set", () => {
      expect(canWrite()).toBe(false);
    });

    it("returns false when GITHUB_TOKEN is empty string", () => {
      process.env.GITHUB_TOKEN = "";
      expect(canWrite()).toBe(false);
    });

    it("returns true when GITHUB_TOKEN is set", () => {
      process.env.GITHUB_TOKEN = "ghp_test123";
      expect(canWrite()).toBe(true);
    });

    it("is the inverse of isDemo", () => {
      expect(canWrite()).toBe(!isDemo());

      process.env.GITHUB_TOKEN = "ghp_test123";
      expect(canWrite()).toBe(!isDemo());

      delete process.env.GITHUB_TOKEN;
      expect(canWrite()).toBe(!isDemo());
    });
  });

  // ─── getRepoConfig ────────────────────────────────────────────────

  describe("getRepoConfig", () => {
    it("returns 'local' defaults when env vars are unset", () => {
      const cfg = getRepoConfig();
      expect(cfg.owner).toBe("local");
      expect(cfg.repo).toBe("local");
    });

    it("returns owner when GITHUB_REPO_OWNER is set", () => {
      process.env.GITHUB_REPO_OWNER = "LikeDreamwalker";
      const cfg = getRepoConfig();
      expect(cfg.owner).toBe("LikeDreamwalker");
      expect(cfg.repo).toBe("local");
    });

    it("returns repo when GITHUB_REPO_NAME is set", () => {
      process.env.GITHUB_REPO_NAME = "Aftrbrez";
      const cfg = getRepoConfig();
      expect(cfg.owner).toBe("local");
      expect(cfg.repo).toBe("Aftrbrez");
    });

    it("returns full identity when both are set", () => {
      process.env.GITHUB_REPO_OWNER = "previously-lab";
      process.env.GITHUB_REPO_NAME = "agent";
      const cfg = getRepoConfig();
      expect(cfg.owner).toBe("previously-lab");
      expect(cfg.repo).toBe("agent");
    });
  });

  // ─── DEPLOY_GUIDE_URL ────────────────────────────────────────────

  describe("DEPLOY_GUIDE_URL", () => {
    it("is the expected deployment guide URL", () => {
      // Imported at top of file; tested here for completeness.
      expect(DEPLOY_GUIDE_URL).toBe(
        "https://previously.ldwid.com/docs/deployment"
      );
    });
  });
});
