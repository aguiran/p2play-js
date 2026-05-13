import { EventBus } from "../events/EventBus";
import { PlayerId } from "../types";

export interface PingOverlayOptions {
  enabled?: boolean;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  canvas?: HTMLCanvasElement | null;
}

export class PingOverlay {
  private enabled: boolean;
  private position: NonNullable<PingOverlayOptions["position"]>;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pingHistory: Map<PlayerId, number[]> = new Map();
  private ownCanvas: boolean;
  private unsub: () => void;

  constructor(bus: EventBus, opts: PingOverlayOptions = {}) {
    this.enabled = opts.enabled ?? false;
    this.position = opts.position ?? "top-right";
    this.ownCanvas = opts.canvas == null;
    this.canvas = opts.canvas ?? this.createCanvas();
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("CanvasRenderingContext2D not available");
    this.ctx = ctx;

    this.unsub = bus.on("ping", (playerId, ms) => {
      const arr = this.pingHistory.get(playerId) ?? [];
      arr.push(ms);
      if (arr.length > 60) arr.shift();
      this.pingHistory.set(playerId, arr);
      if (this.enabled) this.draw();
    });
  }

  dispose(): void {
    this.unsub();
    this.pingHistory.clear();
    if (this.ownCanvas && this.canvas.parentNode) this.canvas.remove();
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  private createCanvas(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = 220;
    c.height = 120;
    c.style.position = "fixed";
    c.style.zIndex = "9999";
    document.body.appendChild(c);
    this.updatePosition(c);
    return c;
  }

  private updatePosition(c: HTMLCanvasElement) {
    const margin = 8;
    const pos = this.position;
    c.style.top = pos.includes("top") ? `${margin}px` : "";
    c.style.bottom = pos.includes("bottom") ? `${margin}px` : "";
    c.style.left = pos.includes("left") ? `${margin}px` : "";
    c.style.right = pos.includes("right") ? `${margin}px` : "";
    c.style.pointerEvents = "none";
    c.style.background = "rgba(18,18,18,0.6)";
  }

  private clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private draw() {
    this.clear();
    const { ctx, canvas } = this;
    ctx.fillStyle = "white";
    ctx.font = "12px sans-serif";
    ctx.fillText("Ping (ms)", 8, 16);

    const keys = Array.from(this.pingHistory.keys());
    const colors = ["#66c2a5", "#fc8d62", "#8da0cb", "#e78ac3", "#a6d854", "#ffd92f"]; // up to 6 peers
    const chartX = 8;
    const chartY = 24;
    const chartW = canvas.width - 16;
    const chartH = canvas.height - 32;
    ctx.strokeStyle = "#444";
    ctx.strokeRect(chartX, chartY, chartW, chartH);

    keys.forEach((id, idx) => {
      const arr = this.pingHistory.get(id) ?? [];
      ctx.strokeStyle = colors[idx % colors.length];
      ctx.beginPath();
      arr.forEach((v, i) => {
        const x = chartX + (i / Math.max(arr.length - 1, 1)) * chartW;
        const y = chartY + chartH - Math.min(v, 300) / 300 * chartH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = colors[idx % colors.length];
      const last = arr.length ? arr[arr.length - 1] : undefined;
      ctx.fillText(`${id.slice(0, 4)}: ${last !== undefined ? last.toFixed(0) : "-"}`, chartX + 4, chartY + 12 + idx * 14);
    });
  }
}

