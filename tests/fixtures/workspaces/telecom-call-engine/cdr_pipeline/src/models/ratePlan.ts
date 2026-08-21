/**
 * Rate Plan, Tariff & Billed CDR Data Models
 */

import { NormalizedCdr } from './callDetailRecord';

export type PulseRoundingMode = '60/60' | '30/6' | '6/6' | '1/1';

export interface PulseRule {
  initialPulseSec: number;     // e.g. 60 or 30 or 6
  incrementPulseSec: number;   // e.g. 60 or 6 or 1
}

export interface DestinationTariff {
  prefix: string;              // E.164 prefix, e.g. "+1", "+1212", "+44", "+447"
  destinationName: string;     // e.g. "US - New York", "UK - Mobile"
  ratePerMinuteMicros: number; // 1 USD = 1,000,000 micros ($0.02/min = 20,000)
  connectionFeeMicros: number; // Flat fee charged on answer
  pulseRule: PulseRule;        // Rounding rule
  peakRateMultiplier: number;  // e.g. 1.25 for 25% peak surcharge
  isoCountryCode: string;      // e.g. "US", "GB"
}

export interface RateDeck {
  deckId: string;
  tenantId: string;
  name: string;
  currency: string;            // e.g. "USD"
  rates: DestinationTariff[];
  effectiveDateIso: string;
}

export interface RatedCdr extends NormalizedCdr {
  rateDeckId: string;
  matchedPrefix: string;
  destinationZone: string;
  billedDurationSec: number;
  ratePerMinuteMicros: number;
  connectionFeeMicros: number;
  usageCostMicros: number;
  totalCostMicros: number;
  totalCostFormatted: string;   // e.g. "$0.045000"
}
