import { Formatter, FormatterOptions, SessionRecord, SessionKPIs, SessionDetail } from '../types';
import { JSONFormatter } from './jsonFormatter';
import { OKFFormatter } from './okfFormatter';
import { MarkdownFormatter } from './markdownFormatter';
import { TableFormatter } from './tableFormatter';

export { JSONFormatter, OKFFormatter, MarkdownFormatter, TableFormatter };

export function getFormatter(format: string = 'table'): Formatter {
  const normalized = format.toLowerCase();
  switch (normalized) {
    case 'json':
      return new JSONFormatter();
    case 'okf':
      return new OKFFormatter();
    case 'markdown':
    case 'md':
      return new MarkdownFormatter();
    case 'table':
    default:
      return new TableFormatter();
  }
}

export function formatOutput(
  data: { kpis?: SessionKPIs; sessions?: SessionRecord[]; sessionDetail?: SessionDetail },
  options: FormatterOptions
): string {
  const formatter = getFormatter(options.format);
  if (data.sessionDetail) {
    return formatter.formatDetail(data.sessionDetail, options);
  }
  if (data.kpis) {
    return formatter.formatKPIs(data.kpis, options);
  }
  if (data.sessions) {
    return formatter.formatSessions(data.sessions, options);
  }
  return '';
}
