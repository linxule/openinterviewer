import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

const navigation = vi.hoisted(() => ({
  pathname: '/studies',
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push }),
}));

import ResearcherShell from '@/components/shell/ResearcherShell';

beforeEach(() => {
  navigation.pathname = '/studies';
  navigation.push.mockReset();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
});

describe('ResearcherShell', () => {
  it('renders both destinations as links to /studies and /settings', () => {
    render(<ResearcherShell>content</ResearcherShell>);

    const studiesLinks = screen.getAllByRole('link', { name: 'Studies' });
    const settingsLinks = screen.getAllByRole('link', { name: 'Settings' });
    expect(studiesLinks.length).toBeGreaterThan(0);
    expect(settingsLinks.length).toBeGreaterThan(0);
    studiesLinks.forEach((link) => expect(link).toHaveAttribute('href', '/studies'));
    settingsLinks.forEach((link) => expect(link).toHaveAttribute('href', '/settings'));
  });

  it('marks only the active destination with aria-current', () => {
    navigation.pathname = '/settings';
    render(<ResearcherShell>content</ResearcherShell>);

    for (const nav of screen.getAllByRole('navigation', { name: 'Researcher' })) {
      expect(within(nav).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
      expect(within(nav).getByRole('link', { name: 'Studies' })).not.toHaveAttribute('aria-current');
    }
  });

  it('treats non-settings pathnames as Studies-active', () => {
    navigation.pathname = '/dashboard/interview/abc123';
    render(<ResearcherShell>content</ResearcherShell>);

    for (const nav of screen.getAllByRole('navigation', { name: 'Researcher' })) {
      expect(within(nav).getByRole('link', { name: 'Studies' })).toHaveAttribute('aria-current', 'page');
      expect(within(nav).getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current');
    }
  });

  it('renders a breadcrumb trail of Studies, Interviews, and the trailing id for an interview detail path', () => {
    navigation.pathname = '/dashboard/interview/abc123';
    render(<ResearcherShell>content</ResearcherShell>);

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByText('Studies')).toBeInTheDocument();
    expect(within(breadcrumb).getByText('Interviews')).toBeInTheDocument();
    expect(within(breadcrumb).getByText('abc123')).toBeInTheDocument();
  });

  it('shows the "Your keys · your database" line', () => {
    render(<ResearcherShell>content</ResearcherShell>);
    expect(screen.getAllByText('Your keys · your database').length).toBeGreaterThan(0);
  });

  it('gives the skip link the researcher-main target', () => {
    render(<ResearcherShell>content</ResearcherShell>);
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute(
      'href',
      '#researcher-main'
    );
  });

  it('logs out via DELETE /api/auth then navigates to /login', async () => {
    render(<ResearcherShell>content</ResearcherShell>);

    fireEvent.click(screen.getAllByRole('button', { name: 'Log out' })[0]);

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/auth', { method: 'DELETE' });
      expect(navigation.push).toHaveBeenCalledWith('/login');
    });
  });
});
