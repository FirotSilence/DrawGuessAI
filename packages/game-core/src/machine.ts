import { createMachine } from "xstate";

export type GameMachineEvent =
  | { type: "START" }
  | { type: "PROMPT_READY" }
  | { type: "INSPECT" }
  | { type: "RESUME" }
  | { type: "SUBMIT" }
  | { type: "NEXT"; hasMoreTurns: boolean }
  | { type: "REVEAL" }
  | { type: "COMPLETE" }
  | { type: "FAIL" }
  | { type: "RESET" };

export const gamePhaseMachine = createMachine({
  types: {} as { events: GameMachineEvent },
  id: "drawguessai-game",
  initial: "lobby",
  states: {
    lobby: { on: { START: "prompt" } },
    prompt: { on: { PROMPT_READY: "turn", RESET: "lobby" } },
    turn: { on: { INSPECT: "inspect", SUBMIT: "reaction", FAIL: "failed", RESET: "lobby" } },
    inspect: {
      on: { RESUME: "turn", SUBMIT: "reaction", FAIL: "failed", RESET: "lobby" }
    },
    reaction: {
      on: {
        NEXT: [{ guard: ({ event }) => event.hasMoreTurns, target: "turn" }, { target: "reveal" }],
        RESET: "lobby"
      }
    },
    reveal: { on: { COMPLETE: "complete", RESET: "lobby" } },
    complete: { on: { RESET: "lobby" } },
    failed: { on: { RESET: "lobby" } }
  }
});
