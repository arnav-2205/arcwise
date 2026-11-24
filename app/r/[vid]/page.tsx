import Report from '../../../components/Report';

export const metadata = { title: 'Validation report' };

export default async function Page({ params }: { params: Promise<{ vid: string }> }) {
  const { vid } = await params;
  return <Report vid={vid} />;
}
