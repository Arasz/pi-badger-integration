/** System crontab (crontab -l) parsing and footer formatting for pi-cron. */

import { execFileSync } from "node:child_process";

/** One system crontab entry: the schedule as written and the full command remainder. */
export interface SystemCronJob {
  schedule: string;
  command: string;
}

/** What `readSystemCrontab` found, or the fail-open unavailable marker. */
export interface SystemCrontab {
  count: number;
  jobs: SystemCronJob[];
  unavailable: boolean;
}

/** Preview cap for a system command in cron-status rows. */
export const SYSTEM_COMMAND_PREVIEW = 60;

/**
 * Launchd agents outside ai-badger pi-cron are explicitly out of scope: only
 * cron.json (pi-cron) and the user's system crontab (crontab -l) are counted.
 */
const AT_TOKENS = new Set([
  "@reboot",
  "@yearly",
  "@annually",
  "@monthly",
  "@weekly",
  "@daily",
  "@midnight",
  "@hourly",
]);

const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*/;

const MONTHS = new Set([
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
]);

const WEEKDAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

/** A single schedule field is plausible when it carries cron syntax or a known name. */
function isCronField(field: string, index: number): boolean {
  if (!field || !/^[A-Za-z0-9*/,.\-]+$/.test(field)) return false;
  if (/[0-9*/]/.test(field)) return true;
  const parts = field.toLowerCase().split(/[-/,]+/).filter(Boolean);
  if (!parts.length) return false;
  if (index === 3) return parts.every((p) => MONTHS.has(p));
  if (index === 4) return parts.every((p) => WEEKDAYS.has(p) || MONTHS.has(p));
  return false;
}

/** Try one trimmed line as an @-shortcut or five-field entry; null when malformed. */
function tryParseJob(trimmed: string): SystemCronJob | null {
  if (trimmed.startsWith("@")) {
    const space = trimmed.search(/\s/);
    if (space === -1) return null;
    const token = trimmed.slice(0, space);
    const command = trimmed.slice(space).trim();
    if (!AT_TOKENS.has(token) || !command) return null;
    return { schedule: token, command };
  }
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 6) return null;
  const fields = tokens.slice(0, 5);
  if (!fields.every((f, i) => isCronField(f, i))) return null;
  const command = tokens.slice(5).join(" ");
  if (!command) return null;
  return { schedule: fields.join(" "), command };
}

/** Every crontab job in the text; blanks, comments, env and malformed lines are skipped. */
export function parseCrontab(text: string): SystemCronJob[] {
  if (typeof text !== "string" || !text) return [];
  const jobs: SystemCronJob[] = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      if (/^\s*(#|$)/.test(line)) continue;
      const trimmed = line.trim();
      if (!trimmed) continue;
      // An env assignment counts only when it also parses as a cron entry, so a
      // command such as "0 * * * * FOO=bar /cmd" stays a job. Inline # and %
      // are part of the command and pass through untouched.
      if (ENV_RE.test(trimmed)) {
        const asJob = tryParseJob(trimmed);
        if (asJob) jobs.push(asJob);
        continue;
      }
      const job = tryParseJob(trimmed);
      if (job) jobs.push(job);
    } catch {
      continue;
    }
  }
  return jobs;
}

/** Spawn crontab -l synchronously; the argv form never touches a shell. */
export function defaultExec(): string {
  return execFileSync("crontab", ["-l"], {
    encoding: "utf-8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** The system crontab, fail-open: any spawn or parse failure yields unavailable. */
export function readSystemCrontab(execFn: () => string = defaultExec): SystemCrontab {
  try {
    const jobs = parseCrontab(execFn());
    return { count: jobs.length, jobs, unavailable: false };
  } catch {
    return { count: 0, jobs: [], unavailable: true };
  }
}

/** Cap a command preview at 60 chars; short commands pass through untouched. */
export function truncateCommand(command: string, max: number = SYSTEM_COMMAND_PREVIEW): string {
  if (command.length <= max) return command;
  return command.slice(0, max);
}

/** Footer status across pi-cron and the system crontab; zero/unknown system stays legacy. */
export function formatCronStatus(
  piRegistered: number,
  piSchedulable: number,
  sysCount: number,
  sysUnavailable: boolean,
  cronConfigPath: string,
): string {
  const hasPi = piRegistered > 0 || piSchedulable > 0;
  const hasSys = !sysUnavailable && sysCount > 0;
  if (hasPi && hasSys) {
    return `Cron: ${piRegistered + sysCount} jobs (${piRegistered} pi + ${sysCount} crontab)`;
  }
  if (hasSys) return `Cron: ${sysCount} job(s) from system crontab`;
  if (!hasPi) return `Cron: no jobs in ${cronConfigPath}`;
  return `Cron: ${piRegistered}/${piSchedulable} job(s) registered`;
}
