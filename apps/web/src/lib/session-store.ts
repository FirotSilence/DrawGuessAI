import {
  AiPersonaCustomizationSchema,
  type AiPersonaCustomization
} from "@drawguessai/ai-adapters";

export interface RoomSession {
  roomId: string;
  participantId: string;
  reconnectToken: string;
  hostToken?: string;
  inviteUrl?: string;
  seatProfiles: Record<string, string>;
  seatPersonas: Record<string, string>;
  seatPersonaCustomizations: Record<string, AiPersonaCustomization>;
  seatNames: Record<string, string>;
}

function personaCustomizations(value: unknown): Record<string, AiPersonaCustomization> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([seatId, customization]) => {
      const parsed = AiPersonaCustomizationSchema.safeParse(customization);
      return parsed.success ? [[seatId, parsed.data]] : [];
    })
  );
}

function key(roomId: string): string {
  return `drawguessai:room:${roomId.toUpperCase()}`;
}

export function saveRoomSession(session: RoomSession): void {
  sessionStorage.setItem(key(session.roomId), JSON.stringify(session));
}

export function loadRoomSession(roomId: string): RoomSession | undefined {
  try {
    const raw = sessionStorage.getItem(key(roomId));
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as Partial<RoomSession>;
    if (
      typeof parsed.roomId !== "string" ||
      typeof parsed.participantId !== "string" ||
      typeof parsed.reconnectToken !== "string"
    ) {
      return undefined;
    }
    return {
      roomId: parsed.roomId,
      participantId: parsed.participantId,
      reconnectToken: parsed.reconnectToken,
      ...(typeof parsed.hostToken === "string" ? { hostToken: parsed.hostToken } : {}),
      ...(typeof parsed.inviteUrl === "string" ? { inviteUrl: parsed.inviteUrl } : {}),
      seatProfiles:
        typeof parsed.seatProfiles === "object" && parsed.seatProfiles !== null
          ? (parsed.seatProfiles as Record<string, string>)
          : {},
      seatPersonas:
        typeof parsed.seatPersonas === "object" && parsed.seatPersonas !== null
          ? (parsed.seatPersonas as Record<string, string>)
          : {},
      seatPersonaCustomizations: personaCustomizations(parsed.seatPersonaCustomizations),
      seatNames:
        typeof parsed.seatNames === "object" && parsed.seatNames !== null
          ? (parsed.seatNames as Record<string, string>)
          : {}
    };
  } catch {
    return undefined;
  }
}

export function clearRoomSession(roomId: string): void {
  sessionStorage.removeItem(key(roomId));
}
