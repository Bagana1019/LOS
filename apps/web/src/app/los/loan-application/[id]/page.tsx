'use client';
import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { resumeStep, stepHref, useApplication } from '../../../../features/applications';

// FR-1.6 "Мэдээлэл оруулах": сүүлд зогссон (эхний бүрдээгүй) алхам руу.
export default function Page() {
  const { id } = useParams<{ id: string }>();
  const { data } = useApplication(id);
  const router = useRouter();
  useEffect(() => { if (data) router.replace(stepHref(id, resumeStep(data.steps))); }, [data, id, router]);
  return null;
}
