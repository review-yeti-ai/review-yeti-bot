// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

import { PRReviewDetailModal } from '../../src/components/dashboard/pr-review-detail-modal';
import { MermaidViewer } from '../../src/components/dashboard/mermaid-viewer';
import { ReviewJob } from '../../src/types/dashboard';

const mockSequenceDiagram = `\`\`\`mermaid
sequenceDiagram
  autonumber
  actor User as Developer
  participant Gateway as API Gateway
  participant Auth as Auth Service
  
  User->>Gateway: POST /api/v1/auth/login
  Gateway->>Auth: Validate Credentials
  Auth-->>Gateway: 200 OK (JWT Token)
  Gateway-->>User: Auth Response
\`\`\``;

const mockFlowchartDiagram = `\`\`\`mermaid
flowchart TD
  A[Incoming Webhook] --> B{Valid Signature?}
  B -->|Yes| C[Enqueue Job]
  B -->|No| D[Reject Request]
  C --> E[Run Review Personas]
\`\`\``;

const mockJobWithDiagram: ReviewJob = {
  id: 'job-mermaid-test-101',
  repo: 'calltelemetry/cisco-cdr',
  prNumber: 3099,
  title: 'feat(diagrams): add sequence and flowchart generator',
  verdict: 'SHIP',
  status: 'completed',
  personas: ['security', 'architecture', 'review_flowchart'],
  tokens: 12000,
  cost: 0.12,
  latencyMs: 1800,
  timestamp: '2 mins ago',
  headSha: 'c9d8e7f',
  quorum: '3/3',
  mermaidDiagram: mockSequenceDiagram,
};

describe('PR Review Detail View - Mermaid Diagram Rendering', () => {
  it('renders MermaidViewer inside PRReviewDetailModal passing job.mermaidDiagram', () => {
    render(<PRReviewDetailModal job={mockJobWithDiagram} open={true} onOpenChange={() => {}} />);

    expect(screen.getByText(/Architectural Sequence & Flowchart/i)).toBeInTheDocument();
    expect(screen.getByText(/Mermaid Sequence \/ Flowchart/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Visual View/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Raw Code/i })).toBeInTheDocument();
  });

  it('switches between Visual View and Raw Code mode dynamically in MermaidViewer', () => {
    render(<MermaidViewer diagram={mockSequenceDiagram} />);

    // Initially in Visual View mode
    const visualBtn = screen.getByRole('button', { name: /Visual View/i });
    const codeBtn = screen.getByRole('button', { name: /Raw Code/i });
    expect(visualBtn).toBeInTheDocument();

    // Click Raw Code view
    fireEvent.click(codeBtn);

    // Verify raw code contents are rendered
    expect(screen.getByText(/actor User as Developer/)).toBeInTheDocument();
    expect(screen.getByText(/User->>Gateway: POST \/api\/v1\/auth\/login/)).toBeInTheDocument();

    // Click back to Visual View mode
    fireEvent.click(visualBtn);
    expect(screen.queryByText(/User->>Gateway: POST \/api\/v1\/auth\/login/)).not.toBeInTheDocument();
  });

  it('renders dynamic Mermaid flowchart TD diagrams correctly', () => {
    render(<MermaidViewer diagram={mockFlowchartDiagram} />);

    const codeBtn = screen.getByRole('button', { name: /Raw Code/i });
    fireEvent.click(codeBtn);

    expect(screen.getByText(/flowchart TD/)).toBeInTheDocument();
    expect(screen.getByText(/A\[Incoming Webhook\] --> B\{Valid Signature\?\}/)).toBeInTheDocument();
    expect(screen.getByText(/C --> E\[Run Review Personas\]/)).toBeInTheDocument();
  });
});
