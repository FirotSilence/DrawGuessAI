import { Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatAutomatedStartCountdown } from "../lib/automated-start";

export function AutomatedStartCountdown({ nextRunAt }: { nextRunAt: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  const starting = nextRunAt <= now;
  const countdown = formatAutomatedStartCountdown(nextRunAt, now);
  const label = starting
    ? t("automatedRelayStarting")
    : `${t("automatedRelayStartsIn")} ${countdown}`;

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [nextRunAt]);

  return (
    <span className="automated-start-countdown" aria-label={label}>
      <Timer size={16} />
      <span>{t(starting ? "automatedRelayStarting" : "automatedRelayStartsIn")}</span>
      {!starting && <strong>{countdown}</strong>}
    </span>
  );
}
