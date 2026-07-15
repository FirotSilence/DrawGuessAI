import { createDemoTurnResult, AI_PERSONAS, type AiTurnJob } from "@drawguessai/ai-adapters";
import type { GameArtifact, TimelineSlot } from "@drawguessai/game-core";
import { ArrowLeft, Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createAiSeatNames } from "../lib/ai-seats";
import { CanvasBoard } from "./CanvasBoard";
import { SourceLink } from "./SourceLink";
import { Timeline } from "./Timeline";

const prompt = { "zh-CN": "雨中送伞", en: "Sharing an umbrella in the rain" };

function buildDemo(locale: "zh-CN" | "en") {
  const names = Object.values(createAiSeatNames(locale));
  const timeline: TimelineSlot[] = Array.from({ length: 8 }, (_, index) => {
    const persona = AI_PERSONAS[index % 4]!;
    return {
      index,
      role: index % 2 === 0 ? "draw" : "guess",
      actorType: "ai",
      actorId: `demo-${index}`,
      displayName: names[index] ?? `AI ${index + 1}`,
      personaId: persona.id
    };
  });
  const artifacts: GameArtifact[] = [
    { kind: "prompt", turnIndex: -1, actorId: "system", text: prompt[locale] }
  ];
  for (const slot of timeline) {
    const previous = artifacts.at(-1)!;
    const job: AiTurnJob = {
      jobId: `demo-${slot.index}`,
      roomId: "LOCAL",
      turnIndex: slot.index,
      role: slot.role,
      locale,
      personaId: slot.personaId ?? AI_PERSONAS[slot.index % 4]!.id,
      ...(previous.kind === "drawing"
        ? { inputCommands: previous.commands }
        : { inputText: previous.text }),
      observationIndex: 0,
      observationLimit: 0,
      timeLimitSeconds: 30,
      budget: {
        maxStrokes: 60,
        maxUndos: 3,
        colorCount: 10,
        remainingStrokes: 60,
        remainingUndos: 3
      }
    };
    const result = createDemoTurnResult(job);
    artifacts.push(
      slot.role === "draw"
        ? {
            kind: "drawing",
            turnIndex: slot.index,
            actorId: slot.actorId,
            commands: result.commands!,
            canvasHash: "local000"
          }
        : { kind: "guess", turnIndex: slot.index, actorId: slot.actorId, text: result.guess! }
    );
  }
  return { timeline, artifacts };
}

export function LocalDemo({ onBack }: { onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === "en" ? "en" : "zh-CN";
  const demo = useMemo(() => buildDemo(locale), [locale]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const artifact = demo.artifacts[index + 1];
  const prior = demo.artifacts[index];

  useEffect(() => {
    let timer: number | undefined;
    if (playing)
      timer = window.setInterval(
        () => setIndex((current) => (current >= 7 ? 0 : current + 1)),
        2_000
      );
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [playing]);

  return (
    <main className="local-demo-screen">
      <header className="game-header">
        <button className="icon-button" type="button" title={t("back")} onClick={onBack}>
          <ArrowLeft size={19} />
        </button>
        <strong>{t("demoNotice")}</strong>
        <span className="local-demo-header-actions">
          <SourceLink compact />
          <span className="room-tag">LOCAL</span>
        </span>
      </header>
      <section className="game-timeline-band">
        <Timeline slots={demo.timeline} currentIndex={index} />
      </section>
      <section className="demo-stage">
        <div className="demo-clue">
          <span>{index === 0 ? t("customPrompt") : t("previousLink")}</span>
          <strong>
            {index === 0
              ? prompt[locale]
              : prior?.kind === "guess" || prior?.kind === "prompt"
                ? prior.text
                : t("drawing")}
          </strong>
        </div>
        {artifact?.kind === "drawing" ? (
          <CanvasBoard
            commands={artifact.commands}
            playbackMs={1_800}
            playbackKey={`local:${index}`}
          />
        ) : (
          <blockquote className="demo-guess">
            {artifact?.kind === "guess" ? artifact.text : ""}
          </blockquote>
        )}
        <div className="demo-controls">
          <button
            className="icon-button"
            type="button"
            title={t("restart")}
            onClick={() => setIndex(0)}
          >
            <RotateCcw size={18} />
          </button>
          <button className="primary-button" type="button" onClick={() => setPlaying(!playing)}>
            {playing ? <Pause size={18} /> : <Play size={18} />}
            {playing ? t("pause") : t("play")}
          </button>
          <span>{index + 1}/8</span>
        </div>
      </section>
    </main>
  );
}
