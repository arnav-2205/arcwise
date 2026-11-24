import { redirect } from 'next/navigation';

// Old report links moved to the public share URL.
export default async function Page({ params }: { params: Promise<{ vid: string }> }) {
  const { vid } = await params;
  redirect(`/r/${vid}`);
}
