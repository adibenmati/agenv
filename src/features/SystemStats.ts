import * as os from "os";

export interface StatsSnapshot {
  cpu: number;
  memUsed: number;
  memTotal: number;
  memPercent: number;
  platform: string;
  hostname: string;
  uptime: number;
  cores: number;
}

const CACHE_MS = 3000;

/** Machine load for the status bar. Cached for 3 seconds so several browser tabs polling don't each walk the CPU list. */
export class SystemStats {
  private cache: StatsSnapshot | null = null;
  private cachedAt = 0;

  snapshot(): StatsSnapshot {
    const now = Date.now();
    if (!this.cache || now - this.cachedAt > CACHE_MS) {
      this.cache = this.read();
      this.cachedAt = now;
    }
    return this.cache;
  }

  private read(): StatsSnapshot {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const usedMem = totalMem - os.freemem();
    // CPU usage: average across cores (idle vs total)
    let totalIdle = 0, totalTick = 0;
    for (const cpu of cpus) {
      for (const type of Object.keys(cpu.times) as Array<keyof typeof cpu.times>) totalTick += cpu.times[type];
      totalIdle += cpu.times.idle;
    }
    return {
      cpu: Math.round(100 - (totalIdle / totalTick * 100)),
      memUsed: usedMem,
      memTotal: totalMem,
      memPercent: Math.round(usedMem / totalMem * 100),
      platform: os.platform(),
      hostname: os.hostname(),
      uptime: os.uptime(),
      cores: cpus.length,
    };
  }
}
