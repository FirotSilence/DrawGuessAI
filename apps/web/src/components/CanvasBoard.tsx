import {
  BRUSH_PRESETS,
  BRUSH_WIDTHS,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  MASTER_PALETTE,
  MAX_FILLS_PER_TURN,
  activeCanvasMarkCommands,
  quantizePoint,
  simplifyStroke,
  toCanvasCommandOffsetMs,
  type BrushPreset,
  type CanvasCommand,
  type CanvasMarkCommand,
  type FillCommand,
  type Point,
  type StrokeCommand
} from "@drawguessai/canvas-protocol";
import {
  Check,
  Eraser,
  Highlighter,
  PaintBucket,
  Paintbrush,
  PenLine,
  Pencil,
  Undo2
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import {
  canvasPlaybackFrameAtProgress,
  liveCanvasPlaybackCursor,
  playbackProgressForRender
} from "../lib/canvas-playback";
import { drawStroke, renderCanvasCommands } from "../lib/canvas-renderer";

interface CanvasBoardProps {
  commands: readonly CanvasCommand[];
  editable?: boolean;
  colorCount?: number;
  maxStrokes?: number;
  maxUndos?: number;
  remoteCursors?: Readonly<Record<string, Point | null>>;
  onChange?: (commands: CanvasCommand[]) => void;
  onPreview?: (point: Point | null) => void;
  onStrokePreview?: (command: CanvasMarkCommand) => void;
  onFinish?: (offsetMs: number) => void;
  compact?: boolean;
  playbackMs?: number;
  playbackKey?: string;
  commandClockKey?: string;
  livePlayback?: boolean;
}

function logicalPoint(
  canvas: HTMLCanvasElement,
  event: React.PointerEvent<HTMLCanvasElement>
): Point {
  const bounds = canvas.getBoundingClientRect();
  return quantizePoint({
    x: Math.round(((event.clientX - bounds.left) / bounds.width) * CANVAS_WIDTH),
    y: Math.round(((event.clientY - bounds.top) / bounds.height) * CANVAS_HEIGHT)
  });
}

export function CanvasBoard({
  commands,
  editable = false,
  colorCount = 10,
  maxStrokes = 60,
  maxUndos = 3,
  remoteCursors = {},
  onChange,
  onPreview,
  onStrokePreview,
  onFinish,
  compact = false,
  playbackMs,
  playbackKey,
  commandClockKey,
  livePlayback = false
}: CanvasBoardProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const livePoints = useRef<Point[]>([]);
  const liveStrokeId = useRef<string | undefined>(undefined);
  const liveCanvasBase = useRef<ImageData | undefined>(undefined);
  const commandClock = useRef({ key: commandClockKey, startedAtMs: performance.now() });
  if (commandClock.current.key !== commandClockKey) {
    commandClock.current = { key: commandClockKey, startedAtMs: performance.now() };
  }
  const commandOffsetMs = () =>
    toCanvasCommandOffsetMs(performance.now(), commandClock.current.startedAtMs);
  const [tool, setTool] = useState<"pen" | "eraser" | "fill">("pen");
  const [brushPreset, setBrushPreset] = useState<BrushPreset>("ink");
  const [color, setColor] = useState<string>(MASTER_PALETTE[0]);
  const [width, setWidth] = useState<(typeof BRUSH_WIDTHS)[number]>(8);
  const strokeCount = commands.filter(
    (command) => command.type === "stroke" || command.type === "fill"
  ).length;
  const fillCount = commands.filter((command) => command.type === "fill").length;
  const undoCount = commands.filter((command) => command.type === "undo").length;
  const commandSignature = commands.map((command) => command.id).join(":");
  const playbackIdentity =
    playbackMs !== undefined && playbackMs > 0 && commands.length > 0
      ? `${playbackKey ?? "canvas"}:${playbackMs}:${commandSignature}`
      : undefined;
  const [playbackState, setPlaybackState] = useState(() => ({
    identity: playbackIdentity,
    progress: playbackIdentity === undefined ? 1 : 0
  }));
  const playbackProgress = playbackProgressForRender(
    playbackState.identity,
    playbackIdentity,
    playbackState.progress
  );
  const playbackFrame = useMemo(
    () => canvasPlaybackFrameAtProgress(commands, playbackProgress),
    [commands, playbackProgress]
  );
  const playbackCursor = useMemo(
    () => playbackFrame.cursor ?? (livePlayback ? liveCanvasPlaybackCursor(commands) : undefined),
    [commands, livePlayback, playbackFrame.cursor]
  );

  useLayoutEffect(() => {
    if (
      playbackIdentity === undefined ||
      playbackMs === undefined ||
      playbackMs <= 0 ||
      commands.length === 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setPlaybackState({ identity: playbackIdentity, progress: 1 });
      return;
    }
    let frame = 0;
    const startedAt = performance.now();
    setPlaybackState({ identity: playbackIdentity, progress: 0 });
    const tick = (timestamp: number) => {
      const next = Math.min(1, (timestamp - startedAt) / playbackMs);
      setPlaybackState((current) =>
        current.identity === playbackIdentity ? { ...current, progress: next } : current
      );
      if (next < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [playbackIdentity, playbackMs, commands.length]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (context !== null && context !== undefined) {
      renderCanvasCommands(context, playbackFrame.commands);
    }
  }, [playbackFrame]);

  const begin = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (
      !editable ||
      strokeCount >= maxStrokes ||
      (tool === "fill" && fillCount >= MAX_FILLS_PER_TURN)
    )
      return;
    const point = logicalPoint(event.currentTarget, event);
    if (tool === "fill") {
      const next: FillCommand = {
        type: "fill",
        id: crypto.randomUUID(),
        point,
        color,
        offsetMs: commandOffsetMs()
      };
      onStrokePreview?.(next);
      onChange?.([...commands, next]);
      onPreview?.(null);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    liveStrokeId.current = crypto.randomUUID();
    const context = event.currentTarget.getContext("2d");
    liveCanvasBase.current = context?.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    livePoints.current = [point];
    onPreview?.(point);
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editable || tool === "fill" || livePoints.current.length === 0) return;
    const canvas = event.currentTarget;
    const point = logicalPoint(canvas, event);
    livePoints.current.push(point);
    const context = canvas.getContext("2d");
    if (context !== null) {
      const base = liveCanvasBase.current;
      if (base !== undefined) context.putImageData(base, 0, 0);
      drawStroke(context, {
        type: "stroke",
        id: liveStrokeId.current ?? "live",
        tool,
        ...(tool === "pen" ? { brushPreset } : {}),
        color,
        width,
        points: livePoints.current,
        offsetMs: 0
      });
    }
    onPreview?.(point);
  };

  const end = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editable || tool === "fill" || livePoints.current.length === 0) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const points = simplifyStroke(livePoints.current);
    livePoints.current = [];
    liveCanvasBase.current = undefined;
    onPreview?.(null);
    if (points.length < 2) {
      liveStrokeId.current = undefined;
      return;
    }
    const next: StrokeCommand = {
      type: "stroke",
      id: liveStrokeId.current ?? crypto.randomUUID(),
      tool,
      ...(tool === "pen" ? { brushPreset } : {}),
      color,
      width,
      points,
      offsetMs: commandOffsetMs()
    };
    liveStrokeId.current = undefined;
    onStrokePreview?.(next);
    onChange?.([...commands, next]);
  };

  const undo = () => {
    if (!editable || undoCount >= maxUndos) return;
    const active = activeCanvasMarkCommands(commands);
    const target = active.at(-1);
    if (target === undefined) return;
    onChange?.([
      ...commands,
      {
        type: "undo",
        id: crypto.randomUUID(),
        targetId: target.id,
        offsetMs: commandOffsetMs()
      }
    ]);
  };

  return (
    <div className={`canvas-board${compact ? " canvas-board--compact" : ""}`}>
      <div className="canvas-stage">
        <canvas
          ref={canvasRef}
          className={editable ? "is-editable" : ""}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          onPointerDown={begin}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          aria-label={editable ? t("drawing") : t("reveal")}
        />
        {Object.entries(remoteCursors).map(([peerId, point]) =>
          point === null ? null : (
            <span
              className="remote-cursor"
              key={peerId}
              style={{
                left: `${(point.x / CANVAS_WIDTH) * 100}%`,
                top: `${(point.y / CANVAS_HEIGHT) * 100}%`
              }}
            />
          )
        )}
        {playbackCursor !== undefined && (playbackProgress < 1 || livePlayback) && (
          <span
            className="ai-playback-cursor"
            data-brush={playbackCursor.brushPreset}
            data-tool={playbackCursor.tool}
            style={
              {
                left: `${(playbackCursor.point.x / CANVAS_WIDTH) * 100}%`,
                top: `${(playbackCursor.point.y / CANVAS_HEIGHT) * 100}%`,
                color: playbackCursor.tool === "eraser" ? "#202124" : playbackCursor.color,
                "--playback-angle": `${playbackCursor.angleDeg + 45}deg`
              } as CSSProperties
            }
          >
            {playbackCursor.tool === "eraser" ? (
              <Eraser size={20} />
            ) : playbackCursor.brushPreset === "pencil" ? (
              <Pencil size={20} />
            ) : playbackCursor.brushPreset === "marker" ? (
              <Highlighter size={20} />
            ) : playbackCursor.brushPreset === "paint" ? (
              <Paintbrush size={20} />
            ) : (
              <PenLine size={20} />
            )}
          </span>
        )}
        {(playbackProgress < 1 || livePlayback) && (
          <div className="canvas-playback-status" aria-live="polite">
            <Paintbrush size={15} />
            <span>{t("aiDrawingPlayback")}</span>
            {playbackProgress < 1 && <strong>{Math.round(playbackProgress * 100)}%</strong>}
          </div>
        )}
      </div>
      {editable && (
        <div className="canvas-toolbar" aria-label={t("drawing")}>
          <div className="tool-segment">
            <button
              className={tool === "pen" ? "icon-button is-active" : "icon-button"}
              type="button"
              title={t("brush")}
              aria-label={t("brush")}
              onClick={() => setTool("pen")}
            >
              <Paintbrush size={19} />
            </button>
            <button
              className={tool === "eraser" ? "icon-button is-active" : "icon-button"}
              type="button"
              title={t("eraser")}
              aria-label={t("eraser")}
              onClick={() => setTool("eraser")}
            >
              <Eraser size={19} />
            </button>
            <button
              className={tool === "fill" ? "icon-button is-active" : "icon-button"}
              type="button"
              title={t("fill")}
              aria-label={t("fill")}
              disabled={fillCount >= MAX_FILLS_PER_TURN}
              onClick={() => setTool("fill")}
            >
              <PaintBucket size={19} />
            </button>
          </div>
          <label
            className="brush-preset-control"
            title={`${t("brushStyle")}: ${t(`brushPresets.${brushPreset}`)}`}
          >
            {brushPreset === "pencil" ? (
              <Pencil aria-hidden="true" size={17} />
            ) : brushPreset === "marker" ? (
              <Highlighter aria-hidden="true" size={17} />
            ) : brushPreset === "paint" ? (
              <Paintbrush aria-hidden="true" size={17} />
            ) : (
              <PenLine aria-hidden="true" size={17} />
            )}
            <span className="sr-only">{t("brushStyle")}</span>
            <select
              aria-label={t("brushStyle")}
              value={brushPreset}
              onChange={(event) => {
                setBrushPreset(event.target.value as BrushPreset);
                setTool("pen");
              }}
            >
              {BRUSH_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {t(`brushPresets.${preset}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="color-swatches" aria-label={t("colorCount")}>
            {MASTER_PALETTE.slice(0, colorCount).map((item) => (
              <button
                type="button"
                key={item}
                className={color === item ? "color-swatch is-active" : "color-swatch"}
                style={{ backgroundColor: item }}
                aria-label={item}
                title={item}
                onClick={() => {
                  setColor(item);
                  if (tool === "eraser") setTool("pen");
                }}
              />
            ))}
          </div>
          <div className="width-segment" aria-label={t("maxStrokes")}>
            {BRUSH_WIDTHS.map((item) => (
              <button
                type="button"
                key={item}
                className={width === item ? "width-button is-active" : "width-button"}
                aria-label={`${item}`}
                title={`${item}px`}
                onClick={() => setWidth(item)}
              >
                <span style={{ width: Math.max(4, item / 2), height: Math.max(4, item / 2) }} />
              </button>
            ))}
          </div>
          <span className="stroke-counter">
            {strokeCount}/{maxStrokes}
          </span>
          <button
            className="icon-button toolbar-undo"
            type="button"
            title={t("undo")}
            aria-label={t("undo")}
            disabled={undoCount >= maxUndos || activeCanvasMarkCommands(commands).length === 0}
            onClick={undo}
          >
            <Undo2 size={19} />
          </button>
          {onFinish !== undefined && (
            <button
              className="primary-button toolbar-finish"
              type="button"
              onClick={() => onFinish(commandOffsetMs())}
            >
              <Check size={18} />
              {t("finish")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
