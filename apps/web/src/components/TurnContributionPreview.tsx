import type { GameArtifact } from "@drawguessai/game-core";
import { ArrowRight, X, ZoomIn } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { TurnContribution } from "../lib/turn-contribution";
import { CanvasBoard } from "./CanvasBoard";

type DrawingArtifact = Extract<GameArtifact, { kind: "drawing" }>;

function DrawingLightbox({
  artifact,
  onClose
}: {
  artifact: DrawingArtifact;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div
      className="drawing-lightbox"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section role="dialog" aria-modal="true" aria-label={t("enlargedDrawing")}>
        <header>
          <strong>{t("enlargedDrawing")}</strong>
          <button
            ref={closeRef}
            className="icon-button"
            type="button"
            title={t("closeEnlargedDrawing")}
            aria-label={t("closeEnlargedDrawing")}
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>
        <CanvasBoard commands={artifact.commands} compact />
      </section>
    </div>,
    document.body
  );
}

function ArtifactPreview({
  artifact,
  onExpand
}: {
  artifact: GameArtifact;
  onExpand: (artifact: DrawingArtifact) => void;
}) {
  const { t } = useTranslation();
  if (artifact.kind === "drawing") {
    return (
      <div className="contribution-artifact is-drawing">
        <button
          className="contribution-image-button"
          type="button"
          title={t("enlargeDrawing")}
          aria-label={t("enlargeDrawing")}
          onClick={() => onExpand(artifact)}
        >
          <CanvasBoard commands={artifact.commands} compact />
          <span className="contribution-zoom-cue" aria-hidden="true">
            <ZoomIn size={15} />
          </span>
        </button>
      </div>
    );
  }
  return (
    <div className="contribution-artifact is-text">
      <strong>{artifact.text}</strong>
    </div>
  );
}

export function TurnContributionPreview({
  contribution,
  variant = "inline"
}: {
  contribution: TurnContribution;
  variant?: "inline" | "tooltip";
}) {
  const { t } = useTranslation();
  const [expandedDrawing, setExpandedDrawing] = useState<DrawingArtifact>();
  return (
    <>
      <div
        className={`turn-contribution-preview is-${variant}`}
        role="group"
        aria-label={t("turnContribution")}
      >
        <div className="turn-contribution-flow">
          <div className="turn-contribution-node">
            <small>{t("contributionInput")}</small>
            <ArtifactPreview artifact={contribution.input} onExpand={setExpandedDrawing} />
          </div>
          <ArrowRight size={16} aria-hidden="true" />
          <div className="turn-contribution-node">
            <small>{t("contributionOutput")}</small>
            <ArtifactPreview artifact={contribution.output} onExpand={setExpandedDrawing} />
          </div>
        </div>
      </div>
      {expandedDrawing !== undefined && (
        <DrawingLightbox artifact={expandedDrawing} onClose={() => setExpandedDrawing(undefined)} />
      )}
    </>
  );
}
