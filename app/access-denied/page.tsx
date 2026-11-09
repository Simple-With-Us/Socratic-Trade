export const metadata = { title: "Access denied" };

export default function AccessDeniedPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-6 text-center">
      <div className="max-w-md space-y-3">
        <h1 className="text-xl font-semibold text-fg">Access denied</h1>
        <p className="text-sm text-muted">
          Your account isn&apos;t permitted to use this app. If you think this is a mistake, ask the owner to
          add your email to the allowlist.
        </p>
      </div>
    </main>
  );
}
