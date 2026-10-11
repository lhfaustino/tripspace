import type { IadpRosterEventsResponse } from '../normalize-roster-events.js';

const pairingBase = {
  id: 9000,
  logicalId: 'synthetic-pairing-oct-03',
  type: 'PAIRING',
  originalEventType: 'PAIRING',
  fromDateTimeUTC: '2026-10-03T23:00:00Z',
  toDateTimeUTC: '2026-10-04T08:00:00Z',
  fromDateTimeLtAtHb: '2026-10-03T20:00:00-03:00',
  toDateTimeLtAtHb: '2026-10-04T05:00:00-03:00',
  departure: { airportCode: 'GRU', dateTime: '2026-10-03T20:00:00-03:00' },
  arrival: { airportCode: 'GRU', dateTime: '2026-10-04T05:00:00-03:00' },
  eventDescription: { pairingNumber: 'SYN-001' },
};

const firstLeg = {
  id: 9001,
  logicalId: 'synthetic-leg-1',
  type: 'LEG',
  originalEventType: 'LEG',
  fromDateTimeUTC: '2026-10-03T23:30:00Z',
  toDateTimeUTC: '2026-10-04T02:30:00Z',
  fromDateTimeSchedUTC: '2026-10-03T23:20:00Z',
  toDateTimeSchedUTC: '2026-10-04T02:20:00Z',
  fromDateTimeLtAtAirport: '2026-10-03T20:30:00-03:00',
  toDateTimeLtAtAirport: '2026-10-03T23:30:00-03:00',
  fromDateTimeLtAtHb: '2026-10-03T20:30:00-03:00',
  toDateTimeLtAtHb: '2026-10-03T23:30:00-03:00',
  departure: { airportCode: 'GRU', dateTime: '2026-10-03T20:30:00-03:00' },
  arrival: { airportCode: 'NAT', dateTime: '2026-10-03T23:30:00-03:00' },
  eventDescription: {
    flightNumber: 'G3 1234',
    aircraftTypeCode: 'B38M',
  },
};

const secondLeg = {
  id: 9002,
  logicalId: 'synthetic-leg-2',
  type: 'LEG',
  originalEventType: 'LEG',
  fromDateTimeUTC: '2026-10-04T04:00:00Z',
  toDateTimeUTC: '2026-10-04T07:00:00Z',
  fromDateTimeLtAtAirport: '2026-10-04T01:00:00-03:00',
  toDateTimeLtAtAirport: '2026-10-04T04:00:00-03:00',
  fromDateTimeLtAtHb: '2026-10-04T01:00:00-03:00',
  toDateTimeLtAtHb: '2026-10-04T04:00:00-03:00',
  departure: { airportCode: 'NAT', dateTime: '2026-10-04T01:00:00-03:00' },
  arrival: { airportCode: 'GRU', dateTime: '2026-10-04T04:00:00-03:00' },
  eventDescription: {
    flightNumber: 'G3 5678',
    aircraftSubType: 'B738',
  },
};

const reserveActivity = {
  id: 9010,
  logicalId: 'synthetic-reserve-1',
  type: 'GROUND',
  originalEventType: 'GROUND',
  fromDateTimeUTC: '2026-10-05T12:00:00Z',
  toDateTimeUTC: '2026-10-05T18:00:00Z',
  fromDateTimeLtAtHb: '2026-10-05T09:00:00-03:00',
  toDateTimeLtAtHb: '2026-10-05T15:00:00-03:00',
  departure: { airportCode: 'GRU', dateTime: '2026-10-05T09:00:00-03:00' },
  arrival: { airportCode: 'GRU', dateTime: '2026-10-05T15:00:00-03:00' },
  eventDescription: { groundActivityCode: 'FR' },
};

export const syntheticInitialRoster: IadpRosterEventsResponse = {
  success: true,
  result: {
    success: true,
    refTimestamp: '2026-10-01T12:00:00Z',
    rosterPeriod: {
      from: '2026-10-01T03:00:00Z',
      to: '2026-11-01T02:59:59Z',
      fromLocalAtHb: '2026-10-01T00:00:00-03:00',
      toLocalAtHb: '2026-10-31T23:59:59-03:00',
    },
    events: [
      { ...pairingBase, events: [firstLeg, secondLeg] },
      reserveActivity,
    ],
  },
};

export const syntheticUpdatedRoster: IadpRosterEventsResponse = {
  success: true,
  result: {
    success: true,
    refTimestamp: '2026-10-02T12:00:00Z',
    rosterPeriod: syntheticInitialRoster.result?.rosterPeriod,
    events: [
      {
        ...pairingBase,
        events: [
          {
            ...firstLeg,
            eventDescription: { ...firstLeg.eventDescription, aircraftTypeCode: 'B38N' },
          },
          {
            ...secondLeg,
            fromDateTimeUTC: '2026-10-04T04:30:00Z',
            toDateTimeUTC: '2026-10-04T07:30:00Z',
            fromDateTimeLtAtAirport: '2026-10-04T01:30:00-03:00',
            toDateTimeLtAtAirport: '2026-10-04T04:30:00-03:00',
            fromDateTimeLtAtHb: '2026-10-04T01:30:00-03:00',
            toDateTimeLtAtHb: '2026-10-04T04:30:00-03:00',
          },
          {
            id: 9003,
            logicalId: 'synthetic-leg-3',
            type: 'LEG',
            originalEventType: 'LEG',
            fromDateTimeUTC: '2026-10-04T10:00:00Z',
            toDateTimeUTC: '2026-10-04T11:30:00Z',
            fromDateTimeLtAtAirport: '2026-10-04T07:00:00-03:00',
            toDateTimeLtAtAirport: '2026-10-04T08:30:00-03:00',
            fromDateTimeLtAtHb: '2026-10-04T07:00:00-03:00',
            toDateTimeLtAtHb: '2026-10-04T08:30:00-03:00',
            departure: { airportCode: 'GRU', dateTime: '2026-10-04T07:00:00-03:00' },
            arrival: { airportCode: 'VIX', dateTime: '2026-10-04T08:30:00-03:00' },
            eventDescription: { flightNumber: 'G3 9012', aircraftTypeCode: 'B738' },
          },
        ],
      },
    ],
  },
};
