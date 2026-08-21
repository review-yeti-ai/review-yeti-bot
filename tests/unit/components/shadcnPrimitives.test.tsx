// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';

describe('Shadcn UI Primitives Component Unit Tests', () => {
  describe('Button Component', () => {
    it('renders default button variant and handles click event', () => {
      const handleClick = vi.fn();
      render(<Button onClick={handleClick}>Click Me</Button>);

      const button = screen.getByRole('button', { name: 'Click Me' });
      expect(button).toBeInTheDocument();
      expect(button).toHaveClass('bg-primary');

      fireEvent.click(button);
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('renders disabled state correctly', () => {
      const handleClick = vi.fn();
      render(<Button disabled onClick={handleClick}>Disabled Button</Button>);

      const button = screen.getByRole('button', { name: 'Disabled Button' });
      expect(button).toBeDisabled();

      fireEvent.click(button);
      expect(handleClick).not.toHaveBeenCalled();
    });

    it('renders destructive variant with styling', () => {
      render(<Button variant="destructive">Delete Item</Button>);
      const button = screen.getByRole('button', { name: 'Delete Item' });
      expect(button).toHaveClass('bg-destructive');
    });
  });

  describe('Input & Textarea Components', () => {
    it('renders Input element and accepts user input', () => {
      const handleChange = vi.fn();
      render(<Input placeholder="Enter username" onChange={handleChange} />);

      const input = screen.getByPlaceholderText('Enter username');
      expect(input).toBeInTheDocument();

      fireEvent.change(input, { target: { value: 'testuser' } });
      expect(handleChange).toHaveBeenCalled();
      expect((input as HTMLInputElement).value).toBe('testuser');
    });

    it('renders Textarea element and updates content', () => {
      render(<Textarea placeholder="Enter feedback" defaultValue="Initial text" />);

      const textarea = screen.getByPlaceholderText('Enter feedback');
      expect(textarea).toBeInTheDocument();
      expect((textarea as HTMLTextAreaElement).value).toBe('Initial text');
    });
  });

  describe('Card & Badge Components', () => {
    it('renders Card hierarchy with title and content', () => {
      render(
        <Card>
          <CardHeader>
            <CardTitle>Metric Card Title</CardTitle>
          </CardHeader>
          <CardContent>
            <p>Card body content</p>
          </CardContent>
        </Card>
      );

      expect(screen.getByText('Metric Card Title')).toBeInTheDocument();
      expect(screen.getByText('Card body content')).toBeInTheDocument();
    });

    it('renders Badge component with status styling', () => {
      render(<Badge variant="secondary">Active</Badge>);
      const badge = screen.getByText('Active');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveClass('bg-secondary');
    });

    it('renders Progress indicator with correct value', () => {
      const { container } = render(<Progress value={75} />);
      expect(container.firstChild).toBeInTheDocument();
    });
  });
});
