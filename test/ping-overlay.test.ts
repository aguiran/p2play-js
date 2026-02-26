import { describe, it, expect, vi } from 'vitest';
import { PingOverlay } from '../src/overlay/PingOverlay';
import { EventBus } from '../src/events/EventBus';

function createFakeCanvas() {
  const ctx = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 1,
    globalAlpha: 1,
    canvas: { width: 200, height: 100 },
  };
  const canvas = {
    getContext: vi.fn(() => ctx),
    width: 200,
    height: 100,
    style: {} as CSSStyleDeclaration,
    parentNode: null,
    remove: vi.fn(),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, ctx };
}

describe('PingOverlay', () => {
  it('calls getContext on construction with provided canvas', () => {
    const bus = new EventBus();
    const { canvas } = createFakeCanvas();
    const overlay = new PingOverlay(bus, { canvas });
    expect(canvas.getContext).toHaveBeenCalledWith('2d');
    overlay.dispose();
  });

  it('setEnabled toggles drawing behavior', () => {
    const bus = new EventBus();
    const { canvas, ctx } = createFakeCanvas();
    const overlay = new PingOverlay(bus, { canvas, enabled: false });

    bus.emit('ping', 'P1', 50);
    expect(ctx.fillText).not.toHaveBeenCalled();

    overlay.setEnabled(true);
    bus.emit('ping', 'P1', 60);
    expect(ctx.fillText).toHaveBeenCalled();

    ctx.clearRect.mockClear();
    overlay.setEnabled(false);
    expect(ctx.clearRect).toHaveBeenCalled();
    overlay.dispose();
  });

  it('draws on ping event when enabled', () => {
    const bus = new EventBus();
    const { canvas, ctx } = createFakeCanvas();
    const overlay = new PingOverlay(bus, { canvas, enabled: true });

    bus.emit('ping', 'P1', 42);

    expect(ctx.fillText).toHaveBeenCalled();
    expect(ctx.beginPath).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();
    overlay.dispose();
  });

  it('truncates history at 60 entries', () => {
    const bus = new EventBus();
    const { canvas } = createFakeCanvas();
    const overlay = new PingOverlay(bus, { canvas, enabled: true });

    for (let i = 0; i < 70; i++) {
      bus.emit('ping', 'P1', i);
    }

    const history = (overlay as any).pingHistory.get('P1');
    expect(history.length).toBe(60);
    expect(history[0]).toBe(10);
    overlay.dispose();
  });

  it('dispose clears listeners and history', () => {
    const bus = new EventBus();
    const { canvas, ctx } = createFakeCanvas();
    const overlay = new PingOverlay(bus, { canvas, enabled: true });

    bus.emit('ping', 'P1', 10);
    expect((overlay as any).pingHistory.size).toBe(1);

    overlay.dispose();
    expect((overlay as any).pingHistory.size).toBe(0);

    ctx.fillText.mockClear();
    bus.emit('ping', 'P1', 20);
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it('creates own canvas when none provided (DOM mock)', () => {
    const fakeCreatedCanvas = {
      width: 0,
      height: 0,
      style: {} as Record<string, string>,
      getContext: vi.fn(() => ({
        clearRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(),
        beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
        stroke: vi.fn(), strokeRect: vi.fn(),
        fillStyle: '', strokeStyle: '', font: '',
        canvas: { width: 220, height: 120 },
      })),
      parentNode: null,
      remove: vi.fn(),
    };
    (globalThis as any).document = {
      createElement: vi.fn(() => fakeCreatedCanvas),
      body: { appendChild: vi.fn() },
    };
    const bus = new EventBus();
    const overlay = new PingOverlay(bus, { position: 'bottom-left' });
    expect((globalThis as any).document.createElement).toHaveBeenCalledWith('canvas');
    expect((globalThis as any).document.body.appendChild).toHaveBeenCalled();
    expect(fakeCreatedCanvas.style.position).toBe('fixed');
    expect(fakeCreatedCanvas.style.zIndex).toBe('9999');
    expect(fakeCreatedCanvas.style.bottom).toContain('px');
    expect(fakeCreatedCanvas.style.left).toContain('px');
    overlay.dispose();
    delete (globalThis as any).document;
  });

  it('creates own canvas with top-right position', () => {
    const fakeCreatedCanvas = {
      width: 0, height: 0,
      style: {} as Record<string, string>,
      getContext: vi.fn(() => ({
        clearRect: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(),
        beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
        stroke: vi.fn(), strokeRect: vi.fn(),
        fillStyle: '', strokeStyle: '', font: '',
        canvas: { width: 220, height: 120 },
      })),
      parentNode: null, remove: vi.fn(),
    };
    (globalThis as any).document = {
      createElement: vi.fn(() => fakeCreatedCanvas),
      body: { appendChild: vi.fn() },
    };
    const bus = new EventBus();
    const overlay = new PingOverlay(bus, { position: 'top-right' });
    expect(fakeCreatedCanvas.style.top).toContain('px');
    expect(fakeCreatedCanvas.style.right).toContain('px');
    expect(fakeCreatedCanvas.style.bottom).toBe('');
    expect(fakeCreatedCanvas.style.left).toBe('');
    overlay.dispose();
    delete (globalThis as any).document;
  });

  it('draw covers both moveTo and lineTo branches', () => {
    const bus = new EventBus();
    const { canvas, ctx } = createFakeCanvas();
    const overlay = new PingOverlay(bus, { canvas, enabled: true });
    bus.emit('ping', 'P1', 50);
    bus.emit('ping', 'P1', 80);
    expect(ctx.moveTo).toHaveBeenCalled();
    expect(ctx.lineTo).toHaveBeenCalled();
    overlay.dispose();
  });

  it('handles multiple peers in history', () => {
    const bus = new EventBus();
    const { canvas, ctx } = createFakeCanvas();
    const overlay = new PingOverlay(bus, { canvas, enabled: true });

    bus.emit('ping', 'P1', 30);
    bus.emit('ping', 'P2', 50);

    expect((overlay as any).pingHistory.size).toBe(2);
    expect(ctx.beginPath).toHaveBeenCalledTimes(3);
    overlay.dispose();
  });
});
