/**
 * E.164 Radix Trie Tariff Rating Engine & Pulse Rounding Calculator
 */

import { NormalizedCdr } from './models/callDetailRecord';
import { DestinationTariff, PulseRule, RateDeck, RatedCdr } from './models/ratePlan';
import { CdrRatingError } from '../../src/common/errors';

export class RadixTrieNode<T> {
  public value: T | null = null;
  public prefix: string = '';
  public readonly children: Map<string, RadixTrieNode<T>> = new Map();
}

export class E164RadixTrie<T> {
  private root: RadixTrieNode<T> = new RadixTrieNode();

  /**
   * Inserts a prefix route into the Trie in O(k) where k is prefix length.
   */
  public insert(prefix: string, value: T): void {
    const normalized = prefix.startsWith('+') ? prefix.slice(1) : prefix;
    let current = this.root;

    for (let i = 0; i < normalized.length; i++) {
      const char = normalized[i];
      let next = current.children.get(char);
      if (!next) {
        next = new RadixTrieNode<T>();
        next.prefix = normalized.slice(0, i + 1);
        current.children.set(char, next);
      }
      current = next;
    }
    current.value = value;
  }

  /**
   * Performs Longest Prefix Match (LPM) in O(k).
   */
  public longestPrefixMatch(e164Number: string): { matchedPrefix: string; value: T } | null {
    const normalized = e164Number.startsWith('+') ? e164Number.slice(1) : e164Number;
    let current = this.root;
    let longestMatch: { matchedPrefix: string; value: T } | null = null;

    if (current.value !== null) {
      longestMatch = { matchedPrefix: '', value: current.value };
    }

    for (let i = 0; i < normalized.length; i++) {
      const char = normalized[i];
      const next = current.children.get(char);
      if (!next) {
        break;
      }
      current = next;
      if (current.value !== null) {
        longestMatch = { matchedPrefix: `+${current.prefix}`, value: current.value };
      }
    }

    return longestMatch;
  }

  public clear(): void {
    this.root = new RadixTrieNode();
  }
}

export class DestinationUnroutableError extends Error {
  constructor(public readonly destination: string) {
    super(`[DestinationUnroutableError] No tariff prefix matched destination: ${destination}`);
    this.name = 'DestinationUnroutableError';
  }
}

export class TariffRatingEngine {
  private readonly tenantTries: Map<string, { deckId: string; trie: E164RadixTrie<DestinationTariff> }> = new Map();

  /**
   * Atomic rate sheet hot-reload without downtime or race conditions.
   */
  public loadRateDeck(deck: RateDeck): void {
    const newTrie = new E164RadixTrie<DestinationTariff>();
    for (const tariff of deck.rates) {
      newTrie.insert(tariff.prefix, tariff);
    }
    // Atomic reference swap
    this.tenantTries.set(deck.tenantId, { deckId: deck.deckId, trie: newTrie });
  }

  /**
   * Rates a normalized CDR.
   */
  public rateCall(cdr: NormalizedCdr, isPeak: boolean = false): RatedCdr {
    const tenantEntry = this.tenantTries.get(cdr.tenantId);
    if (!tenantEntry) {
      throw new CdrRatingError(`No active rate deck loaded for tenant: ${cdr.tenantId}`);
    }

    const match = tenantEntry.trie.longestPrefixMatch(cdr.callee);
    if (!match) {
      throw new DestinationUnroutableError(cdr.callee);
    }

    const tariff = match.value;
    const rawBillableSec = cdr.billableDurationSec;

    if (rawBillableSec === 0 || cdr.disposition !== 'ANSWERED') {
      return {
        ...cdr,
        rateDeckId: tenantEntry.deckId,
        matchedPrefix: match.matchedPrefix,
        destinationZone: tariff.destinationName,
        billedDurationSec: 0,
        ratePerMinuteMicros: tariff.ratePerMinuteMicros,
        connectionFeeMicros: 0,
        usageCostMicros: 0,
        totalCostMicros: 0,
        totalCostFormatted: '$0.000000',
      };
    }

    const billedDurationSec = this.calculatePulseDuration(rawBillableSec, tariff.pulseRule);

    const effectiveRatePerMinuteMicros = isPeak
      ? Math.round(tariff.ratePerMinuteMicros * (tariff.peakRateMultiplier || 1.0))
      : tariff.ratePerMinuteMicros;

    const usageCostMicros = Math.round((billedDurationSec / 60) * effectiveRatePerMinuteMicros);
    const connectionFeeMicros = tariff.connectionFeeMicros || 0;
    const totalCostMicros = usageCostMicros + connectionFeeMicros;

    return {
      ...cdr,
      rateDeckId: tenantEntry.deckId,
      matchedPrefix: match.matchedPrefix,
      destinationZone: tariff.destinationName,
      billedDurationSec,
      ratePerMinuteMicros: effectiveRatePerMinuteMicros,
      connectionFeeMicros,
      usageCostMicros,
      totalCostMicros,
      totalCostFormatted: this.formatMicroCurrency(totalCostMicros),
    };
  }

  /**
   * Calculates billed duration based on pulse rule (e.g. 60/60, 30/6, 6/6, 1/1)
   */
  public calculatePulseDuration(actualSeconds: number, pulse: PulseRule): number {
    if (actualSeconds <= 0) return 0;
    if (actualSeconds <= pulse.initialPulseSec) {
      return pulse.initialPulseSec;
    }
    const remaining = actualSeconds - pulse.initialPulseSec;
    const increments = Math.ceil(remaining / pulse.incrementPulseSec);
    return pulse.initialPulseSec + increments * pulse.incrementPulseSec;
  }

  /**
   * Formats micro-units ($1.00 = 1,000,000 micros) into standard decimal currency string
   */
  public formatMicroCurrency(micros: number, currency: string = '$'): string {
    const val = micros / 1000000;
    return `${currency}${val.toFixed(6)}`;
  }
}
