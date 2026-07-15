import { type ModelProfile, type ModelRole } from "@drawguessai/ai-adapters";
import { ExternalLink, Plus, Save, ShieldCheck, TestTube2, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { executeAiPipeline } from "../lib/ai-executor";
import {
  CCSWITCH_PROFILE_ID,
  deleteModelProfile,
  isBuiltInLocalProfileId,
  saveModelProfile,
  type StoredModelProfile
} from "../lib/model-store";
import { PROJECT_REPOSITORY_URL } from "../lib/project-links";

interface ModelProfilesDialogProps {
  open: boolean;
  profiles: readonly StoredModelProfile[];
  onClose: () => void;
  onReload: () => Promise<void>;
}

interface ProfileDraft {
  id?: string;
  label: string;
  protocol: "openai-compatible" | "anthropic-compatible";
  authMode: "protocol-default" | "bearer" | "x-api-key";
  baseUrl: string;
  model: string;
  apiKey: string;
  vision: boolean;
  structuredOutput: "none" | "json-object" | "json-schema";
  drawingPlanMode: "inline" | "separate";
  reasoningMode: "provider-default" | "disabled";
  observations: number;
  supportedRoles: ModelRole[];
  remember: boolean;
}

const ALL_MODEL_ROLES: readonly ModelRole[] = ["prompt", "draw", "guess", "review"];

const EMPTY_DRAFT: ProfileDraft = {
  label: "",
  protocol: "openai-compatible",
  authMode: "protocol-default",
  baseUrl: "http://127.0.0.1:8080",
  model: "",
  apiKey: "",
  vision: true,
  structuredOutput: "json-schema",
  drawingPlanMode: "inline",
  reasoningMode: "provider-default",
  observations: 1,
  supportedRoles: [...ALL_MODEL_ROLES],
  remember: false
};

function createVisionTestImageDataUrl(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Canvas is unavailable");

  context.fillStyle = "#f7f8fa";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#202124";
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = 12;
  context.beginPath();
  context.moveTo(70, 170);
  context.quadraticCurveTo(160, 55, 250, 170);
  context.stroke();
  context.fillStyle = "#2e62d5";
  context.beginPath();
  context.arc(160, 128, 28, 0, Math.PI * 2);
  context.fill();
  return canvas.toDataURL("image/png");
}

function draftFromRecord(record: StoredModelProfile): ProfileDraft {
  return {
    id: record.profile.id,
    label: record.profile.label,
    protocol:
      record.profile.protocol === "anthropic-compatible"
        ? "anthropic-compatible"
        : "openai-compatible",
    authMode: record.profile.authMode ?? "protocol-default",
    baseUrl: record.profile.baseUrl,
    model: record.profile.model,
    apiKey: record.apiKey ?? "",
    vision: record.profile.capabilities.vision,
    structuredOutput: record.profile.capabilities.structuredOutput,
    drawingPlanMode: record.profile.capabilities.drawingPlanMode ?? "inline",
    reasoningMode: record.profile.capabilities.reasoningMode ?? "provider-default",
    observations: record.profile.capabilities.maxObservationPasses,
    supportedRoles:
      record.profile.capabilities.supportedRoles ??
      ALL_MODEL_ROLES.filter((role) => role !== "guess" || record.profile.capabilities.vision),
    remember: record.remember
  };
}

export function ModelProfilesDialog({
  open,
  profiles,
  onClose,
  onReload
}: ModelProfilesDialogProps) {
  const { t, i18n } = useTranslation();
  const editableProfiles = useMemo(
    () =>
      profiles.filter(
        (record) =>
          record.profile.protocol !== "demo" && !isBuiltInLocalProfileId(record.profile.id)
      ),
    [profiles]
  );
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  const isCcswitchPreset = draft.id === CCSWITCH_PROFILE_ID;
  const isBuiltInLocalPreset = isBuiltInLocalProfileId(draft.id);

  const buildRecord = (): StoredModelProfile => {
    const id = draft.id ?? `profile-${crypto.randomUUID()}`;
    const profile: ModelProfile = {
      id,
      label: draft.label.trim(),
      protocol: draft.protocol,
      authMode: draft.authMode,
      execution: "local",
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      capabilities: {
        vision: draft.vision,
        structuredOutput: draft.structuredOutput,
        observationMode: draft.vision && draft.observations > 0 ? "checkpoint" : "one-shot",
        maxObservationPasses: draft.vision ? Math.min(2, Math.max(0, draft.observations)) : 0,
        drawingPlanMode: draft.drawingPlanMode,
        reasoningMode: draft.reasoningMode,
        supportedRoles: draft.supportedRoles.filter((role) => role !== "guess" || draft.vision)
      },
      secretRef: id,
      enabled: true
    };
    return { profile, apiKey: draft.apiKey, remember: draft.remember };
  };

  const test = async () => {
    setBusy(true);
    setStatus("");
    try {
      const record = buildRecord();
      const testCapabilities = { ...record.profile.capabilities };
      delete testCapabilities.supportedRoles;
      const testRecord: StoredModelProfile = {
        ...record,
        profile: { ...record.profile, capabilities: testCapabilities }
      };
      const result = await executeAiPipeline(
        testRecord,
        {
          roomId: "profile-test",
          participantId: "local",
          reconnectToken: "local",
          seatProfiles: {},
          seatPersonas: {},
          seatPersonaCustomizations: {},
          seatNames: {}
        },
        {
          jobId: `test-${crypto.randomUUID()}`,
          roomId: "profile-test",
          turnIndex: -1,
          role: "prompt",
          locale: i18n.language === "en" ? "en" : "zh-CN",
          personaId: "inspector",
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
        },
        { timeoutMs: 30_000 }
      );
      if (result.status !== "ok") {
        throw new Error(`AI test failed: ${result.errorCode ?? "invalid response"}`);
      }
      if (draft.vision) {
        const visionResult = await executeAiPipeline(
          testRecord,
          {
            roomId: "profile-test",
            participantId: "local",
            reconnectToken: "local",
            seatProfiles: {},
            seatPersonas: {},
            seatPersonaCustomizations: {},
            seatNames: {}
          },
          {
            jobId: `vision-test-${crypto.randomUUID()}`,
            roomId: "profile-test",
            turnIndex: 0,
            role: "guess",
            locale: i18n.language === "en" ? "en" : "zh-CN",
            personaId: "inspector",
            imageDataUrl: createVisionTestImageDataUrl(),
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
          },
          { timeoutMs: 30_000 }
        );
        if (visionResult.status !== "ok" || visionResult.guess === undefined) {
          throw new Error(
            t("visionTestFailed", { code: visionResult.errorCode ?? "invalid response" })
          );
        }
        setStatus(`${result.prompt ?? "OK"} · ${t("visionVerified")}`);
      } else {
        setStatus(result.prompt ?? "OK");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Connection failed");
    } finally {
      setBusy(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await saveModelProfile(buildRecord());
      await onReload();
      setDraft(EMPTY_DRAFT);
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (profileId: string) => {
    await deleteModelProfile(profileId);
    await onReload();
    if (draft.id === profileId) setDraft(EMPTY_DRAFT);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal model-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id="model-dialog-title">{t("modelProfiles")}</h2>
          <button className="icon-button" type="button" title={t("close")} onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <div className="model-dialog-body">
          <nav className="profile-list" aria-label={t("modelProfiles")}>
            {profiles.map((record) => (
              <button
                type="button"
                key={record.profile.id}
                className={draft.id === record.profile.id ? "profile-row is-active" : "profile-row"}
                disabled={
                  record.profile.protocol === "demo" || record.profile.execution === "server"
                }
                onClick={() => setDraft(draftFromRecord(record))}
              >
                <span>{record.profile.label}</span>
                <small>
                  {record.profile.execution === "server" ? "Server" : record.profile.protocol}
                </small>
              </button>
            ))}
            <button
              className="secondary-button add-profile"
              type="button"
              onClick={() => setDraft(EMPTY_DRAFT)}
            >
              <Plus size={16} />
              {t("addProfile")}
            </button>
          </nav>
          <form className="profile-form" onSubmit={(event) => void save(event)}>
            <aside className="model-security-notice wide-field">
              <ShieldCheck size={18} aria-hidden="true" />
              <span>
                {t("customModelSecurityNotice")}{" "}
                <a href={PROJECT_REPOSITORY_URL} target="_blank" rel="noopener noreferrer">
                  {t("customModelGithubDetails")}
                  <ExternalLink size={13} aria-hidden="true" />
                </a>
              </span>
            </aside>
            <label>
              <span>{t("profileLabel")}</span>
              <input
                required
                disabled={isBuiltInLocalPreset}
                value={draft.label}
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </label>
            <label>
              <span>{t("protocol")}</span>
              <select
                disabled={isBuiltInLocalPreset}
                value={draft.protocol}
                onChange={(event) =>
                  setDraft({ ...draft, protocol: event.target.value as ProfileDraft["protocol"] })
                }
              >
                <option value="openai-compatible">OpenAI Chat Completions</option>
                <option value="anthropic-compatible">Anthropic Messages</option>
              </select>
            </label>
            <label>
              <span>{t("authentication")}</span>
              <select
                disabled={isBuiltInLocalPreset}
                value={draft.authMode}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    authMode: event.target.value as ProfileDraft["authMode"]
                  })
                }
              >
                <option value="protocol-default">{t("authProtocolDefault")}</option>
                <option value="bearer">{t("authBearer")}</option>
                <option value="x-api-key">{t("authApiKey")}</option>
              </select>
            </label>
            <label className="wide-field">
              <span>{t("endpoint")}</span>
              <input
                required
                disabled={isBuiltInLocalPreset}
                type="url"
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </label>
            {!isCcswitchPreset && (
              <label>
                <span>{t("model")}</span>
                <input
                  required
                  disabled={isBuiltInLocalPreset}
                  value={draft.model}
                  onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                />
              </label>
            )}
            {!isBuiltInLocalPreset && (
              <label>
                <span>{t("apiKey")}</span>
                <input
                  required
                  type="password"
                  autoComplete="off"
                  value={draft.apiKey}
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                />
              </label>
            )}
            <label>
              <span>{t("structuredOutput")}</span>
              <select
                disabled={isBuiltInLocalPreset}
                value={draft.structuredOutput}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    structuredOutput: event.target.value as ProfileDraft["structuredOutput"]
                  })
                }
              >
                <option value="json-schema">JSON Schema</option>
                <option value="json-object">JSON Object</option>
                <option value="none">Prompt JSON</option>
              </select>
            </label>
            <label>
              <span>{t("maxObservations")}</span>
              <input
                type="number"
                min={0}
                max={2}
                value={draft.observations}
                disabled={isBuiltInLocalPreset || !draft.vision}
                onChange={(event) =>
                  setDraft({ ...draft, observations: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t("drawingPlanning")}</span>
              <select
                disabled={isBuiltInLocalPreset}
                value={draft.drawingPlanMode}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    drawingPlanMode: event.target.value as ProfileDraft["drawingPlanMode"]
                  })
                }
              >
                <option value="inline">{t("drawingPlanningInline")}</option>
                <option value="separate">{t("drawingPlanningSeparate")}</option>
              </select>
            </label>
            <label>
              <span>{t("reasoningOutput")}</span>
              <select
                disabled={isBuiltInLocalPreset || draft.protocol !== "anthropic-compatible"}
                value={draft.reasoningMode}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    reasoningMode: event.target.value as ProfileDraft["reasoningMode"]
                  })
                }
              >
                <option value="provider-default">{t("reasoningProviderDefault")}</option>
                <option value="disabled">{t("reasoningDisabled")}</option>
              </select>
            </label>
            <label className="toggle-setting">
              <input
                type="checkbox"
                checked={draft.vision}
                disabled={isBuiltInLocalPreset}
                onChange={(event) => {
                  const vision = event.target.checked;
                  const roles = vision
                    ? draft.supportedRoles
                    : draft.supportedRoles.filter((role) => role !== "guess");
                  setDraft({
                    ...draft,
                    vision,
                    observations: vision ? draft.observations : 0,
                    supportedRoles: roles.length === 0 ? ["draw"] : roles
                  });
                }}
              />
              <span>{t("vision")}</span>
            </label>
            <fieldset className="profile-role-capabilities wide-field">
              <legend>{t("supportedRoles")}</legend>
              <div>
                {ALL_MODEL_ROLES.map((role) => {
                  const checked = draft.supportedRoles.includes(role);
                  return (
                    <label className="toggle-setting" key={role}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isBuiltInLocalPreset || (role === "guess" && !draft.vision)}
                        onChange={(event) => {
                          const roles = event.target.checked
                            ? [...new Set([...draft.supportedRoles, role])]
                            : draft.supportedRoles.filter((candidate) => candidate !== role);
                          if (roles.length > 0) setDraft({ ...draft, supportedRoles: roles });
                        }}
                      />
                      <span>{t(`modelRole_${role}`)}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <label className="toggle-setting">
              <input
                type="checkbox"
                checked={draft.remember}
                disabled={isBuiltInLocalPreset}
                onChange={(event) => setDraft({ ...draft, remember: event.target.checked })}
              />
              <span>{t("remember")}</span>
            </label>
            <p className="form-help wide-field">{t("aiHelp")}</p>
            {status !== "" && <output className="profile-status wide-field">{status}</output>}
            <div className="form-actions wide-field">
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => void test()}
              >
                <TestTube2 size={17} />
                {t("testProfile")}
              </button>
              {draft.id !== undefined &&
                editableProfiles.some((record) => record.profile.id === draft.id) && (
                  <button
                    className="danger-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(draft.id!)}
                  >
                    <Trash2 size={17} />
                    {t("deleteProfile")}
                  </button>
                )}
              {!isBuiltInLocalPreset && (
                <button className="primary-button" type="submit" disabled={busy}>
                  <Save size={17} />
                  {t("saveProfile")}
                </button>
              )}
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
