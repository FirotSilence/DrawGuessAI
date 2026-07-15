import { getPersona } from "@drawguessai/ai-adapters";
import {
  Circle,
  Crown,
  Drama,
  Feather,
  FileSearch,
  Megaphone,
  Minus,
  Palette,
  Scale,
  Search,
  WandSparkles,
  Zap,
  type LucideIcon
} from "lucide-react";

const icons: readonly LucideIcon[] = [
  Crown,
  Minus,
  Megaphone,
  Search,
  Drama,
  WandSparkles,
  Circle,
  Palette,
  FileSearch,
  Feather,
  Zap,
  Scale
];

export function PersonaAvatar({
  personaId,
  size = "medium",
  label
}: {
  personaId: string;
  size?: "small" | "medium" | "large";
  label?: string;
}) {
  const persona = getPersona(personaId);
  const Icon = icons[persona.avatarIndex] ?? Crown;
  return (
    <span
      className={`persona-avatar persona-avatar-${persona.avatarIndex} persona-avatar-${size}`}
      role={label === undefined ? undefined : "img"}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
    >
      <span className="persona-avatar-face">
        <Icon />
      </span>
    </span>
  );
}
