// ============================================================
// Pricing Page — /organizer/events/[id]/pricing
//
// Redirects to the main manage event page which already has
// the pricing controls built in. This route exists because
// the initial scaffold created it, but the pricing UI is
// integrated directly into the manage event page.
// ============================================================

'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function PricingRedirectPage() {
  const params = useParams();
  const router = useRouter();

  // Redirect to the main manage page which has pricing controls
  useEffect(() => {
    router.replace(`/organizer/events/${params.id}`);
  }, [params.id, router]);

  return (
    <div className="page-container py-20 text-center">
      <div className="spinner mx-auto" style={{ width: 32, height: 32 }}></div>
      <p className="mt-4 text-sm" style={{ color: 'var(--text-muted)' }}>
        Redirecting to event management...
      </p>
    </div>
  );
}
