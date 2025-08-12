// Date format for Spain timezone
// Returns format: DD-MM-YYYY-HH:MM

export function formatDateEs(dateInput: Date | string | number): string {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find(p => p.type === type)?.value || '';

  const day = get('day');
  const month = get('month');
  const year = get('year');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');

  return `${day}-${month}-${year}-${hour}:${minute}:${second}`;
}

export function parseEsDate(esDate: string): Date {
  // Expected format: DD-MM-YYYY-HH:MM:SS
  const match = esDate.match(/^(\d{2})-(\d{2})-(\d{4})-(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return new Date(NaN);
  const [, dd, mm, yyyy, HH, MM, SS] = match;
  const isoLike = `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}`;
  return new Date(isoLike);
}


