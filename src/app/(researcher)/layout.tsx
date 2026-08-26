import ResearcherShell from '@/components/shell/ResearcherShell';

export default function ResearcherLayout({ children }: { children: React.ReactNode }) {
  return <ResearcherShell>{children}</ResearcherShell>;
}
