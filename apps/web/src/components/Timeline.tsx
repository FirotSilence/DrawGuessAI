import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { getPersona } from "@drawguessai/ai-adapters";
import type { TimelineSlot } from "@drawguessai/game-core";
import { GripVertical, Paintbrush, Search, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PersonaAvatar } from "./PersonaAvatar";

interface TimelineProps {
  slots: readonly TimelineSlot[];
  currentIndex?: number;
  editable?: boolean;
  onChange?: (slots: TimelineSlot[]) => void;
}

function Slot({
  slot,
  current,
  editable
}: {
  slot: TimelineSlot;
  current: boolean;
  editable: boolean;
}) {
  const { i18n } = useTranslation();
  const sortable = useSortable({ id: `${slot.actorId}:${slot.index}`, disabled: !editable });
  const persona = slot.actorType === "ai" ? getPersona(slot.personaId ?? "maestro") : undefined;
  return (
    <li
      ref={sortable.setNodeRef}
      className={`timeline-slot${current ? " is-current" : ""}${editable ? " is-editable" : ""}`}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition
      }}
      {...sortable.attributes}
    >
      {editable && (
        <button className="drag-handle" type="button" {...sortable.listeners} aria-label="Reorder">
          <GripVertical size={15} />
        </button>
      )}
      <span className="timeline-index">{slot.index + 1}</span>
      <span className={`timeline-role role-${slot.role}`}>
        {slot.role === "draw" ? <Paintbrush size={15} /> : <Search size={15} />}
      </span>
      <span className="timeline-actor-icon">
        {slot.actorType === "ai" ? (
          <PersonaAvatar personaId={slot.personaId ?? "maestro"} size="small" />
        ) : (
          <UserRound size={15} />
        )}
      </span>
      <span className="timeline-name">{slot.displayName}</span>
      {persona !== undefined && (
        <span className="timeline-persona">
          {slot.personaName ?? persona.names[i18n.language === "en" ? "en" : "zh-CN"]}
        </span>
      )}
    </li>
  );
}

export function Timeline({ slots, currentIndex, editable = false, onChange }: TimelineProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const dragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const oldIndex = slots.findIndex((slot) => `${slot.actorId}:${slot.index}` === event.active.id);
    const newIndex = slots.findIndex((slot) => `${slot.actorId}:${slot.index}` === event.over?.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onChange?.(
      arrayMove([...slots], oldIndex, newIndex).map((slot, index) => ({
        ...slot,
        index,
        role: index % 2 === 0 ? ("draw" as const) : ("guess" as const)
      }))
    );
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
      <SortableContext
        items={slots.map((slot) => `${slot.actorId}:${slot.index}`)}
        strategy={horizontalListSortingStrategy}
      >
        <ol className="timeline-list">
          {slots.map((slot) => (
            <Slot
              key={`${slot.actorId}:${slot.index}`}
              slot={slot}
              current={slot.index === currentIndex}
              editable={editable}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}
