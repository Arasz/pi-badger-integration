import { describe, expect, test } from "bun:test";
import {
  formatCronStatus,
  parseCrontab,
  readSystemCrontab,
  truncateCommand,
} from "../../extensions/pi-cron/crontab.ts";

const PATH = "/home/test/.config/ai-badger/cron.json";

describe("parseCrontab: blanks and comments are skipped", () => {
  test("blank lines, whitespace-only lines and # comments yield no jobs", () => {
    const jobs = parseCrontab("\n   \n# a comment\n   # indented comment\n\t\n");
    expect(jobs).toEqual([]);
  });
});

describe("parseCrontab: env assignments are skipped", () => {
  test("VAR=x is skipped", () => {
    expect(parseCrontab("VAR=x\n")).toEqual([]);
  });

  test('MAILTO="" is skipped', () => {
    expect(parseCrontab('MAILTO=""\n')).toEqual([]);
  });

  test("spaced env assignment is skipped", () => {
    expect(parseCrontab("  PATH = /usr/bin:/bin  \n")).toEqual([]);
  });
});

describe("parseCrontab: command containing = after the schedule is a job", () => {
  test("0 * * * * FOO=bar /cmd counts as one job", () => {
    const jobs = parseCrontab("0 * * * * FOO=bar /cmd\n");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.schedule).toBe("0 * * * *");
    expect(jobs[0]!.command).toContain("FOO=bar");
  });
});

describe("parseCrontab: @-shortcuts", () => {
  test("@daily is counted with the token verbatim", () => {
    const jobs = parseCrontab("@daily /usr/bin/backup\n");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.schedule).toBe("@daily");
    expect(jobs[0]!.command).toBe("/usr/bin/backup");
  });

  test("@reboot is counted with the token verbatim", () => {
    const jobs = parseCrontab("@reboot /usr/bin/onboot\n");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.schedule).toBe("@reboot");
  });
});

describe("parseCrontab: inline # is part of the command", () => {
  test("trailing # comment is preserved", () => {
    const jobs = parseCrontab("0 * * * * echo hi # keep me\n");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.command).toBe("echo hi # keep me");
  });
});

describe("parseCrontab: % passthrough", () => {
  test("bare % stays in the command", () => {
    const jobs = parseCrontab("0 * * * * echo foo%bar\n");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.command).toBe("echo foo%bar");
  });

  test("\\% stays verbatim in the command", () => {
    const jobs = parseCrontab("0 * * * * echo foo\\%bar\n");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.command).toBe("echo foo\\%bar");
  });
});

describe("parseCrontab: malformed lines are skipped, never throw", () => {
  test("too few fields, no command, unknown @-token and garbage are ignored", () => {
    const text = [
      "* * *",
      "0 * * * *",
      "@bogus /cmd",
      "not a cron line at all whatever",
      "",
    ].join("\n");
    expect(() => parseCrontab(text)).not.toThrow();
    expect(parseCrontab(text)).toEqual([]);
  });
});

describe("readSystemCrontab", () => {
  test("a throwing execFn yields count 0, empty jobs, unavailable true", () => {
    const result = readSystemCrontab(() => {
      throw new Error("ENOENT");
    });
    expect(result).toEqual({ count: 0, jobs: [], unavailable: true });
  });

  test("an injected fixture is parsed for its count", () => {
    const fixture = "0 * * * * /bin/a\n@daily /bin/b\nMAILTO=x\n";
    const result = readSystemCrontab(() => fixture);
    expect(result.unavailable).toBe(false);
    expect(result.count).toBe(2);
    expect(result.jobs).toHaveLength(2);
  });

  test("the injected stub is used instead of spawning the real crontab binary", () => {
    let calls = 0;
    const result = readSystemCrontab(() => {
      calls += 1;
      return "5 4 * * * /bin/only\n";
    });
    expect(calls).toBe(1);
    expect(result.count).toBe(1);
    expect(result.jobs[0]!.command).toBe("/bin/only");
  });
});

describe("formatCronStatus matrix", () => {
  test("both pi and system jobs combine into the total form", () => {
    expect(formatCronStatus(2, 2, 3, false, PATH)).toBe("Cron: 5 jobs (2 pi + 3 crontab)");
  });

  test("pi-only keeps the legacy registered string byte-identical", () => {
    expect(formatCronStatus(2, 3, 0, false, PATH)).toBe("Cron: 2/3 job(s) registered");
  });

  test("system-only uses the (s) literal form", () => {
    expect(formatCronStatus(0, 0, 3, false, PATH)).toBe("Cron: 3 job(s) from system crontab");
  });

  test("neither yields the legacy no-jobs string", () => {
    expect(formatCronStatus(0, 0, 0, true, PATH)).toBe(`Cron: no jobs in ${PATH}`);
  });

  test("system 0 and available stays legacy byte-identical (no suffix)", () => {
    expect(formatCronStatus(2, 3, 0, false, PATH)).toBe("Cron: 2/3 job(s) registered");
    expect(formatCronStatus(0, 0, 0, false, PATH)).toBe(`Cron: no jobs in ${PATH}`);
  });

  test("characterization: unavailable system pins both legacy strings", () => {
    expect(formatCronStatus(0, 0, 0, true, PATH)).toBe(`Cron: no jobs in ${PATH}`);
    expect(formatCronStatus(1, 2, 0, true, PATH)).toBe("Cron: 1/2 job(s) registered");
  });
});

describe("truncateCommand", () => {
  test("commands longer than 60 chars are capped at 60", () => {
    const long = `echo ${"x".repeat(100)}`;
    const out = truncateCommand(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).toBe(long.slice(0, 60));
  });

  test("short commands pass through", () => {
    expect(truncateCommand("echo hi")).toBe("echo hi");
  });
});
