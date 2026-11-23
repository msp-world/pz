/**
 * 《僵尸毁灭工程》Project Zomboid 实时状态桥接 MSP World（移植自 coopani-world-pz）：
 * - 读取 Mod 输出的 JSON 状态文件或 HTTP 端点
 * - 工具：pz_state, pz_recent, pz_tips
 * - 信号：pz.status, pz.alert
 */
import * as fs from "node:fs";
import type { MSPNode } from "../shared/msp.ts";

export interface PzSnapshot {
  day?: number;
  clock?: string;
  isNight?: boolean;
  health?: number;
  infected?: boolean;
  hunger?: number;
  thirst?: number;
  fatigue?: number;
  stamina?: number;
  visibleZombies?: number;
  weapon?: { name?: string; conditionPct?: number } | null;
  hasLight?: boolean;
  bandages?: number;
  waterCount?: number;
}

export class PzWorld {
  private readonly stateFile: string;
  private readonly pollIntervalMs: number;
  private node: MSPNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: PzSnapshot = {};
  private recent: Array<{ at: string; summary: string }> = [];
  private lastHealth = 100;

  constructor(config: { stateFile?: string; pollIntervalMs?: number } = {}) {
    this.stateFile = config.stateFile ?? "";
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
  }

  attach(node: MSPNode): void {
    this.node = node;
    node.declareSignal("pz.status", "僵尸毁灭工程角色状态变化");
    node.declareSignal("pz.alert", "受伤/感染/大量僵尸逼近告警");

    node.tool(
      "pz_state",
      "读取此刻角色完整处境（天数、时间、血量、感染、饥饿口渴疲劳、可见僵尸数、武器与背包）",
      () => {
        this.pollOnce();
        return this.latest as Record<string, unknown>;
      },
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "pz_recent",
      "读取最近发生的战况事件（掉血/感染/入夜/死亡）",
      (args) => {
        const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 20) : 8;
        return { count: this.recent.length, events: this.recent.slice(-limit) };
      },
      { type: "object", properties: { limit: { type: "integer", default: 8 } } },
    );

    node.tool(
      "pz_tips",
      "按当前状态计算生存隐患清单（缺绷带、没水、入夜无光源、武器快断、体力见底、感染）",
      () => {
        this.pollOnce();
        const tips: string[] = [];
        const s = this.latest;
        if (s.infected) tips.push("已感染僵尸病毒");
        if ((s.bandages ?? 1) <= 0) tips.push("缺少绷带");
        if ((s.waterCount ?? 1) <= 0) tips.push("缺少饮用水");
        if (s.isNight && !s.hasLight) tips.push("已入夜但身上没有光源");
        if (s.weapon && (s.weapon.conditionPct ?? 100) <= 15) tips.push(`武器 ${s.weapon.name ?? ""} 耐久见底`);
        if ((s.stamina ?? 100) <= 20) tips.push("体力见底，注意脱战喘息");
        return { ok: tips.length === 0, tips };
      },
      { type: "object", additionalProperties: false, properties: {} },
    );
  }

  start(): void {
    if (this.timer) return;
    this.pollOnce();
    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => this.pollOnce(), this.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  updateSnapshot(next: PzSnapshot): void {
    const prevHp = this.lastHealth;
    this.latest = next;
    if (typeof next.health === "number") {
      if (next.health < prevHp - 5) {
        const msg = `生命值下降: ${prevHp} → ${next.health}`;
        this.pushEvent(msg);
        this.node?.publish("pz.alert", { kind: "damage", health: next.health, message: msg });
      }
      this.lastHealth = next.health;
    }
    if ((next.visibleZombies ?? 0) >= 8) {
      this.node?.publish("pz.alert", { kind: "horde", visibleZombies: next.visibleZombies });
    }
    this.node?.publish("pz.status", next as Record<string, unknown>);
  }

  pollOnce(): void {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as PzSnapshot;
      this.updateSnapshot(parsed);
    } catch {
      /* ignore partial write */
    }
  }

  private pushEvent(summary: string): void {
    this.recent.push({ at: new Date().toISOString(), summary });
    if (this.recent.length > 30) this.recent.shift();
  }
}
