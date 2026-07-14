import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// CPU utilisation is a rate, so it needs two readings. We keep the last
// aggregate cpu-times reading module-side and compute the delta each sample —
// os.cpus() is cross-platform (Linux droplet + macOS dev).
function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const v of Object.values(cpu.times)) total += v;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

let lastCpu = cpuTimes();

/** Aggregate CPU busy % since the previous call (0–100). */
export function cpuPercent() {
  const now = cpuTimes();
  const idleDelta = now.idle - lastCpu.idle;
  const totalDelta = now.total - lastCpu.total;
  lastCpu = now;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)));
}

const BYTES_PER_MB = 1024 * 1024;

// Prefer /proc/meminfo on Linux: MemAvailable is the real "how much can a new
// process use" figure (os.freemem() ignores reclaimable cache and understates
// it badly), and it's the only place to read swap. Fall back to os.* elsewhere.
function memory() {
  try {
    const info = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (key) => {
      const m = info.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = kb("MemTotal");
    const avail = kb("MemAvailable");
    const swapTotal = kb("SwapTotal") ?? 0;
    const swapFree = kb("SwapFree") ?? 0;
    if (total && avail != null) {
      return {
        totalMb: total / BYTES_PER_MB,
        availableMb: avail / BYTES_PER_MB,
        usedMb: (total - avail) / BYTES_PER_MB,
        swapUsedMb: (swapTotal - swapFree) / BYTES_PER_MB,
        swapTotalMb: swapTotal / BYTES_PER_MB,
      };
    }
  } catch {
    // not Linux / no /proc — fall through
  }
  const total = os.totalmem();
  const free = os.freemem();
  return {
    totalMb: total / BYTES_PER_MB,
    availableMb: free / BYTES_PER_MB,
    usedMb: (total - free) / BYTES_PER_MB,
    swapUsedMb: 0,
    swapTotalMb: 0,
  };
}

// df -Pk gives POSIX-portable, script-friendly output on both Linux and macOS.
async function disk(mount = "/") {
  try {
    const { stdout } = await execFileP("df", ["-Pk", mount]);
    const cols = stdout.trim().split("\n")[1].split(/\s+/);
    const totalGb = Number(cols[1]) / BYTES_PER_MB; // KB -> GB
    const usedGb = Number(cols[2]) / BYTES_PER_MB;
    if (Number.isFinite(totalGb) && Number.isFinite(usedGb)) return { totalGb, usedGb };
  } catch {
    // df unavailable
  }
  return { totalGb: null, usedGb: null };
}

/**
 * One point-in-time system snapshot. `cpuPct` is passed in by the caller (the
 * sampler owns the interval that makes a rate meaningful).
 */
export async function systemSnapshot(cpuPct) {
  const [load1, load5, load15] = os.loadavg();
  const mem = memory();
  const d = await disk("/");
  return {
    cpu_pct: cpuPct,
    load1,
    load5,
    load15,
    cores: os.cpus().length,
    mem_total_mb: mem.totalMb,
    mem_used_mb: mem.usedMb,
    mem_available_mb: mem.availableMb,
    swap_used_mb: mem.swapUsedMb,
    swap_total_mb: mem.swapTotalMb,
    disk_total_gb: d.totalGb,
    disk_used_gb: d.usedGb,
  };
}

/**
 * Live top processes by memory, so you can see which service (node pipeline,
 * fb-bot, caddy, n8n, …) is consuming the box. Best-effort: returns [] if ps
 * isn't available or its flags aren't supported. `pcpu`/`pmem`/`-A` are the
 * portable forms accepted by both Linux and BSD/macOS ps.
 */
export async function topProcesses(limit = 8) {
  try {
    const { stdout } = await execFileP("ps", ["-A", "-o", "pid=,comm=,pcpu=,pmem="]);
    const rows = stdout
      .trim()
      .split("\n")
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        const pid = parts[0];
        const pmem = Number(parts[parts.length - 1]);
        const pcpu = Number(parts[parts.length - 2]);
        const command = parts.slice(1, parts.length - 2).join(" ");
        return { pid, command, cpu_pct: pcpu, mem_pct: pmem };
      })
      .filter((r) => Number.isFinite(r.mem_pct));
    rows.sort((a, b) => b.mem_pct - a.mem_pct);
    return rows.slice(0, limit);
  } catch {
    return [];
  }
}
