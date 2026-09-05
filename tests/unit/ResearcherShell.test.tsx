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
import { useSetTrailingCrumb } from '@/components/shell/breadcrumb';

beforeEach(() => {
  navigation.pathname = '/studies';
  navigation.push.mockReset();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
});

describe('ResearcherShell', () => {
  it('renders all three destinations as links to /studies, /dashboard, and /settings', () => {
    render(<ResearcherShell>content</ResearcherShell>);

    const studiesLinks = screen.getAllByRole('link', { name: 'Studies' });
    const interviewsLinks = screen.getAllByRole('link', { name: 'Interviews' });
    const settingsLinks = screen.getAllByRole('link', { name: 'Settings' });
    expect(studiesLinks.length).toBeGreaterThan(0);
    expect(interviewsLinks.length).toBeGreaterThan(0);
    expect(settingsLinks.length).toBeGreaterThan(0);
    studiesLinks.forEach((link) => expect(link).toHaveAttribute('href', '/studies'));
    interviewsLinks.forEach((link) => expect(link).toHaveAttribute('href', '/dashboard'));
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

  it('marks Interviews active on dashboard paths', () => {
    navigation.pathname = '/dashboard/interview/abc123';
    render(<ResearcherShell>content</ResearcherShell>);

    for (const nav of screen.getAllByRole('navigation', { name: 'Researcher' })) {
      expect(within(nav).getByRole('link', { name: 'Interviews' })).toHaveAttribute('aria-current', 'page');
      expect(within(nav).getByRole('link', { name: 'Studies' })).not.toHaveAttribute('aria-current');
      expect(within(nav).getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current');
    }
  });

  it('still marks Studies active on /setup', () => {
    navigation.pathname = '/setup';
    render(<ResearcherShell>content</ResearcherShell>);

    for (const nav of screen.getAllByRole('navigation', { name: 'Researcher' })) {
      expect(within(nav).getByRole('link', { name: 'Studies' })).toHaveAttribute('aria-current', 'page');
      expect(within(nav).getByRole('link', { name: 'Interviews' })).not.toHaveAttribute('aria-current');
      expect(within(nav).getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current');
    }
  });

  it('renders a breadcrumb trail of Interviews and the trailing id, with no Studies crumb, for an interview detail path', () => {
    navigation.pathname = '/dashboard/interview/abc123';
    render(<ResearcherShell>content</ResearcherShell>);

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByText('Interviews')).toBeInTheDocument();
    expect(within(breadcrumb).getByText('abc123')).toBeInTheDocument();
    expect(within(breadcrumb).queryByText('Studies')).not.toBeInTheDocument();
    expect(within(breadcrumb).getByRole('link', { name: 'Interviews' })).toHaveAttribute('href', '/dashboard');
  });

  it('names a saved study in the /setup breadcrumb, and says "New study" when nothing names it', () => {
    navigation.pathname = '/setup';
    function NamedDocument() {
      useSetTrailingCrumb('Returning to saved research');
      return <span>content</span>;
    }
    const { unmount } = render(<ResearcherShell><NamedDocument /></ResearcherShell>);
    let breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByText('Returning to saved research')).toBeInTheDocument();
    expect(within(breadcrumb).queryByText('New study')).not.toBeInTheDocument();
    unmount();

    render(<ResearcherShell>content</ResearcherShell>);
    breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByText('New study')).toBeInTheDocument();
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
