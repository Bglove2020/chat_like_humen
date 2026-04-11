export const MEMORY_TIME_ZONE = 'Asia/Shanghai';
export const MEMORY_DAY_START_HOUR = 5;

function getTimeZoneParts(date: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});
}

export function computeMemoryDate(
  reference: Date | string,
  timeZone = MEMORY_TIME_ZONE,
  dayStartHour = MEMORY_DAY_START_HOUR,
): string {
  const date = reference instanceof Date ? reference : new Date(reference);
  const parts = getTimeZoneParts(date, timeZone);

  const shifted = new Date(
    Date.UTC(
      parseInt(parts.year, 10),
      parseInt(parts.month, 10) - 1,
      parseInt(parts.day, 10),
      parseInt(parts.hour, 10),
      parseInt(parts.minute, 10),
      parseInt(parts.second, 10),
    ),
  );

  shifted.setUTCHours(shifted.getUTCHours() - dayStartHour);
  return shifted.toISOString().slice(0, 10);
}
