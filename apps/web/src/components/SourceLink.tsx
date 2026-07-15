import { Code2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PROJECT_REPOSITORY_URL } from "../lib/project-links";

export function SourceLink({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <a
      className={`source-link${compact ? " is-compact" : ""}`}
      href={PROJECT_REPOSITORY_URL}
      target="_blank"
      rel="noopener noreferrer"
      title={t("sourceCode")}
      aria-label={t("sourceCode")}
    >
      <Code2 size={16} />
      <span>{t("sourceCode")}</span>
    </a>
  );
}
