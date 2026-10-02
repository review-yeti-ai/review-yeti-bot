import { expect } from 'vitest';
import request from 'supertest';

const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string) => { window: { document: Document } };
};

/** Inspect the rendered document, never serialized React payloads or hidden legacy placeholders. */
export function dashboardDocument(html: string): Document {
  const document = new JSDOM(html).window.document;
  expect(document.doctype?.name).toBe('html');
  expect(document.querySelector('main')).not.toBeNull();
  return document;
}

export function assertDashboardRouteHtml(html: string, route: 'live' | 'settings'): Document {
  const document = dashboardDocument(html);
  const sources = Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]')).map((script) => script.getAttribute('src'));
  expect(sources.some((source) => new RegExp(`^/_next/static/chunks/app/${route}/page-[a-zA-Z0-9-]+\\.js$`).test(source ?? ''))).toBe(true);
  expect(document.querySelector(`aside a[href="/${route}"]`)).not.toBeNull();
  return document;
}

export function assertSettingsMarkup(html: string): void {
  const document = assertDashboardRouteHtml(html, 'settings');
  expect(document.querySelector('main h1')?.textContent).toBe('Swarm Policies & Settings');
  expect(document.querySelector('main button[id="save-all-btn"]')?.textContent).toBe('Save All Changes');
  expect(document.querySelector('main [id="persona-settings-grid"] textarea')).not.toBeNull();
  expect(Array.from(document.querySelectorAll('main [role="tab"]')).map((tab) => tab.textContent))
    .toEqual(['Review Tasks & Personas', 'Model Providers & Budgets']);
}

export function assertLiveMarkup(html: string): void {
  const document = assertDashboardRouteHtml(html, 'live');
  // useSearchParams suspends during static export. The page-specific client bundle
  // hydrates the controls; the meaningful waiting state belongs inside main.
  expect(document.querySelector('main')?.textContent).toContain('Live Command Center');
  expect(document.querySelector('main')?.textContent).toContain('Connecting to Cloudflare Edge Swarm SSE Stream');
}

/** A missing chunk must not pass by receiving the SPA's HTML fallback with HTTP 200. */
export async function assertDashboardClientAssets(app: any, html: string, route: 'live' | 'settings'): Promise<void> {
  const document = assertDashboardRouteHtml(html, route);
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))
    .map((script) => script.getAttribute('src')!)
    .filter((source) => source.startsWith('/_next/static/chunks/'));
  expect(scripts.length).toBeGreaterThan(0);
  for (const source of [...new Set(scripts)]) {
    const response = await request(app).get(source);
    expect(response.status, source).toBe(200);
    expect(response.headers['content-type'], source).toMatch(/javascript/);
    expect(response.text.length, source).toBeGreaterThan(100);
    expect(response.text, source).not.toMatch(/<!doctype html>/i);
  }
}
