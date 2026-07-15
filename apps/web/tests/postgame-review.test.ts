import {
  DEFAULT_GAME_CONFIG,
  createInitialGameState,
  type GameArtifact,
  type GameState
} from "@drawguessai/game-core";
import { describe, expect, it } from "vitest";

import {
  buildPostGameReviewContext,
  departedReviewText,
  humanDrawingForReviewer,
  isUsablePostGameReviewResult,
  normalizeReviewText,
  resolvePostGameActions
} from "../src/lib/postgame-review";

function completedState(): GameState {
  return {
    ...createInitialGameState("room", "seed", DEFAULT_GAME_CONFIG, 1),
    phase: "complete",
    timeline: [
      {
        index: 0,
        role: "draw",
        actorType: "ai",
        actorId: "ai-maestro",
        displayName: "大师",
        personaId: "maestro"
      },
      {
        index: 1,
        role: "guess",
        actorType: "ai",
        actorId: "ai-deadpan",
        displayName: "冷面",
        personaId: "deadpan"
      },
      {
        index: 2,
        role: "draw",
        actorType: "ai",
        actorId: "ai-maestro",
        displayName: "大师",
        personaId: "maestro"
      },
      {
        index: 3,
        role: "guess",
        actorType: "ai",
        actorId: "ai-deadpan",
        displayName: "冷面",
        personaId: "deadpan"
      }
    ],
    artifacts: [
      {
        kind: "prompt",
        turnIndex: -1,
        actorId: "host",
        text: "画蛇添足",
        metadata: { language: "zh-CN", kind: "idiom", length: 4 }
      },
      {
        kind: "drawing",
        turnIndex: 0,
        actorId: "ai-maestro",
        commands: [],
        canvasHash: "00000000"
      },
      {
        kind: "guess",
        turnIndex: 1,
        actorId: "ai-deadpan",
        text: "一条奇怪的鱼"
      }
    ],
    promptMetadata: { language: "zh-CN", kind: "idiom", length: 4 }
  };
}

describe("post-game player banter", () => {
  it("gives each persona its own turn and neighbor context", () => {
    const context = buildPostGameReviewContext(completedState(), "ai-maestro", []);
    expect(context).toContain(
      'actorId=ai-maestro,name="大师",actorType=ai,roles=T1:draw,T3:draw,YOU'
    );
    expect(context).toContain("SELF ROLE: DRAWER");
    expect(context).toContain(
      "ROLE OWNERSHIP: YOU created the drawing; YOU did not make the downstream guess"
    );
    expect(context).toContain('ORIGINAL PROMPT: "画蛇添足"');
    expect(context).toContain('FINAL RESULT: "一条奇怪的鱼"');
    expect(context).toContain("START-TO-FINAL MATCH=no");
    expect(context).toContain("HANDOFFS:");
    expect(context).toContain(
      'T1 DRAW actorId=ai-maestro name="大师" input="画蛇添足" -> T2 GUESS actorId=ai-deadpan name="冷面" output="一条奇怪的鱼" MATCH=no'
    );
    expect(context).toContain('YOU drew input="画蛇添足"; downstream=冷面 guessed="一条奇怪的鱼"');
    expect(context).toContain("MATCH=no");
    expect(context).toContain("type=idiom; length=4");
    expect(context).not.toContain("personaId=");
    expect(context).not.toContain("FULL RELAY");
  });

  it("keeps every actor and handoff in a maximum-length relay", () => {
    const base = completedState();
    const timeline = Array.from({ length: 12 }, (_, index) => ({
      index,
      role: index % 2 === 0 ? ("draw" as const) : ("guess" as const),
      actorType: "ai" as const,
      actorId: `actor-${index}`,
      displayName: `玩家${index + 1}`,
      personaId: index % 2 === 0 ? "maestro" : "deadpan"
    }));
    const turnArtifacts: GameArtifact[] = timeline.map((slot) =>
      slot.role === "draw"
        ? {
            kind: "drawing",
            turnIndex: slot.index,
            actorId: slot.actorId,
            commands: [],
            canvasHash: `${slot.index}`.padStart(8, "0")
          }
        : {
            kind: "guess",
            turnIndex: slot.index,
            actorId: slot.actorId,
            text: `猜${slot.index + 1}`
          }
    );
    const state: GameState = {
      ...base,
      timeline,
      artifacts: [base.artifacts[0]!, ...turnArtifacts]
    };

    const context = buildPostGameReviewContext(state, "actor-0", []);
    expect(context).toContain('actorId=actor-11,name="玩家12",actorType=ai,roles=T12:guess');
    expect(context).toContain(
      'T11 DRAW actorId=actor-10 name="玩家11" input="猜10" -> T12 GUESS actorId=actor-11 name="玩家12" output="猜12" MATCH=no'
    );
    expect(context.length).toBeLessThanOrEqual(5_600);
  });

  it("recommends concise table talk without truncating a valid response", () => {
    expect(normalizeReviewText("  这条蛇画得像鱼。\n后面的解释省省吧。  ")).toBe(
      "这条蛇画得像鱼。 后面的解释省省吧。"
    );
    const longComment =
      "That snake applied for a fish license. Then it opened a seafood restaurant and explained the whole relay again.";
    expect(normalizeReviewText(longComment)).toBe(longComment);
  });

  it("keeps only valid directed player interactions", () => {
    const state = completedState();
    const requested = resolvePostGameActions(state, "ai-maestro", [
      { targetActorId: "deadpan", kind: "applause", text: "居然接住了。" },
      { targetActorId: "ai-maestro", kind: "heart", text: "Self reaction" }
    ]);
    expect(requested).toEqual([]);

    expect(resolvePostGameActions(state, "ai-deadpan", undefined)).toEqual([]);
    expect(resolvePostGameActions(state, "ai-maestro", undefined)).toEqual([]);
    expect(
      resolvePostGameActions(state, "ai-maestro", [
        {
          targetActorId: "deadpan",
          targetTurnIndex: 1,
          kind: "egg",
          text: "你把蛇认成鱼了。"
        }
      ])
    ).toEqual([]);
    expect(
      resolvePostGameActions(state, "ai-maestro", [
        {
          targetActorId: "ai-deadpan",
          targetTurnIndex: 1,
          kind: "egg",
          text: "你把蛇认成鱼了。"
        }
      ])[0]
    ).toMatchObject({
      targetSeatId: "ai-deadpan",
      targetDisplayName: "冷面",
      targetTurnIndex: 1,
      reaction: "egg",
      text: "你把蛇认成鱼了。"
    });

    const matched: GameState = {
      ...state,
      artifacts: state.artifacts.map((artifact) =>
        artifact.kind === "guess" ? { ...artifact, text: "画蛇添足" } : artifact
      )
    };
    expect(
      resolvePostGameActions(matched, "ai-maestro", [
        {
          targetActorId: "ai-deadpan",
          targetTurnIndex: 1,
          kind: "applause",
          text: "这次真接住了。"
        }
      ])[0]
    ).toMatchObject({ reaction: "applause", text: "这次真接住了。" });
  });

  it("marks human players explicitly and allows AI reactions to target their contribution", () => {
    const state: GameState = {
      ...completedState(),
      timeline: completedState().timeline.map((slot) => {
        if (slot.index !== 1) return slot;
        const humanSlot = {
          ...slot,
          actorType: "human" as const,
          actorId: "human-friend",
          displayName: "小林"
        };
        delete humanSlot.personaId;
        return humanSlot;
      }),
      artifacts: completedState().artifacts.map((artifact) =>
        artifact.turnIndex === 1 ? { ...artifact, actorId: "human-friend" } : artifact
      )
    };
    const context = buildPostGameReviewContext(state, "ai-maestro", []);
    expect(context).toContain('actorId=human-friend,name="小林",actorType=human');
    expect(context).toContain("HUMAN PARTICIPATION:");
    expect(context).toContain('human-friend/小林: T2 THEY guessed="一条奇怪的鱼"');
    expect(context).toContain("DIRECT HUMAN LINKS: T1 DOWNSTREAM HUMAN actorId=human-friend");
    expect(
      resolvePostGameActions(state, "ai-maestro", [
        {
          targetActorId: "human-friend",
          targetTurnIndex: 1,
          kind: "egg",
          text: "你把蛇认成鱼了。"
        }
      ])[0]
    ).toMatchObject({ targetSeatId: "human-friend", targetDisplayName: "小林" });
  });

  it("grounds positive interactions in the target player's exact contribution", () => {
    const base = completedState();
    const state: GameState = {
      ...base,
      timeline: [
        { ...base.timeline[0]!, actorId: "drawer-a", displayName: "甲" },
        { ...base.timeline[1]!, actorId: "guesser-b", displayName: "乙" },
        { ...base.timeline[2]!, actorId: "drawer-c", displayName: "丙" },
        { ...base.timeline[3]!, actorId: "guesser-d", displayName: "丁" }
      ],
      artifacts: [
        base.artifacts[0]!,
        { ...base.artifacts[1]!, actorId: "drawer-a" },
        { kind: "guess", turnIndex: 1, actorId: "guesser-b", text: "一条鱼" },
        {
          kind: "drawing",
          turnIndex: 2,
          actorId: "drawer-c",
          commands: [],
          canvasHash: "11111111"
        },
        { kind: "guess", turnIndex: 3, actorId: "guesser-d", text: "一只鸟" }
      ]
    };

    expect(
      resolvePostGameActions(state, "drawer-a", [
        {
          targetActorId: "guesser-d",
          targetTurnIndex: 3,
          kind: "applause",
          text: "你猜得真准。"
        }
      ])
    ).toEqual([]);
  });

  it("provides an upstream human drawing to a vision-capable review caller", () => {
    const state = completedState();
    const humanDraw = { ...state.timeline[0]!, actorType: "human" as const };
    delete humanDraw.personaId;
    state.timeline[0] = humanDraw;
    state.artifacts = state.artifacts.map((artifact) =>
      artifact.turnIndex === 0 ? { ...artifact, actorId: humanDraw.actorId } : artifact
    );
    const source = humanDrawingForReviewer(state, "ai-deadpan");
    expect(source?.slot.actorType).toBe("human");
    expect(source?.artifact.turnIndex).toBe(0);
    expect(buildPostGameReviewContext(state, "ai-deadpan", [])).toContain(
      "DIRECT HUMAN LINKS: T2 UPSTREAM HUMAN"
    );
    expect(buildPostGameReviewContext(state, "ai-deadpan", [])).toContain("SELF ROLE: GUESSER");
    expect(buildPostGameReviewContext(state, "ai-deadpan", [])).toContain(
      "YOU did not create the incoming drawing"
    );
  });

  it("rejects fallback copy as a usable AI review", () => {
    expect(
      isUsablePostGameReviewResult({
        jobId: "review",
        status: "fallback",
        review: { text: "少一笔，差十里。", score: 3 },
        confidence: 0,
        reaction: { kind: "confused", text: "fallback" },
        errorCode: "timeout"
      })
    ).toBe(false);
    expect(
      isUsablePostGameReviewResult({
        jobId: "review",
        status: "ok",
        review: { text: "我有话说。", score: 3 },
        confidence: 0.7,
        reaction: { kind: "confused", text: "等一下。" }
      })
    ).toBe(false);
    expect(
      isUsablePostGameReviewResult({
        jobId: "review",
        status: "ok",
        review: {
          text: "我有话说。",
          score: 3,
          actions: [{ targetActorId: "ai-maestro", kind: "egg", text: "这画我不认。" }]
        },
        confidence: 0.7,
        reaction: { kind: "confused", text: "等一下。" }
      })
    ).toBe(true);
    expect(departedReviewText("zh-CN")).toBe("AI无言以对,已退出房间(掉线/报错)");
  });
});
