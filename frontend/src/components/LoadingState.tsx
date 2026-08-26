export function LoadingState({ label = "טוענים נתונים" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="loading-seal" aria-hidden="true"><i /><i /><i /></span>
      <span>{label}…</span>
    </div>
  );
}
