import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <section aria-labelledby="not-found-title" className="mx-auto grid max-w-md gap-3 py-16 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 id="not-found-title" className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-sm text-muted-foreground">This page does not exist in the new Dashboard yet.</p>
      <div className="flex justify-center gap-2 pt-2">
        <Button asChild><Link to="/">Go to Overview</Link></Button>
        <Button asChild variant="outline"><a href="/dashboard?ui=legacy">Open classic Dashboard</a></Button>
      </div>
    </section>
  );
}
