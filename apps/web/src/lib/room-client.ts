import { quantizePoint, type CanvasMarkCommand } from "@drawguessai/canvas-protocol";
import {
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage
} from "@drawguessai/network-protocol";

import { fetchIceServers } from "./api";
import { PeerMesh, type PeerSignal, type PreviewPacket } from "./peer-mesh";
import type { RoomSession } from "./session-store";

export interface RoomClientHandlers {
  onMessage: (message: ServerMessage) => void;
  onPreview: (peerId: string, packet: PreviewPacket) => void;
  onConnection: (state: "connecting" | "direct" | "fallback" | "offline") => void;
}

export class RoomClient {
  private socket: WebSocket | undefined;
  private mesh: PeerMesh | undefined;
  private reconnectTimer: number | undefined;
  private stopped = false;
  private directPeers = 0;
  private iceServers: RTCIceServer[] = [];
  private peerIds: string[] = [];
  private peerMeshEnabled = true;
  private previewRecipients: ReadonlySet<string> | undefined;
  private previewGeneration = 0;

  constructor(
    private readonly session: RoomSession,
    private icePolicy: RTCIceTransportPolicy,
    private readonly handlers: RoomClientHandlers
  ) {}

  async connect(): Promise<void> {
    this.handlers.onConnection("connecting");
    try {
      this.iceServers = await fetchIceServers(this.session);
    } catch {
      this.iceServers = [{ urls: "stun:stun.cloudflare.com:3478" }];
    }
    this.openSocket();
  }

  private openSocket(): void {
    if (this.stopped) return;
    const url = new URL(`/api/rooms/${this.session.roomId}/ws`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("participantId", this.session.participantId);
    const socket = new WebSocket(url, [
      "drawguessai.v1",
      `drawguessai.auth.${this.session.reconnectToken}`
    ]);
    this.socket = socket;
    socket.onopen = () => {
      this.handlers.onConnection(this.directPeers > 0 ? "direct" : "fallback");
      if (this.peerMeshEnabled) this.createMesh();
    };
    socket.onmessage = (event) => {
      try {
        const message = ServerMessageSchema.parse(JSON.parse(String(event.data)));
        if (
          message.type === "signal.offer" ||
          message.type === "signal.answer" ||
          message.type === "signal.ice"
        ) {
          void this.mesh?.handleSignal(message).catch(() => {
            this.handlers.onConnection("fallback");
          });
        } else if (message.type === "preview.cursor") {
          this.handlers.onPreview(message.peerId, { type: "cursor", point: message.point });
        } else if (message.type === "preview.stroke") {
          this.handlers.onPreview(message.peerId, {
            type: "stroke",
            command: message.command,
            generation: message.generation
          });
        } else if (message.type === "preview.clear") {
          this.handlers.onPreview(message.peerId, {
            type: "clear",
            generation: message.generation
          });
        } else {
          if (message.type === "room.snapshot") {
            this.peerIds = message.peers.map((peer) => peer.id);
            this.setPeerMeshEnabled(message.automated !== true);
            if (this.peerMeshEnabled) this.mesh?.syncPeers(this.peerIds.map((id) => ({ id })));
          }
          this.handlers.onMessage(message);
        }
      } catch {
        // Malformed server packets are ignored and the next snapshot reconciles state.
      }
    };
    socket.onclose = () => {
      this.mesh?.close();
      this.mesh = undefined;
      this.handlers.onConnection("offline");
      if (!this.stopped) {
        this.reconnectTimer = window.setTimeout(() => this.openSocket(), 1_500);
      }
    };
  }

  private createMesh(): void {
    this.mesh?.close();
    this.mesh = new PeerMesh(
      this.session.participantId,
      this.iceServers,
      this.icePolicy,
      (signal) => this.send(signal),
      this.handlers.onPreview,
      (count) => {
        this.directPeers = count;
        this.handlers.onConnection(count > 0 ? "direct" : "fallback");
      }
    );
    this.mesh.syncPeers(this.peerIds.map((id) => ({ id })));
  }

  setIcePolicy(policy: RTCIceTransportPolicy): void {
    if (policy === this.icePolicy) return;
    this.icePolicy = policy;
    if (this.peerMeshEnabled && this.socket?.readyState === WebSocket.OPEN) this.createMesh();
  }

  private setPeerMeshEnabled(enabled: boolean): void {
    if (this.peerMeshEnabled === enabled) return;
    this.peerMeshEnabled = enabled;
    if (!enabled) {
      this.mesh?.close();
      this.mesh = undefined;
      this.directPeers = 0;
      if (this.socket?.readyState === WebSocket.OPEN) this.handlers.onConnection("fallback");
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) this.createMesh();
  }

  send(message: ClientMessage | PeerSignal): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  sendPreview(point: { x: number; y: number } | null): void {
    const boundedPoint = point === null ? null : quantizePoint(point);
    const packet: PreviewPacket = { type: "cursor", point: boundedPoint };
    if (!this.mesh?.sendPreview(packet, this.previewRecipients))
      this.send({ type: "preview.cursor", point: boundedPoint });
  }

  sendPreviewStroke(command: CanvasMarkCommand): void {
    const packet: PreviewPacket = {
      type: "stroke",
      command,
      generation: this.previewGeneration
    };
    if (!this.mesh?.sendPreview(packet, this.previewRecipients))
      this.send({ type: "preview.stroke", command, generation: this.previewGeneration });
  }

  sendPreviewClear(): void {
    this.previewGeneration += 1;
    const packet: PreviewPacket = { type: "clear", generation: this.previewGeneration };
    this.mesh?.sendPreview(packet, this.previewRecipients);
    this.send({ type: "preview.clear", generation: this.previewGeneration });
  }

  setPreviewRecipients(participantIds: readonly string[]): void {
    this.previewRecipients = new Set(participantIds);
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.mesh?.close();
    this.socket?.close(1000, "Client left room");
  }
}
