import { Formatter, FormatterOptions, SessionRecord, SessionKPIs, SessionDetail } from '../types';

export class JSONFormatter implements Formatter {
  public formatSessions(sessions: SessionRecord[], options?: FormatterOptions): string {
    const indent = options?.pretty !== false ? 2 : undefined;
    return JSON.stringify({ sessions }, null, indent);
  }

  public formatKPIs(kpis: SessionKPIs, options?: FormatterOptions): string {
    const indent = options?.pretty !== false ? 2 : undefined;
    return JSON.stringify({ kpis }, null, indent);
  }

  public formatDetail(detail: SessionDetail, options?: FormatterOptions): string {
    const indent = options?.pretty !== false ? 2 : undefined;
    return JSON.stringify({ session: detail }, null, indent);
  }
}
