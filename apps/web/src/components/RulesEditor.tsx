import type { GameConfig } from "@drawguessai/game-core";
import { Save } from "lucide-react";
import { useTranslation } from "react-i18next";

interface RulesEditorProps {
  config: GameConfig;
  relayOnlyAvailable: boolean;
  onChange: (config: GameConfig) => void;
  onSave: (config: GameConfig) => void;
}

interface NumericSettingProps {
  label: string;
  title?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}

function NumericSetting({
  label,
  title,
  value,
  min,
  max,
  step = 1,
  onChange
}: NumericSettingProps) {
  return (
    <label className="numeric-setting" title={title}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value))))}
      />
    </label>
  );
}

export function RulesEditor({ config, relayOnlyAvailable, onChange, onSave }: RulesEditorProps) {
  const { t } = useTranslation();
  const updateRule = (key: keyof GameConfig["rules"], value: number) =>
    onChange({ ...config, rules: { ...config.rules, [key]: value } });

  return (
    <section className="rules-editor">
      <div className="section-heading">
        <h3>{t("rules")}</h3>
      </div>
      <div className="rules-grid">
        <NumericSetting
          label={t("chainLength")}
          value={config.rules.chainLength}
          min={4}
          max={12}
          onChange={(value) => updateRule("chainLength", value)}
        />
        <NumericSetting
          label={t("drawSeconds")}
          value={config.rules.drawSeconds}
          min={30}
          max={180}
          step={5}
          onChange={(value) => updateRule("drawSeconds", value)}
        />
        <NumericSetting
          label={t("guessSeconds")}
          value={config.rules.guessSeconds}
          min={15}
          max={90}
          step={5}
          onChange={(value) => updateRule("guessSeconds", value)}
        />
        <NumericSetting
          label={t("maxStrokes")}
          value={config.rules.maxStrokes}
          min={20}
          max={120}
          step={5}
          onChange={(value) => updateRule("maxStrokes", value)}
        />
        <NumericSetting
          label={t("maxUndos")}
          value={config.rules.maxUndos}
          min={0}
          max={10}
          onChange={(value) => updateRule("maxUndos", value)}
        />
        <NumericSetting
          label={t("colorCount")}
          value={config.rules.colorCount}
          min={4}
          max={12}
          onChange={(value) => updateRule("colorCount", value)}
        />
        <NumericSetting
          label={t("observations")}
          title={t("observationHint")}
          value={config.rules.aiObservationPasses}
          min={0}
          max={2}
          onChange={(value) => updateRule("aiObservationPasses", value)}
        />
        <NumericSetting
          label={t("playback")}
          value={config.rules.aiPlaybackSeconds}
          min={10}
          max={45}
          step={5}
          onChange={(value) => updateRule("aiPlaybackSeconds", value)}
        />
      </div>
      <div className="rules-toggles">
        <label className="toggle-setting">
          <input
            type="checkbox"
            checked={config.showTopicHint !== false}
            onChange={(event) => onChange({ ...config, showTopicHint: event.target.checked })}
          />
          <span>{t("showTopicHint")}</span>
        </label>
        <label className="toggle-setting">
          <input
            type="checkbox"
            disabled={!relayOnlyAvailable}
            title={!relayOnlyAvailable ? t("relayUnavailable") : undefined}
            checked={config.icePolicy === "relay"}
            onChange={(event) =>
              onChange({
                ...config,
                icePolicy: event.target.checked ? "relay" : "all"
              })
            }
          />
          <span title={!relayOnlyAvailable ? t("relayUnavailable") : undefined}>
            {t("relayOnly")}
          </span>
        </label>
      </div>
      <button className="secondary-button" type="button" onClick={() => onSave(config)}>
        <Save size={17} />
        {t("saveRules")}
      </button>
    </section>
  );
}
