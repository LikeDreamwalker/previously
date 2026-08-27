import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "path";
import {
  normalizePath,
  isPathAllowed,
  getAllowedPaths,
  getMemoryRoot,
  getTasksRoot,
  getSessionsRoot,
  resolveLocalDataPath,
} from "@/lib/whitelist";

describe("normalizePath", () => {
  it("passes through a clean path", () => {
    expect(normalizePath("memory/test.md")).toBe("memory/test.md");
  });

  it("converts Windows backslashes to forward slashes", () => {
    expect(normalizePath("memory\\tasks\\file.md")).toBe("memory/tasks/file.md");
  });

  it("decodes URI-encoded characters", () => {
    expect(normalizePath("memory%2Ftest%2E%6D%64")).toBe("memory/test.md");
  });

  it("resolves dot segments", () => {
    expect(normalizePath("memory/./tasks/./file.md")).toBe("memory/tasks/file.md");
  });

  it("resolves parent directory traversal", () => {
    expect(normalizePath("memory/subdir/../file.md")).toBe("memory/file.md");
  });

  it("blocks traversal that escapes allowed paths via parent refs", () => {
    // After normalization this becomes "src/app/layout.tsx"
    // which is not in allowed paths
    const result = normalizePath("memory/../../src/app/layout.tsx");
    expect(isPathAllowed(result)).toBe(false);
  });

  it("strips leading slashes", () => {
    expect(normalizePath("/memory/test.md")).toBe("memory/test.md");
  });

  it("returns empty string for root traversal", () => {
    expect(normalizePath("../../../")).toBe("");
  });
});

describe("isPathAllowed", () => {
  it("allows paths under memory/", () => {
    expect(isPathAllowed("memory/test.md")).toBe(true);
  });

  it("allows paths under tasks/", () => {
    expect(isPathAllowed("tasks/status.md")).toBe(true);
  });

  it("allows paths under sessions/", () => {
    expect(isPathAllowed("sessions/2025-06-25.md")).toBe(true);
  });

  it("allows nested paths", () => {
    expect(isPathAllowed("memory/projects/deep/file.md")).toBe(true);
  });

  it("allows bare directory name without trailing slash", () => {
    expect(isPathAllowed("memory")).toBe(true);
    expect(isPathAllowed("tasks")).toBe(true);
    expect(isPathAllowed("sessions")).toBe(true);
  });

  it("rejects paths in src/", () => {
    expect(isPathAllowed("src/app/layout.tsx")).toBe(false);
  });

  it("rejects paths in src/ with traversal", () => {
    expect(isPathAllowed("memory/../../src/app/layout.tsx")).toBe(false);
  });

  it("rejects URL-encoded path to src/", () => {
    expect(isPathAllowed("memory%2F..%2F..%2Fsrc%2Fapp%2Flayout%2Etsx")).toBe(
      false
    );
  });

  it("rejects Windows-style path to src/", () => {
    expect(isPathAllowed("memory\\..\\..\\src\\app\\layout.tsx")).toBe(false);
  });

  it("rejects empty path", () => {
    expect(isPathAllowed("")).toBe(false);
  });

  it("rejects absolute Unix path", () => {
    expect(isPathAllowed("/etc/passwd")).toBe(false);
  });

  it("rejects absolute Windows path", () => {
    expect(isPathAllowed("C:\\Windows\\system32")).toBe(false);
  });

  it("rejects paths to .env files", () => {
    expect(isPathAllowed(".env")).toBe(false);
  });

  it("rejects paths to node_modules", () => {
    expect(isPathAllowed("node_modules/evil.js")).toBe(false);
  });
});

describe("getAllowedPaths", () => {
  it("returns the allowed path list", () => {
    const paths = getAllowedPaths();
    expect(paths).toContain("memory/");
    expect(paths).toContain("tasks/");
    expect(paths).toContain("sessions/");
  });
});

describe("MEMORY_ROOT path resolution", () => {
  const SAVED_ENV = { ...process.env };
  const ABSOLUTE_ROOT = resolve("/previously-test-data/memory");

  beforeEach(() => {
    delete process.env.MEMORY_ROOT;
  });

  afterEach(() => {
    process.env = { ...SAVED_ENV };
  });

  describe("getMemoryRoot", () => {
    it("defaults to the repo's memory/ directory when MEMORY_ROOT is unset", () => {
      expect(getMemoryRoot()).toBe(join(process.cwd(), "memory"));
    });

    it("returns the configured absolute path", () => {
      process.env.MEMORY_ROOT = ABSOLUTE_ROOT;
      expect(getMemoryRoot()).toBe(ABSOLUTE_ROOT);
    });

    it("throws when MEMORY_ROOT is not absolute", () => {
      process.env.MEMORY_ROOT = "relative/path";
      expect(() => getMemoryRoot()).toThrow(/absolute/);
    });
  });

  describe("resolveLocalDataPath", () => {
    it("resolves under the repo root when MEMORY_ROOT is unset", () => {
      expect(resolveLocalDataPath("memory/episodic/strands.json")).toBe(
        join(process.cwd(), "memory/episodic/strands.json")
      );
    });

    it("passes the raw path through untouched when MEMORY_ROOT is unset", () => {
      // Byte-identical to the historical join(process.cwd(), path).
      expect(resolveLocalDataPath("memory\\episodic\\strands.json")).toBe(
        join(process.cwd(), "memory\\episodic\\strands.json")
      );
    });

    it("re-roots memory/ paths at MEMORY_ROOT when configured", () => {
      process.env.MEMORY_ROOT = ABSOLUTE_ROOT;
      expect(resolveLocalDataPath("memory/episodic/strands.json")).toBe(
        join(ABSOLUTE_ROOT, "episodic/strands.json")
      );
    });

    it("maps the bare memory directory to MEMORY_ROOT itself", () => {
      process.env.MEMORY_ROOT = ABSOLUTE_ROOT;
      expect(resolveLocalDataPath("memory")).toBe(ABSOLUTE_ROOT);
    });

    it("keeps tasks/ and sessions/ under the repo root", () => {
      process.env.MEMORY_ROOT = ABSOLUTE_ROOT;
      expect(resolveLocalDataPath("tasks/status.md")).toBe(
        join(process.cwd(), "tasks/status.md")
      );
      expect(resolveLocalDataPath("sessions/2025-06-25.md")).toBe(
        join(process.cwd(), "sessions/2025-06-25.md")
      );
    });
  });
});

describe("TASKS_ROOT / SESSIONS_ROOT path resolution", () => {
  const SAVED_ENV = { ...process.env };
  const ABSOLUTE_TASKS = resolve("/previously-test-data/tasks");
  const ABSOLUTE_SESSIONS = resolve("/previously-test-data/sessions");

  beforeEach(() => {
    delete process.env.MEMORY_ROOT;
    delete process.env.TASKS_ROOT;
    delete process.env.SESSIONS_ROOT;
  });

  afterEach(() => {
    process.env = { ...SAVED_ENV };
  });

  describe("getTasksRoot / getSessionsRoot", () => {
    it("defaults to the repo's tasks/ and sessions/ directories when unset", () => {
      expect(getTasksRoot()).toBe(join(process.cwd(), "tasks"));
      expect(getSessionsRoot()).toBe(join(process.cwd(), "sessions"));
    });

    it("returns the configured absolute paths", () => {
      process.env.TASKS_ROOT = ABSOLUTE_TASKS;
      process.env.SESSIONS_ROOT = ABSOLUTE_SESSIONS;
      expect(getTasksRoot()).toBe(ABSOLUTE_TASKS);
      expect(getSessionsRoot()).toBe(ABSOLUTE_SESSIONS);
    });

    it("throws when the configured root is not absolute", () => {
      process.env.TASKS_ROOT = "relative/tasks";
      expect(() => getTasksRoot()).toThrow(/absolute/);
      process.env.SESSIONS_ROOT = "relative/sessions";
      expect(() => getSessionsRoot()).toThrow(/absolute/);
    });
  });

  describe("resolveLocalDataPath", () => {
    it("resolves tasks/ and sessions/ under the repo root when the env roots are unset", () => {
      expect(resolveLocalDataPath("tasks/status.md")).toBe(
        join(process.cwd(), "tasks/status.md")
      );
      expect(resolveLocalDataPath("sessions/2025-06-25.md")).toBe(
        join(process.cwd(), "sessions/2025-06-25.md")
      );
    });

    it("re-roots tasks/ paths at TASKS_ROOT when configured", () => {
      process.env.TASKS_ROOT = ABSOLUTE_TASKS;
      expect(resolveLocalDataPath("tasks/status.md")).toBe(
        join(ABSOLUTE_TASKS, "status.md")
      );
    });

    it("re-roots sessions/ paths at SESSIONS_ROOT when configured", () => {
      process.env.SESSIONS_ROOT = ABSOLUTE_SESSIONS;
      expect(resolveLocalDataPath("sessions/2025-06-25.md")).toBe(
        join(ABSOLUTE_SESSIONS, "2025-06-25.md")
      );
    });

    it("maps the bare directory names to the roots themselves", () => {
      process.env.TASKS_ROOT = ABSOLUTE_TASKS;
      process.env.SESSIONS_ROOT = ABSOLUTE_SESSIONS;
      expect(resolveLocalDataPath("tasks")).toBe(ABSOLUTE_TASKS);
      expect(resolveLocalDataPath("sessions")).toBe(ABSOLUTE_SESSIONS);
    });

    it("leaves other whitelisted paths under the repo root", () => {
      process.env.TASKS_ROOT = ABSOLUTE_TASKS;
      process.env.SESSIONS_ROOT = ABSOLUTE_SESSIONS;
      expect(resolveLocalDataPath("memory/episodic/strands.json")).toBe(
        join(process.cwd(), "memory/episodic/strands.json")
      );
    });
  });
});
