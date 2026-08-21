'use client';

import React from 'react';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen text-slate-100 bg-slate-950 p-6">
      <h1 className="text-4xl font-bold tracking-tight mb-2">404 - Page Not Found</h1>
      <p className="text-slate-400 mb-6 font-mono text-sm">The requested dashboard page could not be found.</p>
      <Link
        href="/live"
        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md text-sm font-medium transition-colors"
      >
        Return to Live Terminal
      </Link>
    </div>
  );
}
