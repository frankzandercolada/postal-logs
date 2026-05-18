export default function Login() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm bg-panel border border-border rounded-lg p-8">
        <div className="font-mono text-sm text-accent mb-1">▎ postal-logs</div>
        <h1 className="text-xl font-semibold mb-1">Sign in</h1>
        <p className="text-sm text-muted mb-6">
          Use your work Google account to access the dashboard.
        </p>
        <a
          href="/auth/google"
          className="block w-full text-center py-2.5 rounded-md bg-ink text-bg font-medium hover:bg-white transition"
        >
          Continue with Google
        </a>
        <p className="text-xs text-muted mt-6 leading-relaxed">
          Access is limited to invited users. If your sign-in fails, ask an
          administrator to add you.
        </p>
      </div>
    </div>
  );
}
