export interface PeerDescriptor {
  id: string;
}

export type PeerSignal =
  | { type: "signal.offer"; peerId: string; sdp: string }
  | { type: "signal.answer"; peerId: string; sdp: string }
  | {
      type: "signal.ice";
      peerId: string;
      candidate: string;
      sdpMid: string | null;
      sdpMLineIndex: number | null;
    };

export type PreviewPacket =
  | { type: "cursor"; point: { x: number; y: number } | null }
  | { type: "clear"; generation: number }
  | {
      type: "stroke";
      command: CanvasMarkCommand;
      generation: number;
    };

const PreviewPacketSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cursor"), point: PointSchema.nullable() }).strict(),
  z
    .object({
      type: z.literal("clear"),
      generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    })
    .strict(),
  z
    .object({
      type: z.literal("stroke"),
      command: CanvasMarkCommandSchema,
      generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    })
    .strict()
]);

const MAX_PREVIEW_PACKET_BYTES = 40_000;

interface PeerRecord {
  connection: RTCPeerConnection;
  channel?: RTCDataChannel;
  timeout: number;
  pendingCandidates: RTCIceCandidateInit[];
}

export class PeerMesh {
  private readonly peers = new Map<string, PeerRecord>();

  constructor(
    private readonly ownId: string,
    private readonly iceServers: RTCIceServer[],
    private readonly iceTransportPolicy: RTCIceTransportPolicy,
    private readonly sendSignal: (signal: PeerSignal) => void,
    private readonly onPreview: (peerId: string, packet: PreviewPacket) => void,
    private readonly onStatus: (directPeers: number) => void
  ) {}

  syncPeers(peers: readonly PeerDescriptor[]): void {
    const desired = new Set(peers.map((peer) => peer.id).filter((id) => id !== this.ownId));
    for (const [peerId, record] of this.peers) {
      if (!desired.has(peerId)) {
        window.clearTimeout(record.timeout);
        record.connection.close();
        this.peers.delete(peerId);
      }
    }
    for (const peerId of desired) {
      if (!this.peers.has(peerId)) {
        void this.createPeer(peerId, this.ownId < peerId).catch(() => {
          this.onStatus(this.directPeerCount());
        });
      }
    }
  }

  private async createPeer(peerId: string, initiator: boolean): Promise<PeerRecord> {
    const connection = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: this.iceTransportPolicy
    });
    const record: PeerRecord = {
      connection,
      timeout: window.setTimeout(() => this.onStatus(this.directPeerCount()), 8_000),
      pendingCandidates: []
    };
    this.peers.set(peerId, record);
    connection.onicecandidate = (event) => {
      if (event.candidate === null) return;
      this.sendSignal({
        type: "signal.ice",
        peerId,
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex
      });
    };
    connection.onconnectionstatechange = () => this.onStatus(this.directPeerCount());
    connection.ondatachannel = (event) => this.attachChannel(peerId, record, event.channel);
    if (initiator) {
      const channel = connection.createDataChannel("drawguessai-preview", {
        ordered: false,
        maxRetransmits: 0
      });
      this.attachChannel(peerId, record, channel);
      await connection.setLocalDescription(await connection.createOffer());
      if (connection.localDescription?.sdp !== undefined) {
        this.sendSignal({ type: "signal.offer", peerId, sdp: connection.localDescription.sdp });
      }
    }
    return record;
  }

  private attachChannel(peerId: string, record: PeerRecord, channel: RTCDataChannel): void {
    record.channel = channel;
    channel.onopen = () => this.onStatus(this.directPeerCount());
    channel.onclose = () => this.onStatus(this.directPeerCount());
    channel.onmessage = (event) => {
      try {
        const raw = String(event.data);
        if (raw.length > MAX_PREVIEW_PACKET_BYTES) return;
        const packet = PreviewPacketSchema.parse(JSON.parse(raw));
        this.onPreview(peerId, packet);
      } catch {
        // Preview packets are intentionally best effort.
      }
    };
  }

  async handleSignal(signal: PeerSignal): Promise<void> {
    let record = this.peers.get(signal.peerId);
    if (record === undefined) record = await this.createPeer(signal.peerId, false);
    if (signal.type === "signal.offer") {
      await record.connection.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      await this.flushCandidates(record);
      await record.connection.setLocalDescription(await record.connection.createAnswer());
      if (record.connection.localDescription?.sdp !== undefined) {
        this.sendSignal({
          type: "signal.answer",
          peerId: signal.peerId,
          sdp: record.connection.localDescription.sdp
        });
      }
    } else if (signal.type === "signal.answer") {
      await record.connection.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      await this.flushCandidates(record);
    } else {
      const candidate = {
        candidate: signal.candidate,
        sdpMid: signal.sdpMid,
        sdpMLineIndex: signal.sdpMLineIndex
      };
      if (record.connection.remoteDescription === null) record.pendingCandidates.push(candidate);
      else await record.connection.addIceCandidate(candidate);
    }
  }

  private async flushCandidates(record: PeerRecord): Promise<void> {
    const pending = record.pendingCandidates.splice(0);
    for (const candidate of pending) await record.connection.addIceCandidate(candidate);
  }

  sendPreview(packet: PreviewPacket, recipients?: ReadonlySet<string>): boolean {
    let expected = 0;
    let sent = 0;
    for (const [peerId, record] of this.peers) {
      if (recipients !== undefined && !recipients.has(peerId)) continue;
      expected += 1;
      if (record.channel?.readyState === "open") {
        record.channel.send(JSON.stringify(packet));
        sent += 1;
      }
    }
    return expected > 0 && sent === expected;
  }

  private directPeerCount(): number {
    return [...this.peers.values()].filter(
      (record) =>
        record.connection.connectionState === "connected" && record.channel?.readyState === "open"
    ).length;
  }

  close(): void {
    for (const record of this.peers.values()) {
      window.clearTimeout(record.timeout);
      record.connection.close();
    }
    this.peers.clear();
  }
}
import {
  CanvasMarkCommandSchema,
  PointSchema,
  type CanvasMarkCommand
} from "@drawguessai/canvas-protocol";
import { z } from "zod";
