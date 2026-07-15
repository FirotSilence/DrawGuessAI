/// <reference lib="webworker" />

import {
  AiAdapterError,
  executeAiTurn,
  type AiTurnJob,
  type ModelProfile,
  type ModelSecret
} from "@drawguessai/ai-adapters";

interface WorkerRequest {
  requestId: string;
  profile: ModelProfile;
  secret?: ModelSecret;
  job: AiTurnJob;
  timeoutMs: number;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  void executeAiTurn({
    profile: request.profile,
    ...(request.secret === undefined ? {} : { secret: request.secret }),
    job: request.job,
    timeoutMs: request.timeoutMs,
    onRetry: (notice) =>
      self.postMessage({
        requestId: request.requestId,
        type: "retry",
        ...notice
      })
  })
    .then((result) =>
      self.postMessage({ requestId: request.requestId, type: "result", ok: true, result })
    )
    .catch((error: unknown) =>
      self.postMessage({
        requestId: request.requestId,
        type: "result",
        ok: false,
        errorCode: error instanceof AiAdapterError ? error.code : "worker-error",
        error: error instanceof Error ? error.message : "AI request failed"
      })
    );
};

export {};
