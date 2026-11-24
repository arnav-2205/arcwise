'use client';

/**
 * The homepage's living moss world as a page background. The authored page is loaded unchanged and
 * only its UI layers are made invisible (visibility keeps their layout, which the scene measures
 * while it grows the roots). Decorative: not focusable, no pointer events.
 */
export default function World({ ghost }: { ghost?: string }) {
  return (
    <>
      <div className="world" aria-hidden>
        <iframe
          title=""
          tabIndex={-1}
          src="/landing-pages/arcwise-world.html"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, pointerEvents: 'none', background: '#383B34' }}
        />
      </div>
      {ghost && <div className="ghost-word" aria-hidden>{ghost}</div>}
    </>
  );
}
