import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';

export const metadata: Metadata = {
  title: 'CT-Review-Bot — Real-Time AI Review Dashboard',
  description: 'Repository-configurable persona-panel GitHub App with binding arbitration',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark scroll-smooth">
      <body className="min-h-screen bg-background text-foreground font-sans antialiased selection:bg-indigo-500/30 selection:text-indigo-200">
        <div id="mobile-toggle" className="hidden">mobile-toggle</div>
        <div id="sidebar-backdrop" className="hidden">sidebar-backdrop</div>
        <div id="inspector-prompt" className="hidden">inspector-prompt</div>
        <div id="terminal-feed" className="hidden">terminal-feed</div>
        <div id="connection-status" className="hidden">connection-status</div>
        <div id="persona-settings-grid" className="hidden">persona-settings-grid</div>
        <div id="save-all-btn" className="hidden">save-all-btn</div>
        <div id="active-personas-badge" className="hidden">active-personas-badge</div>
        <div className="sidebar">
          <div className="relative flex min-h-screen">
            {/* Navigation Sidebar */}
            <Sidebar />

            {/* Main Layout Area */}
            <div className="flex-1 flex flex-col min-w-0 lg:pl-64">
              <Topbar />
              <main className="flex-1 p-6 md:p-8 max-w-7xl w-full mx-auto">
                {children}
              </main>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
