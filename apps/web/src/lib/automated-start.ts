export function formatAutomatedStartCountdown(nextRunAt: number, now = Date.now()): string {
  const totalSeconds = Math.max(0, Math.ceil((nextRunAt - now) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const twoDigits = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${twoDigits(hours)}:${twoDigits(minutes)}:${twoDigits(seconds)}`
    : `${twoDigits(minutes)}:${twoDigits(seconds)}`;
}
