export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const GOOGLE_CALENDAR_TIME_ZONE = 'America/Sao_Paulo';

export type CalendarFlight = {
  id: string;
  date: string;
  flightNumber: string;
  origin: string;
  destination: string;
  period: string;
  crewService: string;
  paxService: string;
};

export type GoogleCalendarEvent = {
  id: string;
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  extendedProperties: { private: { tripspaceFlightId: string } };
};

export async function buildGoogleCalendarEvent(flight: CalendarFlight): Promise<GoogleCalendarEvent | null> {
  const date = normalizeCalendarDate(flight.date);
  const periodMatch = flight.period.match(/(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})/);

  if (!date || !periodMatch) return null;

  const [, startHour, startMinute, endHour, endMinute] = periodMatch;
  const startTime = `${startHour}:${startMinute}:00`;
  const endTime = `${endHour}:${endMinute}:00`;
  const endDate = endTime <= startTime ? addCalendarDays(date, 1) : date;

  return {
    id: await createGoogleEventId(flight.id),
    summary: `Voo ${flight.flightNumber}: ${flight.origin} → ${flight.destination}`,
    description: [
      `Voo: ${flight.flightNumber}`,
      `Rota: ${flight.origin} → ${flight.destination}`,
      `Serviço crew: ${flight.crewService}`,
      `Serviço pax: ${flight.paxService}`,
      '',
      'Adicionado pelo TripSpace.',
    ].join('\n'),
    start: {
      dateTime: `${date}T${startTime}`,
      timeZone: GOOGLE_CALENDAR_TIME_ZONE,
    },
    end: {
      dateTime: `${endDate}T${endTime}`,
      timeZone: GOOGLE_CALENDAR_TIME_ZONE,
    },
    extendedProperties: {
      private: { tripspaceFlightId: flight.id },
    },
  };
}

function normalizeCalendarDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const brazilMatch = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return brazilMatch ? `${brazilMatch[3]}-${brazilMatch[2]}-${brazilMatch[1]}` : null;
}

function addCalendarDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));

  return result.toISOString().slice(0, 10);
}

async function createGoogleEventId(flightId: string) {
  const bytes = new TextEncoder().encode(`tripspace:${flightId}`);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');

  // Google accepts 5-1024 base32hex characters. Hex is a valid subset.
  return `tripspace${hex}`;
}
