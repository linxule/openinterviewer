import type { Metadata } from 'next';
import DemoSimulation from '@/components/DemoSimulation';

export const metadata: Metadata = {
  title: 'Try a scripted interview | OpenInterviewer',
  description:
    'Follow a fictional participant through a deterministic qualitative interview, then inspect the evidence behind an illustrative researcher note.',
};

export default function DemoPage() {
  return <DemoSimulation />;
}
