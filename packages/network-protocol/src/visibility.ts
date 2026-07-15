import type { Visibility } from "./schema";

export interface VisibilityViewer {
  participantId: string;
  roomRole: "host" | "player" | "spectator";
  hasActed: boolean;
  isAiExecutor: boolean;
}

export interface VisibilityContext {
  activeParticipantId?: string;
  phase: string;
}

export function canView(
  visibility: Visibility,
  viewer: VisibilityViewer,
  context: VisibilityContext
): boolean {
  switch (visibility) {
    case "public":
      return true;
    case "active":
      return context.activeParticipantId === viewer.participantId;
    case "acted":
      return viewer.hasActed || viewer.roomRole === "spectator";
    case "spectators":
      return viewer.roomRole === "spectator";
    case "reveal":
      return context.phase === "reveal" || context.phase === "complete";
    case "ai-executor":
      return viewer.isAiExecutor;
  }
}
